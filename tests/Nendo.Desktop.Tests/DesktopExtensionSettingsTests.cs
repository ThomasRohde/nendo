namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopExtensionSettingsTests
{
    [TestMethod]
    public async Task StaleFileTogglesAndLinksPreserveDeviceOffAndOtherFiles()
    {
        await using var workspace = new DesktopTestWorkspace();
        using var first = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        using var second = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        first.SetRun(false);
        first.SetFileEnabled("first", false);
        first.SetLink("first", "first.package", workspace.FileHistoryRoot);
        second.SetFileEnabled("second", false);
        second.SetLink("second", "second.package", workspace.FileHistoryRoot);
        using var reopened = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(reopened.Run, "An unrelated stale file setting restored the device switch to On.");
        Assert.IsFalse(second.Run, "The already-open store kept its cached device On.");
        Assert.IsFalse(reopened.FileEnabled("first"), "A second file's toggle erased another file's Off.");
        Assert.IsFalse(reopened.FileEnabled("second"));
        Assert.HasCount(1, reopened.LinksFor("first"));
        Assert.HasCount(1, reopened.LinksFor("second"));
        second.RemoveLink("second", "second.package");
        Assert.HasCount(1, first.LinksFor("first"));
        Assert.IsEmpty(first.LinksFor("second"));
    }

    [TestMethod]
    public async Task DeviceOffWithoutTheLockStaysLocalAndIsMergedAtTheNextSave()
    {
        await using var workspace = new DesktopTestWorkspace();
        using var store = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        store.SetFileEnabled("first", false);
        var acquired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var holder = Task.Factory.StartNew(() =>
        {
            using var guard = DesktopDeviceStateLock.EnterRequired(Path.Combine(workspace.FileHistoryRoot, "extension-settings.json"));
            acquired.SetResult();
            release.Wait();
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        await acquired.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            store.SetRun(false);
            Assert.IsFalse(store.Run, "An unsaved device Off stopped applying to this session.");
            using var reopened = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
            Assert.IsTrue(reopened.Run, "The control document was overwritten without owning its lock.");
            Assert.IsNotNull(store.Notice);
        }
        finally { release.Set(); await holder; }
        store.SetFileEnabled("second", false);
        using var kept = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(kept.Run, "The next serialized save lost this session's unsaved device Off.");
        Assert.IsFalse(kept.FileEnabled("first"));
        Assert.IsFalse(kept.FileEnabled("second"));
    }

    [TestMethod]
    public async Task ASharedDeviceOffSupersedesAnEarlierUnsavedSessionOn()
    {
        await using var workspace = new DesktopTestWorkspace();
        using var store = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        store.SetFileEnabled("first", false);
        var acquired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var holder = Task.Factory.StartNew(() =>
        {
            using var guard = DesktopDeviceStateLock.EnterRequired(Path.Combine(workspace.FileHistoryRoot, "extension-settings.json"));
            acquired.SetResult();
            release.Wait();
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        await acquired.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            store.SetRun(true);
            Assert.IsTrue(store.Run);
            Assert.IsNotNull(store.Notice);
        }
        finally { release.Set(); await holder; }
        using var other = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        other.SetRun(false);
        Assert.IsFalse(store.Run, "An unsaved session On outran another controller's later device Off.");
        store.SetFileEnabled("second", false);
        using var reopened = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(reopened.Run, "A later save persisted the superseded session On again.");
    }

    [TestMethod]
    [DataRow(true)]
    [DataRow(false)]
    public async Task ASharedFileOffSupersedesAnEarlierUnsavedSessionFileOn(bool initiallyEnabled)
    {
        await using var workspace = new DesktopTestWorkspace();
        using var store = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        store.SetFileEnabled("shared", initiallyEnabled);
        var acquired = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        var holder = Task.Factory.StartNew(() =>
        {
            using var guard = DesktopDeviceStateLock.EnterRequired(Path.Combine(workspace.FileHistoryRoot, "extension-settings.json"));
            acquired.SetResult();
            release.Wait();
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
        await acquired.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            store.SetFileEnabled("shared", true);
            Assert.IsTrue(store.FileEnabled("shared"));
            Assert.IsNotNull(store.Notice);
        }
        finally { release.Set(); await holder; }
        using var other = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        other.SetFileEnabled("shared", false);
        Assert.IsFalse(store.FileEnabled("shared"), "An unsaved session file On outran another controller's later file Off.");
        store.SetLink("unrelated", "unrelated.package", workspace.FileHistoryRoot);
        using var reopened = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(reopened.FileEnabled("shared"), "A later save persisted the superseded session file On again.");
    }

    [TestMethod]
    public async Task AnOversizedSaveKeepsTheReadableDeviceOffDocument()
    {
        await using var workspace = new DesktopTestWorkspace();
        const int maximumBytes = 256 * 1024;
        var files = Enumerable.Range(0, 4096).Select(index => index.ToString("D32", System.Globalization.CultureInfo.InvariantCulture)).ToArray();
        byte[] Document(int revisions) => System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
        {
            Version = 1, Run = false, DisabledFiles = files, DevelopmentLinks = Array.Empty<object>(),
            RunGeneration = 0L, FileRevision = 4096L,
            FileRevisions = files.Take(revisions).Select((file, index) => (file, revision: (long)index + 1))
                .ToDictionary(entry => entry.file, entry => entry.revision, StringComparer.Ordinal),
        });
        var low = 0;
        var high = files.Length;
        while (low < high)
        {
            var middle = (low + high + 1) / 2;
            if (Document(middle).Length <= maximumBytes) low = middle;
            else high = middle - 1;
        }
        Assert.IsLessThan(files.Length, low, "The fixture must reach the byte bound before the count bound.");
        var before = Document(low);
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "extension-settings.json");
        await File.WriteAllBytesAsync(path, before);
        using var store = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(store.Run, "The near-limit fixture must start with readable device Off.");
        Assert.IsNull(store.Notice);

        store.SetFileEnabled(files[low], false);

        Assert.IsFalse(store.Run, "An oversized save replaced readable device Off with settings that reopen as On.");
        Assert.IsFalse(store.Run, "A repeated fresh read lost the saved device Off.");
        Assert.IsNotNull(store.Notice, "Byte admission must report that the choice could not be saved.");
        using var reopened = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(reopened.Run, "Reopen lost device Off after a rejected oversized save.");
        Assert.IsFalse(reopened.FileEnabled(files[low]));
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(path), "The refused save replaced the durable settings document.");
        Assert.IsLessThanOrEqualTo(maximumBytes, new FileInfo(path).Length);
    }

    [TestMethod]
    public async Task ABusySettingsDocumentKeepsTheLastSwitchesItRead()
    {
        await using var workspace = new DesktopTestWorkspace();
        using var store = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        store.SetRun(false);
        store.SetFileEnabled("first", false);
        var path = Path.Combine(workspace.FileHistoryRoot, "extension-settings.json");
        using (new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            Assert.IsFalse(store.Run, "A briefly busy settings document turned custom views back on for the device.");
            Assert.IsFalse(store.FileEnabled("first"), "A briefly busy settings document turned a file's views back on.");
            store.SetFileEnabled("second", false);
            Assert.IsFalse(store.FileEnabled("second"), "A change made while the document was busy did not apply to this session.");
        }
        store.SetFileEnabled("third", false);
        using var reopened = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(reopened.Run, "A change made after a busy read saved the defaults over device Off.");
        Assert.IsFalse(reopened.FileEnabled("first"), "A change made after a busy read saved the defaults over a file's Off.");
        Assert.IsFalse(reopened.FileEnabled("second"));
        Assert.IsFalse(reopened.FileEnabled("third"));
    }

    [TestMethod]
    public async Task ADeviceChangeNotifiesAnAlreadyOpenListenerWithoutARead()
    {
        await using var workspace = new DesktopTestWorkspace();
        using var first = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        using var second = new DesktopExtensionSettingsStore(workspace.FileHistoryRoot);
        var changed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        second.Changed += () => changed.TrySetResult();
        first.SetRun(false);
        await changed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.IsFalse(second.Run, "The live notification did not carry the persisted device Off.");
    }
}
