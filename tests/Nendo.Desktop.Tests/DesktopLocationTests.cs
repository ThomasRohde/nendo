using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopLocationTests
{
    [TestMethod]
    public void InjectedRootsUseCanonicalPathBoundariesWithoutLookingUpAProvider()
    {
        var root = Path.Combine(Path.GetTempPath(), "nendo-location-policy", Guid.NewGuid().ToString("N"));
        var policy = new DesktopLocationPolicy(["relative", "", "C:\\bad\0value", Path.Combine(root, "cloud")]);
        Assert.IsNotNull(policy.Inspect(Path.Combine(root, "CLOUD", "nested", "file.nendo")));
        Assert.IsNull(policy.Inspect(Path.Combine(root, "cloud-other", "file.nendo")));
        Assert.IsNull(policy.Inspect(Path.Combine(root, "cloud", "..", "local", "file.nendo")));
        var warning = policy.Inspect(Path.Combine(root, "cloud", "file.nendo"))!;
        Assert.Contains("missing warning does not prove", warning.Message);
        Assert.DoesNotContain(root, JsonSerializer.Serialize(warning));
        Assert.IsFalse(Directory.Exists(root));
    }

    [TestMethod]
    public async Task WritableCreationRequiresExplicitPathSpecificRequestAcknowledgementBeforeAnyWrite()
    {
        await using var workspace = new DesktopTestWorkspace();
        var directory = Path.GetDirectoryName(workspace.FilePath)!;
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot,
            locationPolicy: new([directory]));
        var empty = await session.GetViewAsync();
        var denied = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.CreateAsync(workspace.FilePath));
        Assert.AreEqual("unsupported-sync-location", denied.Code);
        Assert.IsFalse(File.Exists(workspace.FilePath));
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
        using (session.BindFileRequest(empty.FileSessionId!))
        {
            await session.AcknowledgeDestinationLocationAsync(workspace.FilePath);
            var created = await session.CreateAsync(workspace.FilePath);
            Assert.IsNotNull(created.LocationWarning);
            Assert.IsTrue(created.Capabilities.Mutate);
        }
        // An accepted source location is not a blanket grant for other outputs.
        var backup = Path.Combine(directory, "other.nendo");
        denied = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.PrepareBackupAsync(backup, "backup"));
        Assert.AreEqual("unsupported-sync-location", denied.Code);
        Assert.IsFalse(File.Exists(backup));
        using (session.BindFileRequest((await session.GetViewAsync()).FileSessionId!))
        {
            await session.AcknowledgeDestinationLocationAsync(backup);
            var plan = await session.PrepareBackupAsync(backup, "backup");
            await session.CreateBackupAsync(plan.PlanId);
        }
        Assert.IsTrue(File.Exists(backup));
    }

    [TestMethod]
    public async Task LegacyPickerPlaceholderIsNotInitializedBeforeUnsupportedLocationIsAcknowledged()
    {
        await using var workspace = new DesktopTestWorkspace();
        await File.WriteAllBytesAsync(workspace.FilePath, []);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot,
            locationPolicy: new([Path.GetDirectoryName(workspace.FilePath)!]));
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(workspace.FilePath),
            () => Task.FromResult<string?>(workspace.FilePath), _ => { });
        var response = await handler.HandleAsync(JsonSerializer.Serialize(new { protocolVersion = 4, requestId = "create", method = "session.createFile" }));
        Assert.AreEqual("unsupported-sync-location", response.Error!.Code);
        Assert.AreEqual(0, new FileInfo(workspace.FilePath).Length);
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
    }

    [TestMethod]
    public async Task ReadOnlyOpenNeedsNoAcknowledgementButWritableOpenAndRecentOpenDo()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot,
            locationPolicy: new([Path.GetDirectoryName(workspace.FilePath)!]));
        var assessment = await session.AssessOpenAsync(workspace.FilePath);
        Assert.IsNotNull(assessment.LocationWarning);
        var denied = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.OpenAssessedAsync(assessment.AssessmentId, false));
        Assert.AreEqual("unsupported-sync-location", denied.Code);
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
        var readOnly = await session.OpenAssessedAsync(assessment.AssessmentId, true);
        Assert.IsFalse(readOnly.Capabilities.Mutate);
        Assert.IsTrue(readOnly.Capabilities.ReadData);
        Assert.IsNotNull(readOnly.LocationWarning);
        await session.CloseAsync();
        var recent = (await session.GetRecentFilesAsync()).Files.Single();
        denied = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.OpenRecentAsync(recent.Id));
        Assert.AreEqual("unsupported-sync-location", denied.Code);
        using (session.BindFileRequest((await session.GetViewAsync()).FileSessionId!))
        {
            assessment = await session.AssessRecentAsync(recent.Id);
            await session.AcknowledgeOpenLocationAsync(assessment.AssessmentId);
            Assert.IsTrue((await session.OpenAssessedAsync(assessment.AssessmentId, false)).Capabilities.Mutate);
        }
        await session.CloseAsync();
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task RestoreFromReadOnlyLocationRequiresConfirmationAndCanReopenOnlyItsAdmittedLocation()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var backup = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");
        File.Copy(workspace.FilePath, backup);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot,
            locationPolicy: new([Path.GetDirectoryName(workspace.FilePath)!]));
        var inspected = await session.OpenReadOnlyAsync(workspace.FilePath);
        var denied = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.PrepareRestoreAsync(backup, "restore"));
        Assert.AreEqual("unsupported-sync-location", denied.Code);
        using (session.BindFileRequest(inspected.FileSessionId!))
        {
            await session.AcknowledgeCurrentLocationAsync();
            var plan = await session.PrepareRestoreAsync(backup, "restore");
            var restored = await session.RestoreAsync(plan.PlanId, true);
            Assert.IsTrue(restored.Session.Capabilities.Mutate, restored.Notice);
            Assert.AreNotEqual(inspected.FileSessionId, restored.Session.FileSessionId);
            Assert.IsNotNull(restored.Session.LocationWarning);
        }
    }

    [TestMethod]
    public async Task DestinationWarningsCannotBeForgedThroughBridgePayloadsOrInheritedByAnotherRequest()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace);
        var directory = Path.GetDirectoryName(workspace.FilePath)!;
        var warnedRoot = Path.Combine(directory, "configured-root");
        Directory.CreateDirectory(warnedRoot);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, locationPolicy: new([warnedRoot]));
        var view = await session.OpenAsync(workspace.FilePath);
        var destination = Path.Combine(warnedRoot, "export.csv");
        using (session.BindFileRequest(view.FileSessionId!)) await session.AcknowledgeDestinationLocationAsync(destination);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { }, async _ =>
        {
            await session.PrepareRecoveryExportAsync(NendoApplicationService.IdeaEntityId, destination, "export");
            return new(await session.GetViewAsync(), null);
        });
        var response = await handler.HandleAsync(JsonSerializer.Serialize(new { protocolVersion = 5, requestId = "export", method = "file.export", fileSessionId = view.FileSessionId,
            payload = new { acknowledgeUnsupportedLocation = true, path = destination } }));
        Assert.AreEqual("unsupported-sync-location", response.Error!.Code);
        Assert.IsFalse(File.Exists(destination));
    }

    private static async Task SeedAsync(DesktopTestWorkspace workspace)
    {
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, locationPolicy: new([]));
        await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        await session.CreateIdeaRecordAsync("record", "Preserved", "record");
    }
}
