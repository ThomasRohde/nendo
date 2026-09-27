namespace Nendo.Desktop.Tests;

/// <summary>
/// Gives this test process a device-state folder of its own.
///
/// A <see cref="DesktopSessionController"/> built without a device-state root uses
/// <see cref="DesktopAppearanceStore.DefaultRoot"/>, which is the person's real
/// %LOCALAPPDATA%\Nendo unless NENDO_DEVICE_STATE_ROOT names another. Sixty-six of the
/// suite's controllers were built that way, so they read the person's saved agent settings
/// -- a fixed port their running Nendo already held -- and, once agent failures were kept
/// (W-085), wrote one line per refused bind into that person's agent-failures.jsonl: fifty
/// on 2026-09-27, before any of it was theirs. Setting the variable here, once, before any
/// test runs, moves every default at once; a test that needs its own root still passes one.
/// </summary>
[TestClass]
public static class DesktopTestDeviceState
{
    private static string? _root;

    [AssemblyInitialize]
    public static void IsolateDeviceState(TestContext _)
    {
        _root = Path.Combine(Path.GetTempPath(), "nendo-desktop-tests", $"device-state-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_root);
        Environment.SetEnvironmentVariable("NENDO_DEVICE_STATE_ROOT", _root);
    }

    [AssemblyCleanup]
    public static void RemoveDeviceState()
    {
        Environment.SetEnvironmentVariable("NENDO_DEVICE_STATE_ROOT", null);
        if (_root is null) return;
        try
        {
            Directory.Delete(_root, recursive: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // A host still closing may hold a file; the temp folder is the operating system's to clear.
        }
    }
}
