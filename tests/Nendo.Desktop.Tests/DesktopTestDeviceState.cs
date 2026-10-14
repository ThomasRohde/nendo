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
///
/// The device folder was isolated and the agent ports were not: every fresh device folder
/// starts from 41763, the port the person's Nendo keeps for its first file, so a test host
/// took it whenever it was free (TST-04). NENDO_AGENT_PORTS=system lets the system pick the
/// ports of a device with no saved setting; a test of the kept ports saves its own.
/// </summary>
[TestClass]
public static class DesktopTestDeviceState
{
    private static string? _root;

    [AssemblyInitialize]
    public static void IsolateDeviceState(TestContext _)
    {
        // The assembly's one initializer, so the pool is sized here too (TST-02).
        DesktopTestHostThreads.SizeThePool();
        _root = Path.Combine(Path.GetTempPath(), "nendo-desktop-tests", $"device-state-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_root);
        Environment.SetEnvironmentVariable("NENDO_DEVICE_STATE_ROOT", _root);
        Environment.SetEnvironmentVariable("NENDO_AGENT_PORTS", "system");
    }

    [AssemblyCleanup]
    public static void RemoveDeviceState()
    {
        Environment.SetEnvironmentVariable("NENDO_DEVICE_STATE_ROOT", null);
        Environment.SetEnvironmentVariable("NENDO_AGENT_PORTS", null);
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
