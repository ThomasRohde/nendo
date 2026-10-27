using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Session;

internal static partial class WorkbenchMethods
{
    /// <summary>
    /// Every setting this host offers, from the settings catalogue (ADR-0038), with the values only
    /// the host can read and any environment variable that fixes one. Needs no file.
    /// </summary>
    internal const string SettingsDescribe = "settings.describe";

    /// <summary>
    /// Change a setting that has no other method on the bridge: what Close does and whether failures
    /// are recorded. Every other setting is changed through the method its own control has always used.
    /// </summary>
    internal const string SettingsSet = "settings.set";

    /// <summary>
    /// Keep this computer's value for a setting an app of the open file declares, or with null take
    /// it away (ADR-0038). Answers the session, whose package carries the value.
    /// </summary>
    internal const string PackageSettingsSet = "package.settings.set";
}

internal sealed record SettingChangePayload(string Id, JsonElement Value);

internal sealed record PackageSettingPayload(string PackageId, string SettingId, JsonElement Value);

internal sealed partial class WorkbenchProtocolHandler
{
    /// <summary>Whether this host offers the Windows host's settings: its window, diagnostics and agents.</summary>
    private partial bool OffersWindowsSettings();

    /// <summary>The value of a setting only this host can read, or null where the page reads it elsewhere.</summary>
    private partial object? HostSettingValue(string id);

    /// <summary>Changes a setting only this host keeps; refuses any other.</summary>
    private partial void ChangeHostSetting(string id, bool value);

    private async Task<DesktopSessionView> SetPackageSettingAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        var request = Deserialize<PackageSettingPayload>(payload);
        return await _session.SetPackageSettingAsync(request.PackageId, request.SettingId, request.Value, cancellationToken);
    }

    private SettingsView DescribeSettings() =>
        SettingsCatalogue.Describe(OffersWindowsSettings(), HostSettingValue, Environment.GetEnvironmentVariable);

    private SettingsView ChangeSetting(JsonElement payload)
    {
        var request = Deserialize<SettingChangePayload>(payload);
        var setting = SettingsCatalogue.All.FirstOrDefault(item => item.Id == request.Id && (OffersWindowsSettings() || !item.WindowsOnly))
            ?? throw new NendoValidationException("That is not one of this host's settings.");
        if (setting.Id is not (SettingsCatalogue.CloseToTray or SettingsCatalogue.RecordFailures))
            throw new NendoValidationException($"{setting.Title} is changed by its own control.");
        if (SettingsCatalogue.Override(setting.Id, Environment.GetEnvironmentVariable) is { } variable)
            throw new NendoPreconditionException("setting-overridden", $"{variable} sets this for the running Nendo, so it cannot be changed here.");
        if (request.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new NendoValidationException($"{setting.Title} is on or off.");
        ChangeHostSetting(setting.Id, request.Value.GetBoolean());
        return DescribeSettings();
    }
}
