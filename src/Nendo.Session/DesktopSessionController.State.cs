namespace Nendo.Session;

/// <summary>The session's device state and its file session, whichever host it runs in.</summary>
internal sealed partial class DesktopSessionController
{
    private readonly string _deviceStateRoot;
    private readonly string? _ownedDeviceStateRoot;
    private string _fileSessionId = $"file-session-{Guid.NewGuid():N}";

    /// <param name="deviceStateRoot">
    /// Where this device's settings, grants and agent ports are kept. The window always names
    /// one. A controller built without one is a test's, and gets a folder of its own that goes
    /// when it is disposed: it used to fall back to the person's real device state, so a test
    /// that switched agent access on could keep a port there that a real file then lost.
    /// </param>
    internal DesktopSessionController(string? fileHistoryRoot = null, DesktopLocationPolicy? locationPolicy = null, string? deviceStateRoot = null)
    {
        _ownedDeviceStateRoot = deviceStateRoot is null
            ? Path.Combine(Path.GetTempPath(), "nendo-device-state", Guid.NewGuid().ToString("N"))
            : null;
        _deviceStateRoot = deviceStateRoot ?? _ownedDeviceStateRoot!;
        // Recent files are device state like the rest (ADR-0034), so a test's controller keeps
        // them in its own folder too.
        _fileHistory = new DesktopFileHistory(fileHistoryRoot ?? DesktopDeviceStateLayout.Files(_deviceStateRoot));
        _locationPolicy = locationPolicy ?? DesktopLocationPolicy.ForDevice();
    }

    /// <summary>Where this controller keeps its recent files.</summary>
    internal string FileHistoryRoot => _fileHistory.Root;
}
