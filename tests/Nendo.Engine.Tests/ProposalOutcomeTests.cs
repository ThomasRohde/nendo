using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ProposalOutcomeTests
{
    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task RepeatedPromotionResolvesCommittedReceiptAfterLaterEditAndReopen(bool reopen)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposal = await PrepareAsync(service, fixture);
        var original = await service.PromoteProposalAsync(proposal.ProposalId);
        var record = fixture.LoadRecords().First();
        await service.CreateRecordAsync(new(fixture.Entity.EntityId, record.RecordId, record.ToValues(),
            new("outcome-test", "later-create", "test")));
        if (reopen)
        {
            await coordinator.DisposeAsync();
            workspace.Forget(coordinator);
            coordinator = await workspace.OpenAsync();
            service = new(coordinator);
        }
        var before = await service.GetSnapshotAsync();
        var history = JsonSerializer.Serialize(await service.GetHistoryAsync());

        var repeated = await service.PromoteProposalAsync(proposal.ProposalId);

        Assert.IsTrue(repeated.Applied);
        Assert.AreEqual(NendoProposalState.Active, repeated.State);
        AssertReceipt(original.Result!, repeated.Result!);
        Assert.AreEqual(before.Manifest, (await service.GetSnapshotAsync()).Manifest);
        Assert.AreEqual(history, JsonSerializer.Serialize(await service.GetHistoryAsync()));
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
    }

    [TestMethod]
    [DataRow("metadata")]
    [DataRow("deletion")]
    public async Task CommittedProposalReturnsReceiptWhenWorkspaceCleanupFails(string failure)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposal = await PrepareAsync(service, fixture);
        var directory = Path.Combine(coordinator.ProposalRoot, proposal.ProposalId);
        FileStream? blocker = null;
        coordinator.BeforeProposalCommit = () => blocker = new FileStream(
            Path.Combine(directory, failure == "metadata" ? "proposal.json" : "operations.json"),
            FileMode.Open, FileAccess.Read, failure == "metadata" ? FileShare.Read : FileShare.ReadWrite);
        NendoPromotionOutcome committed;
        try
        {
            committed = await service.PromoteProposalAsync(proposal.ProposalId);
            Assert.IsTrue(committed.Applied);
            Assert.AreEqual(NendoProposalState.Active, committed.State);
            Assert.IsNotNull(committed.Result);
            Assert.IsTrue(committed.CleanupPending);
            Assert.IsTrue(service.ProposalCleanupPending);
            Assert.IsTrue(Directory.Exists(directory));
            Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
        }
        finally
        {
            blocker?.Dispose();
            coordinator.BeforeProposalCommit = null;
        }

        var before = await service.GetSnapshotAsync();
        var retried = await service.PromoteProposalAsync(proposal.ProposalId);
        AssertReceipt(committed.Result!, retried.Result!);
        Assert.AreEqual(before.Manifest, (await service.GetSnapshotAsync()).Manifest);
        Assert.IsFalse(Directory.Exists(directory));
        Assert.IsFalse(retried.CleanupPending);
        Assert.IsFalse(service.ProposalCleanupPending);
    }

    [TestMethod]
    public async Task ReopenWithLockedDerivativeStillResolvesReceiptAndPreservesNewUnacceptedWork()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposal = await PrepareAsync(service, fixture);
        FileStream? blocker = null;
        var directory = Path.Combine(coordinator.ProposalRoot, proposal.ProposalId);
        coordinator.BeforeProposalCommit = () => blocker = new FileStream(Path.Combine(directory, "proposal.json"),
            FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            var committed = await service.PromoteProposalAsync(proposal.ProposalId);
            await coordinator.DisposeAsync();
            workspace.Forget(coordinator);
            coordinator = await workspace.OpenAsync();
            service = new(coordinator);
            Assert.IsTrue(service.ProposalCleanupPending);
            AssertReceipt(committed.Result!, (await service.GetProposalReceiptAsync(proposal.ProposalId))!);
            var pendingId = $"proposal-{Guid.NewGuid():N}";
            var pending = await service.PrepareProposalAsync(new NendoProposalRequest(pendingId, "Inspect a draft", "test",
                new NendoChangeSet([new NendoMutation("outcome-test", "pending", "test", "Change board title",
                    [new SetUiPropertyOperation("pending-op", fixture.Board.SurfaceId, fixture.Board.RootNodeId, "title", "Draft title")])])));
            Assert.IsFalse(await service.RetryProposalCleanupAsync());
            Assert.IsTrue(Directory.Exists(Path.Combine(coordinator.ProposalRoot, pendingId)));
            Assert.IsNotNull(blocker);
            blocker.Dispose();
            blocker = null;
            Assert.IsTrue(await service.RetryProposalCleanupAsync());
            Assert.IsFalse(service.ProposalCleanupPending);
            Assert.IsFalse(Directory.Exists(directory));
            Assert.AreEqual(pending.State, (await service.GetProposalAsync(pendingId)).State);
            AssertReceipt(committed.Result!, (await service.GetProposalReceiptAsync(proposal.ProposalId))!);
        }
        finally { blocker?.Dispose(); }
    }

    [TestMethod]
    [DataRow("data", "before-authority-failure", false)]
    [DataRow("proposal", "before-authority-failure", false)]
    [DataRow("data", "before-authority-cancel", false)]
    [DataRow("proposal", "before-authority-cancel", false)]
    [DataRow("data", "after-commit-failure", false)]
    [DataRow("proposal", "after-commit-failure", false)]
    [DataRow("data", "after-commit-failure", true)]
    [DataRow("proposal", "after-commit-failure", true)]
    [DataRow("data", "after-commit-cancel", false)]
    [DataRow("proposal", "after-commit-cancel", false)]
    public async Task FaultsAndCancellationResolveToOneDurableEffect(string lane, string fault, bool reopen)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposal = await PrepareAsync(service, fixture);
        if (lane == "data") await service.PromoteProposalAsync(proposal.ProposalId);
        var record = fixture.LoadRecords().First();
        var request = new NendoCreateRecordRequest(fixture.Entity.EntityId, record.RecordId, record.ToValues(),
            new("outcome-test", "lost-reply", "test"));
        var identity = new NendoOperationIdentity(request.Context.IdempotencyScope, request.Context.IdempotencyKey);
        var before = await service.GetSnapshotAsync();
        using var cancellation = new CancellationTokenSource();
        Action inject = fault.EndsWith("cancel", StringComparison.Ordinal)
            ? cancellation.Cancel : () => throw new IOException("Injected response or authority-read failure");
        var afterCommit = fault.StartsWith("after", StringComparison.Ordinal);
        if (afterCommit) coordinator.AfterCommit = inject;
        else coordinator.BeforeCommitAuthorityRead = inject;
        Task Invoke(CancellationToken token) => lane == "data"
            ? service.CreateRecordAsync(request, token) : service.PromoteProposalAsync(proposal.ProposalId, token);
        if (fault.EndsWith("failure", StringComparison.Ordinal))
            await Assert.ThrowsExactlyAsync<IOException>(() => Invoke(cancellation.Token));
        else if (!afterCommit)
            await Assert.ThrowsAsync<OperationCanceledException>(() => Invoke(cancellation.Token));
        else await Invoke(cancellation.Token);
        coordinator.AfterCommit = null;
        coordinator.BeforeCommitAuthorityRead = null;
        if (reopen)
        {
            await coordinator.DisposeAsync();
            workspace.Forget(coordinator);
            coordinator = await workspace.OpenAsync();
            service = new(coordinator);
        }
        var receipt = lane == "data" ? await service.GetMutationReceiptAsync(identity)
            : (await service.GetProposalReceiptAsync(proposal.ProposalId))?.Revisions.Single();
        Assert.AreEqual(afterCommit, receipt is not null);
        var observed = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence + (afterCommit ? 1 : 0), observed.Manifest.ChangeSequence);
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
        await Invoke(CancellationToken.None);
        var final = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence + 1, final.Manifest.ChangeSequence);
        var recovered = lane == "data" ? await service.GetMutationReceiptAsync(identity)
            : (await service.GetProposalReceiptAsync(proposal.ProposalId))?.Revisions.Single();
        Assert.IsNotNull(recovered);
        if (afterCommit) Assert.AreEqual(receipt, recovered);
    }

    private static Task<NendoProposalPreview> PrepareAsync(NendoApplicationService service, SemanticApplicationFixture fixture)
    {
        var id = $"proposal-{Guid.NewGuid():N}";
        return service.PrepareProposalAsync(new NendoProposalRequest(id, "Create Decision Log", "test", fixture.DefinitionChangeSet(id)));
    }

    [TestMethod]
    public async Task WholeChangeSetRetryChecksOriginalRequestIdentitiesAndReservesCommittedProposalId()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposal = await PrepareAsync(service, fixture);
        var changeSet = fixture.DefinitionChangeSet(proposal.ProposalId);
        var original = await service.PromoteProposalAsync(proposal.ProposalId);
        var replay = await coordinator.ApplyChangeSetAsync(changeSet, proposal.ProposalId);
        AssertReceipt(original.Result!, replay);
        var differentKeys = new NendoChangeSet(changeSet.Mutations.Select(mutation => new NendoMutation(
            mutation.IdempotencyScope, mutation.IdempotencyKey + "-changed", mutation.Origin,
            mutation.Description, mutation.Operations)).ToArray());
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() =>
            coordinator.ApplyChangeSetAsync(differentKeys, proposal.ProposalId));
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => service.PrepareProposalAsync(
            new NendoProposalRequest(proposal.ProposalId, "Reused ID", "test", changeSet)));
        Assert.HasCount(original.Result!.Revisions.Count + 1, await service.GetHistoryAsync());
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ReceiptLookupRefusesOutsideAuditChanges(bool proposalLookup)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var proposal = await PrepareAsync(service, fixture);
        var committed = await service.PromoteProposalAsync(proposal.ProposalId);
        await using (var outside = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString()))
        {
            await outside.OpenAsync();
            await using var command = outside.CreateCommand();
            command.CommandText = "UPDATE __nendo_revision SET description = 'outside' WHERE revision_id = @revision;";
            command.Parameters.AddWithValue("@revision", committed.Result!.Revisions[0].RevisionId);
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => proposalLookup
            ? (Task)service.GetProposalReceiptAsync(proposal.ProposalId)
            : service.GetMutationReceiptAsync(new("unknown", "unknown")));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, coordinator.Health);
    }

    [TestMethod]
    public async Task DelayedAcceptanceCannotApplyDifferentContentReusingAnUncommittedProposalId()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var fixture = SemanticApplicationFixture.Load("decision-log");
        var first = await PrepareAsync(service, fixture);
        await service.RejectProposalAsync(first.ProposalId);
        var replacement = await service.PrepareProposalAsync(new NendoProposalRequest(first.ProposalId,
            "Replacement review", "test", fixture.DefinitionChangeSet(first.ProposalId + "-new")));
        Assert.AreNotEqual(first.OperationDigest, replacement.OperationDigest);
        var before = await service.GetSnapshotAsync();
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() =>
            service.PromoteProposalAsync(first.ProposalId, expectedOperationDigest: first.OperationDigest));
        Assert.AreEqual(before.Manifest, (await service.GetSnapshotAsync()).Manifest);
        var committed = await service.PromoteProposalAsync(replacement.ProposalId,
            expectedOperationDigest: replacement.OperationDigest);
        Assert.IsTrue(committed.Applied);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        coordinator = await workspace.OpenAsync();
        service = new NendoApplicationService(coordinator);
        var repeated = await service.PromoteProposalAsync(replacement.ProposalId,
            expectedOperationDigest: replacement.OperationDigest);
        AssertReceipt(committed.Result!, repeated.Result!);
    }

    private static void AssertReceipt(NendoChangeSetApplyResult original, NendoChangeSetApplyResult repeated)
    {
        Assert.AreEqual(original.ChangeSetDigest, repeated.ChangeSetDigest);
        Assert.AreEqual(original.DefinitionRevision, repeated.DefinitionRevision);
        Assert.AreEqual(original.DataRevision, repeated.DataRevision);
        Assert.AreEqual(original.ChangeSequence, repeated.ChangeSequence);
        Assert.HasCount(original.Revisions.Count, repeated.Revisions);
        for (var index = 0; index < original.Revisions.Count; index++)
            Assert.AreEqual(original.Revisions[index] with { IsIdempotentReplay = true }, repeated.Revisions[index]);
    }
}
