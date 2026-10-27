using Nendo.Desktop;
using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// The Windows host's own settings on the Settings page (ADR-0038): what Close does and whether
/// failures are recorded, kept in <c>window\tray.json</c> beside the tray menu that also changes them.
/// Each read and write takes the document as it is now, so the tray and every window agree.
/// </summary>
internal sealed partial class WorkbenchProtocolHandler
{
    private partial bool OffersWindowsSettings() => true;

    private partial object? HostSettingValue(string id) => id switch
    {
        SettingsCatalogue.CloseToTray => (DesktopRuntimeConfiguration.CloseAction ?? _session.ShellSettings().CloseAction) == "tray",
        SettingsCatalogue.RecordFailures => _session.ShellSettings().RecordViewFailures,
        _ => null,
    };

    private partial void ChangeHostSetting(string id, bool value)
    {
        var shell = _session.ShellSettings();
        if (id == SettingsCatalogue.CloseToTray) shell.SetCloseAction(value ? "tray" : "exit");
        else if (id == SettingsCatalogue.RecordFailures) shell.SetRecordViewFailures(value);
        else throw new NendoValidationException("That is not one of this host's settings.");
        if (!shell.Persisted) throw new NendoPreconditionException("setting-not-saved", shell.Notice ?? "That choice could not be kept on this computer.");
    }
}

internal sealed partial class DesktopSessionController
{
    /// <summary>The window's settings as the device keeps them now, read again for each use.</summary>
    internal DesktopShellStore ShellSettings() => new(_deviceStateRoot);
}
