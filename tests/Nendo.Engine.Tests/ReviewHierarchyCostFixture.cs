using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

// ADR-0019 delivery stage 1: what a declared hierarchy would cost, measured before any
// product code. Explicit opt-in driver, invoked by tools/Review-HierarchyCost.ps1; no test
// calls it. The fixture is built through canonical coordinator operations, so the tables,
// the reference columns and their covering indexes have the production shape. The reads are
// the candidate SQL the Engine would run, timed on a read-only connection to that file; the
// writes go through the coordinator, so they carry versions, history and inverse evidence.
public static class ReviewHierarchyCostFixture
{
    private const int MaxDepth = 32;
    private const int Warmups = 3;

    // Stage 1 ran at 10,000 records with a node of 1,000 children. The 2026-10-16 amendment also
    // runs it at the file's own bound: a file holds at most 100,000 operation rows and refuses a
    // write from 99,000 (SqliteNendoStore.WriteCeilingRows), and every create is a row, so 98,000
    // nodes and 500 links leave room for the writes measured afterwards. There the wide node
    // holds 20,000 children, more than the old bound let a move read; the whole-level renumber
    // (20,000 rows a round) does not fit and is measured at 10,000 only, and the walks that
    // re-sort the whole subtree take fewer samples.
    private const int LargeNodeCount = 98_000;
    private static int NodeCount = 10_000, LinkCount = 5_000, WideChildren = 1_000, Samples = 30, SlowSamples = 30;

    // Pre-registered targets (ADR-0019, Evidence and validation obligations): every read within
    // the 150 ms bounded-read target of ADR-0003; the cycle check adds at most 2 ms to a save of
    // about 12 ms; the one-off declaration scan and a 1,000-sibling renumber within 1 s.
    private static readonly Dictionary<string, double> TargetsMs = new()
    {
        ["cycleCheckDeepest"] = 2, ["cycleCheckShallow"] = 2,
        ["childrenPageWideFirst"] = 150, ["childrenPageWideLast"] = 150, ["topLevelPage"] = 150,
        ["descendantPageRoot"] = 150, ["subtreeAggregateRoot"] = 150, ["subtreeAggregateMiddle"] = 150,
        ["relatedAcrossSubtreeRoot"] = 150, ["declarationScan"] = 1_000,
        ["saveMoveRecord"] = 150, ["renumberWideSiblings"] = 1_000,
        // Stage 4: reads that evaluate a subtree Count for every record they return.
        ["calculatedPage"] = 150, ["calculatedTreeWindow"] = 150, ["calculatedSnapshot"] = 10_000,
        // ADR-0020 stage 3: a HierarchyPath column instead of the subtree Count.
        ["pathPage"] = 150, ["pathDeepestRecord"] = 150,
        // 2026-10-16 amendment. The walk as stage 3 built it, run as SQL so it reads past the old
        // bound: every page re-walks and re-sorts the subtree, then cuts by OFFSET. The figures
        // without a target of their own are recorded against the bounded-read target or, for a
        // whole read, against the one-second declaration scan target.
        ["positionWalkPageFirst"] = 150, ["positionWalkPageLast"] = 150, ["positionWalkFullRead"] = 1_000,
        ["descendantPageRootUnbounded"] = 150, ["subtreeAggregateRootUnbounded"] = 150,
        // The same reads through the service, as the host serves them.
        ["treeFirstPage"] = 150, ["treeLastPage"] = 150, ["treeFullRead"] = 1_000, ["treeWideSiblingsFullRead"] = 1_000,
        ["descendantOfPageRoot"] = 150, ["descendantOfCountRoot"] = 150, ["moveAmongWideSiblings"] = 150,
    };

    public static Task<string> RunAsync(string filePath) => RunAsync(filePath, 10_000);

