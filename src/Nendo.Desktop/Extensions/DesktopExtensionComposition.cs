using System.Runtime.InteropServices;

namespace Nendo.Desktop;

/// <summary>Only the host positions the authenticated helper HWND inside its own window.</summary>
internal static class DesktopExtensionComposition
{
    internal static void Attach(DesktopExtensionProcess renderer, nint parent)
    {
        ExtensionNative.GetWindowThreadProcessId(parent, out var owner);
        ExtensionNative.GetWindowThreadProcessId(renderer.WindowHandle, out var childOwner);
        if (owner != Environment.ProcessId || childOwner != renderer.ProcessId || renderer.Session.IsClosed)
            throw new InvalidOperationException("The custom-view window identity changed.");
        if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(parent), GetWindowDpiAwarenessContext(renderer.WindowHandle)))
            throw new InvalidOperationException("The custom-view window has incompatible display scaling. Use Studio instead.");
        var style = GetWindowLongPtr(renderer.WindowHandle, -16).ToInt64();
        Marshal.SetLastPInvokeError(0);
        SetWindowLongPtr(renderer.WindowHandle, -16, (nint)((style & ~0x80000000L) | 0x40000000L));
        if (Marshal.GetLastPInvokeError() != 0) throw new InvalidOperationException("The custom-view window could not be composed.");
        Marshal.SetLastPInvokeError(0);
        SetParent(renderer.WindowHandle, parent);
        if (Marshal.GetLastPInvokeError() != 0 || GetParent(renderer.WindowHandle) != parent)
            throw new InvalidOperationException("The custom-view window could not attach to Nendo.");
        ExtensionNative.Check(SetLayeredWindowAttributes(renderer.WindowHandle, 0, 255, 2), "Show contained view");
    }

    internal static void Place(DesktopExtensionProcess renderer, int x, int y, int width, int height)
    {
        if (renderer.Session.IsClosed) return;
        ExtensionNative.Check(SetWindowPos(renderer.WindowHandle, 0, x, y, Math.Max(1, width), Math.Max(1, height),
            0x0010 | 0x0004 | 0x0040), "Position contained view");
    }

    /// <summary>
    /// Take the contained window off screen while the boundary beside it is being dragged,
    /// and put it back afterwards.
    ///
    /// Resizing a browser hands its compositor new surfaces. At a maximized window the
    /// contained tree already holds about half of its 512 MiB Job, and resizing it along a
    /// drag walked it past the 480 MiB pressure notification, which fails closed: the view
    /// stopped mid-drag. Not resizing it at all while the pointer is down costs a moment
    /// where the pane shows its own background, and the view is still there afterwards.
    /// Neither call reports failure: a window that is already in the requested state
    /// returns false, which is not an error.
    /// </summary>
    internal static void Suspend(DesktopExtensionProcess renderer)
    {
        if (renderer.Session.IsClosed) return;
        ShowWindow(renderer.WindowHandle, 0); // SW_HIDE
    }

    internal static void Resume(DesktopExtensionProcess renderer)
    {
        if (renderer.Session.IsClosed) return;
        ShowWindow(renderer.WindowHandle, 8); // SW_SHOWNA -- visible without taking activation
    }

    [DllImport("user32.dll")] private static extern bool ShowWindow(nint window, int command);

    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetParent(nint child, nint parent);
    [DllImport("user32.dll")] internal static extern nint GetParent(nint window);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern nint GetWindowLongPtr(nint window, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)] private static extern nint SetWindowLongPtr(nint window, int index, nint value);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetLayeredWindowAttributes(nint window, uint key, byte alpha, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(nint window, nint after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern nint GetWindowDpiAwarenessContext(nint window);
    [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(nint first, nint second);
}
