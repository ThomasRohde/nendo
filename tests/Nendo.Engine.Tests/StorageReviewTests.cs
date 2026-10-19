using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Storage, History and canonical payloads.
/// </summary>
[TestClass]
public sealed class StorageReviewTests
{
    [TestMethod]
    [DataRow("ui.addNode", """{"surfaceId":"s","nodeId":"n","parentNodeId":null,"kind":"section","position":"1"}""", "position")]
    [DataRow("data.setField", """{"entityId":"e","recordId":"r","fieldId":"f","value":"x","expectedRecordVersion":null}""", "expectedRecordVersion")]
    [DataRow("schema.renameEntity", """{"entityId":"e","displayName":"E","expectedDefinitionRevision":"3"}""", "expectedDefinitionRevision")]
    [DataRow("data.createRecord", """{"entityId":"e","recordId":"r","values":{},"expectedTargetVersions":{"a":"2"}}""", "a")]
    [DataRow("schema.setFieldSequence", """{"entityId":"e","fieldId":"f","prefix":"T-","width":99999999999,"expectedDefinitionRevision":1}""", "width")]
    public void ESM09_AWronglyTypedIntegerIsARefusalNamingItsProperty(string operationType, string payload, string property)
    {
        var refusal = Assert.ThrowsExactly<NendoValidationException>(
            () => NendoCanonicalOperations.Check(operationType, JsonDocument.Parse(payload).RootElement.Clone()),
            "A client typo escaped the shape check as an internal error.");
        StringAssert.Contains(refusal.Message, $"property {property} requires an integer", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task ESM07_AnOperationIdAnEarlierRevisionUsedIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [new CreateEntityOperation("rename", "e", "E", "e")]));

