namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ProposalLifecycleTests
{
    [TestMethod]
    public async Task IdeaGardenPreviewUsesPhysicalCloneThenPromotesExactChangeSet()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Existing idea", "record");
        var activeBytes = await ReadBytesSharedAsync(workspace.FilePath);

        var preview = await service.PrepareIdeaGardenProposalAsync();

        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.IsNotEmpty(preview.PreviewApplications);
        Assert.AreEqual("Idea board", preview.Root("boardSurface").Title());
        Assert.AreEqual("Idea", preview.PreviewApplications.Single().Records.Single()
            .Values[NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.HasCount(1, preview.TouchedRecords);
        Assert.IsGreaterThan(40, preview.OperationCount);
        // The board is announced by the name it is being given, rather than by its kind
        // alone with the name arriving as a separate line further down.
        Assert.IsTrue(preview.SemanticDiff.Any(entry => entry.Summary == "Add the grouped board \"Idea board\"."));
        var proposalPath = Path.Combine(coordinator.ProposalRoot, preview.ProposalId);
        foreach (var name in new[]
                 {
                     "proposal.nendo",
                     "proposal.json",
                     "operations.json",
                     "validation.json",
                     "semantic-diff.json",
                 })
        {
            Assert.IsTrue(File.Exists(Path.Combine(proposalPath, name)), name);
        }
        CollectionAssert.AreEqual(activeBytes, await ReadBytesSharedAsync(workspace.FilePath));
        var activeBefore = await service.GetSnapshotAsync();
        Assert.HasCount(1, activeBefore.Entities.Single().Fields);
        Assert.IsEmpty(activeBefore.UiNodes);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, activeBefore.Manifest.MinimumHostVersion);

        var promoted = await service.PromoteProposalAsync(preview.ProposalId);

        Assert.IsTrue(promoted.Applied);
        Assert.AreEqual(NendoProposalState.Active, promoted.State);
        Assert.IsNotNull(promoted.Result);
        Assert.AreEqual(preview.OperationDigest, promoted.Result.ChangeSetDigest);
        Assert.IsFalse(Directory.Exists(proposalPath));
        var active = await service.GetSnapshotAsync();
        Assert.HasCount(6, active.Entities.Single().Fields);
        Assert.HasCount(18, active.UiNodes);
        Assert.AreEqual("Idea", active.Records.Single().Values[NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.AreEqual((2L, 2L, 4L), (
            active.Manifest.DefinitionRevision,
            active.Manifest.DataRevision,
            active.Manifest.ChangeSequence));
        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid);
        var digest = compiled.App().Digest;

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var reopened = await workspace.OpenAsync("reopen");
        var reopenedService = new NendoApplicationService(reopened);
        Assert.AreEqual(digest, (await reopenedService.CompileSemanticUiAsync()).App().Digest);
        Assert.AreEqual("Idea", (await reopenedService.GetSnapshotAsync()).Records.Single()
            .Values[NendoApplicationService.IdeaStatusFieldId].GetString());
    }

    [TestMethod]
    public async Task RejectDeletesWorkspaceAndLeavesActiveFileUnchanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        var before = await ReadBytesSharedAsync(workspace.FilePath);
        var preview = await service.PrepareIdeaGardenProposalAsync();
        var proposalPath = Path.Combine(coordinator.ProposalRoot, preview.ProposalId);

        var rejected = await service.RejectProposalAsync(preview.ProposalId);

        Assert.IsFalse(rejected.Applied);
        Assert.AreEqual(NendoProposalState.Rejected, rejected.State);
        Assert.IsFalse(Directory.Exists(proposalPath));
        CollectionAssert.AreEqual(before, await ReadBytesSharedAsync(workspace.FilePath));
        Assert.IsEmpty((await service.GetSnapshotAsync()).UiNodes);
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.GetProposalAsync(preview.ProposalId));
    }

    [TestMethod]
    public async Task InvalidProposalRetainsEvidenceAndCannotPromote()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        var before = await service.GetSnapshotAsync();
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var invalid = new NendoChangeSet([
            new NendoMutation(
                "invalid-test",
                proposalId,
                "test",
                "Add an incomplete board",
                [new AddUiNodeOperation(
                    "operation-invalid-board",
                    "surface.idea.board",
                    "node.idea.board.root",
                    null,
                    "boardSurface",
                    0)]),
        ]).Validate();

        var preview = await coordinator.BeginProposalAsync(
            proposalId,
            "Incomplete board",
            "test",
            invalid);
        var outcome = await coordinator.PromoteProposalAsync(proposalId);

        Assert.AreEqual(NendoProposalState.Invalid, preview.State);
        Assert.IsEmpty(preview.PreviewApplications);
        Assert.IsNotEmpty(preview.Diagnostics);
        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Invalid, outcome.State);
        Assert.IsTrue(File.Exists(Path.Combine(coordinator.ProposalRoot, proposalId, "proposal.nendo")));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, after.Manifest.ChangeSequence);
        Assert.IsEmpty(after.UiNodes);
    }

    [TestMethod]
    public async Task DefinitionChangeStalesUiProposal()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateIdeaGardenAsync(workspace);
        var rename = await service.PrepareBoardTitleProposalAsync("Ideas in motion");
        await coordinator.ApplyAsync(new NendoMutation(
            "test",
            "concurrent-definition",
            "test",
            "Rename the form",
            [new SetUiPropertyOperation(
                "operation-concurrent-definition",
                IdeaGardenDefinition.FormSurfaceId,
                IdeaGardenDefinition.FormRootId,
                "title",
                "Edit idea")]));

        var outcome = await service.PromoteProposalAsync(rename.ProposalId);

        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Stale, outcome.State);
        Assert.AreEqual("Idea board", (await service.CompileSemanticUiAsync()).Root("boardSurface").Title());
    }

    [TestMethod]
    public async Task UnrelatedRecordEditDoesNotStaleUiOnlyProposal()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await CreateIdeaGardenAsync(workspace);
        await service.CreateIdeaRecordAsync("idea-2", "Before", "record-2");
        var rename = await service.PrepareBoardTitleProposalAsync("Ideas in motion");
        await service.SetIdeaTitleAsync("idea-2", 1, "Changed during review", "edit-2");

        var outcome = await service.PromoteProposalAsync(rename.ProposalId);

        Assert.IsTrue(outcome.Applied);
        var compiled = await service.CompileSemanticUiAsync();
        Assert.AreEqual("Ideas in motion", compiled.Root("boardSurface").Title());
        Assert.AreEqual(
            "Changed during review",
            compiled.App().Records.Single(record => record.SemanticId == "idea-2")
                .Values[NendoApplicationService.IdeaTitleFieldId].GetString());
    }

    [TestMethod]
    public async Task TouchedRecordChangeStalesDataProposal()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateIdeaGardenAsync(workspace);
        var record = (await service.GetSnapshotAsync()).Records.Single();
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var changeSet = new NendoChangeSet([
            new NendoMutation(
                "test",
                proposalId,
                "test",
                "Move the Idea to Paused",
                [new SetFieldOperation(
                    "operation-pause",
                    NendoApplicationService.IdeaEntityId,
                    record.RecordId,
                    NendoApplicationService.IdeaStatusFieldId,
                    record.RecordVersion,
                    "Paused")]),
        ]).Validate();
        var preview = await coordinator.BeginProposalAsync(
            proposalId,
            "Pause Idea",
            "test",
            changeSet);
        await service.SetIdeaTitleAsync(
            record.RecordId,
            record.RecordVersion,
            "Changed while reviewing",
            "concurrent-record");

        var outcome = await service.PromoteProposalAsync(preview.ProposalId);

        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Stale, outcome.State);
        var active = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual("Idea", active.Values[NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.AreEqual("Changed while reviewing", active.Values[NendoApplicationService.IdeaTitleFieldId].GetString());
    }

    [TestMethod]
    public async Task InjectedPromotionFailureLeavesActiveFileAndHistoryUnchanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        var preview = await service.PrepareIdeaGardenProposalAsync();
        var before = await service.GetSnapshotAsync();
        coordinator.BeforeProposalCommit = () => throw new InvalidOperationException("injected");

        var outcome = await service.PromoteProposalAsync(preview.ProposalId);

        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Failed, outcome.State);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, after.Manifest.ChangeSequence);
        Assert.HasCount(1, after.Entities.Single().Fields);
        Assert.IsEmpty(after.UiNodes);
        Assert.IsFalse((await service.GetHistoryAsync()).Any(revision => revision.ProposalId == preview.ProposalId));
        Assert.IsTrue(Directory.Exists(Path.Combine(coordinator.ProposalRoot, preview.ProposalId)));
    }

    [TestMethod]
    public async Task ReopenRemovesOnlyAbandonedProposalDirectoriesForTheApplication()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var root = coordinator.ProposalRoot;
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var abandoned = Path.Combine(root, $"proposal-{Guid.NewGuid():N}");
        Directory.CreateDirectory(abandoned);
        await File.WriteAllTextAsync(Path.Combine(abandoned, "proposal.json"), "{}");
        var unrelated = Path.Combine(root, "keep-me");
        Directory.CreateDirectory(unrelated);

        var reopened = await workspace.OpenAsync("cleanup");

        Assert.IsFalse(Directory.Exists(abandoned));
        Assert.IsTrue(Directory.Exists(unrelated));
        Directory.Delete(unrelated);
        await reopened.DisposeAsync();
        workspace.Forget(reopened);
    }

    [TestMethod]
    public async Task AProposalThatFailsToValidateForANonNendoReasonIsNotRetained()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposalId = $"proposal-{Guid.NewGuid():N}";

        // Occupy the clone destination so BackupToAsync throws a plain IOException — a
        // failure that is not a NendoException — while the proposal is being validated.
        var workspacePath = Path.Combine(coordinator.ProposalRoot, proposalId);
        Directory.CreateDirectory(workspacePath);
        await File.WriteAllTextAsync(Path.Combine(workspacePath, "proposal.nendo"), "occupied");

        var change = new NendoChangeSet([new NendoMutation("test", "rename", "test", "Rename",
            [new RenameEntityOperation("rename", NendoApplicationService.IdeaEntityId, "Ideas", revision)])]);
        await Assert.ThrowsExactlyAsync<IOException>(
            () => coordinator.BeginProposalAsync(proposalId, "Blocked", "test", change));

        // The half-registered proposal must not linger: it would block its own ID, refuse
        // promotion as never-previewable, count against a restore and never clean up.
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => service.GetProposalAsync(proposalId));
    }

    [TestMethod]
    public async Task AWorkspaceThatCannotBeRemovedDoesNotReplaceTheReasonValidationFailed()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposalId = $"proposal-{Guid.NewGuid():N}";

        // The clone destination is a directory, so the clone fails for a reason that is
        // neither a Nendo refusal nor an IOException — and a file held open inside it
        // means the workspace cannot be removed either. Removing it unguarded in the
        // failure handler threw the removal's own IOException in place of the failure.
        var workspacePath = Path.Combine(coordinator.ProposalRoot, proposalId);
        var occupied = Path.Combine(workspacePath, "proposal.nendo");
        Directory.CreateDirectory(occupied);
        await using var held = new FileStream(
            Path.Combine(occupied, "held"), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);

        var change = new NendoChangeSet([new NendoMutation("test", "rename", "test", "Rename",
            [new RenameEntityOperation("rename", NendoApplicationService.IdeaEntityId, "Ideas", revision)])]);
        Exception? surfaced = null;
        try
        {
            await coordinator.BeginProposalAsync(proposalId, "Blocked", "test", change);
        }
        catch (Exception exception)
        {
            surfaced = exception;
        }

        Assert.IsNotNull(surfaced, "A clone into a directory was accepted.");
        Assert.IsNotInstanceOfType<NendoException>(surfaced, "The failure was a Nendo refusal, so the cleanup path was never exercised.");
        Assert.IsNotInstanceOfType<IOException>(surfaced,
            $"The workspace removal's failure replaced the reason validation failed: {surfaced.Message}");
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => service.GetProposalAsync(proposalId));
    }

    private static async Task<(NendoWriteCoordinator Coordinator, NendoApplicationService Service)>
        CreateIdeaGardenAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "First idea", "record");
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        var outcome = await service.PromoteProposalAsync(proposal.ProposalId);
        Assert.IsTrue(outcome.Applied);
        return (coordinator, service);
    }

    private static async Task<byte[]> ReadBytesSharedAsync(string path)
    {
        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Access = FileAccess.Read,
            Mode = FileMode.Open,
            Share = FileShare.ReadWrite,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
        });
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer);
        return buffer.ToArray();
    }
}