    public static async Task<string> RunAsync(string filePath, int nodeCount)
    {
        if (nodeCount is not (10_000 or LargeNodeCount)) throw new ArgumentOutOfRangeException(nameof(nodeCount), "Run at 10,000 or 98,000 records.");
        NodeCount = nodeCount;
        LinkCount = nodeCount == 10_000 ? 5_000 : 500;
        WideChildren = nodeCount == 10_000 ? 1_000 : 20_000;
        SlowSamples = nodeCount == 10_000 ? 30 : 3;
        var repo = ReviewOutcomeChildDriver.RepositoryRoot();
        var artifactRoot = Path.GetFullPath(Path.Combine(repo, "artifacts")) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(filePath);
        if (!path.StartsWith(artifactRoot, StringComparison.OrdinalIgnoreCase) || Path.GetExtension(path) != ".nendo")
            throw new ArgumentException("Experiment files must be owned .nendo artifacts.");
        if (File.Exists(path)) throw new IOException("The experiment file already exists; choose a new run.");

        var tree = BuildTree();
        var setup = Stopwatch.StartNew();
        await GenerateAsync(path, tree);
        var setupMs = setup.Elapsed.TotalMilliseconds;

        var reads = MeasureReads(path, tree);
        var writes = await MeasureWritesAsync(path, tree);
        var results = reads.Concat(writes).ToDictionary(pair => pair.Key, pair => pair.Value);
        return JsonSerializer.Serialize(new
        {
            nodes = NodeCount, links = LinkCount, maxDepth = tree.Depth.Values.Max(), wideChildren = WideChildren,
            rootDescendants = tree.Descendants(tree.RootA).Count, middleNode = tree.Middle,
            middleDescendants = tree.Descendants(tree.Middle).Count,
            setupMilliseconds = setupMs, fileBytes = new FileInfo(path).Length, samples = Samples,
            results = results.ToDictionary(pair => pair.Key, pair => new
            {
                pair.Value.P50, pair.Value.P95, pair.Value.Max, pair.Value.Answer,
                targetMs = TargetsMs[pair.Key], passes = pair.Value.P95 <= TargetsMs[pair.Key],
            }),
        }, new JsonSerializerOptions { WriteIndented = true });
    }

    // ------------------------------------------------------------------------------------------
    // The tree: one large root holding almost everything, and a small second root. A spine
    // reaches the depth bound, one node has a thousand children, and the rest spread over the
    // first seven levels, as a capability model or an organisation chart does.

    private sealed class Tree
    {
        public readonly List<string> Order = [];
        public readonly Dictionary<string, string?> Parent = [];
        public readonly Dictionary<string, int> Depth = [];
        public readonly Dictionary<string, List<string>> Children = [];
        public string RootA = "", RootB = "", SpineLeaf = "", Wide = "", Middle = "", Shallow = "";

        public void Add(string id, string? parent)
        {
            Order.Add(id);
            Parent[id] = parent;
            Depth[id] = parent is null ? 1 : Depth[parent] + 1;
            Children[id] = [];
            if (parent is not null) Children[parent].Add(id);
        }

        public List<string> Descendants(string id)
        {
            var found = new List<string>();
            var stack = new Stack<string>(Children[id]);
            while (stack.Count > 0)
            {
                var next = stack.Pop();
                found.Add(next);
                foreach (var child in Children[next]) stack.Push(child);
            }
            return found;
        }
    }

    private static Tree BuildTree()
    {
        var tree = new Tree();
        var random = new Random(19);
        var serial = 0;
        var width = NodeCount > 99_999 ? 6 : 5;
        string Next() => $"node-{(serial++).ToString(new string('0', width), System.Globalization.CultureInfo.InvariantCulture)}";

        tree.RootA = Next(); tree.Add(tree.RootA, null);
        tree.RootB = Next(); tree.Add(tree.RootB, null);
        var spine = tree.RootA;
        for (var depth = 2; depth <= MaxDepth; depth++) { var id = Next(); tree.Add(id, spine); spine = id; }
        tree.SpineLeaf = spine;
        var group = Next(); tree.Add(group, tree.RootA);
        tree.Wide = Next(); tree.Add(tree.Wide, group);
        for (var i = 0; i < WideChildren; i++) tree.Add(Next(), tree.Wide);
        for (var i = 0; i < 50; i++) tree.Add(Next(), tree.RootB);

        // The rest attach to a random earlier node of depth 1 to 6 under the first root.
        var candidates = tree.Order.Where(id => tree.Depth[id] <= 6 && id != tree.RootB && tree.Parent[id] != tree.RootB
            && tree.Parent[id] != tree.Wide).ToList();
        while (tree.Order.Count < NodeCount)
        {
            var parent = candidates[random.Next(candidates.Count)];
            var id = Next();
            tree.Add(id, parent);
            if (tree.Depth[id] <= 6) candidates.Add(id);
        }
        tree.Shallow = tree.Order.First(id => tree.Depth[id] == 3 && tree.Children[id].Count > 0);
        tree.Middle = tree.Order.Where(id => tree.Depth[id] == 3)
            .OrderBy(id => Math.Abs(tree.Descendants(id).Count - 500)).First();
        return tree;
    }

