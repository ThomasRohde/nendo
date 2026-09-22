using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Nendo.Desktop;

/// <summary>
/// A custom view lives in a pane of the main window, beside Studio and Use, so a selected
/// node opens next to the graph rather than in a second window. The toolbar belongs to
/// Nendo; only the bounded viewport belongs to the contained helper, whose HWND is a child
/// of the main window placed over that viewport.
/// </summary>
internal sealed class DesktopExtensionPane : Grid
{
    private readonly DesktopSessionController _session;
    private readonly DesktopExtensionRunningView _run;
    private readonly Border _viewport = new();
    private readonly TextBlock _notice = new() { Text = "Select a node, then choose Open record. F6 moves between the graph and these controls.", TextWrapping = TextWrapping.Wrap };
    private readonly Button _open = new() { Content = "Open record" };
    private readonly CancellationTokenSource _closed = new();
    private bool _attached;
    private (int X, int Y, int Width, int Height) _placed;
    /// <summary>
    /// How often the contained window may actually be resized.
    ///
    /// Resizing a browser is not free, so a window the person is dragging the edge of does
    /// not need a resize per layout pass. Sixteen times a second still reads as live.
    ///
    /// This bounds the work; it is not what keeps a dragged boundary from killing the view.
    /// Throttling to this interval was measured and the view still stopped: the fix is
    /// <see cref="SuspendPlacement"/>, which resizes it no times at all while the pointer
    /// is down.
    /// </summary>
    private const int PlaceIntervalMs = 60;
    private readonly DispatcherTimer _placeTimer = new() { Interval = TimeSpan.FromMilliseconds(PlaceIntervalMs) };
    private readonly System.Diagnostics.Stopwatch _sincePlaced = System.Diagnostics.Stopwatch.StartNew();
    private bool _placePending;
    private bool _suspended;
    internal event Action? Closed;

    internal void ApplyTheme(ElementTheme theme)
    {
        RequestedTheme = theme;
        Background = new SolidColorBrush(theme == ElementTheme.Dark
            ? Windows.UI.Color.FromArgb(255, 10, 28, 43) : Windows.UI.Color.FromArgb(255, 247, 248, 251));
    }

