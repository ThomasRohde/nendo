namespace Nendo.Engine.Tests;

[TestClass]
public sealed class MalleabilityTests
{
    [TestMethod]
    public async Task DecisionLogUsesGenericProposalDataCommandAndReopenPath()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var originalBytes = await ReadBytesSharedAsync(workspace.FilePath);

        var rejectedProposalId = ProposalId();
        var rejectedPreview = await service.PrepareProposalAsync(new NendoProposalRequest(
            rejectedProposalId,
            "Create Decision Log",
            "test",
            fixture.DefinitionChangeSet(rejectedProposalId)));

        Assert.AreEqual(NendoProposalState.Previewable, rejectedPreview.State);
        Assert.IsNotEmpty(rejectedPreview.PreviewApplications);
        Assert.AreEqual("entity.decision", rejectedPreview.PreviewApplications.Single().Entity.SemanticId);
        Assert.AreEqual("Decision board", rejectedPreview.Root("boardSurface").Title());
        Assert.IsFalse(rejectedPreview.SemanticDiff.Any(entry => entry.Summary.Contains("Idea", StringComparison.Ordinal)));
        Assert.AreEqual(NendoProposalState.Rejected,
            (await service.RejectProposalAsync(rejectedPreview.ProposalId)).State);
        CollectionAssert.AreEqual(originalBytes, await ReadBytesSharedAsync(workspace.FilePath));
        Assert.IsEmpty((await service.GetSnapshotAsync()).Entities);

        var acceptedProposalId = ProposalId();
        var acceptedPreview = await service.PrepareProposalAsync(new NendoProposalRequest(
            acceptedProposalId,
            "Create Decision Log",
            "test",
            fixture.DefinitionChangeSet(acceptedProposalId)));
        var promoted = await service.PromoteProposalAsync(acceptedPreview.ProposalId);
        Assert.IsTrue(promoted.Applied);
        Assert.AreEqual(acceptedPreview.OperationDigest, promoted.Result!.ChangeSetDigest);

        foreach (var record in fixture.LoadRecords())
        {
            await service.CreateRecordAsync(new NendoCreateRecordRequest(
                fixture.Entity.EntityId,
                record.RecordId,
                record.ToValues(),
                Context($"create-{record.RecordId}")));
        }

