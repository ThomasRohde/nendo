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
                return await ReadOnlyTreeAsync(query, _readOnlySnapshot, cancellationToken);
            }
            return await GetStore().TreeRecordsAsync(query, _queryCursors, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    internal static string TreeScope(NendoTreeQuery query) => "tree/" + Convert.ToHexString(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new { query.EntityId, query.RootRecordId, query.Depth })));

    /// <summary>
    /// The children of one parent, or the top level, with their versions and orders, for a move
    /// to place a record among. One read from one change, whatever the number of siblings.
    /// </summary>
    internal async Task<IReadOnlyList<(string RecordId, long Version, long? Order)>> HierarchySiblingsAsync(
        string entityId, string? parentRecordId, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_readOnlySnapshot is not null)
            {
                if (!Capabilities.ReadData) throw new NendoPreconditionException("data-unavailable", "Data cannot be safely interpreted for this file.");
                var entity = _readOnlySnapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == entityId)
                    ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
                var hierarchy = entity.Hierarchy
                    ?? throw new NendoPreconditionException("hierarchy-not-declared", $"{entity.DisplayName} declares no hierarchy.");
                return _readOnlySnapshot.Records
                    .Where(record => record.EntityId == entityId && ParentOf(record, hierarchy) == parentRecordId)
                    .Select(record => (record.RecordId, record.RecordVersion, Order(record, hierarchy))).ToArray();
            }
            return await GetStore().HierarchySiblingsAsync(entityId, parentRecordId, cancellationToken);
        }
        catch (NendoRecoveryRequiredException) { EnterRecovery(); throw; }
        finally { _gate.Release(); }
    }

    /// <summary>A read-only file's records by parent and by ID, built once per snapshot and record type.</summary>
    private (NendoSessionSnapshot Snapshot, string EntityId, Dictionary<string, List<NendoRecordSnapshot>> Children,
        Dictionary<string, (NendoRecordSnapshot Record, int Position)> Records)? _readOnlyTree;

    /// <summary>
    /// The same walk over a read-only file's snapshot, which has no store to query: the same
    /// <see cref="NendoTreeWalk"/>, seeking in the snapshot's sibling lists instead of an index.
    /// </summary>
    private async Task<NendoPage<NendoTreeNode>> ReadOnlyTreeAsync(NendoTreeQuery query, NendoSessionSnapshot snapshot, CancellationToken cancellationToken)
    {
        var entity = snapshot.Entities.SingleOrDefault(candidate => candidate.EntityId == query.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", "The requested record type does not exist.");
        var hierarchy = entity.Hierarchy
            ?? throw new NendoPreconditionException("hierarchy-not-declared", $"{entity.DisplayName} declares no hierarchy to read as a tree.");
        if (_readOnlyTree is not { } tree || tree.Snapshot != snapshot || tree.EntityId != query.EntityId)
        {
            var children = ChildrenByParent(snapshot.Records.Where(record => record.EntityId == query.EntityId).ToArray(), hierarchy);
            var positions = new Dictionary<string, (NendoRecordSnapshot, int)>(StringComparer.Ordinal);
            foreach (var siblings in children.Values)
                for (var index = 0; index < siblings.Count; index++) positions[siblings[index].RecordId] = (siblings[index], index);
            tree = (snapshot, query.EntityId, children, positions);
            _readOnlyTree = tree;
        }
        if (query.RootRecordId is not null && !tree.Records.ContainsKey(query.RootRecordId))
            throw new NendoPreconditionException("record-not-found", $"Record {query.RootRecordId} does not exist.");
        NendoTreeChild Child(NendoRecordSnapshot record) =>
            new(record.RecordId, Order(record, hierarchy), tree.Children.GetValueOrDefault(record.RecordId)?.Count ?? 0);

        var scope = TreeScope(query);
        var chain = new List<NendoTreeChild>();
        if (_queryCursors.Decode(query.Cursor, snapshot.Manifest, scope) is { } after)
        {
            for (string? current = after; current != query.RootRecordId && chain.Count < query.Depth;
                 current = ParentOf(tree.Records[current].Record, hierarchy))
            {
                if (current is null || !tree.Records.ContainsKey(current))
                    throw NendoQueryCursor.Invalid();
                chain.Insert(0, Child(tree.Records[current].Record));
            }
            if (chain.Count == 0 || ParentOf(tree.Records[chain[0].RecordId].Record, hierarchy) != query.RootRecordId)
                throw NendoQueryCursor.Invalid();
        }
        var steps = await NendoTreeWalk.CollectAsync(query.RootRecordId, query.Depth, query.Limit + 1, chain,
            (parent, from, limit, _) =>
            {
                var siblings = tree.Children.GetValueOrDefault(parent ?? "") ?? [];
                var start = from is { } previous ? tree.Records[previous.RecordId].Position + 1 : 0;
                return Task.FromResult<IReadOnlyList<NendoTreeChild>>(siblings.Skip(start).Take(limit).Select(Child).ToArray());
            }, cancellationToken);
        var shown = steps.Take(query.Limit).ToArray();
        var next = steps.Count > query.Limit ? _queryCursors.Encode(snapshot.Manifest, scope, shown[^1].RecordId) : null;
        return new(shown.Select(step => new NendoTreeNode(tree.Records[step.RecordId].Record, step.ParentRecordId, step.Depth, step.ChildCount)).ToArray(),
            next, snapshot.Manifest.ChangeSequence);
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
        return found;
    }

    /// <summary>Children by parent ID ("" for the top level), in the hierarchy's sibling order.</summary>
    private static Dictionary<string, List<NendoRecordSnapshot>> ChildrenByParent(IReadOnlyList<NendoRecordSnapshot> records, NendoHierarchy hierarchy) =>
        records.GroupBy(record => ParentOf(record, hierarchy) ?? "", StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group
                .OrderBy(record => Order(record, hierarchy) is null).ThenBy(record => Order(record, hierarchy))
                .ThenBy(record => record.RecordId, StringComparer.Ordinal).ToList(), StringComparer.Ordinal);

    private static long? Order(NendoRecordSnapshot record, NendoHierarchy hierarchy) => hierarchy.OrderFieldId is { } field &&
        record.Values.GetValueOrDefault(field) is { ValueKind: JsonValueKind.Number } value ? value.GetInt64() : null;

    private static string? ParentOf(NendoRecordSnapshot record, NendoHierarchy hierarchy) =>
        record.Values.GetValueOrDefault(hierarchy.ParentFieldId) is { ValueKind: JsonValueKind.String } parent ? parent.GetString() : null;
}
