using Microsoft.Web.WebView2.Core;

namespace Nendo.Desktop;

/// <summary>
/// Where the Workbench's browser keeps its profile: its cache, cookies and page storage,
/// which holds a view's unsaved drafts and settings.
/// <para>
/// Under the device-state folder (%LOCALAPPDATA%\Nendo), beside everything else this
/// device remembers. WebView2's default is a folder beside the executable, which put about
/// 100 MB of profile inside the install folder: setup does not own it, so uninstall left it
/// behind for good, and every setup run walked it. Setup moves that old folder here once,
/// when nothing is here yet (Invoke-NendoSetup.ps1, whose default destination
/// DesktopBrowserProfileTests pins to this one).
/// </para>
/// <para>
/// A Debug build keeps a folder of its own, so a development host never shares a browser
/// process or page storage with the installed Nendo. WEBVIEW2_USER_DATA_FOLDER still wins
/// when the process owner sets it, as the lanes do: WebView2 gives that variable precedence
/// over the folder an application passes, so reading it here keeps this answer and the
/// browser's in agreement.
/// </para>
/// </summary>
internal static class DesktopBrowserProfile
{
    internal const string FolderName = "WebView2";
    internal const string DebugFolderName = "WebView2-debug";

    internal static string ResolveUserDataFolder(Func<string, string?> read, string deviceStateRoot, bool debugBuild)
    {
        var chosen = read("WEBVIEW2_USER_DATA_FOLDER");
        if (!string.IsNullOrWhiteSpace(chosen)) return Path.GetFullPath(chosen);
        return Path.Combine(Path.GetFullPath(deviceStateRoot), debugBuild ? DebugFolderName : FolderName);
    }

    private static bool DebugBuild =>
#if DEBUG
        true;
#else
        false;
#endif

    internal static string UserDataFolder =>
        ResolveUserDataFolder(Environment.GetEnvironmentVariable, DesktopAppearanceStore.DefaultRoot, DebugBuild);

    /// <summary>The browser environment every Workbench view in this process starts in.</summary>
    internal static Task<CoreWebView2Environment> CreateEnvironmentAsync() =>
        CoreWebView2Environment.CreateWithOptionsAsync(null, UserDataFolder, new CoreWebView2EnvironmentOptions()).AsTask();
}
