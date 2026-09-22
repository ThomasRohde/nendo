using Nendo.Engine;
using System.Text.Json;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopExtensionConsentTests
{
    [TestMethod]
    public async Task PackageMenuDelegatesToNativeUiWithoutForwardingPageSuppliedPaths()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var snapshot = await session.CreateAsync(workspace.FilePath);
        WorkbenchFileActionRequest? invoked = null;
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { },
            request => { invoked = request; return Task.FromResult(new DesktopFileActionView(snapshot, null)); });
        var response = await handler.HandleAsync(JsonSerializer.Serialize(new { protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId = "native-packages", fileSessionId = snapshot.FileSessionId, method = "file.customViews",
            payload = new { path = "C:/not-a-picker/package.nendoview", approve = true } }));
        Assert.IsTrue(response.Ok, response.Error?.Message);
        Assert.IsNotNull(invoked);
        Assert.AreEqual(WorkbenchFileAction.CustomViews, invoked.Action);
        Assert.IsNull(invoked.DroppedPath);
        Assert.IsNull(invoked.RecentId);
        Assert.IsEmpty(session.ExtensionPackages.List());
    }

    internal static async Task<byte[]> SeedAsync(DesktopTestWorkspace workspace, byte[]? archive = null)
    {
        var bytes = archive ?? DesktopExtensionDeviceTests.Archive();
        var package = new DesktopExtensionPackageStore(workspace.FileHistoryRoot).Inspect(bytes);
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "extension-test");
        await coordinator.ApplyAsync(new("test", "schema", "test", "Graph data", [
            new CreateEntityOperation("nodes", "nodes", "Tasks", "nodes"),
            new AddFieldOperation("label", "nodes", "label", "Task title", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("edges", "edges", "Dependencies", "edges"),
            new AddFieldOperation("from", "edges", "from", "Upstream task", "from_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("to", "edges", "to", "Downstream task", "to_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind-from", "edges", "from", "nodes", "label", 0),
            new ConfigureReferenceOperation("bind-to", "edges", "to", "nodes", "label", 0),
        ]));
        var properties = new Dictionary<string, object?>
        {
            ["definitionVersion"] = 3, ["entityId"] = "nodes", ["title"] = "Dependencies",
            ["packageId"] = package.PackageId, ["packageVersion"] = package.Version, ["packageDigest"] = package.Digest,
            ["protocolVersion"] = 1, ["configurationVersion"] = 1, ["configuration"] = "{}",
            ["edgeEntityId"] = "edges", ["labelFieldId"] = "label", ["sourceFieldId"] = "from", ["targetFieldId"] = "to",
        };
        await coordinator.ApplyAsync(new("test", "view", "test", "Graph view", [
            new AddUiNodeOperation("graph", "graph", "graph", null, NendoExtensionViewDefinition.NodeKind, 0),
            .. properties.Select(p => new SetUiPropertyOperation("set-" + p.Key, "graph", "graph", p.Key, p.Value)),
        ]));
        await coordinator.ApplyAsync(new("test", "data", "test", "Keep data", [
            new CreateRecordOperation("record", "nodes", "one", new Dictionary<string, object?> { ["label"] = "Unchanged" }),
        ]));
        return bytes;
    }

    [TestMethod]
    public async Task ConsentReviewsActualFieldsAndIsSeparateFromInstallAndDefinitionAcceptance()
    {
        await using var workspace = new DesktopTestWorkspace();
        var bytes = await SeedAsync(workspace);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var opened = await session.OpenAsync(workspace.FilePath);
        var absent = await session.ReadExtensionStatusAsync("graph");
        Assert.AreEqual("missing", absent.PackageState);
        Assert.IsFalse(absent.IsApproved);
        Assert.AreEqual("extension-package-unavailable", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.PrepareExtensionConsentAsync("graph"))).Code);
        session.ExtensionPackages.Install(bytes);
        var review = await session.PrepareExtensionConsentAsync("graph");
        Assert.AreEqual(new DesktopExtensionDisclosure("Tasks", "Task title", "Dependencies", "Upstream task", "Downstream task", null), review.View.Disclosure);
        Assert.IsFalse(review.View.IsApproved);
        Assert.IsTrue((await session.ApproveExtensionAsync(review.ReviewId)).IsApproved);
        Assert.AreEqual("extension-review-stale", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.ApproveExtensionAsync(review.ReviewId))).Code);
        await session.CloseAsync();
        await session.OpenAsync(workspace.FilePath);
        Assert.IsTrue((await session.ReadExtensionStatusAsync("graph")).IsApproved);
        await session.DisableExtensionAsync("graph");
        Assert.IsFalse((await session.ReadExtensionStatusAsync("graph")).IsApproved);
        var after = await session.GetViewAsync();
        Assert.AreEqual(opened.Manifest!.ChangeSequence, after.Manifest!.ChangeSequence, "Device consent changed the portable file.");
        Assert.HasCount(1, after.Records);
    }

    [TestMethod]
    public async Task RawFileCopyKeepsItsDefinitionButDoesNotInheritDeviceConsent()
    {
        await using var workspace = new DesktopTestWorkspace();
        var bytes = await SeedAsync(workspace);
        await using var original = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        var before = await original.OpenAsync(workspace.FilePath);
        original.ExtensionPackages.Install(bytes);
        var review = await original.PrepareExtensionConsentAsync("graph");
        await original.ApproveExtensionAsync(review.ReviewId);
        await original.CloseAsync();
        var copyPath = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "raw-copy.nendo");
        File.Copy(workspace.FilePath, copyPath);
        // A fresh history does not already know the original; consent still has to distinguish the physical file.
        await using var copy = new DesktopSessionController(fileHistoryRoot: Path.Combine(workspace.FileHistoryRoot, "fresh-history"), deviceStateRoot: workspace.FileHistoryRoot);
        var after = await copy.OpenAsync(copyPath);
        Assert.AreEqual(before.Manifest!.ApplicationId, after.Manifest!.ApplicationId);
        Assert.AreEqual(before.Manifest.InstanceId, after.Manifest.InstanceId);
        var status = await copy.ReadExtensionStatusAsync("graph");
        Assert.AreEqual("available", status.PackageState);
        Assert.IsFalse(status.IsApproved, "A raw file copy inherited the original's consent through the Desktop controller.");
        Assert.HasCount(1, after.Records);
    }

    [TestMethod]
    public async Task ChangedBindingsAndReopenedFileInvalidatePendingConsent()
    {
        await using var workspace = new DesktopTestWorkspace();
        var bytes = await SeedAsync(workspace);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        session.ExtensionPackages.Install(bytes);
        var review = await session.PrepareExtensionConsentAsync("graph");
        var proposal = await session.PrepareProposalAsync(new("proposal-" + Guid.NewGuid().ToString("N"), "swap", "test", new([
            new("test", "swap", "test", "Reverse graph", [
                new("source", "ui.setProperty", JsonSerializer.SerializeToElement(new { surfaceId = "graph", nodeId = "graph", propertyName = "sourceFieldId", value = "to" })),
                new("target", "ui.setProperty", JsonSerializer.SerializeToElement(new { surfaceId = "graph", nodeId = "graph", propertyName = "targetFieldId", value = "from" })),
            ]),
        ])));
        Assert.IsTrue((await session.PromoteProposalAsync(proposal.ProposalId)).Promotion.Applied);
        Assert.AreEqual("extension-review-stale", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.ApproveExtensionAsync(review.ReviewId))).Code);
        Assert.IsFalse((await session.ReadExtensionStatusAsync("graph")).IsApproved);
        review = await session.PrepareExtensionConsentAsync("graph");
        await session.CloseAsync();
        await session.OpenAsync(workspace.FilePath);
        Assert.AreEqual("extension-review-stale", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.ApproveExtensionAsync(review.ReviewId))).Code);
    }
}