        await service.SetFieldAsync(new NendoSetFieldRequest(
            fixture.Entity.EntityId,
            "decision-001",
            "field.decision.owner",
            1,
            "Thomas Klok Rohde",
            Context("edit-owner")));
        await service.ExecuteCommandAsync(new NendoExecuteCommandRequest(
            fixture.Command.NodeId,
            "decision-001",
            2,
            Context("accept-decision")));

        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetFieldAsync(new NendoSetFieldRequest(
                fixture.Entity.EntityId,
                "decision-001",
                "field.decision.context",
                1,
                "Stale overwrite",
                Context("stale-edit"))));
        Assert.AreEqual("record-version-conflict", stale.Code);

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid);
        Assert.IsNotEmpty(compiled.Applications);
        Assert.AreEqual("Decision", compiled.App().Entity.DisplayName);
        // The board's columns are the group field's options, in stored order.
        CollectionAssert.AreEqual(
            new[] { "Proposed", "Accepted", "Superseded" },
            compiled.App().Entity.Fields
                .Single(field => field.SemanticId == "field.decision.state").Options.ToArray());
        // The timeline is the S3 proof on this application: a root of the newest
        // kind compiled through the same generic path, its span's end date carried.
        var timeline = compiled.Root("timelineSurface");
        Assert.AreEqual("field.decision.decidedDate", timeline.Properties["dateFieldId"].GetString());
        Assert.AreEqual("field.decision.reviewDate", timeline.Properties["endDateFieldId"].GetString());
        Assert.AreEqual("field.decision.state", timeline.Properties["accentFieldId"].GetString());
        // The gallery is the S2 proof on this application: cards over the list's window,
        // titled and toned through the same generic path.
        var gallery = compiled.Root("gallerySurface");
        Assert.AreEqual("field.decision.title", gallery.Properties["titleFieldId"].GetString());
        Assert.AreEqual("field.decision.state", gallery.Properties["accentFieldId"].GetString());
        Assert.HasCount(2, compiled.App().Records);
        var accepted = compiled.App().Records.Single(record => record.SemanticId == "decision-001");
        Assert.AreEqual(3L, accepted.Version);
        Assert.AreEqual("Accepted", accepted.Values["field.decision.state"].GetString());
        Assert.AreEqual("Thomas Klok Rohde", accepted.Values["field.decision.owner"].GetString());
        var unrelated = compiled.App().Records.Single(record => record.SemanticId == "decision-002");
        Assert.AreEqual(1L, unrelated.Version);
        Assert.AreEqual("Proposed", unrelated.Values["field.decision.state"].GetString());
        var digest = compiled.App().Digest;
        Assert.IsTrue((await service.GetHistoryAsync()).Any(revision =>
            revision.Description == "Accept decision"));

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var reopened = await workspace.OpenAsync("decision-reopen");
        var reopenedService = new NendoApplicationService(reopened);
        var reopenedCompilation = await reopenedService.CompileSemanticUiAsync();
        Assert.IsTrue(reopenedCompilation.IsValid);
        Assert.AreEqual(digest, reopenedCompilation.App().Digest);
        Assert.AreEqual("Accepted", reopenedCompilation.App().Records
            .Single(record => record.SemanticId == "decision-001")
            .Values["field.decision.state"].GetString());
        await ExportRuntimeEvidenceIfRequestedAsync(reopened);
    }

    [TestMethod]
    public async Task GenericServicesRejectUnknownSemanticTargetsWithoutMutation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposalId = ProposalId();
        var preview = await service.PrepareProposalAsync(new NendoProposalRequest(
            proposalId,
            "Create Decision Log",
            "test",
            fixture.DefinitionChangeSet(proposalId)));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var before = await service.GetSnapshotAsync();

        var missingEntity = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.CreateRecordAsync(new NendoCreateRecordRequest(
                "entity.unknown",
                "record-1",
                new Dictionary<string, object?>(),
                Context("unknown-entity"))));
        Assert.AreEqual("entity-not-found", missingEntity.Code);
        var missingField = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetFieldAsync(new NendoSetFieldRequest(
                fixture.Entity.EntityId,
                "record-1",
                "field.decision.unknown",
                1,
                "value",
                Context("unknown-field"))));
        Assert.AreEqual("field-not-found", missingField.Code);
        var missingCommand = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.ExecuteCommandAsync(new NendoExecuteCommandRequest(
                "command.decision.unknown",
                "record-1",
                1,
                Context("unknown-command"))));
        Assert.AreEqual("command-unavailable", missingCommand.Code);

        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, after.Manifest.ChangeSequence);
        Assert.IsEmpty(after.Records);
    }

    [TestMethod]
    public async Task DecisionProposalFailureLeavesActiveStateUnchanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposalId = ProposalId();
        var preview = await service.PrepareProposalAsync(new NendoProposalRequest(
            proposalId,
            "Create Decision Log",
            "test",
            fixture.DefinitionChangeSet(proposalId)));
        var before = await service.GetSnapshotAsync();
        coordinator.BeforeProposalCommit = () => throw new InvalidOperationException("injected");

        var outcome = await service.PromoteProposalAsync(preview.ProposalId);

        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Failed, outcome.State);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, after.Manifest.ChangeSequence);
        Assert.IsEmpty(after.Entities);
        Assert.IsEmpty(after.UiNodes);
    }

    private static NendoRequestContext Context(string key) =>
        new("test.p2.5", key, "test");

    private static string ProposalId() => $"proposal-{Guid.NewGuid():N}";

    private static async Task ExportRuntimeEvidenceIfRequestedAsync(NendoWriteCoordinator coordinator)
    {
        var requestedPath = Environment.GetEnvironmentVariable("NENDO_P25_RUNTIME_EXPORT");
        if (string.IsNullOrWhiteSpace(requestedPath))
        {
            return;
        }
        var destinationPath = Path.GetFullPath(requestedPath);
        if (File.Exists(destinationPath))
        {
            throw new IOException($"Runtime evidence destination already exists: {destinationPath}");
        }
        await coordinator.BackupToAsync(destinationPath);
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
