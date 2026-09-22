namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ChangeSetTests
{
    [TestMethod]
    public async Task DefinitionAndDataGroupsCommitAtomicallyWithProposalAudit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Existing idea", "record");
        var changeSet = SemanticChangeSet("atomic");

        var result = await coordinator.ApplyChangeSetAsync(changeSet, "proposal-atomic");
        var snapshot = await coordinator.GetSnapshotAsync();
        var history = await coordinator.GetHistoryAsync();

        Assert.AreEqual(changeSet.OperationDigest, result.ChangeSetDigest);
        Assert.HasCount(2, result.Revisions);
        Assert.AreEqual((2L, 2L, 4L), (
            result.DefinitionRevision,
            result.DataRevision,
            result.ChangeSequence));
        Assert.AreEqual(NendoFormat.SemanticMinimumHostVersion, snapshot.Manifest.MinimumHostVersion);
        Assert.AreEqual("Idea", snapshot.Records.Single().Values["field.idea.status"].GetString());
        var promoted = history.Where(revision => revision.ProposalId == "proposal-atomic").ToArray();
        Assert.HasCount(2, promoted);
        Assert.AreEqual(NendoRevisionLane.Definition, promoted[0].Lane);
        Assert.AreEqual(NendoRevisionLane.Data, promoted[1].Lane);
        Assert.IsTrue(promoted.All(revision => revision.ProposalDigest == changeSet.OperationDigest));
        Assert.AreEqual(promoted[0].ChangeSequence + 1, promoted[1].ChangeSequence);
    }

    [TestMethod]
    public async Task FailureBeforeCommitRollsBackEveryLaneAndAuditRow()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Existing idea", "record");
        coordinator.BeforeProposalCommit = () => throw new InvalidOperationException("injected failure");

        await Assert.ThrowsExactlyAsync<InvalidOperationException>(() =>
            coordinator.ApplyChangeSetAsync(SemanticChangeSet("failure"), "proposal-failure"));

        var snapshot = await coordinator.GetSnapshotAsync();
        Assert.AreEqual((1L, 1L, 2L), (
            snapshot.Manifest.DefinitionRevision,
            snapshot.Manifest.DataRevision,
            snapshot.Manifest.ChangeSequence));
        Assert.HasCount(1, snapshot.Entities.Single().Fields);
        Assert.IsEmpty(snapshot.UiNodes);
        Assert.IsFalse(snapshot.Records.Single().Values.ContainsKey("field.idea.status"));
        Assert.IsFalse((await coordinator.GetHistoryAsync())
            .Any(revision => revision.ProposalId == "proposal-failure"));
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
    }

    [TestMethod]
    public async Task SqliteBackupClonePreservesIdentityAndIsIndependent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Active", "record");
        var activeBefore = await coordinator.GetSnapshotAsync();
        var clonePath = Path.Combine(
            Path.GetDirectoryName(workspace.FilePath)!,
            "proposal-clone.nendo");

        await coordinator.BackupToAsync(clonePath);
        var collision = await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => NendoWriteCoordinator.OpenAsync(clonePath, "clone"));
        Assert.AreEqual("instance-in-use", collision.Code);
        // Proposal clones remain internal storage workspaces, not a second
        // writable file session claiming the active instance's identity.
        await using var clone = await Nendo.Engine.Storage.SqliteNendoStore.OpenAsync(clonePath, CancellationToken.None);
        var cloned = await clone.GetSessionSnapshotAsync("proposal-clone.nendo", NendoSessionHealth.Normal, CancellationToken.None);
        Assert.AreEqual(activeBefore.Manifest.ApplicationId, cloned.Manifest.ApplicationId);
        Assert.AreEqual(activeBefore.Manifest.InstanceId, cloned.Manifest.InstanceId);

        await clone.ApplyAsync(new NendoMutation("clone", "clone-edit", "test", "Preview only",
            [new SetFieldOperation("clone-edit", NendoApplicationService.IdeaEntityId, "idea-1", NendoApplicationService.IdeaTitleFieldId, 1, "Preview only")]),
            await clone.GetAuthoritySnapshotAsync(CancellationToken.None), CancellationToken.None);
        Assert.AreEqual(
            "Preview only",
            (await clone.GetSessionSnapshotAsync("proposal-clone.nendo", NendoSessionHealth.Normal, CancellationToken.None)).Records.Single()
                .Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreEqual(
            "Active",
            (await service.GetSnapshotAsync()).Records.Single()
                .Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.AreEqual(activeBefore.Manifest.ChangeSequence, (await service.GetSnapshotAsync()).Manifest.ChangeSequence);
    }

    [TestMethod]
    public void ChangeSetDigestIncludesGroupOrderAndRejectsDuplicateOperationIds()
    {
        var original = SemanticChangeSet("digest");
        var reversed = new NendoChangeSet(original.Mutations.Reverse().ToArray()).Validate();
        Assert.AreNotEqual(original.OperationDigest, reversed.OperationDigest);

        var duplicate = new NendoChangeSet([
            new NendoMutation(
                "scope",
                "one",
                "test",
                "First",
                [new SetFieldOperation("same", "entity.idea", "idea-1", "field.idea.title", 1, "One")]),
            new NendoMutation(
                "scope",
                "two",
                "test",
                "Second",
                [new SetFieldOperation("same", "entity.idea", "idea-2", "field.idea.title", 1, "Two")]),
        ]);
        Assert.ThrowsExactly<NendoValidationException>(() => duplicate.Validate());
    }

    private static NendoChangeSet SemanticChangeSet(string key) => new NendoChangeSet([
        new NendoMutation(
            "proposal-test",
            $"{key}-definition",
            "test",
            "Add Status and Idea board root",
            [
                new AddFieldOperation(
                    $"operation-{key}-status",
                    "entity.idea",
                    "field.idea.status",
                    "Status",
                    "status",
                    NendoStorageKind.Text,
                    required: false,
                    presentation: "singleChoice",
                    options: ["Idea", "Exploring", "Trying", "Paused", "Done"]),
                new AddUiNodeOperation(
                    $"operation-{key}-board",
                    "surface.idea.board",
                    "node.idea.board.root",
                    null,
                    "boardSurface",
                    0),
                new SetUiPropertyOperation(
                    $"operation-{key}-entity",
                    "surface.idea.board",
                    "node.idea.board.root",
                    "entityId",
                    "entity.idea"),
            ]),
        new NendoMutation(
            "proposal-test",
            $"{key}-data",
            "test",
            "Place existing Idea in the Idea group",
            [new SetFieldOperation(
                $"operation-{key}-backfill",
                "entity.idea",
                "idea-1",
                "field.idea.status",
                1,
                "Idea")]),
    ]).Validate();
}
