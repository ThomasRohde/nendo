using System.Runtime.InteropServices;

namespace Nendo.Desktop;

/// <summary>What the tray menu should say the next time it is opened.</summary>
/// <param name="Header">The open file, or the product name when none is open.</param>
/// <param name="AgentAccess">
/// The visible access mode, or null when no file is open. This is on the menu
/// because the notification area is now where an owner meets a Nendo that has no
/// window: a resident process holding a file open with agent access on is exactly
/// the state ADR-0009 asks them to be able to see and end.
/// </param>
internal sealed record DesktopTrayMenuState(
    string Header,
    string? AgentAccess,
    bool AgentAccessOn,
    bool CloseMinimisesToTray,
    bool RecordViewFailures);

/// <summary>What the person chose from the tray menu, or from clicking the icon.</summary>
internal enum DesktopTrayCommand
{
    Open = 1,
    TurnAgentAccessOff = 2,
    ToggleCloseAction = 3,
    Exit = 4,
    ToggleViewFailureLog = 5,
}

/// <summary>
/// A notification-area icon and its menu.
/// <para>
/// The first interop in this project, and deliberately hand-rolled rather than
/// taken as a package: it is one shell API, one window class and one popup menu,
/// and a dependency would cost more review than the code it replaces.
/// </para>
/// <para>
/// Two details are load-bearing and easy to get wrong. The owning window is a
/// hidden top-level window rather than a message-only one, because message-only
/// windows do not receive the broadcast TaskbarCreated and the icon would then
/// disappear for good the first time Explorer restarts. And the icon is identified
/// by window handle plus ID rather than by guidItem, because a GUID registration is
/// bound to the path of the executable — two Nendo windows would fight over one
/// registration instead of showing one icon each.
/// </para>
/// <para>
/// The menu is a native popup, so it follows the Windows theme rather than the
/// application appearance preference. That is intended: the notification area is
/// system chrome, the tray menus Windows draws for itself behave the same way, and
/// the native control carries keyboard and screen-reader support for free.
/// </para>
/// </summary>
internal sealed class DesktopTrayIcon : IDisposable
{
    private const int WM_APP = 0x8000;
    private const int CallbackMessage = WM_APP + 1;
    private const int WM_DESTROY = 0x0002;
    private const int WM_NULL = 0x0000;
    private const int WM_CONTEXTMENU = 0x007B;
    private const int NIN_SELECT = WM_APP + 0;
    private const int NIN_KEYSELECT = WM_APP + 1;
    private const int WM_LBUTTONUP = 0x0202;
    private const int WM_RBUTTONUP = 0x0205;

    private const int NIM_ADD = 0x00000000;
    private const int NIM_MODIFY = 0x00000001;
    private const int NIM_DELETE = 0x00000002;
    private const int NIM_SETVERSION = 0x00000004;
    private const int NOTIFYICON_VERSION_4 = 4;

    private const int NIF_MESSAGE = 0x00000001;
    private const int NIF_ICON = 0x00000002;
    private const int NIF_TIP = 0x00000004;
    private const int NIF_INFO = 0x00000010;
    private const int NIF_SHOWTIP = 0x00000080;

    private const int MF_STRING = 0x00000000;
    private const int MF_GRAYED = 0x00000001;
    private const int MF_DISABLED = 0x00000002;
    private const int MF_CHECKED = 0x00000008;
    private const int MF_SEPARATOR = 0x00000800;

    private const int TPM_RIGHTBUTTON = 0x0002;
    private const int TPM_RETURNCMD = 0x0100;

    private const int IMAGE_ICON = 1;
    private const int LR_LOADFROMFILE = 0x00000010;
    private const int LR_DEFAULTSIZE = 0x00000040;
    private const int SM_CXSMICON = 49;
    private const int SM_CYSMICON = 50;

    private const int WS_OVERLAPPED = 0x00000000;

    private static int _instances;

    private readonly Action<DesktopTrayCommand> _invoke;
    private readonly Action? _taskbarRecreated;
    private readonly Func<DesktopTrayMenuState> _describe;
    private readonly WndProcDelegate _wndProc;
    private readonly string _className;
    private readonly ushort _classAtom;
    private readonly uint _taskbarCreated;
    private readonly IntPtr _hwnd;
    private readonly IntPtr _icon;
    private string _tip = "Nendo";
    private bool _added;
    private bool _disposed;

    /// <summary>Whether the notification area accepted the icon. False means there is no tray to close to.</summary>
    internal bool IsPresent => _added;

