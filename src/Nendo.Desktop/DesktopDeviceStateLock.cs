namespace Nendo.Desktop;

/// <summary>
/// One device-state document at a time, across every Nendo on this computer.
/// <para>
/// Each open file is its own process, and some device state is shared between them: the place
/// each file's window was, the port each file keeps. A read, change and write of one of those
/// documents from two processes at once loses whichever write lands first. A named mutex in
/// this session serializes them; failing to take it within a second is not worth blocking a
/// window over, so the caller goes ahead unguarded, which is what it did before.
/// Approval and custom-view controls require the lock instead: they retain an unsaved
/// session choice and report it rather than risk restoring another file's revoked choice.
/// </para>
/// <para>
/// Enter and dispose on the same thread, with no await between them: a mutex belongs to the
/// thread that took it, and one released from another thread is not released.
/// </para>
/// </summary>
internal sealed class DesktopDeviceStateLock : IDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(1);

    private Mutex? _mutex;

    private DesktopDeviceStateLock(Mutex? mutex) => _mutex = mutex;

    /// <summary>A control document must never be overwritten without owning its lock.</summary>
    internal static DesktopDeviceStateLock EnterRequired(string path)
    {
        var identity = Path.GetFullPath(path);
        if (OperatingSystem.IsWindows()) identity = identity.ToUpperInvariant();
        var digest = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(identity)));
        return Enter("control." + digest, required: true);
    }

    internal static DesktopDeviceStateLock Enter(string document, bool required = false)
    {
        Mutex? mutex = null;
        try
        {
            mutex = new Mutex(false, $@"Local\Nendo.DeviceState.v1.{document}");
            try
            {
                if (mutex.WaitOne(Patience)) return new DesktopDeviceStateLock(mutex);
            }
            catch (AbandonedMutexException)
            {
                // A process that died holding it: the document is as it left it, and ours now.
                return new DesktopDeviceStateLock(mutex);
            }
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or IOException or WaitHandleCannotBeOpenedException)
        {
        }
        mutex?.Dispose();
        if (required) throw new IOException("The shared device settings are busy. This change could not be saved.");
        return new DesktopDeviceStateLock(null);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _mutex, null) is not { } mutex) return;
        try { mutex.ReleaseMutex(); }
        catch (ApplicationException) { }
        mutex.Dispose();
    }
}
