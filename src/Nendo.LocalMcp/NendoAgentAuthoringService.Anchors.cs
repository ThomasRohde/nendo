using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// Places a node beside another instead of at a number (W-168). A position is a sort key among a
/// node's siblings, ordered by position and then by ID, and an author upgrading an existing file
/// could not see the keys: one replaced a root screen at a guessed index and it landed a slot late.
/// <c>beforeNodeId</c> or <c>afterNodeId</c> on <c>ui.addNode</c> and <c>ui.moveNode</c> is resolved
/// here, when the operation is added, to the position the canonical operation stores, against the
/// file's definition and the change set's earlier operations. Where no free key lies between the
/// neighbours, the siblings after the slot move up by <c>ui.moveNode</c> operations the change set
/// then carries and the person reviews. Nothing behind the boundary learns of anchors.
/// </summary>
internal sealed partial class NendoAgentAuthoringService
{
    private readonly record struct PlacedNode(string SurfaceId, string? ParentNodeId, int Position);

    private static bool HasAnchor(NendoAgentOperationInput operation) =>
        operation.OperationType is "ui.addNode" or "ui.moveNode" &&
        (operation.Payload.Element.TryGetProperty("beforeNodeId", out _) || operation.Payload.Element.TryGetProperty("afterNodeId", out _));

    private async Task<IReadOnlyList<NendoAgentMutationInput>> ResolveAnchorsAsync(
        IReadOnlyList<NendoAgentMutationInput> earlier,
        IReadOnlyList<NendoAgentMutationInput> mutations,
        int firstMutationOrdinal,
        CancellationToken cancellationToken)
    {
        if (!mutations.Any(mutation => mutation.Operations.Any(HasAnchor))) return mutations;
        var nodes = (await application.GetDefinitionSnapshotAsync(cancellationToken)).UiNodes
            .ToDictionary(node => node.NodeId, node => new PlacedNode(node.SurfaceId, node.ParentNodeId, node.Position), StringComparer.Ordinal);
        foreach (var operation in earlier.SelectMany(mutation => mutation.Operations).SelectMany(Expand)) Place(nodes, operation);
        var resolved = new List<NendoAgentMutationInput>(mutations.Count);
        for (var mutationIndex = 0; mutationIndex < mutations.Count; mutationIndex++)
        {
            var mutation = mutations[mutationIndex];
            var operations = new List<NendoAgentOperationInput>(mutation.Operations.Count);
            for (var operationIndex = 0; operationIndex < mutation.Operations.Count; operationIndex++)
            {
                var operation = mutation.Operations[operationIndex];
                IReadOnlyList<NendoAgentOperationInput> placed;
                try
                {
                    placed = HasAnchor(operation) ? Anchor(nodes, operation) : [operation];
                }
                catch (NendoValidationException exception)
                {
                    throw new NendoValidationException(
                        $"Mutation {firstMutationOrdinal + mutationIndex}, operation {operationIndex} ({Describe(operation)}): {exception.Message}");
                }
                foreach (var value in placed)
                {
                    operations.Add(value);
                    foreach (var expanded in Expand(value)) Place(nodes, expanded);
                }
            }
            resolved.Add(mutation with { Operations = operations });
        }
        return resolved;
    }