    internal DesktopExtensionPane(DesktopSessionController session, DesktopExtensionRunningView run, string title,
        ElementTheme theme, Action studio, Action<string, string, string> openRecord)
    {
        _session = session; _run = run;
        // A layout panel has no automation peer of its own; the pane is addressed through its controls.
        AutomationProperties.SetAutomationId(_notice, "extensions.notice");
        ApplyTheme(theme);
        RowDefinitions.Add(new() { Height = GridLength.Auto });
        RowDefinitions.Add(new() { Height = GridLength.Auto });
        RowDefinitions.Add(new() { Height = new(1, GridUnitType.Star) });
        var toolbar = new Grid { ColumnSpacing = 8, RowSpacing = 8, Margin = new(16, 12, 16, 8) };
        var refresh = new Button { Content = "Refresh" };
        var studioButton = new Button { Content = "Studio" };
        var disable = new Button { Content = "Disable view" };
        var close = new Button { Content = "Close" };
        var graph = new Button { Content = "Focus graph" };
        var controls = new[] { _open, graph, refresh, studioButton, disable, close };
        foreach (var button in controls) toolbar.Children.Add(button);
        void ArrangeToolbar()
        {
            var columns = toolbar.ActualWidth is > 0 and < 760 ? 3 : 6;
            if (toolbar.ColumnDefinitions.Count == columns) return;
            toolbar.ColumnDefinitions.Clear(); toolbar.RowDefinitions.Clear();
            for (var i = 0; i < columns; i++) toolbar.ColumnDefinitions.Add(new() { Width = GridLength.Auto });
            for (var i = 0; i < controls.Length / columns; i++) toolbar.RowDefinitions.Add(new() { Height = GridLength.Auto });
            for (var i = 0; i < controls.Length; i++) { Grid.SetColumn(controls[i], i % columns); Grid.SetRow(controls[i], i / columns); }
        }
        ArrangeToolbar();
        toolbar.SizeChanged += (_, _) => ArrangeToolbar();
        AutomationProperties.SetAutomationId(_open, "extensions.openRecord");
        AutomationProperties.SetAutomationId(studioButton, "extensions.studio");
        AutomationProperties.SetAutomationId(graph, "extensions.focusGraph");
        AutomationProperties.SetAutomationId(_viewport, "extensions.viewport");
        Children.Add(toolbar);
        _notice.Margin = new(16, 0, 16, 12); Grid.SetRow(_notice, 1); Children.Add(_notice);
        Grid.SetRow(_viewport, 2); Children.Add(_viewport);
        KeyDown += async (_, e) =>
        {
            if (e.Key != Windows.System.VirtualKey.F6) return;
            e.Handled = true; await FocusGraphAsync();
        };
        graph.Click += async (_, _) => await FocusGraphAsync();
        Loaded += (_, _) => Attach();
        _placeTimer.Tick += (_, _) => { _placeTimer.Stop(); _placePending = false; Place(); };
        _viewport.SizeChanged += (_, _) => RequestPlace();
        _viewport.LayoutUpdated += (_, _) => RequestPlace(); // The pane moves when the layout beside it changes, not only when it resizes.
        ActualThemeChanged += async (_, _) => await SendThemeAsync();
        _open.Click += async (_, _) =>
        {
            try
            {
                var target = await _session.GetExtensionSelectionAsync(_run);
                if (target is { } record) openRecord(_run.FileSessionId, record.EntityId, record.RecordId);
                else _notice.Text = "Select a current node. If the file changed, refresh the graph first.";
            }
            catch (Exception error) { Fail(error.Message); }
        };
        refresh.Click += async (_, _) =>
        {
            try { await _session.RefreshExtensionAsync(_run, _closed.Token); _notice.Text = "Showing the current records. Select a node to open it."; }
            catch (Exception error) { Fail(error.Message); }
        };
        studioButton.Click += (_, _) => studio();
        disable.Click += async (_, _) =>
        {
            try
            {
                using var scope = _session.BindFileRequest(run.FileSessionId);
                await _session.DisableExtensionAsync(run.Grant.ViewId);
                Fail("This view is disabled. Your records remain available in Studio.");
            }
            catch (Exception error) { Fail(error.Message); }
        };
        close.Click += (_, _) => Close();
        _ = WatchAsync();
    }

    /// <summary>Ends the view: the run is disposed (which stops the helper and its tree) and the host removes the pane.</summary>
    internal void Close()
    {
        if (_closed.IsCancellationRequested) return;
        _placeTimer.Stop();
        _closed.Cancel();
        _ = _run.DisposeAsync();
        Closed?.Invoke();
    }

    private void Attach()
    {
        if (_closed.IsCancellationRequested || _attached) return;
        try
        {
            var window = App.CurrentWindow ?? throw new InvalidOperationException("The main window is unavailable.");
            DesktopExtensionComposition.Attach(_run.Renderer, WinRT.Interop.WindowNative.GetWindowHandle(window));
            _attached = true; Place();
        }
        catch (Exception error) { Fail(error.Message); }
    }

    /// <summary>
    /// Place now if the last one is old enough, otherwise once the interval is up. The
    /// trailing timer is what makes this safe: the position a drag ends at arrives even
    /// though the moves that produced it were dropped.
    /// </summary>
    /// <summary>
    /// While the boundary beside the pane is being dragged, the contained window is neither
    /// moved nor resized. See <see cref="DesktopExtensionComposition.Suspend"/> for what a
    /// resize per pointer move costs.
    /// </summary>
    internal void SuspendPlacement()
    {
        if (_suspended || !_attached || _run.IsClosed || _closed.IsCancellationRequested) return;
        _suspended = true;
        _placeTimer.Stop();
        _placePending = false;
        try { DesktopExtensionComposition.Suspend(_run.Renderer); }
        catch (Exception error) { Fail(error.Message); }
    }

