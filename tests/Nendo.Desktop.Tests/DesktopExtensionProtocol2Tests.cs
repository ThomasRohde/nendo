using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The native review of a protocol-2 view (ADR-0013, 2026-09-24; W-060): it names every
/// field the page will receive, a reference by whose label it sends, and the fields the
/// view is narrowed by; and a package that speaks another protocol is not called corrupt.
/// </summary>
[TestClass]
public sealed class DesktopExtensionProtocol2Tests
{
    private static async Task SeedAsync(DesktopTestWorkspace workspace, string packageDigest, string packageVersion)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "extension-test");
        await coordinator.ApplyAsync(new("test", "schema", "test", "Graph data", [
            new CreateEntityOperation("nodes", "nodes", "Tasks", "nodes"),
            new AddFieldOperation("label", "nodes", "label", "Task title", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("owner", "nodes", "owner", "Owner", "owner", NendoStorageKind.Text, false),
            new AddFieldOperation("weight", "nodes", "weight", "Weight", "weight", NendoStorageKind.Integer, false),
            new AddFieldOperation("parent", "nodes", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new CreateEntityOperation("edges", "edges", "Dependencies", "edges"),
            new AddFieldOperation("from", "edges", "from", "Upstream task", "from_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("to", "edges", "to", "Downstream task", "to_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("kind", "edges", "kind", "Kind", "kind", NendoStorageKind.Text, false),
            new ConfigureReferenceOperation("bind-from", "edges", "from", "nodes", "label", 0),
            new ConfigureReferenceOperation("bind-to", "edges", "to", "nodes", "label", 0),
            new ConfigureReferenceOperation("bind-parent", "nodes", "parent", "nodes", "label", 0),
        ]));
        var properties = new Dictionary<string, object?>
        {
            ["definitionVersion"] = 3, ["entityId"] = "nodes", ["title"] = "Dependencies",
            ["packageId"] = "org.nendo.offline-test", ["packageVersion"] = packageVersion, ["packageDigest"] = packageDigest,
            ["protocolVersion"] = 2, ["configurationVersion"] = 1, ["configuration"] = "{}",
            ["edgeEntityId"] = "edges", ["labelFieldId"] = "label", ["sourceFieldId"] = "from", ["targetFieldId"] = "to",
        };
        (string Kind, Dictionary<string, object?> Properties)[] children =
        [
            ("fieldBinding", new() { ["fieldId"] = "owner" }),
            ("fieldBinding", new() { ["fieldId"] = "parent" }),
            ("fieldBinding", new() { ["fieldId"] = "kind" }),
            ("filterClause", new() { ["fieldId"] = "weight", ["operator"] = "gte", ["value"] = 1 }),
        ];
        await coordinator.ApplyAsync(new("test", "view", "test", "Graph view", [
            new AddUiNodeOperation("graph", "graph", "graph", null, NendoExtensionViewDefinition.NodeKind, 0),
            .. properties.Select(p => new SetUiPropertyOperation("set-" + p.Key, "graph", "graph", p.Key, p.Value)),
            .. children.SelectMany((child, i) => (NendoOperation[])[
                new AddUiNodeOperation($"child-{i}", "graph", $"graph-{i}", "graph", child.Kind, i),
                .. child.Properties.Select(p => new SetUiPropertyOperation($"child-{i}-{p.Key}", "graph", $"graph-{i}", p.Key, p.Value))]),
        ]));
    }

    [TestMethod]
    public async Task TheReviewNamesEveryDisclosedFieldAndWhatTheViewIsNarrowedBy()
    {
        await using var workspace = new DesktopTestWorkspace();
        var bytes = DesktopExtensionDeviceTests.Archive(protocol: 2);
        var package = new DesktopExtensionPackageStore(workspace.FileHistoryRoot).Inspect(bytes);
        await SeedAsync(workspace, package.Digest, package.Version);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        session.ExtensionPackages.Install(bytes);
        var review = await session.PrepareExtensionConsentAsync("graph");
        Assert.AreEqual(new DesktopExtensionDisclosure("Tasks", "Task title", "Dependencies", "Upstream task", "Downstream task", null)
        {
            NodeFields = ["Owner", "Parent (the Task title of each Tasks record)"],
            EdgeFields = ["Kind"],
            FilterFields = ["Weight"],
        }, review.View.Disclosure);
        Assert.IsTrue((await session.ApproveExtensionAsync(review.ReviewId)).IsApproved);
    }

    [TestMethod]
    public async Task ARecordSetReviewNamesItsColumnsAndNoRelationship()
    {
        await using var workspace = new DesktopTestWorkspace();
        var bytes = DesktopExtensionDeviceTests.Archive(protocol: 2);
        var package = new DesktopExtensionPackageStore(workspace.FileHistoryRoot).Inspect(bytes);
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "extension-test"))
        {
            await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
                new CreateEntityOperation("nodes", "nodes", "Tasks", "nodes"),
                new AddFieldOperation("label", "nodes", "label", "Task title", "label", NendoStorageKind.Text, true),
                new AddFieldOperation("starts", "nodes", "starts", "Starts", "starts", NendoStorageKind.Date, false),
                new AddFieldOperation("owner", "nodes", "owner", "Owner", "owner", NendoStorageKind.Text, false),
            ]));
            var properties = new Dictionary<string, object?>
            {
                ["definitionVersion"] = 3, ["entityId"] = "nodes", ["title"] = "Schedule",
                ["packageId"] = "org.nendo.offline-test", ["packageVersion"] = package.Version, ["packageDigest"] = package.Digest,
                ["protocolVersion"] = 2, ["configurationVersion"] = 1, ["configuration"] = "{}", ["labelFieldId"] = "label",
            };
            await coordinator.ApplyAsync(new("test", "view", "test", "Record view", [
                new AddUiNodeOperation("graph", "graph", "graph", null, NendoExtensionViewDefinition.RecordsKind, 0),
                .. properties.Select(p => new SetUiPropertyOperation("set-" + p.Key, "graph", "graph", p.Key, p.Value)),
                new AddUiNodeOperation("c0", "graph", "graph-0", "graph", "fieldBinding", 0),
                new SetUiPropertyOperation("c0-f", "graph", "graph-0", "fieldId", "starts"),
                new AddUiNodeOperation("c1", "graph", "graph-1", "graph", "filterClause", 1),
                new SetUiPropertyOperation("c1-f", "graph", "graph-1", "fieldId", "owner"),
                new SetUiPropertyOperation("c1-o", "graph", "graph-1", "operator", "isNotNull"),
            ]));
        }
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        session.ExtensionPackages.Install(bytes);
        var review = await session.PrepareExtensionConsentAsync("graph");
        Assert.AreEqual(new DesktopExtensionDisclosure("Tasks", "Task title", null, null, null, null)
        {
            NodeFields = ["Starts"],
            FilterFields = ["Owner"],
        }, review.View.Disclosure);
        Assert.IsTrue(review.View.Definition.IsRecordSet);
    }

    [TestMethod]
    public async Task APackageAtAnotherProtocolIsIncompatibleNotCorrupt()
    {
        await using var workspace = new DesktopTestWorkspace();
        var bytes = DesktopExtensionDeviceTests.Archive(protocol: 1);
        var package = new DesktopExtensionPackageStore(workspace.FileHistoryRoot).Inspect(bytes);
        await SeedAsync(workspace, package.Digest, package.Version);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        session.ExtensionPackages.Install(bytes);
        Assert.AreEqual("incompatible", (await session.ReadExtensionStatusAsync("graph")).PackageState);
        Assert.AreEqual("extension-package-unavailable", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.PrepareExtensionConsentAsync("graph"))).Code);
    }
}
