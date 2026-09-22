using System.Runtime.InteropServices;

namespace Nendo.Desktop;

internal enum DesktopShellBadgeKind
{
    /// <summary>Nothing worth saying. The taskbar button carries no overlay.</summary>
    None,

    /// <summary>Something is waiting for the person: approval, or recovery.</summary>
    Attention,

    /// <summary>The file is open but cannot be changed.</summary>
    ReadOnly,
}

/// <summary>
/// What the open file's state is worth saying outside the window, in one place.
/// <para>
/// The notification-area tooltip and the taskbar overlay say the same thing in
/// different ways, so they share the choice rather than each making it. Two copies of
/// this precedence would eventually disagree, and the one nobody was looking at would
/// be the wrong one.
/// </para>
/// </summary>
internal sealed record DesktopShellBadge(DesktopShellBadgeKind Kind, string? Reason)
{
    private static readonly DesktopShellBadge Nothing = new(DesktopShellBadgeKind.None, null);

    internal static DesktopShellBadge For(DesktopShellState state) => state switch
    {
        { RequiresApproval: true, IsApproved: false } => new(DesktopShellBadgeKind.Attention, "Approval needed"),
        { Health: "readOnly" } => new(DesktopShellBadgeKind.ReadOnly, "Read-only"),
        { Health: "recoveryRequired" } => new(DesktopShellBadgeKind.Attention, "Recovery needed"),
        _ => Nothing,
    };

    /// <summary>
    /// The notification-area tooltip: the product, the open file, and the reason where
    /// there is one. Lower case in brackets, because it reads as an aside to the file
    /// name rather than as a second sentence.
    /// </summary>
    internal string Tooltip(string? fileName)
    {
        var head = fileName is null ? "Nendo" : $"Nendo — {fileName}";
        return Reason is null ? head : $"{head} ({Reason.ToLowerInvariant()})";
    }
}

/// <summary>
/// The taskbar button: an overlay badge, and a progress state while a file action runs.
/// <para>
/// Both are for the person who is not looking at the window. A file waiting on approval
/// behind three other windows is exactly the state the frame already shows and nobody
/// can see, and a backup that takes ten seconds looks identical to a frozen application
/// from the taskbar.
/// </para>
/// <para>
/// Hand-rolled interop for the same reason as the notification area: one shell
/// interface and two methods of it. Everything fails quietly — a taskbar that refused
/// an overlay is a missing hint, and the window still says it all.
/// </para>
/// </summary>
internal sealed class DesktopTaskbarStatus : IDisposable
{
    private const uint CLSCTX_INPROC_SERVER = 1;
    private const int TBPF_NOPROGRESS = 0;
    private const int TBPF_INDETERMINATE = 1;
    private const int IMAGE_ICON = 1;
    private const int LR_LOADFROMFILE = 0x00000010;
    private const int LR_DEFAULTSIZE = 0x00000040;
    private const int SM_CXSMICON = 49;
    private const int SM_CYSMICON = 50;

    private static readonly Guid CLSID_TaskbarList = new("56fdf344-fd6d-11d0-958a-006097c9a090");
    private static readonly Guid IID_ITaskbarList3 = new("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf");

    private readonly IntPtr _hwnd;
    private readonly Dictionary<DesktopShellBadgeKind, IntPtr> _icons = [];
    private ITaskbarList3? _taskbar;
    private DesktopShellBadge? _badge;
    private bool _busy;
    private bool _disposed;

    internal DesktopTaskbarStatus(IntPtr hwnd)
    {
        _hwnd = hwnd;
        try
        {
            if (CoCreateInstance(CLSID_TaskbarList, IntPtr.Zero, CLSCTX_INPROC_SERVER, IID_ITaskbarList3, out var instance) != 0)
                return;
            if (instance is not ITaskbarList3 taskbar) return;
            taskbar.HrInit();
            _taskbar = taskbar;
        }
        catch (Exception exception) when (exception is COMException or InvalidCastException or NotSupportedException or PlatformNotSupportedException)
        {
            _taskbar = null;
        }
    }

    /// <summary>
    /// Puts the state on the taskbar button. Repeating the current badge does nothing,
    /// because every redraw of the shell state calls this and the taskbar animates.
    /// </summary>
    /// <remarks>
    /// The cache is written after the call, not before. A button that does not exist
    /// yet refuses the overlay, and recording the refusal as applied would mean the
    /// badge never appeared and nothing ever tried again.
    /// </remarks>
    internal void Apply(DesktopShellBadge badge)
    {
        if (_disposed || _taskbar is not { } taskbar) return;
        if (_badge == badge) return;
        try
        {
            taskbar.SetOverlayIcon(_hwnd, IconFor(badge.Kind), badge.Reason ?? string.Empty);
            _badge = badge;
        }
        catch (Exception exception) when (exception is COMException or InvalidCastException)
        {
        }
    }

