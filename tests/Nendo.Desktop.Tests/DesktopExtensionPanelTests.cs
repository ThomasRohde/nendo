using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// A custom view on a record page, below the window (ADR-0013, 2026-09-24; W-061): what the
/// bridge accepts from the page, what the review says, and that nothing starts without the
/// record it is for. The journey measures the window itself.
/// </summary>
[TestClass]
public sealed class DesktopExtensionPanelTests
{
    private static async Task<(DesktopExtensionViewStatus Status, string ReviewId)> SeedAsync(DesktopTestWorkspace workspace, DesktopSessionController session)
    {
        var bytes = DesktopExtensionDeviceTests.Archive(protocol: 2);
        var package = session.ExtensionPackages.Inspect(bytes);
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "panel-test"))
        {
            await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
                new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
                new AddFieldOperation("title", "tasks", "title", "Task title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("starts", "tasks", "starts", "Starts", "starts", NendoStorageKind.Date, false),
            ]));
            var pin = new Dictionary<string, object?>
            {
                ["title"] = "Schedule", ["packageId"] = package.PackageId, ["packageVersion"] = package.Version, ["packageDigest"] = package.Digest,
                ["protocolVersion"] = 2, ["configurationVersion"] = 1, ["configuration"] = "{}", ["labelFieldId"] = "title",
            };
            await coordinator.ApplyAsync(new("test", "ui", "test", "Page", [
                new AddUiNodeOperation("page", "page", "page", null, "detailSurface", 0),
                new SetUiPropertyOperation("page-v", "page", "page", "definitionVersion", 3),
                new SetUiPropertyOperation("page-e", "page", "page", "entityId", "tasks"),
                new AddUiNodeOperation("page-f", "page", "page-title", "page", "fieldBinding", 0),
                new SetUiPropertyOperation("page-f-id", "page", "page-title", "fieldId", "title"),
                new AddUiNodeOperation("panel", "page", "panel", "page", NendoExtensionViewDefinition.PanelKind, 1),
                .. pin.Select(p => new SetUiPropertyOperation("panel-" + p.Key, "page", "panel", p.Key, p.Value)),
                new AddUiNodeOperation("panel-f", "page", "panel-f", "panel", "fieldBinding", 0),
                new SetUiPropertyOperation("panel-f-id", "page", "panel-f", "fieldId", "starts"),
            ]));
            await coordinator.ApplyAsync(new("test", "data", "test", "Task", [
                new CreateRecordOperation("t1", "tasks", "t1", new Dictionary<string, object?> { ["title"] = "Survey", ["starts"] = "2026-10-01" })]));
        }
        await session.OpenAsync(workspace.FilePath);
        session.ExtensionPackages.Install(bytes);
        var review = await session.PrepareExtensionConsentAsync("panel");
        return (review.View, review.ReviewId);
    }

    [TestMethod]
    public async Task APanelIsReviewedByItsColumnsAndStartsOnlyForItsRecord()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var (status, reviewId) = await SeedAsync(workspace, session);
        Assert.IsTrue(status.Definition.IsRecordPanel);
        Assert.AreEqual(new DesktopExtensionDisclosure("Tasks", "Task title", null, null, null, null) { NodeFields = ["Starts"] }, status.Disclosure);
        Assert.IsTrue((await session.ApproveExtensionAsync(reviewId)).IsApproved);
        // Refused before any process is started: a panel runs for a record, and only a panel takes one.
        Assert.AreEqual("extension-record-scope", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.StartExtensionAsync("panel", "no-helper", "no-scratch", "light", "en"))).Code);
    }

    [TestMethod]
    public void APlacementIsBoundedBeforeItReachesTheWindow()
    {
        JsonElement Payload(object value) => JsonSerializer.SerializeToElement(value);
        var placed = WorkbenchProtocolHandler.RequiredPlacement(Payload(new { visible = true, x = 10.5, y = -40, width = 431, height = 360, clipX = 10.5, clipY = 0, clipWidth = 431, clipHeight = 320 }));
        Assert.AreEqual(new DesktopExtensionPanelPlacement(true, 10.5, -40, 431, 360, 10.5, 0, 431, 320), placed);
        foreach (var refused in new object[]
        {
            new { x = 0, y = 0, width = 10, height = 10, clipX = 0, clipY = 0, clipWidth = 10, clipHeight = 10 },
            new { visible = true, x = 0, y = 0, width = 0, height = 10, clipX = 0, clipY = 0, clipWidth = 0, clipHeight = 10 },
            new { visible = true, x = 0, y = 0, width = 9000, height = 10, clipX = 0, clipY = 0, clipWidth = 10, clipHeight = 10 },
            new { visible = true, x = 1e9, y = 0, width = 10, height = 10, clipX = 0, clipY = 0, clipWidth = 10, clipHeight = 10 },
            new { visible = true, x = "0", y = 0, width = 10, height = 10, clipX = 0, clipY = 0, clipWidth = 10, clipHeight = 10 },
        })
            Assert.ThrowsExactly<NendoValidationException>(() => WorkbenchProtocolHandler.RequiredPlacement(Payload(refused)), JsonSerializer.Serialize(refused));
    }

    [TestMethod]
    public async Task AHostWithoutPanelsSaysSoRatherThanStartingAnything()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var snapshot = await session.CreateAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { });
        var response = await handler.HandleAsync(JsonSerializer.Serialize(new { protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId = "panel-show", fileSessionId = snapshot.FileSessionId, method = "extension.panel.show", payload = new { viewId = "panel", recordId = "t1" } }));
        Assert.IsFalse(response.Ok);
        Assert.AreEqual("extension-panels-unavailable", response.Error?.Code);
    }
}
