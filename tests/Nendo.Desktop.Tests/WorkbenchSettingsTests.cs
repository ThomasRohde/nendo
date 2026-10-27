using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The settings catalogue behind the Settings page (ADR-0038): one row for each choice a person
/// keeps, each with one home, and the window's settings changed in the same document the tray menu
/// changes.
/// </summary>
[TestClass]
public sealed class WorkbenchSettingsTests
{
    /// <summary>
    /// Every ADR-0034 document that keeps a person's choice. A store added there without a row in
    /// the catalogue would be a setting the Settings page cannot show.
    /// </summary>
    private static readonly string[] ChoiceStores =
    [
        @"window\appearance.json", @"window\tray.json", @"agents\connection.json", @"agents\ports.json", @"agents\access.json",
        @"agents\launch.json", @"agents\settings.json", @"views\settings.json", @"actions\consent.json",
    ];

    [TestMethod]
    public void EveryStoreThatKeepsAChoiceHasARowAndEveryRowHasOneHome()
    {
        var settings = SettingsCatalogue.All;
        foreach (var store in ChoiceStores)
            Assert.IsTrue(settings.Any(setting => setting.Store == store), $"No setting is kept in {store}.");
        Assert.HasCount(settings.Count, settings.Select(setting => setting.Id).Distinct(StringComparer.Ordinal).ToList(), "A setting ID is used twice.");
        foreach (var setting in settings)
        {
            Assert.Contains(setting.Home, new[] { "device", "here", "file" }, $"{setting.Id} has no home of the three.");
            Assert.Contains(setting.Kind, new[] { "toggle", "choice", "number", "text", "icons", "link", "action" }, $"{setting.Id} has no known control.");
            Assert.Contains(setting.Section, new[] { "general", "agents", "views", "file" }, $"{setting.Id} is in no section.");
            if (setting.Kind == "choice") Assert.IsTrue(setting.Options is { Count: > 1 }, $"{setting.Id} offers no choice.");
            // Nothing a file keeps can set what this computer allows it.
            if (setting.Home == "file") Assert.StartsWith("definition:", setting.Store, $"{setting.Id} says it is in the file but is kept elsewhere.");
            else Assert.DoesNotStartWith("definition:", setting.Store, $"{setting.Id} is kept on this computer but names the definition.");
        }
    }

    [TestMethod]
    public void TheLeaseBoundsAreTheConnectionStoresOwn()
    {
        var lease = SettingsCatalogue.All.Single(setting => setting.Id == "agents.leaseExpirySeconds");
        Assert.AreEqual(DesktopAgentSettingsStore.MinimumExpirySeconds, lease.Minimum);
        Assert.AreEqual(DesktopAgentSettingsStore.MaximumExpirySeconds, lease.Maximum);
    }

    [TestMethod]
    public async Task TheWindowsSettingsAreDescribedWithoutAFileAndChangeTheTrayDocument()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(deviceStateRoot: workspace.FileHistoryRoot, fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(session, _ => { });

        var described = await handler.HandleAsync(Request(WorkbenchMethods.SettingsDescribe));
        Assert.IsTrue(described.Ok, described.Error?.Message);
        var view = (SettingsView)described.Result!;
        Assert.HasCount(SettingsCatalogue.All.Count, view.Settings, "The Windows host offers every setting.");
        Assert.IsFalse(session.HasFile);
        Assert.IsTrue(On(view, SettingsCatalogue.CloseToTray), "Close keeps Nendo in the notification area unless changed.");
        Assert.IsTrue(On(view, SettingsCatalogue.RecordFailures));
        Assert.IsNull(Value(view, "appearance.theme"), "The page reads the theme where it always has.");

        var changed = await handler.HandleAsync(Request(WorkbenchMethods.SettingsSet, new { id = SettingsCatalogue.CloseToTray, value = false }));
        Assert.IsTrue(changed.Ok, changed.Error?.Message);
        Assert.IsFalse(On((SettingsView)changed.Result!, SettingsCatalogue.CloseToTray));
        Assert.AreEqual("exit", new DesktopShellStore(workspace.FileHistoryRoot).CloseAction, "The tray menu reads what the page chose.");

        var recorded = await handler.HandleAsync(Request(WorkbenchMethods.SettingsSet, new { id = SettingsCatalogue.RecordFailures, value = false }));
        Assert.IsTrue(recorded.Ok, recorded.Error?.Message);
        Assert.IsFalse(new DesktopShellStore(workspace.FileHistoryRoot).RecordViewFailures);
        Assert.AreEqual("exit", new DesktopShellStore(workspace.FileHistoryRoot).CloseAction, "Changing one kept the other.");

        // The tray changes it back, and the page reads that.
        new DesktopShellStore(workspace.FileHistoryRoot).SetCloseAction("tray");
        Assert.IsTrue(On((SettingsView)(await handler.HandleAsync(Request(WorkbenchMethods.SettingsDescribe))).Result!, SettingsCatalogue.CloseToTray));
    }

    [TestMethod]
    public async Task OnlyTheWindowsOwnSettingsAreChangedThroughSettingsSet()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(deviceStateRoot: workspace.FileHistoryRoot, fileHistoryRoot: workspace.FileHistoryRoot);
        var handler = new WorkbenchProtocolHandler(session, _ => { });

        var theme = await handler.HandleAsync(Request(WorkbenchMethods.SettingsSet, new { id = "appearance.theme", value = true }));
        Assert.IsFalse(theme.Ok);
        Assert.AreEqual("Theme is changed by its own control.", theme.Error!.Message);
        var unknown = await handler.HandleAsync(Request(WorkbenchMethods.SettingsSet, new { id = "agents.secret", value = true }));
        Assert.AreEqual("That is not one of this host's settings.", unknown.Error!.Message);
        var notOnOff = await handler.HandleAsync(Request(WorkbenchMethods.SettingsSet, new { id = SettingsCatalogue.CloseToTray, value = "exit" }));
        Assert.AreEqual("Close keeps Nendo in the notification area is on or off.", notOnOff.Error!.Message);
        Assert.AreEqual("tray", new DesktopShellStore(workspace.FileHistoryRoot).CloseAction, "A refused change wrote nothing.");
    }

    [TestMethod]
    public void AnEnvironmentVariableMakesItsRowReadOnly()
    {
        Assert.AreEqual("NENDO_DESKTOP_CLOSE_ACTION", SettingsCatalogue.Override(SettingsCatalogue.CloseToTray, name => name == "NENDO_DESKTOP_CLOSE_ACTION" ? "exit" : null));
        Assert.IsNull(SettingsCatalogue.Override(SettingsCatalogue.CloseToTray, _ => null));
        Assert.IsNull(SettingsCatalogue.Override("appearance.theme", _ => "exit"));
        var view = SettingsCatalogue.Describe(false, _ => null, _ => null);
        Assert.IsFalse(view.Settings.Any(item => item.Setting.WindowsOnly), "A page in a browser offers no window, tray or agent setting.");
        Assert.IsTrue(view.Settings.Any(item => item.Setting.Id == "views.run"));
    }

    private static object? Value(SettingsView view, string id) => view.Settings.Single(item => item.Setting.Id == id).Value;

    private static bool On(SettingsView view, string id) => (bool)Value(view, id)!;

    private static string Request(string method, object? payload = null) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion, requestId = Guid.NewGuid().ToString("N"), method, payload = payload ?? new { },
    });
}