    /// <summary>
    /// Creates the icon on the calling thread, which must be the thread pumping
    /// messages — the callbacks arrive on it, so everything they touch is already on
    /// the UI thread and needs no marshalling back.
    /// </summary>
    /// <param name="taskbarRecreated">
    /// Explorer restarted. Everything on the taskbar went with it — this icon, and the
    /// overlay and progress on the window's button — so whoever owns those has to put
    /// them back. Raised on the message-pumping thread, like the rest of this class.
    /// </param>
    internal DesktopTrayIcon(Func<DesktopTrayMenuState> describe, Action<DesktopTrayCommand> invoke,
        Action? taskbarRecreated = null)
    {
        _describe = describe;
        _invoke = invoke;
        _taskbarRecreated = taskbarRecreated;
        _wndProc = WindowProcedure;
        _className = $"NendoTray.{Environment.ProcessId}.{Interlocked.Increment(ref _instances)}";
        _taskbarCreated = RegisterWindowMessageW("TaskbarCreated");

        var module = GetModuleHandleW(null);
        var windowClass = new WNDCLASSEXW
        {
            cbSize = Marshal.SizeOf<WNDCLASSEXW>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(_wndProc),
            hInstance = module,
            lpszClassName = _className,
        };
        _classAtom = RegisterClassExW(ref windowClass);
        if (_classAtom == 0) return;

        _hwnd = CreateWindowExW(0, _className, "Nendo", WS_OVERLAPPED, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, module, IntPtr.Zero);
        if (_hwnd == IntPtr.Zero) return;

        _icon = LoadTrayIcon();
        _added = Notify(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP);
        if (_added) Notify(NIM_SETVERSION, 0, version: NOTIFYICON_VERSION_4);
    }

    /// <summary>The tooltip, which is how two open files are told apart in the notification area.</summary>
    internal void SetTooltip(string tip)
    {
        var trimmed = Truncate(tip, 127);
        if (string.Equals(_tip, trimmed, StringComparison.Ordinal)) return;
        _tip = trimmed;
        if (_added) Notify(NIM_MODIFY, NIF_TIP | NIF_SHOWTIP);
    }

    /// <summary>
    /// The balloon the shell draws, used only when Windows notifications are
    /// unavailable. It carries no button and cannot be recovered once missed, which
    /// is why it is the fallback rather than the mechanism.
    /// </summary>
    internal void ShowBalloon(string title, string message)
    {
        if (!_added) return;
        Notify(NIM_MODIFY, NIF_INFO, Truncate(title, 63), Truncate(message, 255));
    }

