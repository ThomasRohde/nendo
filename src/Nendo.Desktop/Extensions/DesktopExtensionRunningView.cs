using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>Native-owned lifetime; neither a page nor a package can construct this capability.</summary>
internal sealed class DesktopExtensionRunningView : IAsyncDisposable
{
    private readonly DesktopExtensionPackageLease _package;
    private readonly CancellationTokenSource _lifetime;
    private int _closed;
    private readonly object _cleanupGate = new();
    private Task? _cleanup;
    internal string FileSessionId { get; }
    internal NendoExtensionGrant Grant { get; }
    internal DesktopExtensionProcess Renderer { get; }
    internal bool IsClosed => Volatile.Read(ref _closed) != 0 || Renderer.Session.IsClosed;
    internal long ChangeSequence { get; set; }
    internal SemaphoreSlim UpdateGate { get; } = new(1, 1);
    internal CancellationToken Lifetime => _lifetime.Token;

    internal DesktopExtensionRunningView(string fileSessionId, NendoExtensionGrant grant,
        DesktopExtensionPackageLease package, DesktopExtensionProcess renderer, CancellationTokenSource lifetime,
        long changeSequence)
    {
        FileSessionId = fileSessionId; Grant = grant; _package = package;
        Renderer = renderer; _lifetime = lifetime; ChangeSequence = changeSequence;
    }

    internal void Stop()
    {
        lock (_cleanupGate)
        {
            if (Interlocked.Exchange(ref _closed, 1) != 0) return;
            _lifetime.Cancel();
            Renderer.Stop(); // Kill the Job before releasing any file-session authority.
        }
    }

    public ValueTask DisposeAsync()
    {
        Stop();
        // Cleanup may wait for browser processes. Keep it off the native UI thread.
        // Concurrent owners must await the same cleanup, including the retained package lease.
        lock (_cleanupGate) return new(_cleanup ??= Task.Run(() =>
        {
            try { Renderer.Dispose(); }
            finally { _package.Dispose(); _lifetime.Dispose(); }
        }));
    }
}

internal sealed partial class DesktopSessionController
{
    private readonly List<DesktopExtensionRunningView> _extensionRuns = [];
    private readonly HashSet<CancellationTokenSource> _extensionStarts = [];

    internal async Task<DesktopExtensionRunningView> StartExtensionAsync(string viewId, string helperDirectory,
        string scratchRoot, string theme, string locale, CancellationToken cancellationToken = default)
    {
        DesktopExtensionPackageLease package;
        NendoExtensionViewSnapshot view;
        INendoExtensionAuthority authority;
        string fileSession;
        var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _extensionRuns.RemoveAll(r => r.IsClosed);
            if (_extensionRuns.Count + _extensionStarts.Count >= 4)
                throw new NendoPreconditionException("extension-window-limit", "Close a custom view before opening another.");
            view = await RequireService().ReadExtensionViewAsync(viewId, cancellationToken);
            authority = ExtensionGrants.ForFile(RequireExtensionFileKey());
            if (!authority.IsGranted(GrantFor(view)))
                throw new NendoPreconditionException("extension-not-approved", "Review permission for this exact view before opening it.");
            package = ExtensionPackages.Acquire(view.Definition.PackageDigest, view.Definition.PackageId, view.Definition.PackageVersion);
            fileSession = _fileSessionId;
            _extensionStarts.Add(lifetime);
        }
        catch { lifetime.Dispose(); throw; }
        finally { _gate.Release(); }

