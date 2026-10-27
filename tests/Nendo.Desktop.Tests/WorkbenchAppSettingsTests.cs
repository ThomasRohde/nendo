using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The personal values of the settings an app declares (ADR-0038): kept on this computer by
/// package, checked with the Engine's own rule, carried on the session's package, and never a
/// write to the file.
/// </summary>
[TestClass]
public sealed class WorkbenchAppSettingsTests
{
    private const string PackageId = "org.nendo.test.settings";

    [TestMethod]
    public async Task APersonalValueIsKeptOnThisComputerCheckedAndCarriedOnThePackage()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath, """[{"id":"zoom","title":"Zoom","type":"number","default":1,"min":1,"max":9,"layers":"both"}]""");
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var fileSessionId = (await session.GetViewAsync()).FileSessionId!;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var kept = await handler.HandleAsync(Request(fileSessionId, new { packageId = PackageId, settingId = "zoom", value = 4 }));
        Assert.IsTrue(kept.Ok, kept.Error?.Message);
        var package = ((DesktopSessionView)kept.Result!).Extensions!.Packages.Single(item => item.PackageId == PackageId);
        Assert.AreEqual(4, package.PersonalSettings["zoom"].GetInt32());
        Assert.AreEqual(4, new DesktopAppSettingsStore(workspace.FileHistoryRoot).Values(PackageId)["zoom"].GetInt32(), "kept on this computer");
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "a personal value wrote to the file");

        var refused = await handler.HandleAsync(Request(fileSessionId, new { packageId = PackageId, settingId = "zoom", value = 12 }));
        Assert.AreEqual("package-setting-invalid", refused.Error?.Code);
        Assert.AreEqual("The setting zoom is a number from 1 to 9, and 12 is not.", refused.Error?.Message);
        var unknown = await handler.HandleAsync(Request(fileSessionId, new { packageId = PackageId, settingId = "speed", value = 1 }));
        Assert.AreEqual("package-setting-not-found", unknown.Error?.Code);

        var cleared = await handler.HandleAsync(Request(fileSessionId, new { packageId = PackageId, settingId = "zoom", value = (object?)null }));
        Assert.IsTrue(cleared.Ok, cleared.Error?.Message);
        Assert.IsEmpty(((DesktopSessionView)cleared.Result!).Extensions!.Packages.Single(item => item.PackageId == PackageId).PersonalSettings);
    }

    [TestMethod]
    public async Task ASettingKeptOnlyInTheFileTakesNoPersonalValueAndAStaleOneIsPassedOver()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath, """[{"id":"quotes","title":"Quotes","type":"choice","default":"curly","layers":"shared","options":[{"value":"curly","label":"Curly"},{"value":"straight","label":"Straight"}]},{"id":"zoom","title":"Zoom","type":"number","default":1,"min":1,"max":3,"layers":"personal"}]""");
        // A value an older declaration allowed, kept on this computer before the range narrowed.
        new DesktopAppSettingsStore(workspace.FileHistoryRoot).Set(PackageId, "zoom", JsonDocument.Parse("8").RootElement);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var view = await session.GetViewAsync();

        Assert.IsFalse(view.Extensions!.Packages.Single(item => item.PackageId == PackageId).PersonalSettings.ContainsKey("zoom"),
            "a kept value that no longer fits reached the views");
        var shared = await handler.HandleAsync(Request(view.FileSessionId!, new { packageId = PackageId, settingId = "quotes", value = "straight" }));
        Assert.AreEqual("package-setting-shared", shared.Error?.Code);
    }

    private static async Task SeedAsync(string path, string settings)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "app-settings");
        var declarations = NendoPackageSettings.Parse(JsonDocument.Parse(settings).RootElement, "test");
        await coordinator.ApplyAsync(new("test", "package", "test", "Settings", [
            new SetExtensionPackageOperation("settings-package", PackageId, "Settings probe", "index.html", "1.0.0", settings: declarations),
            PutExtensionFileOperation.FromContent("settings-html", PackageId, "index.html", null, Encoding.UTF8.GetBytes("<!doctype html><p>probe</p>")),
        ]));
    }

    private static string Request(string fileSessionId, object payload) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion,
        requestId = "app-settings-" + Guid.NewGuid().ToString("N"),
        method = WorkbenchMethods.PackageSettingsSet,
        fileSessionId,
        payload,
    });
}
