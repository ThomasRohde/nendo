using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// The tree read pages by key (ADR-0019): each page resumes after the record
/// the one before ended on, so a page costs its own records and a whole read costs what it returns.
/// Until then every page walked and sorted the whole subtree and cut itself by position, and the
/// walk refused past 10,000 records.
/// </summary>
[TestClass]
public sealed class HierarchyTreePagingTests
{
    private const string Entity = "nodes";

    /// <summary>
    /// Every page size, root and depth reads the tree a reference walk builds from the same
    /// records: negative, equal and missing orders, a level wider than a seek's first batch, and
    /// a branch deeper than the depth asked for. The read-only snapshot walk reads it the same way.
    /// </summary>
    [TestMethod]
    public async Task EveryPageSizeReadsTheTreeTheReferenceWalkBuilds()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var nodes = new List<(string Id, string? Parent, long? Order)>
        {
            ("a", null, 2), ("e", null, 2), ("b", null, -5), ("c", null, null), ("d", null, null), ("f", null, 0),
            ("b1", "b", 30), ("b2", "b", 10), ("b3", "b", null), ("b4", "b", -1), ("b5", "b", 10),
            ("b2x", "b2", 1), ("b2y", "b2", null), ("b2xa", "b2x", 1), ("b2xab", "b2xa", 1), ("b2xabc", "b2xab", null),
            ("a1", "a", null), ("a2", "a", null),
        };
        // Wider than the first batch a level asks for, ordered and unordered, with children of its own.
        for (var index = 0; index < 45; index++) nodes.Add(($"c{index:D2}", "c", index % 3 == 0 ? null : 100 - index));
        nodes.Add(("c07a", "c07", 5));
        nodes.Add(("c40a", "c40", null));
        await CreateAsync(coordinator, nodes);
        await DeclareAsync(coordinator, service, order: true);

