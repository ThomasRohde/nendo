using Microsoft.Windows.AppNotifications;

namespace Nendo.Desktop;

/// <summary>
/// Windows notifications, for the states a person has to answer while the window is
/// not in front of them.
/// <para>
/// Nendo is unpackaged, so there is no manifest to carry an identity: the two-argument
/// registration is what writes this application a notification identity and the COM
/// activator behind it. Every step of that can fail on a given machine — a policy, a
/// stripped install, a runtime that did not deploy — so nothing here throws upward.
/// An unavailable notifier degrades to the tray balloon and then to silence; it never
/// costs the window its close button.
/// </para>
/// </summary>
internal sealed class DesktopNotifier : IDisposable
{
    private readonly Action<string> _routeInvoked;
    private bool _registered;
    private bool _disposed;

    /// <summary>Whether Windows accepted the registration. False means fall back to the tray balloon.</summary>
    internal bool IsAvailable => _registered;

    /// <summary>
    /// The route name a click asked for is handed back raw. Marshalling to the UI
    /// thread belongs to the caller: the invoked event arrives on a pool thread, and
    /// this type has no dispatcher of its own to be right about.
    /// </summary>
    internal DesktopNotifier(Action<string> routeInvoked)
    {
        _routeInvoked = routeInvoked;
        try
        {
            if (!AppNotificationManager.IsSupported()) return;
            var manager = AppNotificationManager.Default;
            manager.NotificationInvoked += OnNotificationInvoked;
            var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
            if (File.Exists(icon)) manager.Register("Nendo", new Uri(icon));
            else manager.Register();
            _registered = true;
        }
        catch (Exception)
        {
            _registered = false;
        }
    }

    internal void Show(DesktopNotification notification)
    {
        if (!_registered) return;
        try
        {
            var payload = new AppNotification(DesktopNotificationContent.ToXml(notification))
            {
                Tag = notification.Tag,
                Group = DesktopNotificationContent.Group,
            };
            AppNotificationManager.Default.Show(payload);
        }
        catch (Exception)
        {
            // A notification that could not be shown is not worth failing anything over.
            // The state it announces is still on the window when the window comes back.
        }
    }

    /// <summary>
    /// Clears everything Nendo has posted. Called when the window returns: a person
    /// looking at the file does not need a notification telling them to look at it.
    /// </summary>
    internal void ClearAll()
    {
        if (!_registered) return;
        try { _ = AppNotificationManager.Default.RemoveByGroupAsync(DesktopNotificationContent.Group); }
        catch (Exception) { }
    }

    private void OnNotificationInvoked(AppNotificationManager sender, AppNotificationActivatedEventArgs args)
    {
        var route = DesktopNotificationContent.RouteFrom(args.Argument);
        if (route is null) return;
        try { _routeInvoked(route); }
        catch (Exception) { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (!_registered) return;
        _registered = false;
        try
        {
            // Withdraw anything still on screen before the activator goes: a notification
            // left in the centre after Nendo has exited is one whose button now does
            // nothing at all, which is worse than not having offered it.
            AppNotificationManager.Default.RemoveByGroupAsync(DesktopNotificationContent.Group).AsTask().Wait(2000);
        }
        catch (Exception) { }
        try
        {
            AppNotificationManager.Default.NotificationInvoked -= OnNotificationInvoked;
            AppNotificationManager.Default.Unregister();
        }
        catch (Exception) { }
    }
}
