using System.Runtime.InteropServices;

namespace Nendo.Desktop;

/// <summary>
/// The Win32 and COM entry points more than one part of the shell calls: the jump list and
/// the taskbar button create COM objects, the tray icon and the taskbar badges load small
/// icons from files, and the tray menu and the main window bring a window to the front.
/// </summary>
internal static class DesktopNativeMethods
{
    private const int IMAGE_ICON = 1;
    private const int LR_LOADFROMFILE = 0x00000010;
    private const int LR_DEFAULTSIZE = 0x00000040;
    private const int SM_CXSMICON = 49;
    private const int SM_CYSMICON = 50;

    /// <summary>
    /// The icon file at <paramref name="path"/> at the size the shell draws a small icon, or
    /// zero when it cannot be loaded. The caller owns the handle and frees it with
    /// <see cref="DestroyIcon"/>.
    /// </summary>
    internal static IntPtr LoadSmallIcon(string path, bool defaultSize) =>
        LoadImageW(IntPtr.Zero, path, IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON),
            defaultSize ? LR_LOADFROMFILE | LR_DEFAULTSIZE : LR_LOADFROMFILE);

    [DllImport("ole32.dll")]
    internal static extern int CoCreateInstance(
        in Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, in Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out object ppv);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadImageW(IntPtr hInst, string name, int type, int cx, int cy, int fuLoad);
}
