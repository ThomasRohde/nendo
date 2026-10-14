using System.Diagnostics;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class RecordWindowScaleTests
{
    public TestContext TestContext { get; set; } = null!;

    [TestMethod]
    [DataRow(100)]
    [DataRow(10_000)]
    [DataRow(100_000)]
    [Timeout(600_000, CooperativeCancellation = true)]
    public async Task BoundedWindowsAtScale(int count)
    {
        if (count > 100 && Environment.GetEnvironmentVariable("NENDO_RUN_LAZY_SCALE") != "1")
            Assert.Inconclusive("Set NENDO_RUN_LAZY_SCALE=1 for the explicit 10,000/100,000-record measurements.");
        var cancel = TestContext.CancellationToken;
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("scale", "schema", "test", "Window fixture", [
            new CreateEntityOperation("entity", "items", "Items", "items"),
            new AddFieldOperation("field", "items", "title", "Title", "title", NendoStorageKind.Text, true)]), cancel);
        // Retention policy only, on this disposable fixture. Inspection and write ceilings stay intact.
        coordinator.HistoryFoldPolicy = new(2, 20_000, 1);
        for (var start = 0; start < count; start += 10_000)
        {
            if (start == 80_000)
            {
                var backup = await coordinator.PrepareBackupAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-fold.nendo"), "scale-backup", cancel);
                await coordinator.CreateBackupAsync(backup.PlanId, cancel);
                await service.FoldHistoryAsync(backup.PlanId, cancel);
            }
            await coordinator.ApplyAsync(new("scale", $"seed-{start}", "test", "Seed window fixture",
                Enumerable.Range(start, Math.Min(10_000, count - start)).Select(i => (NendoOperation)new CreateRecordOperation($"create-{i}", "items", $"r-{i:D6}",
                    new Dictionary<string, object?> { ["title"] = $"Title {count - i:D6}" })).ToArray()), cancel);
        }
        var before = coordinator.ReadDiagnostics;
        var query = new NendoRecordQuery("items", 100);
        var lastStart = Math.Max(0, count - 100);
        var watch = Stopwatch.StartNew();
        var direct = await service.QueryRecordWindowAsync(new(query, lastStart), cancel);
        var directMs = watch.Elapsed.TotalMilliseconds;
        Assert.HasCount(100, direct.Items);
        Assert.AreEqual($"r-{lastStart:D6}", direct.Items[0].RecordId);
        Assert.IsFalse(direct.HasMore);
        var cursorReads = 0;
        watch.Restart();
        NendoPage<NendoRecordSnapshot> page;
        do { page = await service.QueryRecordsAsync(query, cancel); cursorReads++; query = query with { Cursor = page.NextCursor }; }
        while (page.NextCursor is not null);
        var cursorMs = watch.Elapsed.TotalMilliseconds;
        CollectionAssert.AreEqual(direct.Items.Select(row => row.RecordId).ToArray(), page.Items.Select(row => row.RecordId).ToArray());
        var times = new List<double>();
        for (var sample = 0; sample < 12; sample++)
        {
            watch.Restart();
            var block = await service.QueryRecordWindowAsync(new(new("items") { SortFieldId = "title" }, lastStart), cancel);
            times.Add(watch.Elapsed.TotalMilliseconds);
            Assert.HasCount(100, block.Items);
        }
        await service.SetFieldAsync(new("items", $"r-{lastStart:D6}", "title", 1, "Moved", Context("scale-edit")), cancel);
        watch.Restart();
        var located = await service.QueryRecordWindowAsync(new(new("items") { SortFieldId = "title" }, LocateRecordId: $"r-{lastStart:D6}"), cancel);
        var locateMs = watch.Elapsed.TotalMilliseconds;
        Assert.AreEqual(0, located.LocatedIndex);
        Assert.AreEqual(before.FullRecordReads, coordinator.ReadDiagnostics.FullRecordReads, "A window read took a full-record snapshot.");
        times.Sort();
        TestContext.WriteLine($"rows={count}; direct={directMs:F2}ms/1 request; cursor={cursorMs:F2}ms/{cursorReads} requests; sorted-block p95={times[(int)Math.Ceiling(times.Count * .95) - 1]:F2}ms; locate-after-edit={locateMs:F2}ms; full-record-read delta=0");
    }
}
