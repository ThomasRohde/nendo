using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class RestoreTests
{
    [TestMethod]
    [DataRow("empty")]
    [DataRow("idea-garden")]
    [DataRow("decision-log")]
    public async Task RestoreRetainsExactCurrentFileAndRestoresCompleteHistoryWithoutAFabricatedRevision(string application)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await PopulateAsync(service, application);
        var oldState = await StateAsync(source);
        var backup = await BackupAsync(source, workspace);
        var backupBytes = await ReadBytesAsync(backup);
        await ChangeAsync(service, application);
        var currentState = await StateAsync(source);
        var currentBytes = await ReadBytesAsync(workspace.FilePath);
        var plan = await service.PrepareRestoreAsync(backup, "restore");
        Assert.AreEqual(plan, await service.PrepareRestoreAsync(backup, "restore"));
        Assert.IsTrue(plan.RetentionPolicy.Contains("does not expire", StringComparison.Ordinal));
        var result = await service.RestoreAsync(plan.PlanId, confirmDiscardProposals: false);
        Assert.AreEqual(plan.Restored, result.Manifest);
        Assert.AreEqual(NendoSessionHealth.Closed, source.Health);
        Assert.IsFalse(service.Capabilities.Mutate);
        await Assert.ThrowsExactlyAsync<ObjectDisposedException>(() => service.GetSnapshotAsync());
        await Assert.ThrowsExactlyAsync<ObjectDisposedException>(() => ChangeAsync(service, application));
        await source.DisposeAsync();
        await using (var restored = await NendoWriteCoordinator.OpenAsync(workspace.FilePath, "restored"))
            Assert.AreEqual(oldState, await StateAsync(restored));
        var retained = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, result.RetainedFileName);
        CollectionAssert.AreEqual(currentBytes, await ReadBytesAsync(retained));
        await using (var before = await NendoWriteCoordinator.OpenReadOnlyAsync(retained))
            Assert.AreEqual(currentState, await StateAsync(before));
        CollectionAssert.AreEqual(backupBytes, await ReadBytesAsync(backup));
        Assert.IsTrue(File.Exists(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, result.ReceiptFileName)));
        Assert.IsFalse((await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).HasPendingReplacement);
        Assert.HasCount(0, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*.nendo"));
        var json = JsonSerializer.Serialize(plan);
        Assert.IsFalse(json.Contains(JsonEncodedText.Encode(Path.GetDirectoryName(workspace.FilePath)!).ToString(), StringComparison.Ordinal));
    }

    [TestMethod]
    [DataRow("wrong-identity")]
    [DataRow("corrupt")]
    [DataRow("current-file")]
    public async Task InvalidBackupCannotChangeTheCurrentApplication(string failure)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var destination = BackupPath(workspace);
        if (failure == "wrong-identity")
        {
            await using var other = await NendoWriteCoordinator.CreateAsync(destination, "other");
        }
        else if (failure == "corrupt") await File.WriteAllTextAsync(destination, "not a Nendo file");
        else destination = workspace.FilePath;
        var before = await ReadBytesAsync(workspace.FilePath);
        await Assert.ThrowsAsync<NendoException>(() => source.PrepareRestoreAsync(destination, "invalid"));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        Assert.HasCount(0, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, "*.receipt.json"));
    }

    [TestMethod]
    public async Task ReadOnlyBackupIsAValidRestoreSource()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        File.SetAttributes(backup, FileAttributes.ReadOnly);
        try
        {
            var plan = await source.PrepareRestoreAsync(backup, "restore");
            await source.RestoreAsync(plan.PlanId, false);
            Assert.AreEqual(NendoSessionHealth.Closed, source.Health);
        }
        finally { File.SetAttributes(backup, FileAttributes.Normal); }
    }

    [TestMethod]
    public async Task StaleCurrentStateAndChangedBackupOrRequestRequireNewConfirmation()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => source.PrepareRestoreAsync(workspace.FilePath, "restore"));
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("later");
        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual("restore-current-changed", stale.Code);
        var fresh = await source.PrepareRestoreAsync(backup, "fresh");
        File.Move(backup, backup + ".retained");
        File.Copy(backup + ".retained", backup);
        var changed = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.RestoreAsync(fresh.PlanId, false));
        Assert.AreEqual("restore-backup-changed", changed.Code);
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
    }

    [TestMethod]
    public async Task ProposalDiscardIsExplicitAndTheReviewedProposalSetCannotChangeSilently()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        var backup = await BackupAsync(source, workspace);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        Assert.AreEqual(1, plan.PendingProposalCount);
        var denied = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual("restore-proposals-pending", denied.Code);
        Assert.AreEqual(proposal.ProposalId, (await source.GetProposalAsync(proposal.ProposalId)).ProposalId);
        await service.RejectProposalAsync(proposal.ProposalId);
        var changed = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.RestoreAsync(plan.PlanId, true));
        Assert.AreEqual("restore-proposals-changed", changed.Code);
        var pending = await service.PrepareIdeaGardenProposalAsync();
        var reviewed = await source.PrepareRestoreAsync(backup, "reviewed");
        await source.RestoreAsync(reviewed.PlanId, true);
        Assert.IsFalse(Directory.Exists(Path.Combine(source.ProposalRoot, pending.ProposalId)));
        await Assert.ThrowsExactlyAsync<ObjectDisposedException>(() => source.PromoteProposalAsync(pending.ProposalId));
    }

    [TestMethod]
    [DataRow("current-backup-verified")]
    [DataRow("restore-stage-verified")]
    [DataRow("recovery-record-durable")]
    public async Task CancellationBeforeRetirementPreservesTheOriginalAndCleansOnlyOwnedStages(string checkpoint)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var before = await ReadBytesAsync(workspace.FilePath);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        using var cancellation = new CancellationTokenSource();
        source.RestoreCheckpoint = value => { if (value == checkpoint) cancellation.Cancel(); };
        await Assert.ThrowsExactlyAsync<OperationCanceledException>(() => source.RestoreAsync(plan.PlanId, false, cancellation.Token));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        Assert.IsFalse(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
        Assert.HasCount(0, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*.nendo"));
    }

    [TestMethod]
    public async Task NativeCapacityFailureAndInvalidStageLeaveTheOriginalAuthoritative()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var before = await ReadBytesAsync(workspace.FilePath);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        source.RestoreMaximumPageCountForTest = 1;
        var capacity = await Assert.ThrowsExactlyAsync<SqliteException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual(13, capacity.SqliteErrorCode);
        source.RestoreMaximumPageCountForTest = null;
        source.BeforeRestoreValidation = stage =>
        {
            using var connection = new SqliteConnection($"Data Source={stage};Pooling=False");
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = "PRAGMA user_version = 999;";
            command.ExecuteNonQuery();
        };
        var invalid = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual("restore-stage-invalid", invalid.Code);
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        Assert.HasCount(0, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*.nendo"));
    }

    [TestMethod]
    [DataRow("before-retention", "verifiedOriginal", "missing", "verifiedReplacement")]
    [DataRow("original-retained", "missing", "verifiedOriginal", "verifiedReplacement")]
    [DataRow("replacement-activated", "verifiedReplacement", "verifiedOriginal", "missing")]
    public async Task InterruptedReplacementLeavesAnExplicitVerifiedRecoveryObservation(
        string checkpoint, string activeState, string retainedState, string stagedState)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("later");
        var before = await ReadBytesAsync(workspace.FilePath);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        source.RestoreCheckpoint = value => { if (value == checkpoint) throw new IOException("injected interruption"); };
        var failure = await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual(plan.RetainedFileName, failure.RetainedFileName);
        Assert.AreEqual(NendoSessionHealth.Closed, source.Health);
        await source.DisposeAsync();
        var recovery = await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath);
        Assert.IsTrue(recovery.HasPendingReplacement);
        Assert.AreEqual(plan.PlanId, recovery.OperationId);
        Assert.AreEqual(activeState, recovery.Active!.State);
        Assert.AreEqual(retainedState, recovery.Retained!.State);
        Assert.AreEqual(stagedState, recovery.Staged!.State);
        var original = checkpoint == "before-retention" ? workspace.FilePath :
            Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, plan.RetainedFileName);
        CollectionAssert.AreEqual(before, await ReadBytesAsync(original));
        if (File.Exists(workspace.FilePath))
        {
            var inspected = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
            Assert.IsFalse(inspected.CanAcquireWriteAuthority);
            Assert.IsTrue(inspected.Findings.Any(finding => finding.Code == "replacement-pending"));
            await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
        }
    }

    [TestMethod]
    public async Task RacingReplacementAndDestinationAreNeverOverwritten()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        source.RestoreCheckpoint = checkpoint =>
        {
            if (checkpoint == "original-retained") File.WriteAllText(workspace.FilePath, "unexpected racing target");
        };
        await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual("unexpected racing target", await File.ReadAllTextAsync(workspace.FilePath));
        await source.DisposeAsync();
        var recovery = await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath);
        Assert.AreEqual("verifiedOriginal", recovery.Retained!.State);
        Assert.AreEqual("verifiedReplacement", recovery.Staged!.State);
    }

    [TestMethod]
    public async Task CancellationAfterRetirementFinishesAndReportsTheCommittedResult()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        using var cancellation = new CancellationTokenSource();
        source.RestoreCheckpoint = value => { if (value == "original-retained") cancellation.Cancel(); };
        var result = await source.RestoreAsync(plan.PlanId, false, cancellation.Token);
        Assert.AreEqual(plan.Restored, result.Manifest);
        Assert.IsFalse(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)));
    }

    private static string BackupPath(EngineTestWorkspace workspace) =>
        Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "backup.nendo");

    [TestMethod]
    public async Task ReadOnlyRestoreAcquiresExclusiveOwnershipAndRetiresItsFrozenSnapshot()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        await using var readOnly = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var plan = await readOnly.PrepareRestoreAsync(backup, "restore");
        var denied = await Assert.ThrowsExactlyAsync<NendoWriteOwnershipException>(() => readOnly.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual("instance-in-use", denied.Code);
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        await source.DisposeAsync();
        await readOnly.RestoreAsync(plan.PlanId, false);
        Assert.AreEqual(NendoSessionHealth.Closed, readOnly.Health);
        await Assert.ThrowsExactlyAsync<ObjectDisposedException>(() => readOnly.GetSnapshotAsync());
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task TargetChangesDuringPinHandoffDoNotMoveOrOverwriteTheUnexpectedFile(bool replaceIdentity)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        byte[]? racingBytes = null;
        source.RestoreCheckpoint = value =>
        {
            if (value != "before-retention") return;
            if (replaceIdentity)
            {
                File.Move(workspace.FilePath, workspace.FilePath + ".externally-moved");
                File.Copy(workspace.FilePath + ".externally-moved", workspace.FilePath);
            }
            else File.WriteAllText(workspace.FilePath, "outside modification");
            racingBytes = File.ReadAllBytes(workspace.FilePath);
        };
        var failure = await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.IsInstanceOfType<NendoPreconditionException>(failure.Cause);
        CollectionAssert.AreEqual(racingBytes!, await ReadBytesAsync(workspace.FilePath));
        Assert.IsFalse(File.Exists(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, plan.RetainedFileName)));
        await source.DisposeAsync();
        var recovery = await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath);
        Assert.IsTrue(recovery.HasPendingReplacement);
        Assert.AreEqual("verifiedOriginal", recovery.PreChangeBackup!.State);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ExistingRetentionNameIsPreservedBeforeOrAfterStaging(bool raceAfterStaging)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var before = await ReadBytesAsync(workspace.FilePath);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        var retained = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, plan.RetainedFileName);
        if (raceAfterStaging)
        {
            source.RestoreCheckpoint = value => { if (value == "before-retention") File.WriteAllText(retained, "unrelated"); };
            await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => source.RestoreAsync(plan.PlanId, false));
        }
        else
        {
            await File.WriteAllTextAsync(retained, "unrelated");
            await Assert.ThrowsExactlyAsync<IOException>(() => source.RestoreAsync(plan.PlanId, false));
        }
        Assert.AreEqual("unrelated", await File.ReadAllTextAsync(retained));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task ReplacedRecoveryMarkerIsNeverDeletedAndUnrecognisedReceiptsDoNotAuthorizeRecovery()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace);
        var plan = await source.PrepareRestoreAsync(backup, "restore");
        var marker = FileReplacementReceipt.PendingPath(workspace.FilePath);
        source.RestoreCheckpoint = value =>
        {
            if (value != "replacement-verified") return;
            File.Move(marker, marker + ".preserved");
            File.WriteAllText(marker, "{\"Version\":1,\"TargetFileName\":\"../../unrelated.nendo\"}");
        };
        await Assert.ThrowsExactlyAsync<NendoReplacementInterruptedException>(() => source.RestoreAsync(plan.PlanId, false));
        Assert.IsTrue(File.Exists(marker));
        await source.DisposeAsync();
        var recovery = await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath);
        Assert.IsTrue(recovery.HasPendingReplacement);
        Assert.IsNull(recovery.OperationId);
        Assert.IsNull(recovery.Active);
        Assert.IsTrue(File.Exists(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, plan.RetainedFileName)));
    }

    private static async Task<byte[]> ReadBytesAsync(string path)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var bytes = new MemoryStream();
        await stream.CopyToAsync(bytes);
        return bytes.ToArray();
    }

    private static async Task<string> BackupAsync(NendoWriteCoordinator source, EngineTestWorkspace workspace)
    {
        var destination = BackupPath(workspace);
        var plan = await source.PrepareBackupAsync(destination, "backup");
        await source.CreateBackupAsync(plan.PlanId);
        return destination;
    }

    private static async Task<string> StateAsync(NendoWriteCoordinator coordinator)
    {
        var snapshot = await coordinator.GetSnapshotAsync();
        return JsonSerializer.Serialize(new { snapshot.Manifest, snapshot.Entities, snapshot.Records, snapshot.UiNodes, History = await coordinator.GetHistoryAsync() });
    }

    private static async Task PopulateAsync(NendoApplicationService service, string application)
    {
        if (application == "empty") return;
        if (application == "idea-garden")
        {
            var idea = await service.PrepareIdeaGardenProposalAsync();
            Assert.IsTrue((await service.PromoteProposalAsync(idea.ProposalId)).Applied);
            await service.CreateIdeaRecordAsync("idea-1", "Before backup", "create");
            return;
        }
        var fixture = SemanticApplicationFixture.Load(application);
        var id = $"proposal-{Guid.NewGuid():N}";
        var proposal = await service.PrepareProposalAsync(new NendoProposalRequest(id, "Decision Log", "test", fixture.DefinitionChangeSet(id)));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        foreach (var record in fixture.LoadRecords())
            await service.CreateRecordAsync(new(fixture.Entity.EntityId, record.RecordId, record.ToValues(), new("restore-tests", record.RecordId, "test")));
    }

    private static async Task ChangeAsync(NendoApplicationService service, string application)
    {
        if (application == "empty") { await service.CreateIdeaSchemaAsync("change"); return; }
        if (application == "idea-garden") { await service.SetIdeaTitleAsync("idea-1", 1, "After backup", "change"); return; }
        var fixture = SemanticApplicationFixture.Load(application);
        await service.ExecuteCommandAsync(new(fixture.Command.NodeId, fixture.LoadRecords()[0].RecordId, 1, new("restore-tests", "command", "test")));
    }
}
