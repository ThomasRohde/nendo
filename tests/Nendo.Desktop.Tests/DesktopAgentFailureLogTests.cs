using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-085: an agent request that failed inside Nendo is kept like a view failure — capped,
/// device-local, under the one tray switch — so the reference an agent was told can be
/// found (ADR-0002, 2026-09-27 amendment).
/// </summary>
[TestClass]
public sealed class DesktopAgentFailureLogTests
{
    private static NendoAgentFailure Failure(int index) => new(
        DateTimeOffset.UtcNow,
        $"{index:x8}",
        "tool",
        "nendo.change_set.accept",
        "System.IO.IOException",
        "at Nendo.LocalMcp.NendoAgentAuthoringService.AcceptAsync()");

    [TestMethod]
    public async Task OnlyTheNewestFailuresAreKeptAndEachReadsBack()
    {
        await using var workspace = new DesktopTestWorkspace();
        var log = new DesktopAgentFailureLog(workspace.FileHistoryRoot);
        Assert.IsEmpty(log.Read());
        Assert.IsFalse(File.Exists(log.LogPath), "A device that has seen no failure carries no file.");
        for (var index = 0; index < DesktopAgentFailureLog.MaximumEntries + 20; index += 1)
            Assert.IsTrue(log.Record(Failure(index)));

        var kept = new DesktopAgentFailureLog(workspace.FileHistoryRoot).Read();
        Assert.HasCount(DesktopAgentFailureLog.MaximumEntries, kept);
        Assert.AreEqual($"{20:x8}", kept[0].Reference);
        Assert.AreEqual($"{DesktopAgentFailureLog.MaximumEntries + 19:x8}", kept[^1].Reference);
        Assert.AreEqual(("tool", "nendo.change_set.accept", "System.IO.IOException"),
            (kept[^1].Source, kept[^1].Request, kept[^1].ExceptionType));
    }

    /// <summary>
    /// The suite's default device folder is its own. A controller built without one used to
    /// read and write the person's real %LOCALAPPDATA%\Nendo, which is how a test run left
    /// fifty lines in their agent-failures.jsonl (see DesktopTestDeviceState).
    /// </summary>
    [TestMethod]
    public async Task TheSuiteNeverDefaultsToThePersonsDeviceFolder()
    {
        var persons = Path.GetFullPath(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Nendo"));
        var suites = Path.GetFullPath(DesktopAppearanceStore.DefaultRoot);
        Assert.AreNotEqual(persons, suites, "The suite writes device state into the person's own folder.");
        StringAssert.StartsWith(suites, Path.GetFullPath(Path.GetTempPath()));

        // Nor its agent hosts' discovery entries, which a running Nendo lists to its agents.
        await using var session = new DesktopSessionController();
        var discovery = Path.GetFullPath(session.CurrentHostOptions().DiscoveryRoot);
        Assert.IsFalse(discovery.StartsWith(persons, StringComparison.OrdinalIgnoreCase),
            $"The suite's agent hosts announce themselves in the person's folder: {discovery}");
    }

    /// <summary>The tray's one switch governs this record too, read at the moment of failure.</summary>
    [TestMethod]
    public async Task TheTraySwitchStopsAgentFailureRecordsAsItStopsViewFailures()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(deviceStateRoot: workspace.FileHistoryRoot);
        var log = new DesktopAgentFailureLog(workspace.FileHistoryRoot);

        session.RecordAgentFailure(Failure(1));
        Assert.HasCount(1, log.Read(), "It records unless it is switched off.");

        new DesktopShellStore(workspace.FileHistoryRoot).SetRecordViewFailures(false);
        session.RecordAgentFailure(Failure(2));
        Assert.HasCount(1, log.Read(), "Switched off in the tray, the next failure is not kept.");
    }
}