        var windows = new (string? Root, int Depth)[] { (null, 1), (null, 2), (null, 3), (null, 32), ("b", 1), ("b", 2), ("b", 32), ("c", 1), ("c", 32), ("b2xab", 32) };
        foreach (var (root, depth) in windows)
        {
            var expected = Reference(nodes, root, depth);
            foreach (var size in new[] { 1, 2, 3, 16, 17, 200 })
                CollectionAssert.AreEqual(expected, await ReadAllAsync(coordinator, root, depth, size),
                    $"The tree under {root ?? "the top level"} to depth {depth} in pages of {size}.");
        }

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        foreach (var (root, depth) in windows)
            foreach (var size in new[] { 1, 3, 200 })
                CollectionAssert.AreEqual(Reference(nodes, root, depth), await ReadAllAsync(reader, root, depth, size),
                    $"The read-only walk under {root ?? "the top level"} to depth {depth} in pages of {size}.");
    }

    /// <summary>
    /// The measure of paging by key: a whole read seeks about as many rows as it returns, however
    /// far into the tree a page is, on a wide flat level and on nested levels alike. A walk that
    /// re-reads what came before each page seeks rows in the square of the tree's size.
    /// </summary>
    [TestMethod]
    public async Task AWholeTreeReadSeeksAboutTheRowsItReturns()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        // 3,001 records under one root: 1,500 children in order, the first 100 with 15 children
        // each, and those with none.
        var nodes = new List<(string Id, string? Parent, long? Order)> { ("root", null, null) };
        for (var index = 0; index < 1_500; index++) nodes.Add(($"n{index:D4}", "root", (index + 1) * 1024L));
        for (var index = 0; index < 1_500; index++) nodes.Add(($"n{index / 15:D4}-{index % 15:D2}", $"n{index / 15:D4}", index % 15));
        await CreateAsync(coordinator, nodes);
        await DeclareAsync(coordinator, service, order: true);

        var before = coordinator.TreeRowsSought;
        var pages = new List<long>();
        var read = 0;
        string? cursor = null;
        do
        {
            var start = coordinator.TreeRowsSought;
            var page = await coordinator.TreeRecordsAsync(new(Entity, "root", 32, 50, cursor));
            pages.Add(coordinator.TreeRowsSought - start);
            read += page.Items.Count;
            cursor = page.NextCursor;
        } while (cursor is not null);
        var sought = coordinator.TreeRowsSought - before;

        Assert.AreEqual(3_000, read);
        Assert.IsLessThanOrEqualTo(3L * read, sought,
            $"A whole read of {read} records in {pages.Count} pages sought {sought} rows; a walk that re-reads each page's predecessors seeks about {read * pages.Count / 2}.");
        Assert.IsLessThanOrEqualTo(200L, pages.Max(),
            $"One page of 50 sought {pages.Max()} rows; the last page sought {pages[^1]}. A page costs its own records and the levels above it.");
    }

    /// <summary>
    /// A move reads the level it places a record in with one statement, whatever its width; past
    /// 10,000 siblings it was refused as hierarchy-too-wide, which was more than a move read.
    /// </summary>
    [TestMethod]
    public async Task AMoveAmongMoreThanTenThousandSiblingsWritesOneRecord()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        var nodes = new List<(string Id, string? Parent, long? Order)> { ("root", null, null) };
        // The old bound counted the siblings without the moved record, so 10,001 others is one past it.
        for (var index = 0; index < 10_002; index++) nodes.Add(($"w{index:D5}", "root", (index + 1) * 1024L));
        await CreateAsync(coordinator, nodes);
        await DeclareAsync(coordinator, service, order: true);

        var moved = await service.MoveRecordAsync(new(Entity, "w00010", 1, "root", 1, "w05000", new("paging-tests", "wide-move", "test")));

        CollectionAssert.AreEqual(new[] { "w00010" }, moved.TouchedRecordIds.ToArray());
        var at = (await ReadAllAsync(coordinator, "root", 1, 200)).FindIndex(entry => entry.StartsWith("w00010@", StringComparison.Ordinal));
        Assert.AreEqual(4_999, at, "The moved record is not just before w05000.");
    }

    /// <summary>
    /// An ordered hierarchy seeks its siblings by an index of (parent, order, record ID): created
    /// when the hierarchy is declared, also on a record type created in the same mutation, and
    /// dropped when it is removed. A hierarchy without an order field reads the reference index.
    /// </summary>
    [TestMethod]
    public async Task TheTreeIndexComesAndGoesWithAnOrderedDeclaration()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator);
        await CreateAsync(coordinator, [("r", null, 1)]);
        Assert.IsNull(TreeIndex(workspace));

        await DeclareAsync(coordinator, service, order: true);
        Assert.AreEqual("parent_id,ord,__nendo_record_id", TreeIndex(workspace));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "remove", "test", "Remove", [new RemoveHierarchyOperation("remove", Entity, revision)]));
        Assert.IsNull(TreeIndex(workspace), "The tree index outlived its declaration.");

        await DeclareAsync(coordinator, service, order: false);
        Assert.IsNull(TreeIndex(workspace), "A hierarchy without an order field reads the reference index (parent, record ID).");

        // A record type and its declaration in one mutation: the columns exist only when it ends.
        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "fresh", "test", "A new tree", [
            new CreateEntityOperation("e2", "units", "Units", "units"),
            new AddFieldOperation("u-title", "units", "unit-title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("u-parent", "units", "unit-parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("u-ord", "units", "unit-ord", "Order", "ord", NendoStorageKind.Integer, false),
            new ConfigureReferenceOperation("u-bind", "units", "unit-parent", "units", "unit-title", revision),
            new DeclareHierarchyOperation("u-declare", "units", "unit-parent", "unit-ord", revision),
        ]));
        Assert.AreEqual("parent_id,ord,__nendo_record_id", TreeIndex(workspace, "units"));
    }

    /// <summary>The columns of a table's tree index, or null when it has none.</summary>
    private static string? TreeIndex(EngineTestWorkspace workspace, string table = Entity)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        connection.Open();
        using var exists = connection.CreateCommand();
        exists.CommandText = "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = @name;";
        exists.Parameters.AddWithValue("@name", $"nendo_tree_{table}");
        if (Convert.ToInt64(exists.ExecuteScalar()) == 0) return null;
        using var columns = connection.CreateCommand();
        columns.CommandText = $"SELECT name FROM pragma_index_info('nendo_tree_{table}') ORDER BY seqno;";
        using var reader = columns.ExecuteReader();
        var names = new List<string>();
        while (reader.Read()) names.Add(reader.GetString(0));
        return string.Join(',', names);
    }

    /// <summary>Every record of the window, page by page, as "id@depth^parent#children".</summary>
    private static async Task<List<string>> ReadAllAsync(NendoWriteCoordinator coordinator, string? root, int depth, int size)
    {
        var read = new List<string>();
        string? cursor = null;
        do
        {
            var page = await coordinator.TreeRecordsAsync(new(Entity, root, depth, size, cursor));
            read.AddRange(page.Items.Select(node => $"{node.Record.RecordId}@{node.Depth}^{node.ParentRecordId}#{node.ChildCount}"));
            cursor = page.NextCursor;
        } while (cursor is not null);
        return read;
    }

    /// <summary>The window as ADR-0019 orders it, built from the records alone: depth-first, siblings by order, unordered last, then ID.</summary>
    private static List<string> Reference(List<(string Id, string? Parent, long? Order)> nodes, string? root, int depth)
    {
        var children = nodes.GroupBy(node => node.Parent ?? "").ToDictionary(group => group.Key, group => group
            .OrderBy(node => node.Order is null).ThenBy(node => node.Order).ThenBy(node => node.Id, StringComparer.Ordinal).ToList());
        var walk = new List<string>();
        void Visit(string? parent, int level)
        {
            foreach (var child in children.GetValueOrDefault(parent ?? "") ?? [])
            {
                walk.Add($"{child.Id}@{level}^{parent}#{children.GetValueOrDefault(child.Id)?.Count ?? 0}");
                if (level < depth) Visit(child.Id, level + 1);
            }
        }
        Visit(root, 1);
        return walk;
    }

    private static Task SchemaAsync(NendoWriteCoordinator coordinator) =>
        coordinator.ApplyAsync(new("test", "schema", "test", "A tree", [
            new CreateEntityOperation("e", Entity, "Nodes", "nodes"),
            new AddFieldOperation("f-title", Entity, "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-parent", Entity, "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("f-ord", Entity, "ord", "Order", "ord", NendoStorageKind.Integer, false),
            new ConfigureReferenceOperation("bind", Entity, "parent", Entity, "title", 0),
        ]));

    /// <summary>Creates the records parents first, in one revision.</summary>
    private static Task CreateAsync(NendoWriteCoordinator coordinator, IReadOnlyList<(string Id, string? Parent, long? Order)> nodes) =>
        coordinator.ApplyAsync(new("test", $"create-{Guid.NewGuid():N}", "test", "Records",
            nodes.Select(node => (NendoOperation)new CreateRecordOperation($"c-{node.Id}", Entity, node.Id,
                new Dictionary<string, object?> { ["title"] = node.Id, ["parent"] = node.Parent, ["ord"] = node.Order },
                node.Parent is null ? null : new Dictionary<string, long> { ["parent"] = 1 })).ToList()));

    private static async Task DeclareAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, bool order)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", $"declare-{Guid.NewGuid():N}", "test", "Declare",
            [new DeclareHierarchyOperation($"d-{Guid.NewGuid():N}", Entity, "parent", order ? "ord" : null, revision)]));
    }
}
