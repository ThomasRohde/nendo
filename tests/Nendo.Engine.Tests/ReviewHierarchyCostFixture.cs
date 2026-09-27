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
    private const int NodeCount = 10_000, LinkCount = 5_000, MaxDepth = 32, WideChildren = 1_000;
    private const int Warmups = 3, Samples = 30;

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
    };

    public static async Task<string> RunAsync(string filePath)
    {
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
        string Next() => $"node-{serial++:D5}";

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
        foreach (var id in tree.Order)
        {
            var parent = tree.Parent[id];
            var position = parent is null ? 0 : tree.Children[parent].IndexOf(id);
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
        await coordinator.ApplyChangeSetAsync(new([
            new("hierarchy-cost", "nodes", "experiment", "The tree", creates),
            new("hierarchy-cost", "links", "experiment", "Links into the tree", links),
        ]), $"proposal-{Guid.NewGuid():N}");
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
        for (var round = 0; round < 5; round++)
        {
            var operations = siblings.Select((id, index) => (NendoOperation)new SetFieldOperation(
                $"r-{round}-{index}", "node", id, "order", versions[id], (long)((index + 1) * 1024 + round))).ToList();
            var watch = Stopwatch.StartNew();
            await coordinator.ApplyAsync(new("hierarchy-cost", $"renumber-{round}", "experiment", "Renumber siblings", operations));
            watch.Stop();
            foreach (var id in siblings) versions[id]++;
            timings.Add(watch.Elapsed.TotalMilliseconds);
        }
        results["renumberWideSiblings"] = Summarise(timings, $"{siblings.Count} siblings per revision, 5 rounds");
        return results;
    }
}