    /// <summary>The anchored operation with its position filled in, then any sibling it moves up to make room.</summary>
    private static IReadOnlyList<NendoAgentOperationInput> Anchor(Dictionary<string, PlacedNode> nodes, NendoAgentOperationInput operation)
    {
        var payload = operation.Payload.Element;
        var before = Text(payload, "beforeNodeId");
        var after = Text(payload, "afterNodeId");
        var nodeId = Text(payload, "nodeId") ?? throw new NendoValidationException($"{operation.OperationType} requires nodeId.");
        if (before is not null && after is not null || payload.TryGetProperty("position", out _))
            throw new NendoValidationException("Give exactly one of position, beforeNodeId and afterNodeId.");
        var anchorId = before ?? after!;
        if (anchorId == nodeId) throw new NendoValidationException($"{nodeId} cannot be placed beside itself.");
        if (!nodes.TryGetValue(anchorId, out var anchor))
            throw new NendoValidationException($"{anchorId} is not a node in this file or earlier in this change set, so nothing can be placed beside it.");
        if (payload.TryGetProperty("parentNodeId", out var parent) &&
            (parent.ValueKind == JsonValueKind.String ? parent.GetString() : null) != anchor.ParentNodeId)
        {
            throw new NendoValidationException(
                $"A node placed beside {anchorId} takes its parent, {anchor.ParentNodeId ?? "none (a root)"}; leave parentNodeId out or send that.");
        }

        // A root's siblings are every root; a child's, the other children of its parent. The order
        // is the one the compiler draws in: position, then surface, then ID.
        var siblings = nodes
            .Where(pair => pair.Key != nodeId && pair.Value.ParentNodeId == anchor.ParentNodeId)
            .OrderBy(pair => pair.Value.Position)
            .ThenBy(pair => pair.Value.SurfaceId, StringComparer.Ordinal)
            .ThenBy(pair => pair.Key, StringComparer.Ordinal)
            .ToList();
        var slot = siblings.FindIndex(pair => pair.Key == anchorId) + (after is not null ? 1 : 0);
        int? previous = slot > 0 ? siblings[slot - 1].Value.Position : null;
        int? next = slot < siblings.Count ? siblings[slot].Value.Position : null;
        var position = (previous, next) switch
        {
            (null, { } n) when n >= 1 => n - 1,
            ({ } p, null) when p < int.MaxValue => p + 1,
            ({ } p, { } n) when n - p >= 2 => p + (n - p) / 2,
            _ => (int?)null,
        };
        var moves = new List<NendoAgentOperationInput>();
        if (position is null)
        {
            // No free key between the neighbours: take the one after the previous sibling and move
            // up each later sibling only as far as it must, which stops at the first already clear.
            position = (previous ?? -1) + 1;
            var floor = position.Value;
            for (var index = slot; index < siblings.Count && siblings[index].Value.Position <= floor; index++)
            {
                floor++;
                var (siblingId, sibling) = (siblings[index].Key, siblings[index].Value);
                moves.Add(new NendoAgentOperationInput("ui.moveNode", Object(writer =>
                {
                    writer.WriteString("surfaceId", sibling.SurfaceId);
                    writer.WriteString("nodeId", siblingId);
                    if (sibling.ParentNodeId is null) writer.WriteNull("parentNodeId");
                    else writer.WriteString("parentNodeId", sibling.ParentNodeId);
                    writer.WriteNumber("position", floor);
                })));
            }
        }
        var placed = new NendoAgentOperationInput(operation.OperationType, Object(writer =>
        {
            foreach (var property in payload.EnumerateObject()
                         .Where(property => property.Name is not ("beforeNodeId" or "afterNodeId" or "parentNodeId")))
            {
                property.WriteTo(writer);
            }
            if (anchor.ParentNodeId is null) writer.WriteNull("parentNodeId");
            else writer.WriteString("parentNodeId", anchor.ParentNodeId);
            writer.WriteNumber("position", position.Value);
        }));
        return [placed, .. moves];
    }

    /// <summary>Applies one expanded operation to the placement it leaves, so a later anchor sees it.</summary>
    private static void Place(Dictionary<string, PlacedNode> nodes, NendoAgentOperationInput operation)
    {
        var payload = operation.Payload.Element;
        if (Text(payload, "nodeId") is not { } nodeId) return;
        switch (operation.OperationType)
        {
            case "ui.addNode" when Text(payload, "surfaceId") is { } surfaceId && Position(payload) is { } position:
                nodes[nodeId] = new PlacedNode(surfaceId, Text(payload, "parentNodeId"), position);
                break;
            case "ui.moveNode" when nodes.TryGetValue(nodeId, out var current) && Position(payload) is { } moved:
                nodes[nodeId] = current with { ParentNodeId = Text(payload, "parentNodeId"), Position = moved };
                break;
            case "ui.removeNode":
                var removed = new HashSet<string>(StringComparer.Ordinal) { nodeId };
                bool grew;
                do
                {
                    grew = false;
                    foreach (var (id, node) in nodes)
                        if (node.ParentNodeId is { } owner && removed.Contains(owner) && removed.Add(id)) grew = true;
                } while (grew);
                foreach (var id in removed) nodes.Remove(id);
                break;
        }
    }

    private static string? Text(JsonElement payload, string name) =>
        payload.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static int? Position(JsonElement payload) =>
        payload.TryGetProperty("position", out var value) && value.TryGetInt32(out var position) ? position : null;
}