    private static async Task GenerateAsync(string path, Tree tree)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "review-hierarchy-cost");
        await coordinator.ApplyAsync(new("hierarchy-cost", "schema", "experiment", "A tree and links into it", [
            new CreateEntityOperation("e-node", "node", "Nodes", "node"),
            new AddFieldOperation("f-title", "node", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-parent", "node", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("f-order", "node", "order", "Order", "ord", NendoStorageKind.Integer, false),
            new AddFieldOperation("f-cost", "node", "cost", "Cost", "cost", NendoStorageKind.Integer, false),
            new AddFieldOperation("f-flag", "node", "flag", "Flag", "flag", NendoStorageKind.Boolean, false),
            new ConfigureReferenceOperation("bind-parent", "node", "parent", "node", "title", 0),
            new CreateEntityOperation("e-link", "link", "Links", "link"),
            new AddFieldOperation("l-label", "link", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("l-node", "link", "node", "Node", "node_id", NendoStorageKind.Reference, true),
            new ConfigureReferenceOperation("bind-node", "link", "node", "node", "title", 0),
        ]));

        // Parents come before their children, so every reference names a record that exists at
        // version 1 when it is written.
        var creates = new List<NendoOperation>(NodeCount);
        var positions = tree.Children.Values.SelectMany(children => children.Select((child, index) => (child, index)))
            .ToDictionary(pair => pair.child, pair => pair.index);
        foreach (var id in tree.Order)
        {
            var parent = tree.Parent[id];
            var position = parent is null ? 0 : positions[id];
            var number = int.Parse(id[5..]);
            creates.Add(new CreateRecordOperation($"c-{id}", "node", id, new Dictionary<string, object?>
            {
                ["title"] = $"Capability {id}", ["parent"] = parent, ["order"] = (position + 1) * 1024L,
                ["cost"] = (long)(number % 100), ["flag"] = number % 3 == 0,
            }, parent is null ? null : new Dictionary<string, long> { ["parent"] = 1 }));
        }
        var random = new Random(20);
        var links = new List<NendoOperation>(LinkCount);
        for (var i = 0; i < LinkCount; i++)
        {
            var target = tree.Order[random.Next(tree.Order.Count)];
            links.Add(new CreateRecordOperation($"l-{i}", "link", $"link-{i:D5}",
                new Dictionary<string, object?> { ["label"] = $"Link {i}", ["node"] = target },
                new Dictionary<string, long> { ["node"] = 1 }));
        }
        if (creates.Count <= 10_000)
        {
            await coordinator.ApplyChangeSetAsync(new([
                new("hierarchy-cost", "nodes", "experiment", "The tree", creates),
                new("hierarchy-cost", "links", "experiment", "Links into the tree", links),
            ]), $"proposal-{Guid.NewGuid():N}");
            return;
        }
        for (var start = 0; start < creates.Count; start += 10_000)
            await coordinator.ApplyAsync(new("hierarchy-cost", $"nodes-{start}", "experiment", "The tree",
                creates.Skip(start).Take(10_000).ToList()));
        await coordinator.ApplyAsync(new("hierarchy-cost", "links", "experiment", "Links into the tree", links));
    }

    // ------------------------------------------------------------------------------------------
    // Candidate reads

    private sealed record Measure(double P50, double P95, double Max, string Answer);

    private static Dictionary<string, Measure> MeasureReads(string path, Tree tree)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        connection.Open();
        var results = new Dictionary<string, Measure>();

        // The cycle rule: would making `target` a child of `start` close a loop? Walk up from the
        // proposed parent; a loop exists if the record itself is met. The walk is bounded by depth.
        const string cycleCheck = """
            WITH RECURSIVE up(id, n) AS (
              SELECT @start, 0
              UNION ALL
              SELECT t.parent_id, up.n + 1 FROM node t JOIN up ON t.__nendo_record_id = up.id
              WHERE t.parent_id IS NOT NULL AND up.n < 33)
            SELECT count(*) FROM up WHERE id = @target;
            """;
        results["cycleCheckDeepest"] = Time(connection, cycleCheck, ("@start", tree.SpineLeaf), ("@target", tree.RootA));
        results["cycleCheckShallow"] = Time(connection, cycleCheck, ("@start", tree.Shallow), ("@target", tree.SpineLeaf));

        // A page of children in sibling order, each with its child count (the outline's read).
        const string children = """
            SELECT c.__nendo_record_id, c.title, c.ord,
                   (SELECT count(*) FROM node g WHERE g.parent_id = c.__nendo_record_id)
            FROM node c WHERE c.parent_id = @parent
            ORDER BY c.ord, c.__nendo_record_id LIMIT 100 OFFSET @offset;
            """;
        results["childrenPageWideFirst"] = Time(connection, children, ("@parent", tree.Wide), ("@offset", 0));
        results["childrenPageWideLast"] = Time(connection, children, ("@parent", tree.Wide), ("@offset", WideChildren - 100));
        results["topLevelPage"] = Time(connection, """
            SELECT c.__nendo_record_id, c.title, c.ord,
                   (SELECT count(*) FROM node g WHERE g.parent_id = c.__nendo_record_id)
            FROM node c WHERE c.parent_id IS NULL ORDER BY c.ord, c.__nendo_record_id LIMIT 100;
            """);

        // descendantOf: a page of 100 from the largest subtree, in record ID order.
        const string subtree = """
            WITH RECURSIVE sub(id, d) AS (
              SELECT __nendo_record_id, 1 FROM node WHERE parent_id = @root
              UNION ALL
              SELECT n.__nendo_record_id, sub.d + 1 FROM node n JOIN sub ON n.parent_id = sub.id WHERE sub.d < 32)
            """;
        results["descendantPageRoot"] = Time(connection, subtree + """
            SELECT n.__nendo_record_id, n.title FROM sub JOIN node n ON n.__nendo_record_id = sub.id
            ORDER BY n.__nendo_record_id LIMIT 100;
            """, ("@root", tree.RootA));

        // SubtreeAggregate: Count, Sum and a FilteredCount, refusing past 10,000 descendants.
        const string aggregate = """
            SELECT count(*), sum(n.cost), sum(n.flag) FROM (SELECT id FROM sub LIMIT 10001) s
            JOIN node n ON n.__nendo_record_id = s.id;
            """;
        results["subtreeAggregateRoot"] = Time(connection, subtree + aggregate, ("@root", tree.RootA));
        results["subtreeAggregateMiddle"] = Time(connection, subtree + aggregate, ("@root", tree.Middle));

        // RelatedAggregate across a subtree: links pointing at any node under the root, or the root.
        results["relatedAcrossSubtreeRoot"] = Time(connection, subtree + """
            SELECT count(*) FROM (SELECT id FROM sub UNION ALL SELECT @root) s
            JOIN link l ON l.node_id = s.id;
            """, ("@root", tree.RootA));

        // Declaring on existing data: every record must be reachable from a top-level record
        // within the depth bound; anything else is on a loop or too deep.
        results["declarationScan"] = Time(connection, """
            WITH RECURSIVE down(id, d) AS (
              SELECT __nendo_record_id, 1 FROM node WHERE parent_id IS NULL
              UNION ALL
              SELECT n.__nendo_record_id, down.d + 1 FROM node n JOIN down ON n.parent_id = down.id WHERE down.d < 33)
            SELECT (SELECT count(*) FROM node) - count(*), max(d) FROM down;
            """, samples: 10);

        // The same folds without the 10,001-row cut, to see what lifting the bound would cost.
        results["descendantPageRootUnbounded"] = Time(connection, subtree + """
            SELECT n.__nendo_record_id, n.title FROM sub JOIN node n ON n.__nendo_record_id = sub.id
            ORDER BY n.__nendo_record_id LIMIT 100;
            """, SlowSamples, ("@root", tree.RootA));
        results["subtreeAggregateRootUnbounded"] = Time(connection, subtree + """
            SELECT count(*), sum(n.cost), sum(n.flag) FROM sub JOIN node n ON n.__nendo_record_id = sub.id;
            """, SlowSamples, ("@root", tree.RootA));

        // The tree read as stage 3 built it (SqliteNendoStore.HierarchyReads until 2026-10-16):
        // a path per row, the whole subtree sorted by it, and the page cut by OFFSET.
        const string segment = """
            CASE WHEN {0}.ord IS NULL THEN 'z'
                 WHEN {0}.ord < 0 THEN 'a' || printf('%019d', 9223372036854775807 + {0}.ord)
                 ELSE 'b' || printf('%019d', {0}.ord) END || char(2) || {0}.__nendo_record_id || char(1)
            """;
        var positionWalk = $"""
            WITH RECURSIVE walk(id, d, path) AS (
              SELECT t.__nendo_record_id, 1, {string.Format(segment, "t")} FROM node t WHERE t.parent_id = @root
              UNION ALL
              SELECT n.__nendo_record_id, walk.d + 1, walk.path || {string.Format(segment, "n")} FROM node n JOIN walk ON n.parent_id = walk.id WHERE walk.d < 32)
            SELECT source_record.__nendo_record_id, source_record.title, source_record.ord, source_record.cost, source_record.flag, walk.d,
                   (SELECT count(*) FROM node child WHERE child.parent_id = source_record.__nendo_record_id)
            FROM walk JOIN node source_record ON source_record.__nendo_record_id = walk.id
            ORDER BY walk.path LIMIT 201 OFFSET @offset;
            """;
        var under = tree.Descendants(tree.RootA).Count;
        results["positionWalkPageFirst"] = Time(connection, positionWalk, SlowSamples, ("@root", tree.RootA), ("@offset", 0));
        results["positionWalkPageLast"] = Time(connection, positionWalk, SlowSamples, ("@root", tree.RootA), ("@offset", Math.Max(0, under - 200)));
        var full = new List<double>();
        var read = 0;
        for (var sample = 0; sample < (NodeCount == 10_000 ? 5 : 1); sample++)
        {
            using var command = connection.CreateCommand();
            command.CommandText = positionWalk;
            command.Parameters.AddWithValue("@root", tree.RootA);
            var offset = command.Parameters.AddWithValue("@offset", 0);
            var watch = Stopwatch.StartNew();
            read = 0;
            for (var start = 0; ; start += 200)
            {
                offset.Value = start;
                var rows = 0;
                using (var reader = command.ExecuteReader()) while (reader.Read()) rows++;
                read += Math.Min(rows, 200);
                if (rows <= 200) break;
            }
            full.Add(watch.Elapsed.TotalMilliseconds);
        }
        results["positionWalkFullRead"] = Summarise(full, $"{read} rows in pages of 200");
        return results;
    }

    // ------------------------------------------------------------------------------------------
    // Reads through the service, as Studio, the view API and MCP reach them. A refusal is an
    // answer: before the 2026-10-16 amendment each of these was refused past 10,000 records.

    private static async Task<Dictionary<string, Measure>> MeasureServiceReadsAsync(NendoApplicationService service, Tree tree)
    {
        var results = new Dictionary<string, Measure>();
        async Task<Measure> TimeAsync(Func<Task<string>> read, int samples, int warmups = Warmups)
        {
            var taken = new List<double>();
            var answer = "";
            for (var i = 0; i < warmups + samples; i++)
            {
                var watch = Stopwatch.StartNew();
                try { answer = await read(); }
                catch (NendoPreconditionException refused) { answer = $"refused: {refused.Code}"; }
                watch.Stop();
                if (i >= warmups) taken.Add(watch.Elapsed.TotalMilliseconds);
            }
            return Summarise(taken, answer);
        }

        // A whole read, page by page, with the time of its last page and a check of the order:
        // every node once, after its parent, one level below it, and siblings in (order, ID) order.
        var lastPages = new List<double>();
        async Task<string> ReadAllAsync(string root, int depth, bool keepLast)
        {
            var seen = new Dictionary<string, (int Depth, string? Parent)>(StringComparer.Ordinal);
            var lastChild = new Dictionary<string, (long? Order, string Id)>(StringComparer.Ordinal);
            var ordered = true;
            string? cursor = null;
            var pages = 0;
            double last = 0;
            do
            {
                var watch = Stopwatch.StartNew();
                var page = await service.TreeRecordsAsync(new("node", root, depth, 200, cursor));
                last = watch.Elapsed.TotalMilliseconds;
                pages++;
                foreach (var node in page.Items)
                {
                    var parent = node.ParentRecordId ?? "";
                    var expectedDepth = parent == root ? 1 : seen.TryGetValue(parent, out var up) ? up.Depth + 1 : -1;
                    long? order = node.Record.Values.GetValueOrDefault("order") is { ValueKind: JsonValueKind.Number } value ? value.GetInt64() : null;
                    if (lastChild.TryGetValue(parent, out var previous) &&
                        (previous.Order is null ? order is not null || string.CompareOrdinal(previous.Id, node.Record.RecordId) >= 0
                            : order is not null && (order < previous.Order || (order == previous.Order && string.CompareOrdinal(previous.Id, node.Record.RecordId) >= 0))))
                        ordered = false;
                    if (expectedDepth != node.Depth || !seen.TryAdd(node.Record.RecordId, (node.Depth, node.ParentRecordId))) ordered = false;
                    lastChild[parent] = (order, node.Record.RecordId);
                }
                cursor = page.NextCursor;
            } while (cursor is not null);
            if (keepLast) lastPages.Add(last);
            return $"{seen.Count} nodes in {pages} pages; depth-first and in sibling order: {ordered}";
        }

        var under = tree.Descendants(tree.RootA).Count;
        results["treeFirstPage"] = await TimeAsync(async () =>
        {
            var page = await service.TreeRecordsAsync(new("node", tree.RootA, MaxDepth, 200));
            return $"{page.Items.Count} nodes; first {page.Items[0].Record.RecordId}";
        }, Samples);
        results["treeFullRead"] = await TimeAsync(() => ReadAllAsync(tree.RootA, MaxDepth, keepLast: true),
            NodeCount == 10_000 ? 5 : 3, warmups: 1);
        results["treeFullRead"] = results["treeFullRead"] with
        {
            Answer = results["treeFullRead"].Answer + $" (expected {under})",
        };
        results["treeLastPage"] = lastPages.Count == 0 ? new Measure(0, 0, 0, results["treeFullRead"].Answer)
            : Summarise(lastPages.Skip(1).ToList() is { Count: > 0 } kept ? kept : lastPages, "the last page of each whole read");
        results["treeWideSiblingsFullRead"] = await TimeAsync(() => ReadAllAsync(tree.Wide, 1, keepLast: false),
            NodeCount == 10_000 ? 5 : 3, warmups: 1);

        var descendant = new NendoRecordFilter("parent", "descendantOf", JsonSerializer.SerializeToElement(tree.RootA));
        results["descendantOfPageRoot"] = await TimeAsync(async () =>
        {
            var page = await service.QueryRecordsAsync(new("node", 100) { Filters = [descendant] });
            return $"{page.Items.Count} records; first {page.Items[0].RecordId}";
        }, SlowSamples);
        results["descendantOfCountRoot"] = await TimeAsync(async () =>
            $"{(await service.CountRecordsAsync(new("node") { Filters = [descendant] })).Count} under the root (expected {under})", SlowSamples);

        // Move one of the wide node's children back and forth among its siblings.
        var wide = tree.Children[tree.Wide];
        var moving = wide[10];
        var version = (await service.QueryRecordsAsync(new("node", 1) { RecordId = moving })).Items.Single().RecordVersion;
        var round = 0;
        results["moveAmongWideSiblings"] = await TimeAsync(async () =>
        {
            var before = round % 2 == 0 ? wide[wide.Count / 2] : wide[11];
            var moved = await service.MoveRecordAsync(new("node", moving, version, tree.Wide, 1, before,
                new("hierarchy-cost", $"move-wide-{round++}", "experiment")));
            version = moved.RecordVersion ?? version;
            return $"{wide.Count} siblings; wrote {moved.TouchedRecordIds.Count} record(s)";
        }, SlowSamples);
        return results;
    }

    private static Measure Time(SqliteConnection connection, string sql, params (string Name, object Value)[] parameters) =>
        Time(connection, sql, Samples, parameters);

    private static Measure Time(SqliteConnection connection, string sql, int samples, params (string Name, object Value)[] parameters)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        foreach (var (name, value) in parameters) command.Parameters.AddWithValue(name, value);
        string answer = "";
        var timings = new List<double>();
        for (var i = 0; i < Warmups + samples; i++)
        {
            var watch = Stopwatch.StartNew();
            using var reader = command.ExecuteReader();
            var rows = 0;
            var first = new List<string>();
            while (reader.Read())
            {
                if (rows == 0) for (var c = 0; c < reader.FieldCount; c++) first.Add(reader.IsDBNull(c) ? "null" : reader.GetValue(c).ToString()!);
                rows++;
            }
            watch.Stop();
            if (i >= Warmups) timings.Add(watch.Elapsed.TotalMilliseconds);
            answer = $"{rows} row(s); first: {string.Join(", ", first)}";
        }
        return Summarise(timings, answer);
    }

    private static Measure Summarise(List<double> timings, string answer)
    {
        timings.Sort();
        double At(double q) => timings[Math.Min(timings.Count - 1, (int)Math.Ceiling(q * timings.Count) - 1)];
        return new Measure(Math.Round(At(0.5), 3), Math.Round(At(0.95), 3), Math.Round(timings[^1], 3), answer);
    }

    // ------------------------------------------------------------------------------------------
    // Writes through the coordinator

    private static async Task<Dictionary<string, Measure>> MeasureWritesAsync(string path, Tree tree)
    {
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(path, "review-hierarchy-cost");
        var results = new Dictionary<string, Measure>();

        // A save that moves a leaf between two parents: the baseline the cycle check adds to.
        var leaf = tree.Children[tree.Wide][0];
        var parents = new[] { tree.Middle, tree.Wide };
        var timings = new List<double>();
        long version = 1;
        for (var i = 0; i < Warmups + Samples; i++)
        {
            var parent = parents[i % 2 == 0 ? 0 : 1];
            var watch = Stopwatch.StartNew();
            await coordinator.ApplyAsync(new("hierarchy-cost", $"move-{i}", "experiment", "Move a leaf",
                [new SetFieldOperation($"m-{i}", "node", leaf, "parent", version, parent, 1)]));
            watch.Stop();
            version++;
            if (i >= Warmups) timings.Add(watch.Elapsed.TotalMilliseconds);
        }
        results["saveMoveRecord"] = Summarise(timings, $"{Samples} saves of one parent change");

        // A move with no gap left renumbers every sibling in one revision, each against its version.
        var siblings = tree.Children[tree.Wide].Where(id => id != leaf).ToList();
        var versions = siblings.ToDictionary(id => id, _ => 1L);
        timings = [];
        for (var round = 0; round < (NodeCount == 10_000 ? 5 : 0); round++)
        {
            var operations = siblings.Select((id, index) => (NendoOperation)new SetFieldOperation(
                $"r-{round}-{index}", "node", id, "order", versions[id], (long)((index + 1) * 1024 + round))).ToList();
            var watch = Stopwatch.StartNew();
            await coordinator.ApplyAsync(new("hierarchy-cost", $"renumber-{round}", "experiment", "Renumber siblings", operations));
            watch.Stop();
            foreach (var id in siblings) versions[id]++;
            timings.Add(watch.Elapsed.TotalMilliseconds);
        }
        if (timings.Count > 0) results["renumberWideSiblings"] = Summarise(timings, $"{siblings.Count} siblings per revision, 5 rounds");

        // Declared, with a calculation that counts each record's whole subtree: every read that
        // returns records now walks one subtree per record.
        var service = new NendoApplicationService(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("hierarchy-cost", "declare", "experiment", "Declare",
            [new DeclareHierarchyOperation("declare-node", "node", "parent", "order", revision)]));
        foreach (var (key, value) in await MeasureServiceReadsAsync(service, tree)) results[key] = value;
        await coordinator.ApplyAsync(new("hierarchy-cost", "inside", "experiment", "Count each subtree",
            [new SetBehaviourDefinitionOperation("inside-node", new NendoCalculationDefinition("node.inside", "node", "inside", "Inside",
                NendoBehaviourScalar.Integer, false, "v", [NendoBehaviourBinding.Subtree("v", "node", NendoAggregateFunction.Count)]), revision + 1)]));
        async Task<Measure> TimeAsync(Func<Task<string>> read, int samples)
        {
            var taken = new List<double>();
            var answer = "";
            for (var i = 0; i < Warmups + samples; i++)
            {
                var watch = Stopwatch.StartNew();
                answer = await read();
                watch.Stop();
                if (i >= Warmups) taken.Add(watch.Elapsed.TotalMilliseconds);
            }
            return Summarise(taken, answer);
        }
        string Inside(NendoRecordSnapshot record) => record.Calculations.Single().State == NendoCalculationState.Value
            ? record.Calculations.Single().Value.GetRawText() : record.Calculations.Single().ErrorCode ?? "error";
        results["calculatedPage"] = await TimeAsync(async () =>
        {
            var page = await service.QueryRecordsAsync(new("node", 100));
            return $"{page.Items.Count} records; first inside {Inside(page.Items[0])}";
        }, Samples);
        results["calculatedTreeWindow"] = await TimeAsync(async () =>
        {
            var page = await service.TreeRecordsAsync(new("node", tree.RootA, 2, 100));
            return $"{page.Items.Count} nodes; first inside {Inside(page.Items[0].Record)}";
        }, Samples);
        // A whole-file snapshot counts every record's subtree; at 100,000 records that is a run of its own.
        if (NodeCount == 10_000) results["calculatedSnapshot"] = await TimeAsync(async () =>
        {
            var snapshot = await service.GetSnapshotAsync();
            return $"{snapshot.Records.Count} records; root inside {Inside(snapshot.Records.Single(record => record.RecordId == tree.RootA))}";
        }, 3);

        // ADR-0020 stage 3: the subtree Count out, a path in its place, so the figures are the path's own.
        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("hierarchy-cost", "path", "experiment", "Path instead of count",
        [
            new RemoveBehaviourDefinitionOperation("inside-remove", "node.inside", NendoBehaviourKind.Calculation, revision),
            new SetBehaviourDefinitionOperation("path-node", new NendoCalculationDefinition("node.path", "node", "path", "Path",
                NendoBehaviourScalar.Text, false, "p", [NendoBehaviourBinding.HierarchyPath("p", "node", "N-")]), revision),
        ]));
        results["pathPage"] = await TimeAsync(async () =>
        {
            var page = await service.QueryRecordsAsync(new("node", 100));
            return $"{page.Items.Count} records; first path {Inside(page.Items[0])}";
        }, Samples);
        results["pathDeepestRecord"] = await TimeAsync(async () =>
        {
            var page = await service.QueryRecordsAsync(new("node", 1) { RecordId = tree.SpineLeaf });
            return $"depth {tree.Depth[tree.SpineLeaf]}; path {Inside(page.Items[0])}";
        }, Samples);
        return results;
    }
}
