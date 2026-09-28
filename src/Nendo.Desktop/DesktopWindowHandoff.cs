using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace Nendo.Desktop;

/// <summary>
/// Hands a file that another Nendo already has open to that Nendo's window.
/// <para>
/// Each open file is its own process. Double-clicking a file that another window had open
/// started a second process that was refused ("already open for editing in another Nendo
/// session") and offered read-only, Duplicate or Fork — when what a person wanted was the
/// window they already had. The same was true of the taskbar's Recent list, File → Open, the
/// recent list and a drop.
/// </para>
/// <para>
/// The owner is found through the write-owner sidecar the Engine keeps beside every file it
/// holds for editing, which names its process. The request goes to that process's
/// notification-area window, which every Nendo window has and which, unlike the main window,
/// exists while the main window is hidden. It is <c>WM_COPYDATA</c> sent with a timeout, so a
/// Nendo that is not answering cannot hang this one, and its answer says whether the window
/// came forward. A request can ask for a view as well, which is how a notification clicked in
/// the wrong process reaches the right one.
/// </para>
/// <para>
/// What a request can do is what the tray menu's Open does: show the window and go to a
/// view. It carries no file, no path and nothing to approve, so any process that can send
/// window messages to this one can do no more with it than a click on the tray icon.
/// </para>
/// </summary>
internal static class DesktopWindowHandoff
{
    /// <summary>Marks a <c>WM_COPYDATA</c> as ours. "NDSW": Nendo, show window.</summary>
    internal const int Signature = 0x4E44_5357;

    internal const int WM_COPYDATA = 0x004A;

    private const string ShowCommand = "show";
    private const uint SMTO_BLOCK = 0x0001;
    private const uint SMTO_ABORTIFHUNG = 0x0002;
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(3);

    /// <summary>
    /// Asks the Nendo that has this file open for editing to bring its window forward. True
    /// only when that window answered that it did; false leaves the caller to open the file
    /// the way it always has, which is also where a refusal still offers read-only.
    /// </summary>
    internal static bool TryShowOwnerOf(string filePath, string? route = null) =>
        OwnerOf(filePath) is { } processId && TryShow(processId, route);

    /// <summary>
    /// The live Nendo process that holds this file for editing, when it is not this one.
    /// </summary>
    /// <param name="filePath">The file somebody asked to open.</param>
    /// <param name="isNendo">Whether a process is a Nendo; a test names its own.</param>
    /// <param name="self">This process; a test names another, to read its own sidecar as someone else's.</param>
    internal static int? OwnerOf(string filePath, Func<int, bool>? isNendo = null, int? self = null)
    {
        string sidecar;
        try { sidecar = System.IO.Path.GetFullPath(filePath) + ".write-owner"; }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
        try
        {
            // The owner opened it delete-on-close, so every other handle has to share delete,
            // and it holds it writable, so every other handle has to share writing too.
            using var stream = new FileStream(sidecar, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length is 0 or > 4096) return null;
            using var document = JsonDocument.Parse(stream);
            // Anything but a number is no owner: TryGetInt32 throws on a string rather than refusing it.
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("processId", out var id)
                || id.ValueKind != JsonValueKind.Number
                || !id.TryGetInt32(out var processId)) return null;
            if (processId <= 0 || processId == (self ?? Environment.ProcessId)) return null;
            return (isNendo ?? IsNendo)(processId) ? processId : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Asks this Nendo process to show its window, and to go to a view when one is named.
    /// </summary>
    internal static bool TryShow(int processId, string? route = null)
    {
        if (processId == Environment.ProcessId) return false;
        var target = FindShowTarget(processId);
        if (target == IntPtr.Zero) return false;
        // The process that received the click may bring a window forward; the one being asked
        // may not, unless it is told it may. Without this the window would come back behind
        // whatever is in front, flashing on the taskbar instead of being there.
        AllowSetForegroundWindow(processId);
        var payload = Encoding.Unicode.GetBytes(Request(route) + '\0');
        var buffer = Marshal.AllocHGlobal(payload.Length);
        try
        {
            Marshal.Copy(payload, 0, buffer, payload.Length);
            var data = new COPYDATASTRUCT { dwData = Signature, cbData = payload.Length, lpData = buffer };
            var sent = SendMessageTimeoutW(target, WM_COPYDATA, IntPtr.Zero, ref data,
                SMTO_BLOCK | SMTO_ABORTIFHUNG, (uint)Patience.TotalMilliseconds, out var answer);
            return sent != IntPtr.Zero && answer == 1;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>The request as it travels: "show", or "show:agent" to go to a view as well.</summary>
    internal static string Request(string? route) => route is null ? ShowCommand : $"{ShowCommand}:{route}";

    /// <summary>
    /// Reads a request out of a <c>WM_COPYDATA</c>. True when it is one of ours, with the view it
    /// named or null for the window alone.
    /// </summary>
    internal static bool TryRead(IntPtr copyData, out string? route)
    {
        route = null;
        if (copyData == IntPtr.Zero) return false;
        var data = Marshal.PtrToStructure<COPYDATASTRUCT>(copyData);
        if (data.dwData != Signature || data.lpData == IntPtr.Zero || data.cbData is <= 0 or > 256) return false;
        var text = Marshal.PtrToStringUni(data.lpData, data.cbData / 2).TrimEnd('\0');
        return TryParse(text, out route);
    }

    internal static bool TryParse(string text, out string? route)
    {
        route = null;
        if (text == ShowCommand) return true;
        if (!text.StartsWith(ShowCommand + ":", StringComparison.Ordinal)) return false;
        // A closed set: a request can name only the views a notification can.
        var named = text[(ShowCommand.Length + 1)..];
        if (named is not (DesktopNotificationContent.RouteOpen or DesktopNotificationContent.RouteAgent or DesktopNotificationContent.RouteHealth))
            return false;
        route = named;
        return true;
    }

    /// <summary>The name the notification-area window's class carries, per process.</summary>
    internal static string TrayClassPrefix(int processId) => $"NendoTray.{processId}.";

    private static IntPtr FindShowTarget(int processId)
    {
        var prefix = TrayClassPrefix(processId);
        var found = IntPtr.Zero;
        var name = new StringBuilder(64);
        EnumWindows((window, _) =>
        {
            GetWindowThreadProcessId(window, out var owner);
            if (owner != (uint)processId) return true;
            name.Clear();
            if (GetClassNameW(window, name, name.Capacity) == 0) return true;
            if (!name.ToString().StartsWith(prefix, StringComparison.Ordinal)) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    private static bool IsNendo(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            using var current = Process.GetCurrentProcess();
            // A sidecar outlives nothing, but a process ID is reused: the name is what says
            // the ID still belongs to a Nendo.
            return !process.HasExited
                && string.Equals(process.ProcessName, current.ProcessName, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct COPYDATASTRUCT
    {
        public nint dwData;
        public int cbData;
        public IntPtr lpData;
    }

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder className, int maximum);

    [DllImport("user32.dll")]
    private static extern bool AllowSetForegroundWindow(int processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, IntPtr wParam,
        ref COPYDATASTRUCT lParam, uint flags, uint timeout, out nint result);
}
