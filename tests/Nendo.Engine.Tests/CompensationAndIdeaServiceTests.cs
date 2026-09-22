namespace Nendo.Engine.Tests;

[TestClass]
public sealed class CompensationAndIdeaServiceTests
{
    [TestMethod]
    public async Task IdeaGardenRecipeUsesGenericDataCommandAndPersistsAfterReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);

        await service.CreateRecordAsync(new NendoCreateRecordRequest(
            NendoApplicationService.IdeaEntityId,
            "idea-1",
            new Dictionary<string, object?>
            {
                [NendoApplicationService.IdeaTitleFieldId] = "Offline bird fieldbook",
                [NendoApplicationService.IdeaNotesFieldId] = "Log bird sightings offline.",
                [NendoApplicationService.IdeaStatusFieldId] = "Idea",
                [NendoApplicationService.IdeaEnergyFieldId] = "High",
                [NendoApplicationService.IdeaCreatedDateFieldId] = "2026-09-03",
                [NendoApplicationService.IdeaNextActionFieldId] = "Design the entry form",
            },
            new NendoRequestContext("test.p2.5", "create-full", "test")));
        await service.SetFieldAsync(new NendoSetFieldRequest(
            NendoApplicationService.IdeaEntityId,
            "idea-1",
            NendoApplicationService.IdeaStatusFieldId,
            1,
            "Exploring",
            new NendoRequestContext("test.p2.5", "explore", "test")));
        await service.ExecuteCommandAsync(new NendoExecuteCommandRequest(
            IdeaGardenDefinition.MoveToTryingCommandId,
            "idea-1",
            2,
            new NendoRequestContext("test.p2.5", "try-command", "test")));

        var record = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual(3L, record.RecordVersion);
        Assert.AreEqual("Offline bird fieldbook", record.Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreEqual("Log bird sightings offline.", record.Values[NendoApplicationService.IdeaNotesFieldId].GetString());
        Assert.AreEqual("Trying", record.Values[NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.AreEqual("High", record.Values[NendoApplicationService.IdeaEnergyFieldId].GetString());
        Assert.AreEqual("2026-09-03", record.Values[NendoApplicationService.IdeaCreatedDateFieldId].GetString());
        Assert.AreEqual("Design the entry form", record.Values[NendoApplicationService.IdeaNextActionFieldId].GetString());

        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.SetFieldAsync(
            new NendoSetFieldRequest(
                NendoApplicationService.IdeaEntityId,
                "idea-1",
                NendoApplicationService.IdeaEnergyFieldId,
                3,
                "Extreme",
                new NendoRequestContext("test.p2.5", "invalid-energy", "test"))));
        Assert.AreEqual(3L, (await service.GetSnapshotAsync()).Records.Single().RecordVersion);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var reopened = await workspace.OpenAsync("reopen");
        var reopenedService = new NendoApplicationService(reopened);
        var reopenedRecord = (await reopenedService.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual(3L, reopenedRecord.RecordVersion);
        Assert.AreEqual("Trying", reopenedRecord.Values[NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.IsTrue((await reopenedService.CompileSemanticUiAsync()).IsValid);
    }

    [TestMethod]
    public async Task DataCompensationRestoresRetainedValueAndAppendsLinkedRevision()
    {
        await using var workspace = new EngineTestWorkspace();
        var (service, _) = await CreateIdeaGardenWithRecordAsync(workspace);
        var edited = await service.SetIdeaFieldAsync(
            "idea-1",
            1,
            NendoApplicationService.IdeaNextActionFieldId,
            "Continue",
            "edit-next");

        var compensated = await service.CompensateRevisionAsync(
            edited.RevisionId,
            "compensate-next");

        var record = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual(3L, record.RecordVersion);
        Assert.AreEqual("Start", record.Values[NendoApplicationService.IdeaNextActionFieldId].GetString());
        var history = await service.GetHistoryAsync();
        var compensation = history.Single(revision => revision.RevisionId == compensated.RevisionId);
        Assert.AreEqual(edited.RevisionId, compensation.CompensationOfRevisionId);
        Assert.AreEqual(NendoRevisionLane.Data, compensation.Lane);
        Assert.AreEqual("data.setField", compensation.Operations.Single().OperationType);
        Assert.AreEqual(edited.ChangeSequence + 1, compensated.ChangeSequence);
        var replay = await service.CompensateRevisionAsync(
            edited.RevisionId,
            "compensate-next");
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.AreEqual(compensated.RevisionId, replay.RevisionId);
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() =>
            service.CompensateRevisionAsync(edited.RevisionId, "compensate-again"));
    }

    [TestMethod]
    public async Task UiPropertyCompensationRestoresBoardTitleAsNewDefinitionRevision()
    {
        await using var workspace = new EngineTestWorkspace();
        var (service, _) = await CreateIdeaGardenWithRecordAsync(workspace);
        var rename = await service.PrepareBoardTitleProposalAsync("Ideas in motion");
        var promoted = await service.PromoteProposalAsync(rename.ProposalId);
        var renameRevision = promoted.Result!.Revisions.Single();
        Assert.AreEqual("Ideas in motion", (await service.CompileSemanticUiAsync()).Root("boardSurface").Title());

        var compensated = await service.CompensateRevisionAsync(
            renameRevision.RevisionId,
            "compensate-title");

        Assert.AreEqual("Idea board", (await service.CompileSemanticUiAsync()).Root("boardSurface").Title());
        var history = await service.GetHistoryAsync();
        var compensation = history.Single(revision => revision.RevisionId == compensated.RevisionId);
        Assert.AreEqual(renameRevision.RevisionId, compensation.CompensationOfRevisionId);
        Assert.AreEqual(NendoRevisionLane.Definition, compensation.Lane);
        Assert.AreEqual(renameRevision.DefinitionRevision + 1, compensated.DefinitionRevision);
    }

    [TestMethod]
    public async Task NewerUiChangeAndIrreversibleRevisionRefuseCompensation()
    {
        await using var workspace = new EngineTestWorkspace();
        var (service, _) = await CreateIdeaGardenWithRecordAsync(workspace);
        var first = await service.PrepareBoardTitleProposalAsync("First title");
        var firstRevision = (await service.PromoteProposalAsync(first.ProposalId)).Result!.Revisions.Single();
        var second = await service.PrepareBoardTitleProposalAsync("Second title");
        Assert.IsTrue((await service.PromoteProposalAsync(second.ProposalId)).Applied);

        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() =>
            service.CompensateRevisionAsync(firstRevision.RevisionId, "stale-title"));
        var created = (await service.GetHistoryAsync())
            .Single(revision => revision.Description == "Create Idea");
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() =>
            service.CompensateRevisionAsync(created.RevisionId, "undo-create"));
        Assert.AreEqual("Second title", (await service.CompileSemanticUiAsync()).Root("boardSurface").Title());
    }

    [TestMethod]
    public async Task NewerRecordVersionPreventsDataCompensation()
    {
        await using var workspace = new EngineTestWorkspace();
        var (service, _) = await CreateIdeaGardenWithRecordAsync(workspace);
        var first = await service.SetIdeaFieldAsync(
            "idea-1",
            1,
            NendoApplicationService.IdeaNextActionFieldId,
            "Continue",
            "first-next");
        await service.SetIdeaFieldAsync(
            "idea-1",
            2,
            NendoApplicationService.IdeaNextActionFieldId,
            "Finish",
            "second-next");

        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.CompensateRevisionAsync(first.RevisionId, "stale-next"));
        Assert.AreEqual(
            "Finish",
            (await service.GetSnapshotAsync()).Records.Single()
                .Values[NendoApplicationService.IdeaNextActionFieldId].GetString());
    }

    [TestMethod]
    public async Task NewerRecordEditPreventsWholeFormCompensationWithoutPartialInverse()
    {
        await using var workspace = new EngineTestWorkspace();
        var (service, _) = await CreateIdeaGardenWithRecordAsync(workspace);
        var edit = await service.SetFieldsAsync(new(NendoApplicationService.IdeaEntityId, "idea-1", 1,
            new Dictionary<string, object?>
            {
                [NendoApplicationService.IdeaTitleFieldId] = "Changed",
                [NendoApplicationService.IdeaNextActionFieldId] = "Continue",
            }, new("form-tests", "edit", "test")));
        await service.SetIdeaFieldAsync("idea-1", 3, NendoApplicationService.IdeaNextActionFieldId, "Later", "later");
        var before = await service.GetSnapshotAsync();
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.CompensateRevisionAsync(edit.RevisionId, "stale-compensation"));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest, after.Manifest);
        Assert.AreEqual("Changed", after.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreEqual("Later", after.Records.Single().Values[NendoApplicationService.IdeaNextActionFieldId].GetString());
        Assert.AreEqual(4L, after.Records.Single().RecordVersion);
    }

    private static async Task<(NendoApplicationService Service, NendoWriteCoordinator Coordinator)>
        CreateIdeaGardenWithRecordAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        await service.CreateIdeaRecordAsync(
            "idea-1",
            new NendoIdeaDraft(
                "First idea",
                null,
                "Idea",
                "Medium",
                "2026-09-03",
                "Start"),
            "create-record");
        return (service, coordinator);
    }
}
