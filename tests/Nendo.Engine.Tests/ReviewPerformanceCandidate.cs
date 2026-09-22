using System.Diagnostics;
using System.Text.Json;

namespace Nendo.Engine.Tests;

public static partial class ReviewPerformanceFixture
{
    private static async Task<string> MeasureCandidateAsync(string path, int recordCount, int revisionCount)
    {
        using var process = Process.GetCurrentProcess();
        var openings = new List<double>();
        long peakPrivate = 0, peakWorking = 0;
        void SampleMemory()
        {
            process.Refresh();
            peakPrivate = Math.Max(peakPrivate, process.PrivateMemorySize64);
            peakWorking = Math.Max(peakWorking, process.WorkingSet64);
        }
        for (var index = 0; index < 3; index++)
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var watch = Stopwatch.StartNew();
            await using var probe = await NendoWriteCoordinator.OpenAsync(path, "review-candidate-open", timeout.Token);
            openings.Add(watch.Elapsed.TotalMilliseconds);
            SampleMemory();
        }
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(path, "review-candidate-measure");
        var service = new NendoApplicationService(coordinator);
        var version = await VerifyCandidateFixtureAsync(service, recordCount, revisionCount);
        SampleMemory();
        var privateBefore = process.PrivateMemorySize64;
        var managedBefore = GC.GetTotalMemory(forceFullCollection: false);
        var countersBefore = coordinator.ReadDiagnostics;
        var times = new Dictionary<string, List<double>>
        {
            ["edit"] = [], ["definitionAndStatus"] = [], ["compileDefinition"] = [],
            ["records50"] = [], ["records200"] = [], ["history50"] = [], ["history200"] = [],
            ["recordsContinuation50"] = [], ["historyContinuation50"] = [],
        };
        var bytes = times.Keys.Where(key => key != "edit").ToDictionary(key => key, _ => new List<int>());
        var editAllocations = new List<long>();
        var sampleAllocations = new List<long>();
        var individual = new List<object>();
        for (var index = -3; index < 40; index++)
        {
            var sample = new Dictionary<string, double>();
            var sampleBytes = new Dictionary<string, int>();
            var allocatedBefore = GC.GetTotalAllocatedBytes(precise: true);
            async Task<T> Timed<T>(string key, Func<CancellationToken, Task<T>> action)
            {
                using var watchdog = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                var watch = Stopwatch.StartNew();
                var value = await action(watchdog.Token);
                sample[key] = watch.Elapsed.TotalMilliseconds;
                if (key != "edit") sampleBytes[key] = JsonSerializer.SerializeToUtf8Bytes(value).Length;
                return value;
            }
            var receipt = await Timed("edit", token => service.SetFieldAsync(new("entity.decision", "record-00000",
                "field.decision.owner", version++, $"Measured owner {index}",
                new("review-performance-candidate", $"edit-{index}", "benchmark")), token));
            var editAllocated = GC.GetTotalAllocatedBytes(precise: true) - allocatedBefore;
            var metadata = await Timed("definitionAndStatus", service.GetDefinitionSnapshotAsync);
            var compiled = await Timed("compileDefinition", service.CompileSemanticDefinitionAsync);
            var records50 = await Timed("records50", token => service.QueryRecordsAsync(new("entity.decision", 50), token));
            var records200 = await Timed("records200", token => service.QueryRecordsAsync(new("entity.decision", 200), token));
            var history50 = await Timed("history50", token => service.QueryHistoryAsync(new(50), token));
            var history200 = await Timed("history200", token => service.QueryHistoryAsync(new(200), token));
            var recordsNext = await Timed("recordsContinuation50", token => service.QueryRecordsAsync(new("entity.decision", 50, records50.NextCursor), token));
            var historyNext = await Timed("historyContinuation50", token => service.QueryHistoryAsync(new(50, history50.NextCursor), token));
            if (records50.Items.Count != 50 || records200.Items.Count != 200 || history50.Items.Count != 50 || history200.Items.Count != 200 ||
                recordsNext.Items.Count != 50 || historyNext.Items.Count != 50 ||
                metadata.Records.Count != 0 || compiled.Applications.Sum(app => app.Records.Count) != 0 || !compiled.IsValid ||
                records50.Items[0].RecordVersion != version ||
                records50.Items[0].Values["field.decision.owner"].GetString() != $"Measured owner {index}" ||
                records50.ChangeSequence != receipt.ChangeSequence || history50.ChangeSequence != receipt.ChangeSequence ||
                compiled.SourceChangeSequence != receipt.ChangeSequence ||
                records50.Items.Select(row => row.RecordId).Intersect(recordsNext.Items.Select(row => row.RecordId)).Any() ||
                history50.Items.Select(row => row.RevisionId).Intersect(historyNext.Items.Select(row => row.RevisionId)).Any())
                throw new InvalidOperationException($"Candidate page consistency failed at sample {index}: expected version {version}, actual {records50.Items[0].RecordVersion}, receipt sequence {receipt.ChangeSequence}, record sequence {records50.ChangeSequence}.");
            SampleMemory();
            if (index < 0) continue;
            foreach (var pair in sample) times[pair.Key].Add(pair.Value);
            foreach (var pair in sampleBytes) bytes[pair.Key].Add(pair.Value);
            editAllocations.Add(editAllocated);
            sampleAllocations.Add(GC.GetTotalAllocatedBytes(precise: true) - allocatedBefore);
            individual.Add(new { index, sequence = receipt.ChangeSequence, milliseconds = sample, bytes = sampleBytes,
                privateBytes = process.PrivateMemorySize64, workingBytes = process.WorkingSet64 });
            if (index % 10 == 9) Console.Error.WriteLine($"Candidate measured {index + 1}/40 edits for {recordCount} records/{revisionCount} starting revisions.");
        }
        var countersAfter = coordinator.ReadDiagnostics;
        if (countersBefore != countersAfter || service.DefinitionCompilationCount != 1)
            throw new InvalidOperationException("An ordinary candidate query/edit repeated a full scan or unchanged-definition compilation.");
        var thresholds = new
        {
            editP50 = Percentile(times["edit"], .50) <= 100,
            editP95 = Percentile(times["edit"], .95) <= 250,
            openMaximum = openings.Max() <= 2000,
            allPageP95 = times.Where(pair => pair.Key.StartsWith("records", StringComparison.Ordinal) || pair.Key.StartsWith("history", StringComparison.Ordinal))
                .All(pair => Percentile(pair.Value, .95) <= 150),
            statusP95 = Percentile(times["definitionAndStatus"], .95) <= 50,
            peakPrivate = peakPrivate <= 512L * 1024 * 1024,
        };
        return JsonSerializer.Serialize(new
        {
            mode = "candidate-engine-measured", recordCount, revisionCount, finalRevisionCount = revisionCount + 43,
            runtime = Environment.Version.ToString(), provider = typeof(Microsoft.Data.Sqlite.SqliteConnection).Assembly.GetName().Version?.ToString(),
            cache = "Uncontrolled warm OS cache; three fresh coordinator opens in one dedicated PowerShell child",
            memoryScope = "PowerShell child and Engine driver, including setup verification and open samples; excludes Desktop/WebView",
            openMilliseconds = Summarize(openings), milliseconds = times.ToDictionary(pair => pair.Key, pair => Summarize(pair.Value)),
            bytes, editAllocatedBytes = editAllocations, sampleAllocatedBytes = sampleAllocations, individual,
            peakPrivateBytes = peakPrivate, peakWorkingBytes = peakWorking, privateBefore, privateAfter = process.PrivateMemorySize64,
            managedBefore, managedAfter = GC.GetTotalMemory(forceFullCollection: false),
            countersBefore, countersAfter, definitionCompilationCount = service.DefinitionCompilationCount, thresholds,
            bytesScope = "Typed Engine JSON only; actual Desktop bridge volumes are separately qualified",
        });
    }

    private static async Task<long> VerifyCandidateFixtureAsync(NendoApplicationService service, int records, int revisions)
    {
        var snapshot = await service.GetSnapshotAsync();
        if (snapshot.Records.Count != records || (await service.GetHistoryAsync()).Count != revisions)
            throw new InvalidOperationException("Measure only a fresh, unmodified generated fixture.");
        return snapshot.Records.Single(row => row.RecordId == "record-00000").RecordVersion;
    }

    private static double Percentile(List<double> samples, double percentile)
    {
        var ordered = samples.Order().ToArray();
        return ordered[(int)Math.Ceiling(ordered.Length * percentile) - 1];
    }
}
