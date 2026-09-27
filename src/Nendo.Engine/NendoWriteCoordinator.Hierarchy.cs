using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    /// <summary>A window of a declared hierarchy, depth-first (ADR-0019).</summary>
    public async Task<NendoPage<NendoTreeNode>> TreeRecordsAsync(NendoTreeQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentException.ThrowIfNullOrWhiteSpace(query.EntityId);
        NendoQueryCursor.RequireLimit(query.Limit);
        if (query.Depth is < 1 or > NendoHierarchyLimits.MaximumDepth)
            throw new NendoValidationException($"A tree read goes 1 to {NendoHierarchyLimits.MaximumDepth} levels deep.");
        if (query.RootRecordId is { Length: 0 or > 200 })
            throw new NendoValidationException("A tree root is a stable record ID of 1–200 characters.");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                return ReadOnlyTree(query, _readOnlySnapshot);
            }
            return await GetStore().TreeRecordsAsync(query, _queryCursors, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    internal static string TreeScope(NendoTreeQuery query) => "tree/" + Convert.ToHexString(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { query.EntityId, query.RootRecordId, query.Depth })));

    /// <summary>The same walk over a read-only file's snapshot, which has no store to query.</summary>
    private NendoPage<NendoTreeNode> ReadOnlyTree(NendoTreeQuery query, NendoSessionSnapshot snapshot)
    {
        var entity = snapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var hierarchy = entity.Hierarchy
            ?? throw new NendoPreconditionException("hierarchy-not-declared", $"{entity.DisplayName} declares no hierarchy to read as a tree.");
        var records = snapshot.Records.Where(record => record.EntityId == query.EntityId).ToArray();
        if (query.RootRecordId is not null && records.All(record => record.RecordId != query.RootRecordId))
            throw new NendoPreconditionException("record-not-found", $"Record {query.RootRecordId} does not exist.");
        var children = ChildrenByParent(records, hierarchy);
        var walk = new List<(NendoRecordSnapshot Record, int Depth)>();
        void Visit(string? parent, int depth)
        {
            if (depth > query.Depth) return;
            foreach (var child in children.GetValueOrDefault(parent ?? "") ?? [])
            {
                walk.Add((child, depth));
                if (walk.Count > NendoHierarchyLimits.MaximumDescendants)
                    throw new NendoPreconditionException("hierarchy-too-wide",
                        $"More than {NendoHierarchyLimits.MaximumDescendants} records lie within {query.Depth} levels of {query.RootRecordId ?? "the top level"}. Read fewer levels or a lower record's subtree.");
                Visit(child.RecordId, depth + 1);
            }
        }
        Visit(query.RootRecordId, 1);
        var scope = TreeScope(query);
        var offset = _queryCursors.Decode(query.Cursor, snapshot.Manifest, scope) is { } after
            ? int.Parse(after, NumberStyles.None, CultureInfo.InvariantCulture) : 0;
        var page = walk.Skip(offset).Take(query.Limit + 1).ToArray();
        var next = page.Length > query.Limit
            ? _queryCursors.Encode(snapshot.Manifest, scope, (offset + query.Limit).ToString(CultureInfo.InvariantCulture)) : null;
        return new(page.Take(query.Limit).Select(node => new NendoTreeNode(node.Record, ParentOf(node.Record, hierarchy), node.Depth,
            children.GetValueOrDefault(node.Record.RecordId)?.Count ?? 0)).ToArray(), next, snapshot.Manifest.ChangeSequence);
    }

    /// <summary>Every record's ID under <paramref name="root"/> in a snapshot, for descendantOf on a read-only file.</summary>
    internal static HashSet<string> SnapshotSubtree(IReadOnlyList<NendoRecordSnapshot> records, NendoHierarchy hierarchy, string root)
    {
        var children = ChildrenByParent(records, hierarchy);
        var found = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Stack<(string Id, int Depth)>([(root, 0)]);
        while (pending.Count > 0)
        {
            var (id, depth) = pending.Pop();
            if (depth >= NendoHierarchyLimits.MaximumDepth) continue;
            foreach (var child in children.GetValueOrDefault(id) ?? [])
                if (found.Add(child.RecordId)) pending.Push((child.RecordId, depth + 1));
        }
        if (found.Count > NendoHierarchyLimits.MaximumDescendants)
            throw new NendoPreconditionException("hierarchy-too-wide",
                $"More than {NendoHierarchyLimits.MaximumDescendants} records sit under {root}, which is more than one hierarchy read folds. Read a lower record's subtree.");
        return found;
    }

    /// <summary>Children by parent ID ("" for the top level), in the hierarchy's sibling order.</summary>
    private static Dictionary<string, List<NendoRecordSnapshot>> ChildrenByParent(IReadOnlyList<NendoRecordSnapshot> records, NendoHierarchy hierarchy)
    {
        long? Order(NendoRecordSnapshot record) => hierarchy.OrderFieldId is { } field &&
            record.Values.GetValueOrDefault(field) is { ValueKind: JsonValueKind.Number } value ? value.GetInt64() : null;
        return records.GroupBy(record => ParentOf(record, hierarchy) ?? "", StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group
                .OrderBy(record => Order(record) is null).ThenBy(record => Order(record))
                .ThenBy(record => record.RecordId, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);
    }

    private static string? ParentOf(NendoRecordSnapshot record, NendoHierarchy hierarchy) =>
        record.Values.GetValueOrDefault(hierarchy.ParentFieldId) is { ValueKind: JsonValueKind.String } parent ? parent.GetString() : null;
}