    /// <summary>
    /// The taskbar button is gone, so nothing this remembers about it is true.
    /// <para>
    /// Hiding the window to the notification area destroys the button; showing it
    /// again creates a fresh one with no overlay and no progress. Without this the
    /// window would come back bare and stay bare until the state next changed — which
    /// is exactly the moment a badge exists to survive.
    /// </para>
    /// </summary>
    internal void Forget()
    {
        _badge = null;
        _busy = false;
    }

    /// <summary>
    /// Says a file action is running, or has stopped. Indeterminate rather than a
    /// percentage: none of these actions can honestly report how far through it is,
    /// and a bar that jumps from nowhere to done is worse than one that just moves.
    /// </summary>
    internal void SetBusy(bool busy)
    {
        if (_disposed || _taskbar is not { } taskbar || _busy == busy) return;
        try
        {
            taskbar.SetProgressState(_hwnd, busy ? TBPF_INDETERMINATE : TBPF_NOPROGRESS);
            _busy = busy;
        }
        catch (Exception exception) when (exception is COMException or InvalidCastException)
        {
        }
    }

    private IntPtr IconFor(DesktopShellBadgeKind kind)
    {
        if (kind == DesktopShellBadgeKind.None) return IntPtr.Zero;
        if (_icons.TryGetValue(kind, out var cached)) return cached;
        var name = kind == DesktopShellBadgeKind.Attention ? "OverlayAttention.ico" : "OverlayReadOnly.ico";
        var path = Path.Combine(AppContext.BaseDirectory, "Assets", name);
        var handle = File.Exists(path)
            ? LoadImageW(IntPtr.Zero, path, IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), LR_LOADFROMFILE | LR_DEFAULTSIZE)
            : IntPtr.Zero;
        // A failure is not cached. Caching zero would make one unreadable moment — a
        // file being replaced by an upgrade, say — a badge that is invisible for the
        // rest of the session and says nothing about why.
        if (handle != IntPtr.Zero) _icons[kind] = handle;
        return handle;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_taskbar is { } taskbar)
        {
            // Clear both before letting go. A window that has gone leaves its button
            // behind for a moment, and a badge on it would outlive what it described.
            try { taskbar.SetOverlayIcon(_hwnd, IntPtr.Zero, string.Empty); } catch (COMException) { }
            try { taskbar.SetProgressState(_hwnd, TBPF_NOPROGRESS); } catch (COMException) { }
            try { Marshal.ReleaseComObject(taskbar); } catch (ArgumentException) { }
            _taskbar = null;
        }
        foreach (var icon in _icons.Values.Where(handle => handle != IntPtr.Zero)) DestroyIcon(icon);
        _icons.Clear();
    }

    [DllImport("ole32.dll")]
    private static extern int CoCreateInstance(
        in Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, in Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadImageW(IntPtr hInst, string name, int type, int cx, int cy, int fuLoad);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetSystemMetrics(int nIndex);

    // Declared in full to the method this uses, because a COM interface is its vtable
    // order: leaving an earlier member out would call a different function.
    [ComImport, Guid("ea1afb91-9e28-4b86-90e9-9e9f8a5eefaf"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ITaskbarList3
    {
        void HrInit();
        void AddTab(IntPtr hwnd);
        void DeleteTab(IntPtr hwnd);
        void ActivateTab(IntPtr hwnd);
        void SetActiveAlt(IntPtr hwnd);
        void MarkFullscreenWindow(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool fFullscreen);
        void SetProgressValue(IntPtr hwnd, ulong ullCompleted, ulong ullTotal);
        void SetProgressState(IntPtr hwnd, int tbpFlags);
        void RegisterTab(IntPtr hwndTab, IntPtr hwndMDI);
        void UnregisterTab(IntPtr hwndTab);
        void SetTabOrder(IntPtr hwndTab, IntPtr hwndInsertBefore);
        void SetTabActive(IntPtr hwndTab, IntPtr hwndMDI, uint dwReserved);
        void ThumbBarAddButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
        void ThumbBarUpdateButtons(IntPtr hwnd, uint cButtons, IntPtr pButton);
        void ThumbBarSetImageList(IntPtr hwnd, IntPtr himl);
        void SetOverlayIcon(IntPtr hwnd, IntPtr hIcon, [MarshalAs(UnmanagedType.LPWStr)] string pszDescription);
        void SetThumbnailTooltip(IntPtr hwnd, [MarshalAs(UnmanagedType.LPWStr)] string pszTip);
        void SetThumbnailClip(IntPtr hwnd, IntPtr prcClip);
    }
}
