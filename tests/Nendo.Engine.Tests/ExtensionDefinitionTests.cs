using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ExtensionDefinitionTests
{
    private static Dictionary<string, object?> Properties() => new()
    {
        ["definitionVersion"] = 3, ["entityId"] = "nodes", ["title"] = "Dependencies",
        ["packageId"] = "org.nendo.dependency-graph", ["packageVersion"] = "0.1.0",
        ["packageDigest"] = new string('a', 64), ["protocolVersion"] = 1,
        ["configurationVersion"] = 1, ["configuration"] = "{}",
        ["edgeEntityId"] = "edges", ["labelFieldId"] = "label", ["sourceFieldId"] = "from", ["targetFieldId"] = "to",
    };

    private static NendoProposalRequest Request(string key, Dictionary<string, object?> properties) => new(
        "proposal-" + Guid.NewGuid().ToString("N"), key, "test", new([
            new("test", key, "test", key, [
                new AddUiNodeOperation(key + "-add", "graph", "graph", null, NendoExtensionViewDefinition.NodeKind, 0),
                .. properties.Select(p => new SetUiPropertyOperation(key + "-" + p.Key, "graph", "graph", p.Key, p.Value)),
            ]),
        ]));

    private static async Task<NendoApplicationService> Seed(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Graph data", [
            new CreateEntityOperation("nodes", "nodes", "Nodes", "nodes"),
            new AddFieldOperation("label", "nodes", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("edges", "edges", "Edges", "edges"),
            new AddFieldOperation("from", "edges", "from", "From", "from_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("to", "edges", "to", "To", "to_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind-from", "edges", "from", "nodes", "label", 0),
            new ConfigureReferenceOperation("bind-to", "edges", "to", "nodes", "label", 0),
        ]));
        await coordinator.ApplyAsync(new("test", "data", "test", "Graph record", [
            new CreateRecordOperation("node", "nodes", "one", new Dictionary<string, object?> { ["label"] = "Keep this record" }),
        ]));
        return new(coordinator);
    }

    [TestMethod]
    public async Task MissingPackageDefinitionReviewsReplaysReopensAndRemovesWithoutDeletingData()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = await Seed(coordinator);
        var before = await service.GetSnapshotAsync();
        var preview = await service.PrepareProposalAsync(Request("graph", Properties()));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, string.Join(";", preview.Diagnostics.Select(d => d.Message)));
        Assert.AreEqual(NendoFormat.ExtensionViewsMinimumHostVersion, preview.MinimumHostVersionAfter);
        Assert.IsEmpty((await service.GetDefinitionSnapshotAsync()).UiNodes);
        var promoted = await service.PromoteProposalAsync(preview.ProposalId, expectedOperationDigest: preview.OperationDigest);
        Assert.IsTrue(promoted.Applied);
        Assert.AreEqual(preview.OperationDigest, promoted.Result!.ChangeSetDigest);
        var graph = await service.ReadExtensionViewAsync("graph");
        Assert.HasCount(1, graph.Projection.Nodes);
        Assert.AreEqual("Keep this record", graph.Projection.Nodes[0].Label);
        Assert.AreEqual(before.Manifest.DataRevision, (await service.GetDefinitionSnapshotAsync()).Manifest.DataRevision);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        coordinator = await workspace.OpenAsync(); service = new(coordinator);
        Assert.AreEqual(graph.Definition.ComputeBindingDigest(), (await service.ReadExtensionViewAsync("graph")).Definition.ComputeBindingDigest());
        Assert.AreEqual(NendoFormat.ExtensionViewsMinimumHostVersion, (await service.GetDefinitionSnapshotAsync()).Manifest.MinimumHostVersion);
        var removed = await coordinator.ApplyAsync(new("test", "remove", "test", "Remove view only", [new RemoveUiNodeOperation("remove", "graph", "graph")]));
        Assert.AreEqual("extension-view-missing", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ReadExtensionViewAsync("graph"))).Code);
        Assert.HasCount(1, (await service.GetSnapshotAsync()).Records);
        Assert.IsTrue((await service.QueryHistoryAsync(new(1))).Items[0].CanRequestCompensation);
        await service.CompensateRevisionAsync(removed.RevisionId, "restore-view");
        Assert.IsTrue((await service.CompensateRevisionAsync(removed.RevisionId, "restore-view")).IsIdempotentReplay);
        Assert.AreEqual(graph.Definition.ComputeBindingDigest(), (await service.ReadExtensionViewAsync("graph")).Definition.ComputeBindingDigest());
    }

    [TestMethod]
    public async Task FutureConfigurationSurvivesUnrelatedEditsButCannotExecute()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync(); var service = await Seed(coordinator);
        var properties = Properties(); properties["configurationVersion"] = 2;
        properties["configuration"] = JsonSerializer.Serialize(new { future = new[] { "opaque", "kept" } });
        var preview = await service.PrepareProposalAsync(Request("future", properties));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.IsTrue(preview.Diagnostics.Any(d => d.Code == "NUI451"));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var stored = (await service.GetDefinitionSnapshotAsync()).UiNodes.Single().Properties["configuration"].GetRawText();
        Assert.AreEqual("extension-version-unsupported", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ReadExtensionViewAsync("graph"))).Code);
        await service.SetFieldAsync(new("nodes", "one", "label", 1, "Changed through Studio", new("test", "edit", "test")));
        Assert.AreEqual(stored, (await service.GetDefinitionSnapshotAsync()).UiNodes.Single().Properties["configuration"].GetRawText());
    }

    [TestMethod]
    public async Task InvalidBindingCannotBecomeAnAcceptedProposal()
    {
        await using var workspace = new EngineTestWorkspace(); var service = await Seed(await workspace.CreateAsync());
        var properties = Properties(); properties["targetFieldId"] = "label";
        var preview = await service.PrepareProposalAsync(Request("bad", properties));
        Assert.AreEqual(NendoProposalState.Invalid, preview.State);
        Assert.IsTrue(preview.Diagnostics.Any(d => d.Code == "NUI450"));
        Assert.IsFalse((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        Assert.IsEmpty((await service.GetDefinitionSnapshotAsync()).UiNodes);
    }

    [TestMethod]
    public async Task RemovalRestorationRefusesLaterDefinitionChanges()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync(); var service = await Seed(coordinator);
        var preview = await service.PrepareProposalAsync(Request("install", Properties()));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var removed = await coordinator.ApplyAsync(new("test", "remove", "test", "Remove view", [new RemoveUiNodeOperation("remove", "graph", "graph")]));
        await coordinator.ApplyAsync(new("test", "new-schema", "test", "Change definition", [new CreateEntityOperation("extra", "extra", "Extra", "extra")]));
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CompensateRevisionAsync(removed.RevisionId, "restore-stale"));
        Assert.AreEqual("definition-revision-conflict", refusal.Code);
        Assert.IsEmpty((await service.GetDefinitionSnapshotAsync()).UiNodes);
    }

    [TestMethod]
    public void ExactPinsAndBoundedConfigurationAreNotExecutableContent()
    {
        var properties = Properties().ToDictionary(p => p.Key, p => JsonSerializer.SerializeToElement(p.Value));
        var definition = NendoExtensionViewDefinition.Read("graph", properties);
        Assert.IsTrue(definition.IsSupported);
        properties["packageVersion"] = JsonSerializer.SerializeToElement("1.0.0-01");
        Assert.ThrowsExactly<NendoPreconditionException>(() => NendoExtensionViewDefinition.Read("graph", properties));
        properties["packageVersion"] = JsonSerializer.SerializeToElement("1.0.0");
        properties["configuration"] = JsonSerializer.SerializeToElement(JsonSerializer.Serialize(new { script = "alert(1)" }));
        Assert.ThrowsExactly<NendoPreconditionException>(() => NendoExtensionViewDefinition.Read("graph", properties));
    }

    [TestMethod]
    public async Task ChangedDefinitionMakesAReviewedGraphProposalStale()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync(); var service = await Seed(coordinator);
        var preview = await service.PrepareProposalAsync(Request("stale", Properties()));
        await coordinator.ApplyAsync(new("test", "another-type", "test", "An independent definition change", [
            new CreateEntityOperation("other", "other", "Other", "other"),
        ]));
        Assert.IsFalse((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        Assert.IsEmpty((await service.GetDefinitionSnapshotAsync()).UiNodes);
    }

    [TestMethod]
    public async Task RetiringTheEdgeTypeRequiresRemovingItsViewInTheSameProposal()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync(); var service = await Seed(coordinator);
        var preview = await service.PrepareProposalAsync(Request("install", Properties()));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "retire", "test", "Retire edges", [
            new SetRetiredOperation("retire", "edges", null, true, revision),
        ])));
        Assert.AreEqual("retired-binding", refusal.Code);
        Assert.HasCount(1, (await service.ReadExtensionViewAsync("graph")).Projection.Nodes);
    }
}
