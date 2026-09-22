using System.Runtime.InteropServices;

namespace Nendo.Desktop;

/// <summary>
/// Who this process is, to the Windows shell.
/// <para>
/// The taskbar groups windows by Application User Model ID, the Jump List is stored
/// against one, and a notification is attributed to one. Without an explicit ID
/// Windows derives one from the executable path, which changes with the install
/// location and says nothing a person would recognise.
/// </para>
/// <para>
/// Nendo was already getting an ID, and that is the part worth knowing: the Windows
/// App SDK notification registration sets a generated one — but it runs in
/// <c>AttachShell</c>, after the window exists. A window created under one identity
/// and reassigned to another is how an application ends up with two taskbar buttons.
/// So this is applied in the <see cref="App"/> constructor, before anything is drawn.
/// </para>
/// </summary>
internal static class DesktopShellIdentity
{
    /// <summary>The identity a normal run uses. Stable across installs and versions.</summary>
    internal const string DefaultAppUserModelId = "Nendo.Desktop";

    private static bool _applied;

    /// <summary>
    /// The identity this process will use: the process owner's pin where there is one,
    /// otherwise <see cref="DefaultAppUserModelId"/>.
    /// </summary>
    /// <remarks>
    /// Resolved once, and a refused pin falls back rather than throwing. Everything
    /// that reads this runs while the first window is being built, where an exception
    /// is a process that exits before drawing anything — and this had exactly that
    /// shape, because the resolution sat outside the callers' try blocks.
    /// <para>
    /// Falling back silently would be wrong on its own: a lane that pinned a typo'd
    /// identity would then write into the machine's real taskbar menu believing it had
    /// one of its own. What makes it safe is that Review-ShellRuntime.ps1 asserts the
    /// window carries the identity it asked for, so a fallback fails there loudly.
    /// </para>
    /// </remarks>
    internal static string AppUserModelId =>
        _resolved ??= ResolveFrom(Environment.GetEnvironmentVariable);

    private static string? _resolved;

    /// <summary>The resolution on its own, so the fallback can be seen to happen.</summary>
    internal static string ResolveFrom(Func<string, string?> read)
    {
        try { return DesktopRuntimeConfiguration.ResolveAppUserModelId(read) ?? DefaultAppUserModelId; }
        catch (Exception) { return DefaultAppUserModelId; }
    }

    /// <summary>
    /// Names this process to the shell. Call before the first window.
    /// </summary>
    /// <remarks>
    /// Every failure is swallowed, including a refused override — the whole body is
    /// inside the try for that reason. A refused identity costs correct taskbar
    /// grouping and a Jump List; a launch that stopped over one would cost the person
    /// their file, and this runs before there is any window to say so in.
    /// </remarks>
    internal static void Apply()
    {
        if (_applied) return;
        _applied = true;
        try
        {
            SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
        }
        catch (Exception)
        {
            // Swallowed for the reason above. What this call did is not readable from
            // here: Review-ShellRuntime.ps1 measures it through the notification
            // registration, which Windows files under whatever identity it finds.
        }
    }

    /// <summary>
    /// Says it again, on the window itself.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The process identity is inherited by a window created after it, which is why
    /// <see cref="Apply"/> runs first. Writing it onto the window as well is belt and
    /// braces against anything that renames the process later — the Windows App SDK
    /// notification registration does exactly that — because a window keeps whatever
    /// the shell last recorded for it.
    /// </para>
    /// <para>
    /// It is also the only way the identity can be read back. There is no API to ask
    /// another process what it named itself; the window's property store is where
    /// Review-ShellRuntime.ps1 reads it, so this is what turns the identity from a call
    /// that was made into a fact that can be measured.
    /// </para>
    /// </remarks>
    internal static void ApplyToWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return;
        try
        {
            var iid = typeof(DesktopShellProperties.IPropertyStore).GUID;
            SHGetPropertyStoreForWindow(hwnd, ref iid, out var instance);
            if (instance is not DesktopShellProperties.IPropertyStore store) return;
            DesktopShellProperties.SetString(store, DesktopShellProperties.AppUserModelId, AppUserModelId);
        }
        catch (Exception)
        {
            // As above, and for the same reason: this is called from the window
            // constructor, where an escaping exception is a process that never drew
            // anything rather than a window with the wrong taskbar grouping.
        }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SetCurrentProcessExplicitAppUserModelID(
        [MarshalAs(UnmanagedType.LPWStr)] string appId);

    [DllImport("shell32.dll", PreserveSig = false)]
    private static extern void SHGetPropertyStoreForWindow(
        IntPtr hwnd, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
}