    internal void ResumePlacement()
    {
        if (!_suspended) return;
        _suspended = false;
        if (_run.IsClosed || _closed.IsCancellationRequested) return;
        // The rect it was last placed at is stale by the whole length of the drag.
        _placed = default;
        Place();
        try { DesktopExtensionComposition.Resume(_run.Renderer); }
        catch (Exception error) { Fail(error.Message); }
    }

    private void RequestPlace()
    {
        if (_suspended) return;
        if (_sincePlaced.ElapsedMilliseconds >= PlaceIntervalMs) { Place(); return; }
        if (_placePending) return;
        _placePending = true;
        _placeTimer.Start();
    }

    private void Place()
    {
        if (_suspended || !_attached || _run.IsClosed || XamlRoot is null) return;
        try
        {
            // Coordinates are relative to the window's XAML root, which starts at the client origin the child HWND is placed in.
            var origin = _viewport.TransformToVisual(null).TransformPoint(new(0, 0));
            var scale = XamlRoot.RasterizationScale;
            var rect = ((int)Math.Round(origin.X * scale), (int)Math.Round(origin.Y * scale),
                (int)Math.Round(_viewport.ActualWidth * scale), (int)Math.Round(_viewport.ActualHeight * scale));
            if (rect == _placed) return;
            _placed = rect;
            _sincePlaced.Restart();
            DesktopExtensionComposition.Place(_run.Renderer, rect.Item1, rect.Item2, rect.Item3, rect.Item4);
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
                if (message.Accepted && message.Code == "focus-host")
                {
                    // The helper is a child of this window, which is therefore already active. Activating it again
                    // would restore focus to the Workbench beside the pane and race the move to Open record.
                    _open.Focus(FocusState.Keyboard); continue;
                }
                if (message.Accepted && message.Code is "render-failed" or "unsupported-projection")
                { Fail("The package could not display this graph. Open Studio to continue."); return; }
            }
            if (!_closed.IsCancellationRequested) Fail(StoppedBecause("This view has closed."));
        }
        catch (Exception) { if (!_closed.IsCancellationRequested) Fail(StoppedBecause("This view has stopped.")); }
    }

    /// <summary>
    /// Why it stopped, when the containment knows. The transport only reports that it broke,
    /// so without this a view the Job shut down for using too much memory and a view whose
    /// page simply exited read the same, and the person is told nothing they can act on.
    /// </summary>
    private string StoppedBecause(string fallback) => (_run.Renderer.ResourceStopReason switch
    {
        "memory-pressure" => "This view asked for more memory than it is allowed, so Nendo stopped it.",
        "process-limit" => "This view started more processes than it is allowed, so Nendo stopped it.",
        "resource-monitor-failed" => "Nendo could not keep watching what this view was using, so it stopped it.",
        _ => fallback,
    }) + " Studio and your records are still available.";

    private async Task FocusGraphAsync()
    {
        if (_run.IsClosed || _closed.IsCancellationRequested) return;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_closed.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            await Task.Run(() => _run.Renderer.SendAsync("{\"method\":\"focus\"}"u8.ToArray(), timeout.Token));
        }
        catch (Exception error) { Fail(error.Message); }
    }

    private async Task SendThemeAsync()
    {
        if (_run.IsClosed || _closed.IsCancellationRequested) return;
        try
        {
            var message = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(new
            { version = 1, method = "setTheme", session = _run.Renderer.Session.SessionId,
                generation = _run.Renderer.Session.Generation, theme = ActualTheme == ElementTheme.Dark ? "dark" : "light" });
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_closed.Token);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            await Task.Run(() => _run.Renderer.SendAsync(message, timeout.Token));
        }
        catch (Exception error) { Fail(error.Message); }
    }

    private void Fail(string message)
    {
        _run.Stop(); _open.IsEnabled = false; _notice.Text = message;
        _ = _run.DisposeAsync();
    }
}
