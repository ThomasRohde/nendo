using Microsoft.UI.Xaml;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>What the record page may ask of a view on it. Only the host starts, places and stops one.</summary>
internal interface IWorkbenchExtensionPanels
{
    Task<object> ShowAsync(string viewId, string recordId);
    object Place(string viewId, string recordId, DesktopExtensionPanelPlacement placement);
    object Close(string viewId, string recordId);
}

/// <summary>The one answer every panel request gets: whether that view is running for that record now.</summary>
internal sealed record ExtensionPanelView(string ViewId, string RecordId, bool Running);

/// <summary>A view on a record page stopped without being asked to. Drawn as text in its placeholder.</summary>
internal sealed record ExtensionPanelStoppedPayload(string FileSessionId, string ViewId, string RecordId, string Message);

public sealed partial class MainPage : IWorkbenchExtensionPanels
{
    /// <summary>
    /// The one view on a record page that runs in this window (ADR-0013, 2026-09-24): showing
    /// another stops it. At 220 to 270 MiB each, a view per placeholder would be most of a
    /// gigabyte for one page.
    /// </summary>
    private DesktopExtensionPanel? _extensionPanel;
    private int _nativeDialogsOpen;

    private static string ExtensionHelperDirectory()
    {
        var helper = Path.Combine(AppContext.BaseDirectory, "ExtensionHost");
#if DEBUG
        if (!Directory.Exists(helper)) helper = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "Nendo.ExtensionHost", "debug"));
#endif
        return helper;
    }

    private static string ExtensionScratchRoot() =>
        Path.Combine(DesktopRuntimeConfiguration.DeviceStateRoot ?? DesktopAppearanceStore.DefaultRoot, "extension-runs");

    async Task<object> IWorkbenchExtensionPanels.ShowAsync(string viewId, string recordId)
    {
        _extensionPanel?.Close();
        _extensionPanel = null;
        var window = App.CurrentWindow ?? throw new NendoPreconditionException("window-unavailable", "The Nendo window is unavailable.");
        var run = await _session.StartExtensionAsync(viewId, ExtensionHelperDirectory(), ExtensionScratchRoot(),
            ActualTheme == ElementTheme.Dark ? "dark" : "light", System.Globalization.CultureInfo.CurrentUICulture.Name, recordId: recordId);
        try
        {
            DesktopExtensionPanel? panel = null;
            panel = new DesktopExtensionPanel(run, WebHost, WinRT.Interop.WindowNative.GetWindowHandle(window), message =>
            {
                if (ReferenceEquals(_extensionPanel, panel)) _extensionPanel = null;
                PostWorkbenchEvent(WorkbenchEvents.ExtensionPanelStopped, new ExtensionPanelStoppedPayload(run.FileSessionId, viewId, recordId, message));
            });
            // A dialog already open keeps it hidden until the dialog closes.
            panel.Hold(_nativeDialogsOpen > 0);
            _extensionPanel = panel;
        }
        catch { await run.DisposeAsync(); throw; }
        return new ExtensionPanelView(viewId, recordId, true);
    }

    object IWorkbenchExtensionPanels.Place(string viewId, string recordId, DesktopExtensionPanelPlacement placement)
    {
        if (Running(viewId, recordId) is not { } panel) return new ExtensionPanelView(viewId, recordId, false);
        panel.Place(placement);
        return new ExtensionPanelView(viewId, recordId, !panel.IsClosed);
    }

    object IWorkbenchExtensionPanels.Close(string viewId, string recordId)
    {
        if (Running(viewId, recordId) is { } panel) { panel.Close(); _extensionPanel = null; }
        return new ExtensionPanelView(viewId, recordId, false);
    }

    private DesktopExtensionPanel? Running(string viewId, string recordId) =>
        _extensionPanel is { IsClosed: false } panel && panel.ViewId == viewId && panel.RecordId == recordId ? panel : null;

    /// <summary>The Workbench went away or the file closed: the page that asked for the view is gone.</summary>
    private void CloseExtensionPanel()
    {
        _extensionPanel?.Close();
        _extensionPanel = null;
    }

    /// <summary>
    /// A native dialog is drawn in XAML, and a contained window sits above all of XAML, so
    /// the view is hidden while any dialog is open rather than drawn over its buttons.
    /// </summary>
    private void TrackNativeDialog(Microsoft.UI.Xaml.Controls.ContentDialog dialog)
    {
        dialog.Opened += (_, _) => { _nativeDialogsOpen++; _extensionPanel?.Hold(true); };
        dialog.Closed += (_, _) => { _nativeDialogsOpen = Math.Max(0, _nativeDialogsOpen - 1); if (_nativeDialogsOpen == 0) _extensionPanel?.Hold(false); };
    }
}
