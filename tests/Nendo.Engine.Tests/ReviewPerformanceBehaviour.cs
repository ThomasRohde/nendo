using System.Diagnostics;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Stage S9 of ADR-0008: what calculations and automatic actions actually cost on a
/// fixture larger than the three records the retired experiment used.
/// <para>
/// It works on a copy of the generated benchmark file, because unlike the baseline
/// measurement it has to install definitions and link records first. The baseline
/// fixture stays byte-identical so its own numbers remain reproducible.
/// </para>
/// </summary>
public static partial class ReviewPerformanceFixture
{
    /// <summary>Related records the aggregate reads, kept under the host's scan ceiling.</summary>
    private const int LinkedRecords = 200;

    private static async Task<string> MeasureBehaviourAsync(string path, int recordCount, int revisionCount)
    {
        var working = Path.ChangeExtension(path, null) + "-behaviour.nendo";
        if (File.Exists(working)) throw new IOException("The behaviour benchmark copy already exists; keep it or choose a new run.");
        File.Copy(path, working);

        var setup = Stopwatch.StartNew();
        await PrepareAsync(working, recordCount, revisionCount);
        var setupMilliseconds = setup.Elapsed.TotalMilliseconds;

        using var process = Process.GetCurrentProcess();

        // Cold: a fresh coordinator, and the first read that evaluates anything.
        var coldOpen = Stopwatch.StartNew();
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(working, "review-behaviour");
        var openMilliseconds = coldOpen.Elapsed.TotalMilliseconds;
        var service = new NendoApplicationService(coordinator);
        TestBehaviourAuthority.Approving(coordinator);

        var cold = Stopwatch.StartNew();
        var first = await service.GetSnapshotAsync();
        var coldMilliseconds = cold.Elapsed.TotalMilliseconds;
        var calculated = first.Records.Single(record => record.RecordId == "record-00000").Calculations;
        if (calculated.Count != 3) throw new InvalidOperationException("The behaviour fixture did not produce its three calculations.");

        var warm = new List<double>();
        var pages = new List<double>();
        for (var index = 0; index < 5; index++)
        {
            var watch = Stopwatch.StartNew();
            await service.GetSnapshotAsync();
            warm.Add(watch.Elapsed.TotalMilliseconds);
            watch.Restart();
            await service.QueryRecordsAsync(new NendoRecordQuery("entity.decision", 50));
            pages.Add(watch.Elapsed.TotalMilliseconds);
        }

        // A save that fires a chain: one edit, one generated write, one revision.
        var saves = new List<double>();
        var allocations = new List<long>();
        var versions = (await service.GetSnapshotAsync()).Records
            .Where(record => record.EntityId == "entity.secondary")
            .ToDictionary(record => record.RecordId, record => record.RecordVersion, StringComparer.Ordinal);
        var linked = versions.Keys.Order(StringComparer.Ordinal).Take(20).ToArray();
        foreach (var recordId in linked)
        {
            var allocated = GC.GetTotalAllocatedBytes(precise: true);
            var watch = Stopwatch.StartNew();
            await service.SetFieldAsync(new("entity.secondary", recordId, "field.secondary.label",
                versions[recordId], $"Measured {recordId}", new("review-performance-behaviour", $"chain-{recordId}", "benchmark")));
            saves.Add(watch.Elapsed.TotalMilliseconds);
            allocations.Add(GC.GetTotalAllocatedBytes(precise: true) - allocated);
        }

        // Joined cancellation: the caller waits for the worker rather than walking
        // away from it. A measurement that only timed the throw would say nothing
        // about whether evaluation was still running afterwards.
        double joinMilliseconds;
        bool observed;
        using (var cancellation = new CancellationTokenSource())
        {
            var work = Task.Run(async () =>
            {
                try { await service.GetSnapshotAsync(cancellation.Token); return false; }
                catch (OperationCanceledException) { return true; }
            });
            await cancellation.CancelAsync();
            var join = Stopwatch.StartNew();
            observed = await work.WaitAsync(TimeSpan.FromSeconds(30));
            joinMilliseconds = join.Elapsed.TotalMilliseconds;
        }

        process.Refresh();
        return JsonSerializer.Serialize(new
        {
            mode = "behaviour-measured",
            recordCount,
            revisionCount,
            linkedRecords = LinkedRecords,
            calculationsPerRecord = 3,
            setupMilliseconds,
            openMilliseconds,
            coldSnapshotMilliseconds = coldMilliseconds,
            warmSnapshotMilliseconds = Summarize(warm),
            boundedPageMilliseconds = Summarize(pages),
            chainedSaveMilliseconds = Summarize(saves),
            chainedSaveAllocatedBytes = allocations,
            cancellationObserved = observed,
            cancellationJoinMilliseconds = joinMilliseconds,
            peakPrivateBytes = process.PrivateMemorySize64,
            peakWorkingBytes = process.WorkingSet64,
            limits = new
            {
                NendoBehaviourLimits.Default.RelatedRows,
                NendoBehaviourLimits.Default.WorkUnits,
                NendoBehaviourLimits.Default.FunctionCalls,
                NendoBehaviourLimits.Default.GeneratedChanges,
            },
            scope = "Engine only, in a dedicated child process: no Desktop window, no WebView and no MCP envelope. " +
                "A snapshot evaluates every record's calculations, so cold and warm snapshot times scale with record count by design. " +
                "Warm cache is uncontrolled; these are not latency guarantees.",
        });
    }

