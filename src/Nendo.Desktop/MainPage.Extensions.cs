using Microsoft.Windows.Storage.Pickers;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>The pickers for bringing a custom-view package into a file and taking one out.</summary>
public sealed partial class MainPage : IWorkbenchExtensionHost
{
    async Task<string?> IWorkbenchExtensionHost.PickPackageSourceAsync()
    {
        var window = App.CurrentWindow ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        // One picker for both shapes a package comes in: choosing a folder's nendo-package.json
        // means that folder, and a zip or a .nendoview means itself.
        var picker = new FileOpenPicker(window.AppWindow.Id)
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            CommitButtonText = "Add to file",
            FileTypeFilter = { ".json", ".zip", ".nendoview" },
        };
        var file = await picker.PickSingleFileAsync();
        return file?.Path;
    }

    async Task<string?> IWorkbenchExtensionHost.PickExportFolderAsync()
    {
        var window = App.CurrentWindow ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FolderPicker(window.AppWindow.Id)
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            CommitButtonText = "Export here",
        };
        var folder = await picker.PickSingleFolderAsync();
        return folder?.Path;
    }

    async Task<string?> IWorkbenchExtensionHost.PickDevelopmentFolderAsync()
    {
        // The journeys cannot press a native picker. Under native diagnostics alone, the folder a
        // test names in the environment is the one picked; nothing else can reach this.
        if (DesktopRuntimeConfiguration.NativeDiagnostics &&
            Environment.GetEnvironmentVariable("NENDO_DIAGNOSTICS_DEVELOPMENT_FOLDER") is { Length: > 0 } scripted)
            return scripted;
        var window = App.CurrentWindow ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FolderPicker(window.AppWindow.Id)
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            CommitButtonText = "Develop from this folder",
        };
        var folder = await picker.PickSingleFolderAsync();
        return folder?.Path;
    }

    /// <summary>A package developed from a folder changed there: its views load it again.</summary>
    internal void ExtensionDevelopmentChanged(string packageId) =>
        PostWorkbenchEvent(WorkbenchEvents.ExtensionDevelopmentChanged, new { packageId });

    Task<IReadOnlyList<ExtensionFrameProcess>> IWorkbenchExtensionHost.ReadFrameProcessesAsync() =>
        ExtensionFrameDiagnostics.ReadAsync(_webView?.CoreWebView2 ?? throw new NendoPreconditionException(
            "workbench-unavailable", "The app view is not running."));
}
