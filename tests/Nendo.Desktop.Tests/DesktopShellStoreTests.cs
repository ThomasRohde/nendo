using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopShellStoreTests
{
    [TestMethod]
    public async Task MissingStateClosesToTheTrayWithoutCreatingState()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        Assert.AreEqual("tray", store.CloseAction);
        Assert.IsFalse(store.TrayIntroShown);
        Assert.IsTrue(store.Persisted);
        Assert.IsNull(store.Notice);
        Assert.IsFalse(Directory.Exists(workspace.FileHistoryRoot));
    }

    [TestMethod]
    [DataRow("tray")]
    [DataRow("exit")]
    public async Task CloseActionSurvivesANewStore(string closeAction)
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        // Away and back, so the tray case is a real write rather than the default it
        // started at. Whether the value ends up on disk is the point of the test.
        store.SetCloseAction(closeAction == "tray" ? "exit" : "tray");
        store.SetCloseAction(closeAction);
        var reopened = new DesktopShellStore(workspace.FileHistoryRoot);
        Assert.AreEqual(closeAction, reopened.CloseAction);
        Assert.IsTrue(reopened.Persisted);
        CollectionAssert.AreEqual(
            new[] { "shell.json" },
            Directory.GetFiles(workspace.FileHistoryRoot).Select(Path.GetFileName).ToArray());
    }

    [TestMethod]
    public async Task ChoosingWhatIsAlreadyChosenWritesNothing()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        store.SetCloseAction("tray");
        Assert.AreEqual("tray", store.CloseAction);
        Assert.IsFalse(
            Directory.Exists(workspace.FileHistoryRoot),
            "Opening and closing a window should not start writing device state nobody changed.");
    }

    [TestMethod]
    public async Task TheNotificationAreaIsExplainedOncePerDevice()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        Assert.IsFalse(store.TrayIntroShown);
        store.MarkTrayIntroShown();
        Assert.IsTrue(store.TrayIntroShown);
        Assert.IsTrue(new DesktopShellStore(workspace.FileHistoryRoot).TrayIntroShown);
    }

    [TestMethod]
    [DataRow("not json")]
    [DataRow("null")]
    [DataRow("{\"Version\":2,\"CloseAction\":\"exit\",\"TrayIntroShown\":true}")]
    [DataRow("{\"Version\":1,\"CloseAction\":\"vanish\",\"TrayIntroShown\":false}")]
    [DataRow("{\"Version\":1,\"CloseAction\":null,\"TrayIntroShown\":false}")]
    public async Task InvalidStateFallsBackToTheDefaultWithoutRepairingItsBytes(string text)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "shell.json");
        await File.WriteAllTextAsync(path, text);
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        Assert.AreEqual("tray", store.CloseAction);
        Assert.IsFalse(store.TrayIntroShown);
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
        Assert.AreEqual(text, await File.ReadAllTextAsync(path));
    }

    [TestMethod]
    public async Task OversizedStateIsBoundedAndPreserved()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "shell.json");
        var text = new string(' ', 4097);
        await File.WriteAllTextAsync(path, text);
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        Assert.AreEqual("tray", store.CloseAction);
        Assert.IsFalse(store.Persisted);
        Assert.AreEqual(text, await File.ReadAllTextAsync(path));
    }

    [TestMethod]
    public async Task AnUnknownCloseActionChangesNothing()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        store.SetCloseAction("exit");
        Assert.ThrowsExactly<NendoValidationException>(() => store.SetCloseAction("vanish"));
        Assert.AreEqual("exit", store.CloseAction);
        Assert.AreEqual("exit", new DesktopShellStore(workspace.FileHistoryRoot).CloseAction);
    }

    [TestMethod]
    public async Task SaveFailureAppliesOnlyToMemoryAndCleansOwnedStage()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "shell.json");
        Directory.CreateDirectory(path); // Deterministic destination failure, not a disk-full test.
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        store.SetCloseAction("exit");
        Assert.AreEqual("exit", store.CloseAction, "The choice still applies to this window.");
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
        Assert.IsEmpty(Directory.GetFiles(workspace.FileHistoryRoot));
    }

    [TestMethod]
    public async Task ShellStateIsDeviceStateAndNeverReachesTheFile()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopShellStore(workspace.FileHistoryRoot);
        store.SetCloseAction("exit");
        store.MarkTrayIntroShown();
        var serialized = await File.ReadAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "shell.json"));
        Assert.IsFalse(serialized.Contains(workspace.FileHistoryRoot, StringComparison.Ordinal));
        Assert.IsFalse(File.Exists(workspace.FilePath));
    }
}