    /// <summary>
    /// Links a bounded number of records, installs the three calculations and one
    /// trigger, and leaves the copy ready to measure.
    /// </summary>
    private static async Task PrepareAsync(string path, int recordCount, int revisionCount)
    {
        await using var coordinator = await NendoWriteCoordinator.OpenAsync(path, "review-behaviour-builder");
        var service = new NendoApplicationService(coordinator);
        var snapshot = await service.GetSnapshotAsync();
        if (snapshot.Records.Count != recordCount || (await service.GetHistoryAsync()).Count != revisionCount)
            throw new InvalidOperationException("Prepare only an unmodified generated fixture.");

        var revision = snapshot.Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("review-performance-behaviour", "link-field", "benchmark", "Link secondary records", [
            new AddFieldOperation("secondary-decision", "entity.secondary", "field.secondary.decision", "Decision",
                "decision_id", NendoStorageKind.Reference, false),
            // What the action writes. It is on the record that raises the event, so
            // every measured save generates a real change rather than a suppressed
            // no-op — which is the thing being timed.
            new AddFieldOperation("secondary-stamp", "entity.secondary", "field.secondary.stamp", "Stamp",
                "stamp", NendoStorageKind.Text, false),
        ]));
        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("review-performance-behaviour", "link-bind", "benchmark", "Bind the link", [
            new ConfigureReferenceOperation("secondary-bind", "entity.secondary", "field.secondary.decision",
                "entity.decision", "field.decision.title", revision),
        ]));

        var secondaries = (await service.GetSnapshotAsync()).Records
            .Where(record => record.EntityId == "entity.secondary")
            .OrderBy(record => record.RecordId, StringComparer.Ordinal)
            .Take(LinkedRecords)
            .ToArray();
        var target = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "record-00000");
        await coordinator.ApplyAsync(new("review-performance-behaviour", "link-records", "benchmark", "Point them at one decision",
            secondaries.Select((record, ordinal) => (NendoOperation)new SetFieldOperation(
                $"link-{ordinal:D5}", "entity.secondary", record.RecordId, "field.secondary.decision",
                record.RecordVersion, JsonSerializer.SerializeToElement("record-00000"), target.RecordVersion)).ToArray()));

        revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("review-performance-behaviour", "behaviour", "benchmark", "Three calculations and one action", [
            new SetBehaviourDefinitionOperation("c-length", new NendoCalculationDefinition(
                "decision.titleLength", "entity.decision", "titleLength", "Title length",
                NendoBehaviourScalar.Integer, false, "TextLength(title)",
                [NendoBehaviourBinding.SameRecordField("title", "entity.decision", "field.decision.title", NendoBehaviourScalar.Text, false)]), revision),
            new SetBehaviourDefinitionOperation("c-linked", new NendoCalculationDefinition(
                "decision.linked", "entity.decision", "linked", "Linked records",
                NendoBehaviourScalar.Integer, false, "count",
                [NendoBehaviourBinding.RelatedCount("count", "entity.decision", "entity.secondary", "field.secondary.decision")]), revision),
            new SetBehaviourDefinitionOperation("c-busy", new NendoCalculationDefinition(
                "decision.busy", "entity.decision", "busy", "Busy",
                NendoBehaviourScalar.Boolean, false, "linked > 100",
                [NendoBehaviourBinding.SameRecordCalculation("linked", "entity.decision", "decision.linked", NendoBehaviourScalar.Integer, false)]), revision),
            // An assignment's bindings resolve against the record the step writes to,
            // so this one reads and writes the event record itself.
            new SetBehaviourDefinitionOperation("a-stamp", new NendoActionDefinition(
                "secondary.stamp", "Stamp the label",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("field.secondary.stamp", "Concat('Seen ', label)",
                        [NendoBehaviourBinding.SameRecordField("label", "entity.secondary", "field.secondary.label", NendoBehaviourScalar.Text, false)],
                        []))]), revision),
            new SetBehaviourDefinitionOperation("t-stamp", new NendoTriggerDefinition(
                "10-stamp", "entity.secondary", "Stamp the label",
                NendoTriggerEvents.Updated, "secondary.stamp", ["field.secondary.label"]), revision),
        ]));
    }
}
