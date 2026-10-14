using System.Text;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Device state that several windows share. Each open file is a process of its own, and the
/// handles and races are the operating system's, so threads here stand in for the windows:
/// a handle one thread holds blocks a move in another exactly as one in another process does.
/// </summary>
[TestClass]
public sealed class DesktopDeviceStateConcurrencyTests
{
    /// <summary>
    /// R2SP-07. A document is replaced by moving a stage over it, and Windows refuses that move
    /// while any reader has the document open, shared for delete or not. Readers take no lock and
    /// every window polls some of these documents, so a save failed now and then: the custom-view
    /// switch said it applied for this session only, and a kept port or level was lost silently.
    /// </summary>
    [TestMethod]
    public async Task AReaderInAnotherWindowNeverMakesAReplaceFail()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;
        var path = Path.Combine(root, "shared.json");
        DesktopStateFile.Replace(root, path, "shared", stream => stream.Write("{\"n\":0}"u8));
        using var stop = new CancellationTokenSource();
        var reads = 0L;
        // Two windows polling far faster than any window does (the custom-view settings are read
        // every 250 ms): a read about every millisecond each.
        var readers = Enumerable.Range(0, 2).Select(_ => Task.Run(() =>
        {
            while (!stop.IsCancellationRequested)
            {
                try
                {
                    DesktopStateFile.ReadBytes(path, 4096, "too large");
                    Interlocked.Increment(ref reads);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
                Thread.Sleep(1);
            }
        })).ToArray();
        var failures = new List<string>();
        try
        {
            while (Interlocked.Read(ref reads) == 0) await Task.Delay(1);
            for (var write = 1; write <= 500; write++)
            {
                var bytes = Encoding.UTF8.GetBytes($"{{\"n\":{write}}}");
                try { DesktopStateFile.Replace(root, path, "shared", stream => stream.Write(bytes)); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    failures.Add($"{write}: {exception.GetType().Name}: {exception.Message}");
                }
            }
        }
        finally
        {
            stop.Cancel();
            await Task.WhenAll(readers);
        }
        Assert.IsEmpty(failures, $"{failures.Count} of 500 replacements failed while another window read the document: {failures.FirstOrDefault()}");
        Assert.AreEqual("{\"n\":500}", await File.ReadAllTextAsync(path));
        Assert.IsEmpty(Directory.GetFiles(root, "*.tmp"), "A failed replacement left its stage behind.");
    }

    /// <summary>
    /// R2SP-07. The recent-file list is written by its own code, which another window's read of
    /// the list -- a start screen, a Jump List refresh -- refused the same way, and the entry was
    /// dropped without a word.
    /// </summary>
    [TestMethod]
    public async Task ARecentFileIsRememberedWhileAnotherWindowReadsTheList()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot))
        {
            await session.CreateAsync(workspace.FilePath);
        }
        var observed = await Nendo.Engine.NendoWriteCoordinator.ObserveAsync(workspace.FilePath, CancellationToken.None);
        var history = new DesktopFileHistory(workspace.FileHistoryRoot);
        var reader = new DesktopFileHistory(workspace.FileHistoryRoot);
        using var stop = new CancellationTokenSource();
        var reads = 0L;
        // Two windows reading the list, each about every millisecond.
        var reading = Task.WhenAll(Enumerable.Range(0, 2).Select(_ => Task.Run(() =>
        {
            while (!stop.IsCancellationRequested)
            {
                if (reader.LatestInstanceByApplication() is not null) Interlocked.Increment(ref reads);
                Thread.Sleep(1);
            }
        })));
        var refused = 0;
        try
        {
            while (Interlocked.Read(ref reads) == 0) await Task.Delay(1);
            for (var write = 0; write < 200; write++)
            {
                if (!await history.RememberAsync(workspace.FilePath, observed, writable: true, CancellationToken.None)) refused++;
            }
        }
        finally
        {
            stop.Cancel();
            await reading;
        }
        Assert.AreEqual(0, refused, $"{refused} of 200 recent-file writes were lost while another window read the list.");
    }

    /// <summary>
    /// R2SP-06. The view-failure and agent-failure logs read, appended and moved a copy over the
    /// log with no lock across processes. One failure reaches every window at once when the
    /// browser process they share exits, so each window's line replaced the others' and the
    /// losers' stages stayed in the device-state folder.
    /// </summary>
    [TestMethod]
    public async Task EveryWindowsLineIsKeptWhenTheyAllRecordAtOnce()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;
        const int windows = 4, lines = 10;
        using var start = new Barrier(windows);
        var recorded = Enumerable.Range(0, windows).Select(window => Task.Run(() =>
        {
            // A log of its own, as each window's process has.
            var log = new DesktopCappedJsonlLog<LogLine>(root, "shared-failures", 200);
            start.SignalAndWait();
            var written = 0;
            for (var line = 0; line < lines; line++)
            {
                if (log.Record(new LogLine(window, line))) written++;
            }
            return written;
        })).ToArray();
        var written = (await Task.WhenAll(recorded)).Sum();
        var kept = new DesktopCappedJsonlLog<LogLine>(root, "shared-failures", 200).Read();
        Assert.AreEqual(windows * lines, written, "A window could not record its line.");
        Assert.HasCount(windows * lines, kept, $"Recorded at the same moment by {windows} windows, {kept.Count} of {windows * lines} lines were kept.");
        Assert.IsEmpty(Directory.GetFiles(root, "*.tmp"), "A window that lost the race left its stage in the device-state folder.");
    }

    private sealed record LogLine(int Window, int Line);
}
