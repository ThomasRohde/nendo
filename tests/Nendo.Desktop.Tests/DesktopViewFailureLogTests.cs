namespace Nendo.Desktop.Tests;

/// <summary>
/// What is kept when the app view stops responding. Nendo keeps no log; this is the one
/// exception, and it earns it by being capped, device-local, switchable from the tray and
/// carrying nothing that identifies a file or its contents.
/// </summary>
[TestClass]
public sealed class DesktopViewFailureLogTests
{
    private static DesktopViewFailure Failure(string kind = "RenderProcessUnresponsive", int upSeconds = 110) =>
        new(DateTimeOffset.UtcNow, kind, upSeconds, true, 12_288, 61);

    [TestMethod]
    public async Task AFailureIsKeptWithTheKindTheHostWasGiven()
    {
        await using var workspace = new DesktopTestWorkspace();
        var log = new DesktopViewFailureLog(workspace.FileHistoryRoot);
        // Nothing exists until something fails: a device that has never seen one carries
        // no file at all.
        Assert.IsEmpty(log.Read());
        Assert.IsFalse(File.Exists(log.LogPath));

        Assert.IsTrue(log.Record(Failure()));

        var kept = new DesktopViewFailureLog(workspace.FileHistoryRoot).Read();
        Assert.HasCount(1, kept);
        Assert.AreEqual("RenderProcessUnresponsive", kept[0].Kind);
        Assert.AreEqual(110, kept[0].ViewUpSeconds);
        Assert.IsTrue(kept[0].OutOfSight);
        Assert.AreEqual(12_288, kept[0].AvailableMemoryMb);
        Assert.AreEqual(61, kept[0].MemoryLoadPercent);
    }

    /// <summary>
    /// The cap is what makes this safe to leave on. A log that grows until somebody
    /// notices it is a second defect waiting behind the first.
    /// </summary>
    [TestMethod]
    public async Task OnlyTheNewestEntriesAreKept()
    {
        await using var workspace = new DesktopTestWorkspace();
        var log = new DesktopViewFailureLog(workspace.FileHistoryRoot);
        for (var index = 0; index < DesktopViewFailureLog.MaximumEntries + 20; index += 1)
            Assert.IsTrue(log.Record(Failure(upSeconds: index)));

        var kept = log.Read();
        Assert.HasCount(DesktopViewFailureLog.MaximumEntries, kept);
        // The oldest fell off the front, and the newest is the one that just happened.
        Assert.AreEqual(20, kept[0].ViewUpSeconds);
        Assert.AreEqual(DesktopViewFailureLog.MaximumEntries + 19, kept[^1].ViewUpSeconds);
        var size = new FileInfo(log.LogPath).Length;
        Assert.IsLessThan(64 * 1024, size, $"The record grew to {size} bytes.");
    }

    /// <summary>A line nothing can read is skipped, not fatal: the rest is still evidence.</summary>
    [TestMethod]
    public async Task AnUnreadableLineDoesNotCostTheOthers()
    {
        await using var workspace = new DesktopTestWorkspace();
        var log = new DesktopViewFailureLog(workspace.FileHistoryRoot);
        log.Record(Failure(kind: "BrowserProcessExited"));
        await File.AppendAllTextAsync(log.LogPath, "{ this is not json\n");
        log.Record(Failure(kind: "RenderProcessUnresponsive"));

        var kept = log.Read();
        Assert.HasCount(2, kept);
        Assert.AreEqual("BrowserProcessExited", kept[0].Kind);
        Assert.AreEqual("RenderProcessUnresponsive", kept[1].Kind);
    }

    /// <summary>
    /// It records unless it is switched off, and the choice survives a restart — the tray
    /// item is the whole of the control, so this is the whole of what it has to do.
    /// </summary>
    [TestMethod]
    public async Task RecordingIsOnUntilItIsSwitchedOffAndThatChoiceSurvives()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        Assert.IsTrue(store.RecordViewFailures);
        Assert.IsTrue(store.View().RecordViewFailures);

        store.SetRecordViewFailures(false);
        Assert.IsFalse(new DesktopShellStore(workspace.FileHistoryRoot).RecordViewFailures);

        store.SetRecordViewFailures(true);
        Assert.IsTrue(new DesktopShellStore(workspace.FileHistoryRoot).RecordViewFailures);
    }

    /// <summary>
    /// A device that chose its close behaviour before this existed never chose about
    /// recording, so it gets the default rather than an off it never asked for.
    /// </summary>
    [TestMethod]
    public async Task AnOlderDeviceDocumentRecordsByDefault()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(
            Path.Combine(workspace.FileHistoryRoot, "shell.json"),
            """{"Version":1,"CloseAction":"exit","TrayIntroShown":true}""");

        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        Assert.AreEqual("exit", store.CloseAction);
        Assert.IsTrue(store.TrayIntroShown);
        Assert.IsTrue(store.RecordViewFailures);
    }

    /// <summary>
    /// What Windows says about memory at the moment of the failure, which is the reading
    /// two of these failures turned on and nothing kept.
    /// </summary>
    [TestMethod]
    public void TheMachinesMemoryIsReadableAtTheMomentItMatters()
    {
        var (availableMb, loadPercent) = DesktopViewFailureLog.MemoryNow();
        Assert.IsNotNull(availableMb);
        Assert.IsNotNull(loadPercent);
        Assert.IsGreaterThan(0, availableMb.Value);
        Assert.IsInRange(0, 100, loadPercent.Value);
    }
}
