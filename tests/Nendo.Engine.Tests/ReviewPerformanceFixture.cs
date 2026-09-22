using System.Diagnostics;
using System.Text.Json;

namespace Nendo.Engine.Tests;

// Explicit opt-in benchmark driver, invoked by tools/Review-Performance.ps1.
// Uses the existing test assembly and canonical coordinator operations; no SQL
// seed shortcuts, extra test project, production backdoor or automatic CI timing.
public static partial class ReviewPerformanceFixture
{
    public static async Task<string> RunAsync(string filePath, int recordCount, int revisionCount, string mode)
    {
        if (recordCount is not (1000 or 10000) || revisionCount is not (1000 or 10000))
            throw new ArgumentException("Use a predeclared matrix cell.");
        var repo = ReviewOutcomeChildDriver.RepositoryRoot();
        var artifactRoot = Path.GetFullPath(Path.Combine(repo, "artifacts")) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(filePath);
        if (!path.StartsWith(artifactRoot, StringComparison.OrdinalIgnoreCase) || Path.GetExtension(path) != ".nendo")
            throw new ArgumentException("Benchmark files must be owned .nendo artifacts.");
        return mode switch
        {
            "Generate" => await GenerateAsync(path, recordCount, revisionCount, repo),
            "Measure" => await MeasureAsync(path, recordCount, revisionCount),
            "MeasureCandidate" => await MeasureCandidateAsync(path, recordCount, revisionCount),
            "MeasureBehaviour" => await MeasureBehaviourAsync(path, recordCount, revisionCount),
            _ => throw new ArgumentException("Unknown benchmark mode."),
        };
    }

