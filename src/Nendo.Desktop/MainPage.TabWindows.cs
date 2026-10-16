namespace Nendo.Desktop;

/// <summary>
/// The page's half of moving a tab into a window of its own (W-277, ADR-0002 2026-10-16): the
/// Workbench hands over the tab's trail, and the window this page is in opens another window of
/// the same file on it.
/// </summary>
public sealed partial class MainPage : IWorkbenchTabWindowHost
{
    bool IWorkbenchTabWindowHost.IsTabWindow => _sharesSession;

    void IWorkbenchTabWindowHost.DetachTab(string trail, bool atPointer)
    {
        var window = Owner ?? throw new Nendo.Engine.NendoPreconditionException("window-unavailable", "The window is not available.");
        if (!_session.HasFile)
            throw new Nendo.Engine.NendoPreconditionException("no-file", "A tab moves to a window of its own only while a file is open.");
        window.OpenTabWindow(_session, trail, atPointer);
    }

    void IWorkbenchTabWindowHost.CloseWindow() =>
        (Owner ?? throw new Nendo.Engine.NendoPreconditionException("window-unavailable", "The window is not available.")).CloseTabWindowForDiagnostics();

    TabWindowStart IWorkbenchTabWindowHost.TakeTab()
    {
        var trail = _pendingTab;
        _pendingTab = null;
        return new(_sharesSession ? "tab" : "main", trail);
    }
}
