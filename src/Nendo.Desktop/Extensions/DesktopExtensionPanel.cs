using Microsoft.UI.Xaml;

namespace Nendo.Desktop;

/// <summary>
/// Where the record page says a running view is, in the page's own CSS pixels from the top
/// left of the Workbench. <see cref="Clip"/> is the part the page shows; the rest is scrolled
/// away or under the page's own chrome. <see cref="Visible"/> false hides it outright: the
/// page is scrolling, a dialog is open, or the placeholder has left the screen.
/// </summary>
internal sealed record DesktopExtensionPanelPlacement(bool Visible, double X, double Y, double Width, double Height,
    double ClipX, double ClipY, double ClipWidth, double ClipHeight);

/// <summary>
/// A custom view on a record page (ADR-0013, 2026-09-24 record-set amendment; W-061). The
/// page draws the placeholder and reports where it is; the host starts the view only when
/// the person asks, places its contained window over the placeholder, cuts it to what the
/// page shows, and hides it while the page moves. It is never a XAML element: it floats over
/// the Workbench, which the pane never did, so it follows the page rather than a layout slot.
/// </summary>
internal sealed class DesktopExtensionPanel
{
    private readonly DesktopExtensionRunningView _run;
    private readonly FrameworkElement _workbench;
    private readonly Action<string> _stopped;
    private readonly CancellationTokenSource _closed = new();
    private DesktopExtensionPanelPlacement? _placement;
    private (int X, int Y, int Width, int Height) _placed;
    private bool _held;
    private bool _visible;

    internal string ViewId => _run.Grant.ViewId;
    internal string RecordId => _run.RecordId!;
    internal string FileSessionId => _run.FileSessionId;
    internal bool IsClosed => _closed.IsCancellationRequested || _run.IsClosed;

    /// <param name="stopped">Called once, on the UI thread, with the sentence the placeholder shows.</param>
    internal DesktopExtensionPanel(DesktopExtensionRunningView run, FrameworkElement workbench, nint window, Action<string> stopped)
    {
        _run = run; _workbench = workbench; _stopped = stopped;
        DesktopExtensionComposition.Attach(_run.Renderer, window);
        // Nothing shows until the page has said where.
        DesktopExtensionComposition.Suspend(_run.Renderer);
        _ = WatchAsync();
    }

    internal void Place(DesktopExtensionPanelPlacement placement)
    {
        if (IsClosed) return;
        _placement = placement;
        Apply();
    }

    /// <summary>A native dialog is open over the page; the view's window would sit on top of it.</summary>
    internal void Hold(bool held)
    {
        if (_held == held) return;
        _held = held;
        Apply();
    }

    private void Apply()
    {
        if (IsClosed) return;
        try
        {
            var placement = _placement;
            if (_held || placement is not { Visible: true } || placement.ClipWidth < 1 || placement.ClipHeight < 1 || _workbench.XamlRoot is null)
            {
                if (_visible) { DesktopExtensionComposition.Suspend(_run.Renderer); _visible = false; }
                return;
            }
            var origin = _workbench.TransformToVisual(null).TransformPoint(new(0, 0));
            var scale = _workbench.XamlRoot.RasterizationScale;
            int Px(double value) => (int)Math.Round(value * scale);
            // Whole size, so the page inside is never squeezed; a resize only when the
            // placeholder itself changes size, which scrolling does not do.
            var rect = (Px(origin.X + placement.X), Px(origin.Y + placement.Y), Px(placement.Width), Px(placement.Height));
            if (rect != _placed)
            {
                _placed = rect;
                DesktopExtensionComposition.Place(_run.Renderer, rect.Item1, rect.Item2, rect.Item3, rect.Item4);
            }
            // The clip in the contained window's own coordinates, and never outside the Workbench.
            var clipLeft = Math.Max(placement.ClipX, 0);
            var clipTop = Math.Max(placement.ClipY, 0);
            var clipRight = Math.Min(placement.ClipX + placement.ClipWidth, _workbench.ActualWidth);
            var clipBottom = Math.Min(placement.ClipY + placement.ClipHeight, _workbench.ActualHeight);
            DesktopExtensionComposition.Clip(_run.Renderer, Px(clipLeft - placement.X), Px(clipTop - placement.Y),
                Math.Max(0, Px(clipRight - clipLeft)), Math.Max(0, Px(clipBottom - clipTop)));
            if (!_visible) { DesktopExtensionComposition.Resume(_run.Renderer); _visible = true; }
        }
        catch (Exception error) { Fail(error.Message); }
    }

    /// <summary>Stops the view. The placeholder is the page's to redraw; the host says nothing more.</summary>
    internal void Close()
    {
        if (_closed.IsCancellationRequested) return;
        _closed.Cancel();
        _ = _run.DisposeAsync();
    }

    internal async Task SendThemeAsync(bool dark)
    {
        if (IsClosed) return;
        try
        {
            var message = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            { version = _run.Grant.ProtocolVersion, method = "setTheme", session = _run.Renderer.Session.SessionId,
                generation = _run.Renderer.Session.Generation, theme = dark ? "dark" : "light" });
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_closed.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            await Task.Run(() => _run.Renderer.SendAsync(message, timeout.Token));
        }
        catch (Exception error) { Fail(error.Message); }
    }

    private async Task WatchAsync()
    {
        try
        {
            while (!_closed.IsCancellationRequested)
            {
                var message = await Task.Run(() => _run.Renderer.ReceiveAsync(_closed.Token));
                if (_run.IsClosed) break;
                if (message.Accepted && message.Code is "render-failed" or "unsupported-projection")
                { Fail("The package could not display this record. The page is still yours to edit, and Studio is available."); return; }
            }
            if (!_closed.IsCancellationRequested) Fail(StoppedBecause("This view has closed."));
        }
        catch (Exception) { if (!_closed.IsCancellationRequested) Fail(StoppedBecause("This view has stopped.")); }
    }

    /// <summary>The same reasons the pane gives, because the containment is the same.</summary>
    private string StoppedBecause(string fallback) => _run.StopMessage is { } host ? host + " The page is still yours to edit." : (_run.Renderer.ResourceStopReason switch
    {
        "memory-pressure" => "This view asked for more memory than it is allowed, so Nendo stopped it.",
        "process-limit" => "This view started more processes than it is allowed, so Nendo stopped it.",
        "resource-monitor-failed" => "Nendo could not keep watching what this view was using, so it stopped it.",
        _ => fallback,
    }) + " The page is still yours to edit.";

    private void Fail(string message)
    {
        if (_closed.IsCancellationRequested) return;
        _closed.Cancel();
        _run.Stop();
        _ = _run.DisposeAsync();
        _stopped(message);
    }
}