        DesktopExtensionProcess? renderer = null;
        var started = false;
        try
        {
            // Launch copies files and establishes OS containment; never block the UI or the file gate.
            renderer = await Task.Run(() => DesktopExtensionProcess.StartAsync(helperDirectory, scratchRoot,
                package.Package, GrantFor(view), authority, view.Projection, theme, locale, lifetime.Token), lifetime.Token);
            await _gate.WaitAsync(cancellationToken);
            try
            {
                lifetime.Token.ThrowIfCancellationRequested();
                if (_disposed || fileSession != _fileSessionId)
                    throw new NendoPreconditionException("stale-file-session", "The custom view belongs to a file that has closed.");
                var current = await RequireService().ReadExtensionViewAsync(viewId, cancellationToken);
                if (GrantFor(current) != GrantFor(view))
                    throw new NendoPreconditionException("extension-review-stale", "The view changed during startup. Review permission again.");
                if (current.Projection.SourceChangeSequence != view.Projection.SourceChangeSequence)
                    throw new NendoPreconditionException("extension-view-changed", "The data changed during startup. Open the view again.");
                var run = new DesktopExtensionRunningView(fileSession, GrantFor(current), package, renderer, lifetime,
                    current.Projection.SourceChangeSequence);
                _extensionRuns.Add(run);
                _extensionStarts.Remove(lifetime);
                started = true;
                _ = Task.Run(() => MonitorExtensionAsync(run));
                return run;
            }
            finally { _gate.Release(); }
        }
        catch
        {
            if (renderer is not null) await Task.Run(renderer.Dispose);
            package.Dispose(); throw;
        }
        finally
        {
            await _gate.WaitAsync();
            try { _extensionStarts.Remove(lifetime); }
            finally { _gate.Release(); }
            if (!started) lifetime.Dispose();
        }
    }

    private async Task MonitorExtensionAsync(DesktopExtensionRunningView run)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(500));
            while (!run.IsClosed && await timer.WaitForNextTickAsync(run.Lifetime))
                await RefreshExtensionAsync(run, run.Lifetime);
        }
        catch { run.Stop(); }
        finally { await run.DisposeAsync(); }
    }

    internal async Task RefreshExtensionAsync(DesktopExtensionRunningView run, CancellationToken cancellationToken = default)
    {
        await run.UpdateGate.WaitAsync(cancellationToken);
        try
        {
            byte[]? message = null;
            await EnterRequestGateAsync(cancellationToken);
            try
            {
                RequireExtensionRun(run);
                var current = await RequireService().ReadExtensionViewAsync(run.Grant.ViewId, cancellationToken);
                if (GrantFor(current) != run.Grant) throw new NendoPreconditionException("extension-review-stale", "The custom view changed. Review permission again.");
                if (current.Projection.SourceChangeSequence != run.ChangeSequence)
                {
                    message = run.Renderer.Session.ReplaceProjection(run.Grant, current.Projection);
                    run.ChangeSequence = current.Projection.SourceChangeSequence;
                }
            }
            finally { _gate.Release(); }
            if (message is null) return;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, run.Lifetime);
            timeout.CancelAfter(TimeSpan.FromSeconds(5));
            await Task.Run(() => run.Renderer.SendAsync(message, timeout.Token), timeout.Token);
        }
        catch { run.Stop(); throw; }
        finally { run.UpdateGate.Release(); }
    }

    /// <summary>Only a native Open record gesture calls this; renderer messages never navigate.</summary>
    internal async Task<(string EntityId, string RecordId)?> GetExtensionSelectionAsync(DesktopExtensionRunningView run,
        CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            RequireExtensionRun(run);
            var current = await RequireService().ReadExtensionViewAsync(run.Grant.ViewId, cancellationToken);
            var selected = run.Renderer.Session.GetSelection(GrantFor(current), current.Projection.SourceChangeSequence);
            return selected is not null && current.Projection.Nodes.Any(n => n.Id == selected.RecordId)
                ? (current.Definition.Binding.NodeEntityId, selected.RecordId) : null;
        }
        finally { _gate.Release(); }
    }

    private void RequireExtensionRun(DesktopExtensionRunningView run)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (run.IsClosed || run.FileSessionId != _fileSessionId || !_extensionRuns.Contains(run))
            throw new NendoPreconditionException("stale-file-session", "This custom view has closed. Open it again from the current file.");
    }

    private void StopExtensionsForFile()
    {
        foreach (var pending in _extensionStarts) pending.Cancel();
        foreach (var run in _extensionRuns) { run.Stop(); _ = run.DisposeAsync(); }
        _extensionRuns.Clear();
    }
}
