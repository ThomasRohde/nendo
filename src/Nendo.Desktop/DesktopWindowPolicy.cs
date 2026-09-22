using Microsoft.UI.Windowing;
using Windows.Graphics;

namespace Nendo.Desktop;

internal static class DesktopWindowPolicy
{
    internal const int DefaultWidth = 1_600;
    internal const int DefaultHeight = 960;
    internal const int MinimumWidth = 1_024;
    internal const int MinimumHeight = 720;

    internal static void Apply(AppWindow appWindow, DesktopWindowState? saved = null)
    {
        var displayArea = saved is null
            ? DisplayArea.GetFromWindowId(appWindow.Id, DisplayAreaFallback.Primary)
            : DisplayArea.GetFromRect(new RectInt32(saved.X, saved.Y, saved.Width, saved.Height), DisplayAreaFallback.Nearest);
        var bounds = saved is null ? FitTo(displayArea.WorkArea) : FitSavedTo(saved, displayArea.WorkArea);
        var minimum = MinimumFor(displayArea.WorkArea);

        if (appWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = minimum.Width;
            presenter.PreferredMinimumHeight = minimum.Height;
        }

        appWindow.MoveAndResize(bounds);
        if (saved?.Maximized == true && appWindow.Presenter is OverlappedPresenter overlapped) overlapped.Maximize();
    }

    internal static RectInt32 FitSavedTo(DesktopWindowState saved, RectInt32 workArea)
    {
        var minimum = MinimumFor(workArea);
        var width = Math.Clamp(saved.Width, minimum.Width, workArea.Width);
        var height = Math.Clamp(saved.Height, minimum.Height, workArea.Height);
        return new RectInt32(
            (int)Math.Clamp((long)saved.X, workArea.X, (long)workArea.X + workArea.Width - width),
            (int)Math.Clamp((long)saved.Y, workArea.Y, (long)workArea.Y + workArea.Height - height), width, height);
    }

    internal static RectInt32 FitTo(RectInt32 workArea)
    {
        var width = Math.Min(DefaultWidth, workArea.Width);
        var height = Math.Min(DefaultHeight, workArea.Height);
        return new RectInt32(
            workArea.X + ((workArea.Width - width) / 2),
            workArea.Y + ((workArea.Height - height) / 2),
            width,
            height);
    }

    internal static SizeInt32 MinimumFor(RectInt32 workArea) =>
        new(
            Math.Min(MinimumWidth, workArea.Width),
            Math.Min(MinimumHeight, workArea.Height));
}
