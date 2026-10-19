using Nendo.Engine;

namespace Nendo.Desktop;

// Explicit process-owner configuration. It is never accepted from Workbench or MCP.
internal static class DesktopRuntimeConfiguration
{
    internal static string? DeviceStateRoot => ResolveDeviceStateRoot(Environment.GetEnvironmentVariable);
    internal static string? NativeCaptureRoot => ResolveNativeCaptureRoot(Environment.GetEnvironmentVariable);
    internal static bool NativeDiagnostics => Environment.GetEnvironmentVariable("NENDO_NATIVE_DIAGNOSTICS") == "1";
    internal static string? CloseAction => ResolveCloseAction(Environment.GetEnvironmentVariable);
    internal static string? AppUserModelId => ResolveAppUserModelId(Environment.GetEnvironmentVariable);
    internal static bool WritesShellState => ResolveWritesShellState(Environment.GetEnvironmentVariable);
    internal static bool AgentPortsBySystem => ResolveAgentPortsBySystem(Environment.GetEnvironmentVariable);

    /// <summary>
    /// Whether a device with no saved agent settings lets the system pick its hosts' ports
    /// instead of keeping the standard ones from 41763 up.
    /// <para>
    /// For a test or lane process only. Its hosts started on fresh device folders, so each took
    /// 41763 or the next free port, which the person's Nendo keeps for its files: an agent
    /// configured for one of them could reach a test's throwaway file meanwhile. A
    /// saved setting still wins, so a test of the kept ports names its own. Any value but
    /// <c>system</c> is refused, and a refused value keeps the standard ports.
    /// </para>
    /// </summary>
    internal static bool ResolveAgentPortsBySystem(Func<string, string?> read)
    {
        var value = read("NENDO_AGENT_PORTS");
        if (string.IsNullOrWhiteSpace(value)) return false;
        if (value != "system") throw new NendoValidationException("NENDO_AGENT_PORTS must be system.");
        return true;
    }

    /// <summary>
    /// Whether this process may write what Windows keeps per shell identity: the taskbar's
    /// Jump List and the notification registration with its icon and activator.
    /// <para>
    /// Both outlive the process and are filed under the identity, not the device state. A
    /// process on an isolated device-state folder under the product identity is a lane or a
    /// test, not the person's Nendo, and wrote both into the installed app's entries: every
    /// Desktop journey republished the person's Jump List with rows that start a Debug build
    /// under artifacts/, and left the notification activator pointing at it. Such a
    /// process now writes neither. A pinned identity is the lane's own, so it still does; a
    /// refused pin falls back to the product identity and therefore does not.
    /// </para>
    /// </summary>
    internal static bool ResolveWritesShellState(Func<string, string?> read)
    {
        try
        {
            if (ResolveAppUserModelId(read) is not null) return true;
            return ResolveDeviceStateRoot(read) is null;
        }
        catch (NendoValidationException)
        {
            return false;
        }
    }

    /// <summary>
    /// Pins the shell identity this process runs under, overriding the product one.
    /// <para>
    /// This exists for one lane rather than for convenience. Windows stores a custom
    /// Jump List in a file named after a hash of the identity, so a lane that used the
    /// product identity would be writing entries into the owner's real taskbar menu and
    /// asserting against it. A run-unique identity gives the lane a Jump List of its own
    /// to read and then delete — and a brand-new file appearing under that hash is
    /// itself the evidence that the identity reached the shell.
    /// </para>
    /// <para>
    /// Process-owner configuration like the rest of this file. Windows caps the value at
    /// 128 characters and forbids a backslash in it, so a value the shell would reject is
    /// refused here, where the message can say so, rather than silently leaving the
    /// process under a different identity from the one somebody asked for.
    /// </para>
    /// </summary>
    internal static string? ResolveAppUserModelId(Func<string, string?> read)
    {
        var value = read("NENDO_DESKTOP_APP_ID");
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (value.Length > 128 || value.Contains('\\') || value.Trim() != value)
            throw new NendoValidationException(
                "NENDO_DESKTOP_APP_ID must be at most 128 characters, carry no surrounding spaces and contain no backslash.");
        return value;
    }

    /// <summary>
    /// Pins what the close button does, overriding the saved preference.
    /// <para>
    /// This exists because closing the window no longer ends the process, and every
    /// scripted lane that drives a real window ends by closing it. None of them can
    /// click a tray menu, so without a way to say "exit on close" they would each
    /// leave a resident process behind and report it as a hang. Naming the behaviour
    /// they depend on is better than each one reaching into device state to forge a
    /// preference the person never chose.
    /// </para>
    /// <para>
    /// Process-owner configuration like the rest of this file: never accepted from the
    /// Workbench or from MCP, and an unrecognised value is refused rather than guessed
    /// at, so a typo cannot silently leave a lane's process resident.
    /// </para>
    /// </summary>
    internal static string? ResolveCloseAction(Func<string, string?> read)
    {
        var value = read("NENDO_DESKTOP_CLOSE_ACTION");
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (value is not ("tray" or "exit"))
            throw new NendoValidationException("NENDO_DESKTOP_CLOSE_ACTION must be tray or exit.");
        return value;
    }

    internal static string? ResolveDeviceStateRoot(Func<string, string?> read)
    {
        var value = read("NENDO_DEVICE_STATE_ROOT");
#if DEBUG
        if (string.IsNullOrWhiteSpace(value)) value = read("NENDO_DESKTOP_TEST_STATE_ROOT");
#endif
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!Path.IsPathFullyQualified(value))
            throw new NendoValidationException("NENDO_DEVICE_STATE_ROOT must name an absolute device-state directory.");
        return Path.GetFullPath(value);
    }

    internal static string? ResolveNativeCaptureRoot(Func<string, string?> read)
    {
        if (read("NENDO_NATIVE_DIAGNOSTICS") == "1") return ResolveDeviceStateRoot(read);
#if DEBUG
        // Preserve the existing Debug-only probe contract.
        if (!string.IsNullOrWhiteSpace(read("NENDO_DESKTOP_TEST_STATE_ROOT"))) return ResolveDeviceStateRoot(read);
#endif
        return null;
    }
}
