using Microsoft.UI.Xaml;

namespace Nendo.Desktop;

public partial class App : Application
{
    private Window? _window;

    internal static MainWindow? CurrentWindow { get; private set; }

    public App()
    {
        DesktopStartupTiming.Mark("app.constructor");
        // Before anything is drawn. The taskbar button, the Jump List and every
        // notification are filed under whatever identity this process had when the
        // first window appeared, and naming it afterwards is how an application ends
        // up with two buttons that do not group.
        DesktopShellIdentity.Apply();
        InitializeComponent();
        DesktopStartupTiming.Mark("app.initialized");
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        DesktopStartupTiming.Mark("app.launched");
        CurrentWindow = new MainWindow(DesktopStartupRequest.FromStartup());
        DesktopStartupTiming.Mark("window.constructed");
        _window = CurrentWindow;
        _window.Activate();
        DesktopStartupTiming.Mark("window.activated");
    }
}