        var direct = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(
            new("test", "again", "test", "Again", [new CreateEntityOperation("rename", "f", "F", "f")])));
        StringAssert.Contains(direct.Message, "operation ID rename", StringComparison.Ordinal);

        // A view may supply its own IDs; a proposal that repeats one is refused with a reason, not a raw SQLite error.
        var preview = await coordinator.BeginProposalAsync($"proposal-{Guid.NewGuid():N}", "Again", "test",
            new NendoChangeSet([new NendoMutation("test", "proposal-again", "test", "Again", [new CreateEntityOperation("rename", "g", "G", "g")])]));
        Assert.AreEqual(NendoProposalState.Invalid, preview.State);
        Assert.IsTrue(preview.Diagnostics.Any(d => d.Message.Contains("operation ID rename", StringComparison.Ordinal)),
            string.Join("; ", preview.Diagnostics.Select(d => d.Message)));
    }

    [TestMethod]
    public async Task ESM04_AScreenEditIsNotReversedOverALaterDefinitionChange()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema()));
        await coordinator.ApplyAsync(new("test", "list", "test", "List", List("e.old")));

        // Retiring a field the list orders by is refused, as retiring a bound field always was.
        var bound = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Retire(coordinator, service, "e.old"));
        Assert.AreEqual("retired-binding", bound.Code, "A retirement under the list's ordering was accepted, and every custom screen would stop compiling.");

        var reordered = await coordinator.ApplyAsync(new("test", "reorder", "test", "Order by New",
            [new SetUiPropertyOperation("reorder", "s", "list", "orderByFieldId", "e.new")]));
        await Retire(coordinator, service, "e.old");

        var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(reordered.RevisionId, "undo-reorder"),
            "Compensation ordered the list by a retired field again.");
        // Worded for every structure change.
        StringAssert.Contains(refused.Message, "Only the latest change to the file's structure can be undone", StringComparison.Ordinal);
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);
    }

    [TestMethod]
    public async Task ESM04_AScreenEditWithNothingAfterItIsStillReversed()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema()));
        await coordinator.ApplyAsync(new("test", "list", "test", "List", List("e.old")));
        var reordered = await coordinator.ApplyAsync(new("test", "reorder", "test", "Order by New",
            [new SetUiPropertyOperation("reorder", "s", "list", "orderByFieldId", "e.new")]));
        await service.CompensateRevisionAsync(reordered.RevisionId, "undo-reorder");
        var list = (await service.CompileSemanticUiAsync()).Applications.Single().Surfaces.Single();
        Assert.AreEqual("e.old", list.Properties["orderByFieldId"].GetString());
    }

    [TestMethod]
    public async Task ESM12_AnAddedNodeAndAMovedNodeAreReversedAsTheirClassSays()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema()));
        await coordinator.ApplyAsync(new("test", "page", "test", "Page", [
            new AddUiNodeOperation("p", "page", "page", null, "detailSurface", 0),
            new SetUiPropertyOperation("p-v", "page", "page", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("p-e", "page", "page", "entityId", "e"),
            new SetUiPropertyOperation("p-t", "page", "page", "title", "E"),
            new AddUiNodeOperation("a", "page", "a", "page", "section", 0),
            new SetUiPropertyOperation("a-t", "page", "a", "title", "A"),
            new AddUiNodeOperation("b", "page", "b", "page", "section", 1),
            new SetUiPropertyOperation("b-t", "page", "b", "title", "B"),
            new AddUiNodeOperation("bind", "page", "bind", "a", "fieldBinding", 0),
            new SetUiPropertyOperation("bind-f", "page", "bind", "fieldId", "e.title"),
        ]));

        var moved = await coordinator.ApplyAsync(new("test", "move", "test", "Move", [new MoveUiNodeOperation("move", "page", "bind", "b", 0)]));
        var history = await service.QueryHistoryAsync(new(1));
        Assert.IsTrue(history.Items[0].CanRequestCompensation, "History does not offer to reverse a move it declares reversible.");
        await service.CompensateRevisionAsync(moved.RevisionId, "undo-move");
        var bind = (await service.GetSnapshotAsync()).UiNodes.Single(node => node.NodeId == "bind");
        Assert.AreEqual("a", bind.ParentNodeId, "The move was not taken back to its retained parent.");

        var added = await coordinator.ApplyAsync(new("test", "add", "test", "Add", [new AddUiNodeOperation("add", "page", "c", "page", "tabGroup", 2)]));
        history = await service.QueryHistoryAsync(new(1));
        Assert.IsTrue(history.Items[0].CanRequestCompensation, "History does not offer to reverse an added node it declares reversible.");
        await service.CompensateRevisionAsync(added.RevisionId, "undo-add");
        Assert.IsFalse((await service.GetSnapshotAsync()).UiNodes.Any(node => node.NodeId == "c"), "The added node is still there.");
    }

    /// <summary>
    /// A compensation lands on an earlier state with no compile of its own, and the state before a
    /// revision may never have compiled: here the middle of two moves, a tab group left with no tab.
    /// </summary>
    [TestMethod]
    public async Task ESM12_ACompensationThatWouldLeaveScreensThatDoNotCompileIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema()));
        await coordinator.ApplyAsync(new("test", "page", "test", "Page", [
            new AddUiNodeOperation("p", "page", "page", null, "detailSurface", 0),
            new SetUiPropertyOperation("p-v", "page", "page", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("p-e", "page", "page", "entityId", "e"),
            new SetUiPropertyOperation("p-t", "page", "page", "title", "E"),
            new AddUiNodeOperation("tabs", "page", "tabs", "page", "tabGroup", 0),
            new AddUiNodeOperation("s1", "page", "s1", "tabs", "section", 0),
            new SetUiPropertyOperation("s1-t", "page", "s1", "title", "One"),
            new AddUiNodeOperation("s1-b", "page", "s1-b", "s1", "fieldBinding", 0),
            new SetUiPropertyOperation("s1-f", "page", "s1-b", "fieldId", "e.title"),
            new AddUiNodeOperation("s2", "page", "s2", "page", "section", 1),
            new SetUiPropertyOperation("s2-t", "page", "s2", "title", "Two"),
            new AddUiNodeOperation("s2-b", "page", "s2-b", "s2", "fieldBinding", 0),
            new SetUiPropertyOperation("s2-f", "page", "s2-b", "fieldId", "e.old"),
        ]));
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);
        // One proposal's two mutations, accepted together: the first leaves the tab group empty.
        await coordinator.ApplyAsync(new("test", "out", "test", "Out of the tabs", [new MoveUiNodeOperation("out", "page", "s1", "page", 2)]));
        var into = await coordinator.ApplyAsync(new("test", "in", "test", "Into the tabs", [new MoveUiNodeOperation("in", "page", "s2", "tabs", 0)]));
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid);

        var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(into.RevisionId, "undo-into"),
            "Compensation left a tab group with no tabs, and every custom screen with it.");
        StringAssert.Contains(refused.Message, "NUI310", StringComparison.Ordinal);
        Assert.IsTrue((await service.CompileSemanticUiAsync()).IsValid, "The refused compensation changed the file.");
    }

    [TestMethod]
    public async Task ESM04_HistoryOffersAScreenEditsReversalOnlyWhileTheDefinitionStandsAsItLeftIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema()));
        await coordinator.ApplyAsync(new("test", "list", "test", "List", List("e.old")));
        var reordered = await coordinator.ApplyAsync(new("test", "reorder", "test", "Order by New",
            [new SetUiPropertyOperation("reorder", "s", "list", "orderByFieldId", "e.new")]));
        Assert.IsTrue((await service.QueryHistoryAsync(new(1))).Items[0].CanRequestCompensation);
        await coordinator.ApplyAsync(new("test", "retitle", "test", "Retitle",
            [new SetUiPropertyOperation("retitle", "s", "list", "title", "Everything")]));
        var history = await service.QueryHistoryAsync(new(5));
        Assert.IsFalse(history.Items.Single(item => item.RevisionId == reordered.RevisionId).CanRequestCompensation,
            "History offered a reversal the engine refuses once the definition has moved on.");
    }

    [TestMethod]
    public async Task ESM26_RunningTheIdeaGardenProposalAgainSaysTheFileHasSurfaces()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);

        var again = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.PrepareIdeaGardenProposalAsync());
        Assert.AreEqual("semantic-definition-exists", again.Code, again.Message);
    }

    private static NendoOperation[] Schema() =>
    [
        new CreateEntityOperation("e", "e", "E", "e"),
        new AddFieldOperation("e-title", "e", "e.title", "Title", "title", NendoStorageKind.Text, true, "singleLine"),
        new AddFieldOperation("e-old", "e", "e.old", "Old sort", "old_sort", NendoStorageKind.Integer, false),
        new AddFieldOperation("e-new", "e", "e.new", "New sort", "new_sort", NendoStorageKind.Integer, false),
    ];

    private static NendoOperation[] List(string orderBy) =>
    [
        new AddUiNodeOperation("list", "s", "list", null, "recordList", 0),
        new SetUiPropertyOperation("list-v", "s", "list", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
        new SetUiPropertyOperation("list-e", "s", "list", "entityId", "e"),
        new SetUiPropertyOperation("list-t", "s", "list", "title", "All"),
        new SetUiPropertyOperation("list-o", "s", "list", "orderByFieldId", orderBy),
        new AddUiNodeOperation("bind", "s", "bind", "list", "fieldBinding", 0),
        new SetUiPropertyOperation("bind-f", "s", "bind", "fieldId", "e.title"),
    ];

    private static async Task Retire(NendoWriteCoordinator coordinator, NendoApplicationService service, string fieldId)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", $"retire-{Guid.NewGuid():N}", "test", "Retire",
            [new SetRetiredOperation($"retire-{Guid.NewGuid():N}", "e", fieldId, true, revision)]));
    }
}