    private IntPtr LoadTrayIcon()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
        if (!File.Exists(path)) return IntPtr.Zero;
        return LoadImageW(
            IntPtr.Zero,
            path,
            IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
            LR_LOADFROMFILE | LR_DEFAULTSIZE);
    }

    private bool Notify(int message, int flags, string? infoTitle = null, string? info = null, int version = 0)
    {
        var data = new NOTIFYICONDATAW
        {
            cbSize = Marshal.SizeOf<NOTIFYICONDATAW>(),
            hWnd = _hwnd,
            uID = 1,
            uFlags = flags,
            uCallbackMessage = CallbackMessage,
            hIcon = _icon,
            szTip = _tip,
            szInfoTitle = infoTitle ?? string.Empty,
            szInfo = info ?? string.Empty,
            uVersionOrTimeout = version,
        };
        return Shell_NotifyIconW(message, ref data);
    }

    private IntPtr WindowProcedure(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (_taskbarCreated != 0 && msg == _taskbarCreated)
        {
            // Explorer restarted and forgot every icon. Re-adding is the only way back;
            // a tray that silently lost its icon would strand a window nobody can reopen.
            _added = Notify(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP);
            if (_added) Notify(NIM_SETVERSION, 0, version: NOTIFYICON_VERSION_4);
            // A throwing handler must not cross this native frame; see Invoke below.
            try { _taskbarRecreated?.Invoke(); } catch (Exception) { }
            return IntPtr.Zero;
        }

        if (msg == CallbackMessage)
        {
            var notification = (int)(lParam.ToInt64() & 0xFFFF);
            switch (notification)
            {
                case NIN_SELECT:
                case NIN_KEYSELECT:
                case WM_LBUTTONUP:
                    Invoke(DesktopTrayCommand.Open);
                    break;
                case WM_CONTEXTMENU:
                case WM_RBUTTONUP:
                    ShowMenu(SignedLowWord(wParam), SignedHighWord(wParam));
                    break;
            }
            return IntPtr.Zero;
        }

        if (msg == WM_DESTROY) return IntPtr.Zero;
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private void ShowMenu(int x, int y)
    {
        DesktopTrayMenuState state;
        try { state = _describe(); }
        catch (Exception) { return; }

        var menu = CreatePopupMenu();
        if (menu == IntPtr.Zero) return;
        try
        {
            AppendMenuW(menu, MF_STRING | MF_GRAYED | MF_DISABLED, 0, Truncate(state.Header, 80));
            AppendMenuW(menu, MF_SEPARATOR, 0, null);
            AppendMenuW(menu, MF_STRING, (int)DesktopTrayCommand.Open, "&Open Nendo");
            if (state.AgentAccess is { } access)
            {
                AppendMenuW(menu, MF_SEPARATOR, 0, null);
                AppendMenuW(menu, MF_STRING | MF_GRAYED | MF_DISABLED, 0, $"Agent access: {access}");
                if (state.AgentAccessOn)
                {
                    AppendMenuW(menu, MF_STRING, (int)DesktopTrayCommand.TurnAgentAccessOff, "&Turn agent access off");
                }
            }
            AppendMenuW(menu, MF_SEPARATOR, 0, null);
            AppendMenuW(
                menu,
                MF_STRING | (state.CloseMinimisesToTray ? MF_CHECKED : 0),
                (int)DesktopTrayCommand.ToggleCloseAction,
                "&Close button minimises here");
            AppendMenuW(
                menu,
                MF_STRING | (state.RecordViewFailures ? MF_CHECKED : 0),
                (int)DesktopTrayCommand.ToggleViewFailureLog,
                "&Record view failures");
            AppendMenuW(menu, MF_SEPARATOR, 0, null);
            AppendMenuW(menu, MF_STRING, (int)DesktopTrayCommand.Exit, "E&xit Nendo");
            SetMenuDefaultItem(menu, (uint)DesktopTrayCommand.Open, 0);

            // Without this the menu stays on screen after the pointer leaves it, because
            // the owning window is not in the foreground. The WM_NULL afterwards is the
            // other half of the same documented workaround.
            SetForegroundWindow(_hwnd);
            var chosen = TrackPopupMenuEx(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD, x, y, _hwnd, IntPtr.Zero);
            PostMessageW(_hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
            if (chosen != 0 && Enum.IsDefined(typeof(DesktopTrayCommand), chosen))
            {
                Invoke((DesktopTrayCommand)chosen);
            }
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    private void Invoke(DesktopTrayCommand command)
    {
        // A throwing handler must not take down the window procedure: an exception
        // crossing a native frame terminates the process rather than surfacing
        // anywhere a person could read it.
        try { _invoke(command); }
        catch (Exception) { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_added) Notify(NIM_DELETE, 0);
        _added = false;
        if (_icon != IntPtr.Zero) DestroyIcon(_icon);
        if (_hwnd != IntPtr.Zero) DestroyWindow(_hwnd);
        if (_classAtom != 0) UnregisterClassW(_className, GetModuleHandleW(null));
    }

    private static string Truncate(string value, int maximum) =>
        value.Length <= maximum ? value : value[..maximum];

    private static int SignedLowWord(IntPtr value) => unchecked((short)(value.ToInt64() & 0xFFFF));

    private static int SignedHighWord(IntPtr value) => unchecked((short)((value.ToInt64() >> 16) & 0xFFFF));

    private delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEXW
    {
        public int cbSize;
        public int style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATAW
    {
        public int cbSize;
        public IntPtr hWnd;
        public int uID;
        public int uFlags;
        public int uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public int dwState;
        public int dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public int uVersionOrTimeout;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public int dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Shell_NotifyIconW(int dwMessage, ref NOTIFYICONDATAW lpData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern ushort RegisterClassExW(ref WNDCLASSEXW lpwcx);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnregisterClassW(string lpClassName, IntPtr hInstance);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(
        int dwExStyle, string lpClassName, string lpWindowName, int dwStyle,
        int x, int y, int nWidth, int nHeight,
        IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterWindowMessageW(string lpString);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyMenu(IntPtr hMenu);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AppendMenuW(IntPtr hMenu, int uFlags, int uIDNewItem, string? lpNewItem);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetMenuDefaultItem(IntPtr hMenu, uint uItem, uint fByPos);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int TrackPopupMenuEx(IntPtr hMenu, int uFlags, int x, int y, IntPtr hwnd, IntPtr lptpm);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadImageW(IntPtr hInst, string name, int type, int cx, int cy, int fuLoad);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandleW(string? lpModuleName);
}