    private static async Task<string> GenerateAsync(string path, int recordCount, int revisionCount, string repo)
    {
        if (File.Exists(path)) throw new IOException("Benchmark fixture destination already exists.");
        var timer = Stopwatch.StartNew();
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "review-performance-builder");
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log", repo);
        var baseDefinition = fixture.DefinitionChangeSet("benchmark-definition").Mutations[0];
        var definition = baseDefinition with { Operations = [.. baseDefinition.Operations,
            new CreateEntityOperation("secondary-entity", "entity.secondary", "Secondary", "secondary"),
            new AddFieldOperation("secondary-label", "entity.secondary", "field.secondary.label", "Label", "label", NendoStorageKind.Text, true, "singleLine", [])] };
        var mainCount = recordCount * 9 / 10;
        var creates = new List<NendoOperation>(recordCount);
        for (var i = 0; i < recordCount; i++)
        {
            var primary = i < mainCount;
            creates.Add(new CreateRecordOperation($"create-{i}", primary ? "entity.decision" : "entity.secondary", $"record-{i:D5}",
                primary ? new Dictionary<string, object?>
                {
                    ["field.decision.title"] = $"Decision {i:D5} with a stable descriptive label",
                    ["field.decision.context"] = new string('c', 160),
                    ["field.decision.state"] = "Proposed", ["field.decision.owner"] = "Initial owner",
                    ["field.decision.reviewDate"] = "2026-09-05",
                } : new Dictionary<string, object?> { ["field.secondary.label"] = $"Unrelated record {i:D5}" }));
        }
        var mutations = new List<NendoMutation>(revisionCount - 1)
        {
            definition,
            new("review-performance", "initial-data", "benchmark", "Initial records for independent scale matrix", creates),
        };
        for (var i = 0; i < revisionCount - 3; i++)
            mutations.Add(new("review-performance", $"history-{i:D5}", "benchmark", "Retained versioned edit",
                [new SetFieldOperation($"history-operation-{i:D5}", "entity.decision", "record-00000", "field.decision.owner", i + 1L, $"Prior owner {i:D5}")]));
        // Setup deliberately batches canonical revisions in one real transaction.
        // This is not a claim about client/import batch limits or setup latency.
        await coordinator.ApplyChangeSetAsync(new(mutations), $"proposal-{Guid.NewGuid():N}");
        var snapshot = await service.GetSnapshotAsync();
        var history = await service.GetHistoryAsync();
        if (snapshot.Records.Count != recordCount || history.Count != revisionCount || snapshot.Entities.Count != 2 ||
            !(await service.CompileSemanticUiAsync()).IsValid)
            throw new InvalidOperationException("Benchmark fixture counts/definition did not match.");
        return JsonSerializer.Serialize(new { mode = "generated", recordCount, revisionCount, mainCount,
            secondaryCount = recordCount - mainCount, contextTextLength = 160, setupMilliseconds = timer.Elapsed.TotalMilliseconds,
            setup = "One canonical change-set transaction with real split revisions, operations, inverse evidence and idempotency receipts",
            fileBytes = new FileInfo(path).Length, manifest = snapshot.Manifest });
    }

    private static async Task<string> MeasureAsync(string path, int recordCount, int revisionCount)
    {
        using var process = Process.GetCurrentProcess();
        var openSamples = new List<double>();
        for (var i = 0; i < 3; i++)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var watch = Stopwatch.StartNew();
            await using var probe = await NendoWriteCoordinator.OpenAsync(path, "review-open", timeout.Token);
            openSamples.Add(watch.Elapsed.TotalMilliseconds);
        }
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(path, "review-measure");
        var service = new NendoApplicationService(coordinator);
        var initial = await service.GetSnapshotAsync();
        var initialHistory = await service.GetHistoryAsync();
        if (initial.Records.Count != recordCount || initialHistory.Count != revisionCount)
            throw new InvalidOperationException("Measure only an unmodified generated fixture.");
        var version = initial.Records.Single(r => r.RecordId == "record-00000").RecordVersion;
        var edits = new List<double>();
        var allocations = new List<long>();
        var snapshots = new List<double>();
        var compilations = new List<double>();
        var histories = new List<double>();
        var snapshotBytes = new List<int>();
        var planBytes = new List<int>();
        var historyBytes = new List<int>();
        long peakPrivate = 0;
        long peakWorking = 0;
        for (var i = -3; i < 40; i++)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var allocated = GC.GetTotalAllocatedBytes(precise: true);
            var watch = Stopwatch.StartNew();
            await service.SetFieldAsync(new("entity.decision", "record-00000", "field.decision.owner", version++,
                $"Measured owner {i}", new("review-performance-measure", $"edit-{i}", "benchmark")), timeout.Token);
            var elapsed = watch.Elapsed.TotalMilliseconds;
            var allocatedBytes = GC.GetTotalAllocatedBytes(precise: true) - allocated;
            if (i < 0) continue;
            edits.Add(elapsed); allocations.Add(allocatedBytes);
            watch.Restart();
            var snapshot = await service.GetSnapshotAsync(timeout.Token);
            snapshots.Add(watch.Elapsed.TotalMilliseconds);
            snapshotBytes.Add(JsonSerializer.SerializeToUtf8Bytes(snapshot).Length);
            watch.Restart();
            var compilation = await service.CompileSemanticUiAsync(timeout.Token);
            compilations.Add(watch.Elapsed.TotalMilliseconds);
            planBytes.Add(JsonSerializer.SerializeToUtf8Bytes(compilation).Length);
            watch.Restart();
            var history = await service.GetHistoryAsync(timeout.Token);
            histories.Add(watch.Elapsed.TotalMilliseconds);
            historyBytes.Add(JsonSerializer.SerializeToUtf8Bytes(history).Length);
            process.Refresh();
            peakPrivate = Math.Max(peakPrivate, process.PrivateMemorySize64);
            peakWorking = Math.Max(peakWorking, process.WorkingSet64);
            if (i % 10 == 9) Console.Error.WriteLine($"Measured {i + 1}/40 edits for {recordCount} records/{revisionCount} starting revisions.");
        }
        return JsonSerializer.Serialize(new { mode = "baseline-engine-measured", recordCount, revisionCount,
            finalRevisionCount = revisionCount + 43, cache = "Uncontrolled warm OS cache; three fresh coordinator opens in the same process",
            runtime = Environment.Version.ToString(), provider = typeof(Microsoft.Data.Sqlite.SqliteConnection).Assembly.GetName().Version?.ToString(),
            process = "Dedicated PowerShell child hosting existing Engine test-assembly benchmark driver; not Desktop/WebView memory",
            openMilliseconds = Summarize(openSamples), editMilliseconds = Summarize(edits),
            editAllocatedBytes = allocations, snapshotMilliseconds = Summarize(snapshots),
            compilationMilliseconds = Summarize(compilations), historyMilliseconds = Summarize(histories),
            snapshotBytes, compilationBytes = planBytes, historyBytes, peakPrivateBytes = peakPrivate, peakWorkingBytes = peakWorking,
            bytesScope = "Baseline Engine JSON payloads only, excluding actual Desktop/MCP envelopes; not bounded-query or bridge qualification" });
    }

    private static object Summarize(List<double> samples)
    {
        var ordered = samples.Order().ToArray();
        return new { samples, p50 = ordered[(int)Math.Ceiling(ordered.Length * .50) - 1],
            p95 = ordered[(int)Math.Ceiling(ordered.Length * .95) - 1], min = ordered[0], max = ordered[^1] };
    }
}
