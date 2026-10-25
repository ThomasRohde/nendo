using Microsoft.Web.WebView2.Core;
using Windows.Graphics;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Nendo.Desktop;

/// <summary>
/// The page's half of moving a tab into a window of its own (ADR-0002): the
/// Workbench hands over the tab's trail, and the window this page is in opens another window of
/// the same file on it, or gives it to the window of the file it was let go over.
/// </summary>
public sealed partial class MainPage : IWorkbenchTabWindowHost
{
    /// <summary>The Workbench here has started and asked its role, so a tab handed to it is heard.</summary>
    private bool _tabsReady;

    bool IWorkbenchTabWindowHost.IsTabWindow => _sharesSession;

    /// <summary>Whether a tab from another window can be handed to this page now.</summary>
    internal bool IsReadyForTabs => _tabsReady && !_unloaded && _webView?.CoreWebView2 is not null;

    string IWorkbenchTabWindowHost.DetachTab(string trail, bool atPointer, bool last)
    {
        var window = Owner ?? throw new Nendo.Engine.NendoPreconditionException("window-unavailable", "The window is not available.");
        if (!_session.HasFile)
            throw new Nendo.Engine.NendoPreconditionException("no-file", "A tab moves to a window of its own only while a file is open.");
        return window.MoveTab(_session, trail, atPointer, last);
    }

    /// <summary>
    /// The dragged tab's picture: what the page last drew, cut at the tab's box and drawn on a tab's
    /// background. The window follows the pointer from the start, and shows the picture once it is
    /// cut, unless the drag has ended meanwhile.
    /// </summary>
    async Task IWorkbenchTabWindowHost.BeginTabDragAsync(TabDragPicture picture)
    {
        var window = Owner ?? throw new Nendo.Engine.NendoPreconditionException("window-unavailable", "The window is not available.");
        var generation = window.StartTabDrag();
        var core = _webView?.CoreWebView2;
        if (core is null) return;
        using var stream = new InMemoryRandomAccessStream();
        await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, stream);
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        var scale = decoder.PixelWidth / picture.ViewportWidth;
        if (DesktopTabWindowRules.PictureBounds(picture, scale, (int)decoder.PixelWidth, (int)decoder.PixelHeight) is not { } bounds) return;
        var data = await decoder.GetPixelDataAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied,
            new BitmapTransform { Bounds = new BitmapBounds { X = (uint)bounds.X, Y = (uint)bounds.Y, Width = (uint)bounds.Width, Height = (uint)bounds.Height } },
            ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
        var pixels = DesktopTabWindowRules.ComposePicture(data.DetachPixelData(), bounds.Width, bounds.Height,
            picture.Background, picture.Border, (int)Math.Round(picture.Radius * scale),
            picture.Outline, (int)Math.Round(picture.OutlineWidth * scale));
        window.ShowTabDragPicture(generation, pixels, bounds.Width, bounds.Height,
            new PointInt32((int)Math.Round(picture.GrabX * scale), (int)Math.Round(picture.GrabY * scale)),
            DesktopTabWindowRules.DashesAlongTop(pixels, bounds.Width, picture.Outline));
    }

    void IWorkbenchTabWindowHost.EndTabDrag(bool dropped) =>
        (Owner ?? throw new Nendo.Engine.NendoPreconditionException("window-unavailable", "The window is not available.")).EndTabDrag(dropped);

    /// <summary>A tab of another window of this file, let go over this page's tabs at <paramref name="x"/>.</summary>
    internal void ReceiveTab(string trail, double? x) => PostWorkbenchEvent(WorkbenchEvents.TabArrived, new { trail, x });

    /// <summary>A tab from another window is held over this page's tabs at <paramref name="x"/>, or no longer.</summary>
    internal void ShowTabDropTarget(double? x) => PostWorkbenchEvent(WorkbenchEvents.TabDropTarget, new { x });

    TabDragDiagnostics IWorkbenchTabWindowHost.DiagnoseTabDrag(bool setPoint, (double X, double Y)? point) =>
        (Owner ?? throw new Nendo.Engine.NendoPreconditionException("window-unavailable", "The window is not available.")).DiagnoseTabDrag(setPoint, point);

    void IWorkbenchTabWindowHost.CloseWindow() =>
        (Owner ?? throw new Nendo.Engine.NendoPreconditionException("window-unavailable", "The window is not available.")).CloseTabWindowForDiagnostics();

    // The tray's Exit, which no journey can press: RequestExit is what its menu entry calls. Queued,
    // so this request is answered first.
    void IWorkbenchTabWindowHost.Exit() =>
        DispatcherQueue.TryEnqueue(() => App.CurrentWindow?.RequestExit());

    TabWindowStart IWorkbenchTabWindowHost.TakeTab()
    {
        var trail = _pendingTab;
        _pendingTab = null;
        _tabsReady = true;
        return new(_sharesSession ? "tab" : "main", trail);
    }
}
