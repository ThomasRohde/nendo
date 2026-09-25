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

    Task<IReadOnlyList<ExtensionFrameProcess>> IWorkbenchExtensionHost.ReadFrameProcessesAsync() =>
        ExtensionFrameDiagnostics.ReadAsync(_webView?.CoreWebView2 ?? throw new NendoPreconditionException(
            "workbench-unavailable", "The app view is not running."));
}
