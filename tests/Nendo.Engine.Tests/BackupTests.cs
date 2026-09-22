using System.Text.Json;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class BackupTests
{
    [TestMethod]
    [DataRow("backup")]
    [DataRow("duplicate")]
    [DataRow("fork")]
    public async Task ActualDestinationCreateDenialPreservesSourceAndUnrelatedFilesAndAllowsExactRetry(string kind)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("This qualification requires Windows ACLs.");
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await ReadBytesAsync(workspace.FilePath);
        // ACL changes are restricted to this newly created disposable directory.
        var folder = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "denied-destination"));
        var destination = Path.Combine(folder.FullName, "result.nendo");
        var unrelated = Path.Combine(folder.FullName, "keep.txt");
        await File.WriteAllTextAsync(unrelated, "Unrelated destination content");
        var planId = kind == "backup"
            ? (await source.PrepareBackupAsync(destination, "denied-copy")).PlanId
            : (await source.PrepareIdentityCopyAsync(kind == "duplicate" ? NendoIdentityCopyKind.Duplicate : NendoIdentityCopyKind.Fork,
                destination, "denied-copy")).PlanId;
        async Task ExecuteAsync()
        {
            if (kind == "backup") await source.CreateBackupAsync(planId);
            else await source.CreateIdentityCopyAsync(planId);
        }
        var original = folder.GetAccessControl(AccessControlSections.Access);
        var denied = folder.GetAccessControl(AccessControlSections.Access);
        using var identity = WindowsIdentity.GetCurrent();
        denied.AddAccessRule(new FileSystemAccessRule(identity.User!, FileSystemRights.CreateFiles,
            InheritanceFlags.None, PropagationFlags.None, AccessControlType.Deny));
        try
        {
            folder.SetAccessControl(denied);
            await Assert.ThrowsExactlyAsync<UnauthorizedAccessException>(ExecuteAsync);
            Assert.IsFalse(File.Exists(destination));
            CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
            Assert.AreEqual("Unrelated destination content", await File.ReadAllTextAsync(unrelated));
            Assert.HasCount(1, Directory.GetFileSystemEntries(folder.FullName));
            Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        }
        finally
        {
            // An unmodified DirectorySecurity snapshot is not persisted by
            // SetAccessControl; mark the saved DACL explicitly for restoration.
            var restored = new DirectorySecurity();
            restored.SetSecurityDescriptorSddlForm(original.GetSecurityDescriptorSddlForm(AccessControlSections.Access),
                AccessControlSections.Access);
            folder.SetAccessControl(restored);
        }
        await ExecuteAsync();
        Assert.IsTrue(File.Exists(destination));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        Assert.AreEqual("Unrelated destination content", await File.ReadAllTextAsync(unrelated));
        Assert.HasCount(2, Directory.GetFileSystemEntries(folder.FullName));
        Assert.IsTrue(kind == "backup"
            ? (await source.CreateBackupAsync(planId)).IsIdempotentReplay
            : (await source.CreateIdentityCopyAsync(planId)).IsIdempotentReplay);
    }

    [TestMethod]
    [DataRow("empty")]
    [DataRow("idea-garden")]
    [DataRow("decision-log")]
    public async Task CurrentBackupPreservesExactApplicationAndHistoryWithoutChangingSource(string application)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        if (application == "idea-garden")
        {
            var proposal = await service.PrepareIdeaGardenProposalAsync();
            Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
            await service.CreateIdeaRecordAsync("idea-1", "Original", "create");
            await service.SetIdeaTitleAsync("idea-1", 1, "Edited", "edit");
        }
        else if (application != "empty")
        {
            var fixture = SemanticApplicationFixture.Load(application);
            var proposalId = $"proposal-{Guid.NewGuid():N}";
            var proposal = await service.PrepareProposalAsync(new NendoProposalRequest(
                proposalId, "Create application", "test", fixture.DefinitionChangeSet(proposalId)));
            Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
            foreach (var record in fixture.LoadRecords())
            {
                await service.CreateRecordAsync(new(fixture.Entity.EntityId, record.RecordId, record.ToValues(),
                    new("backup-tests", $"record-{record.RecordId}", "test")));
            }
            var first = fixture.LoadRecords()[0];
            await service.ExecuteCommandAsync(new(fixture.Command.NodeId, first.RecordId, 1,
                new("backup-tests", "command", "test")));
        }
        var beforeBytes = await ReadBytesAsync(workspace.FilePath);
        var before = await source.GetSnapshotAsync();
        var history = JsonSerializer.Serialize(await source.GetHistoryAsync());
        var destination = Destination(workspace);
        var plan = await service.PrepareBackupAsync(destination, "copy");
        Assert.AreEqual(before.Manifest, plan.Source);
        Assert.IsFalse(JsonSerializer.Serialize(plan).Contains(JsonEncodedText.Encode(Path.GetDirectoryName(destination)!).ToString(), StringComparison.Ordinal));
        var result = await service.CreateBackupAsync(plan.PlanId);
        Assert.IsFalse(result.IsIdempotentReplay);
        Assert.AreEqual(before.Manifest, result.Manifest);
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        CollectionAssert.AreEqual(beforeBytes, await ReadBytesAsync(workspace.FilePath));
        await using (var copy = await NendoWriteCoordinator.OpenReadOnlyAsync(destination))
        {
            Assert.AreEqual(SemanticState(before), SemanticState(await copy.GetSnapshotAsync()));
            Assert.AreEqual(history, JsonSerializer.Serialize(await copy.GetHistoryAsync()));
            Assert.AreEqual("ok", (await copy.GetSnapshotAsync()).Storage.IntegrityResult);
            if (application != "empty")
            {
                Assert.AreEqual((await service.CompileSemanticUiAsync()).App().Digest,
                    (await new NendoApplicationService(copy).CompileSemanticUiAsync()).App().Digest);
            }
        }
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task PreExistingAndRacingDestinationsIncludingEmptyFilesAreNeverConsumed(bool occupiedBeforePreparation)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var destination = Destination(workspace);
        var before = await ReadBytesAsync(workspace.FilePath);
        if (occupiedBeforePreparation)
        {
            await File.WriteAllBytesAsync(destination, []);
            await Assert.ThrowsExactlyAsync<IOException>(() => source.PrepareBackupAsync(destination, "copy"));
            Assert.AreEqual(0L, new FileInfo(destination).Length);
        }
        else
        {
            var plan = await source.PrepareBackupAsync(destination, "copy");
            source.BeforeBackupActivation = () => File.WriteAllText(destination, "unrelated racing file");
            await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateBackupAsync(plan.PlanId));
            Assert.AreEqual("unrelated racing file", await File.ReadAllTextAsync(destination));
        }
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task RacingOperationalSidecarPreventsActivationWithoutRemovingIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var destination = Destination(workspace);
        var plan = await source.PrepareBackupAsync(destination, "copy");
        source.BeforeBackupActivation = () => File.WriteAllText(destination + "-journal", "unrelated journal");
        await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateBackupAsync(plan.PlanId));
        Assert.IsFalse(File.Exists(destination));
        Assert.AreEqual("unrelated journal", await File.ReadAllTextAsync(destination + "-journal"));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task SourceDestinationIsRejectedAndChangedRequestConflicts()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var self = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.PrepareBackupAsync(workspace.FilePath, "self"));
        Assert.AreEqual("backup-source-destination", self.Code);
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        Assert.AreEqual(plan, await source.PrepareBackupAsync(Destination(workspace), "copy"));
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => source.PrepareBackupAsync(Destination(workspace, "different.nendo"), "copy"));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ConcurrentExactRetryReturnsOneCommittedBackupAndDoesNotAdvanceSource()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        var results = await Task.WhenAll(source.CreateBackupAsync(plan.PlanId), source.CreateBackupAsync(plan.PlanId));
        Assert.HasCount(1, results.Where(result => result.IsIdempotentReplay));
        Assert.HasCount(1, results.Where(result => !result.IsIdempotentReplay));
        Assert.AreEqual(0L, (await source.GetSnapshotAsync()).Manifest.ChangeSequence);
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("later");
        var replay = await source.CreateBackupAsync(plan.PlanId);
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.AreEqual(0L, replay.Manifest.ChangeSequence);
        Assert.AreEqual(1L, (await source.GetSnapshotAsync()).Manifest.ChangeSequence);
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task LostResponseCanReplayButAnIdenticalReplacementCannot()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var destination = Destination(workspace);
        var plan = await source.PrepareBackupAsync(destination, "copy");
        source.AfterBackupActivation = () => throw new InvalidOperationException("simulated lost result");
        await Assert.ThrowsExactlyAsync<InvalidOperationException>(() => source.CreateBackupAsync(plan.PlanId));
        Assert.IsTrue(File.Exists(destination));
        source.AfterBackupActivation = null;
        Assert.IsTrue((await source.CreateBackupAsync(plan.PlanId)).IsIdempotentReplay);
        File.Move(destination, Destination(workspace, "retained-original.nendo"));
        File.Copy(Destination(workspace, "retained-original.nendo"), destination);
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() => source.CreateBackupAsync(plan.PlanId));
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task CancellationHasAnExplicitActivationBoundary(bool cancelAfterActivation)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await ReadBytesAsync(workspace.FilePath);
        var destination = Destination(workspace);
        var plan = await source.PrepareBackupAsync(destination, "copy");
        using var cancellation = new CancellationTokenSource();
        if (cancelAfterActivation)
        {
            source.AfterBackupActivation = cancellation.Cancel;
            var result = await source.CreateBackupAsync(plan.PlanId, cancellation.Token);
            Assert.IsFalse(result.IsIdempotentReplay);
            Assert.IsTrue(File.Exists(destination));
        }
        else
        {
            source.BeforeBackupActivation = cancellation.Cancel;
            await Assert.ThrowsExactlyAsync<OperationCanceledException>(() => source.CreateBackupAsync(plan.PlanId, cancellation.Token));
            Assert.IsFalse(File.Exists(destination));
            source.BeforeBackupActivation = null;
            Assert.IsFalse((await source.CreateBackupAsync(plan.PlanId)).IsIdempotentReplay);
        }
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task InvalidOrFaultedStageNeverActivatesAndOnlyOwnedStageIsCleaned(bool injectIoFailure)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await ReadBytesAsync(workspace.FilePath);
        var destination = Destination(workspace);
        var unrelated = Destination(workspace, ".nendo-stage-owned-by-user.nendo");
        await File.WriteAllTextAsync(unrelated, "retain me");
        var plan = await source.PrepareBackupAsync(destination, "copy");
        source.BeforeBackupValidation = stage =>
        {
            if (injectIoFailure) throw new IOException("simulated storage write failure, not a full-volume test");
            ChangeFixture(stage, "UPDATE __nendo_manifest SET modified_at = '2020-01-01T00:00:00.0000000+00:00';");
        };
        if (injectIoFailure)
        {
            await Assert.ThrowsExactlyAsync<IOException>(() => source.CreateBackupAsync(plan.PlanId));
        }
        else
        {
            var failure = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.CreateBackupAsync(plan.PlanId));
            Assert.AreEqual("backup-validation-failed", failure.Code);
        }
        Assert.IsFalse(File.Exists(destination));
        Assert.AreEqual("retain me", await File.ReadAllTextAsync(unrelated));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*"));
    }

    [TestMethod]
    public async Task CoordinatedEditInvalidatesConfirmationWithoutMarkingSessionBroken()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("later");
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.CreateBackupAsync(plan.PlanId));
        Assert.AreEqual("backup-source-changed", error.Code);
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        Assert.IsFalse(File.Exists(Destination(workspace)));
        var fresh = await source.PrepareBackupAsync(Destination(workspace), "fresh");
        Assert.AreEqual(1L, (await source.CreateBackupAsync(fresh.PlanId)).Manifest.ChangeSequence);
    }

    [TestMethod]
    public async Task OutsideEditAfterConfirmationRequiresRecoveryAndDoesNotActivate()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        ChangeFixture(workspace.FilePath, "UPDATE __nendo_manifest SET modified_at = '2020-01-01T00:00:00.0000000+00:00';");
        var changed = await ReadBytesAsync(workspace.FilePath);
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => source.CreateBackupAsync(plan.PlanId));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, source.Health);
        Assert.IsFalse(File.Exists(Destination(workspace)));
        CollectionAssert.AreEqual(changed, await ReadBytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ReadOnlyBackupWillNotAdoptUnreviewedWriterChanges(bool prepareBeforeChange)
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var plan = prepareBeforeChange ? await reader.PrepareBackupAsync(Destination(workspace), "copy") : null;
        await new NendoApplicationService(source).CreateIdeaSchemaAsync("later");
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(async () =>
        {
            if (plan is not null) await reader.CreateBackupAsync(plan.PlanId);
            else await reader.PrepareBackupAsync(Destination(workspace), "copy");
        });
        Assert.AreEqual("backup-source-changed", error.Code);
        Assert.IsFalse(File.Exists(Destination(workspace)));
        Assert.IsFalse(reader.Capabilities.Mutate);
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task RecoveryBackupRetainsMalformedCustomJsonAndReadableRecordsExactly()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        await service.PromoteProposalAsync(proposal.ProposalId);
        await service.CreateIdeaRecordAsync("idea-1", "Retained", "record");
        await source.DisposeAsync();
        workspace.Forget(source);
        ChangeFixture(workspace.FilePath, "UPDATE __nendo_ui_property SET value_json = '{invalid' WHERE property_name = 'entityId';");
        var before = await ReadBytesAsync(workspace.FilePath);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, reader.Health);
        Assert.IsTrue(reader.Capabilities.Backup);
        var plan = await reader.PrepareBackupAsync(Destination(workspace), "copy");
        await reader.CreateBackupAsync(plan.PlanId);
        await using var copied = await NendoWriteCoordinator.OpenReadOnlyAsync(Destination(workspace));
        Assert.AreEqual(SemanticState(await reader.GetSnapshotAsync()), SemanticState(await copied.GetSnapshotAsync()));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, copied.Health);
        Assert.AreEqual("{invalid", ScalarFixture(Destination(workspace), "SELECT value_json FROM __nendo_ui_property WHERE property_name = 'entityId' LIMIT 1;"));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ReadOnlyFileAttributeIsPreservedWhileVerifiedBackupIsUsable()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await source.DisposeAsync();
        workspace.Forget(source);
        File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) | FileAttributes.ReadOnly);
        try
        {
            var before = await ReadBytesAsync(workspace.FilePath);
            await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
            var plan = await reader.PrepareBackupAsync(Destination(workspace), "copy");
            await reader.CreateBackupAsync(plan.PlanId);
            Assert.AreNotEqual((FileAttributes)0, File.GetAttributes(workspace.FilePath) & FileAttributes.ReadOnly);
            Assert.IsTrue((await NendoWriteCoordinator.InspectAsync(Destination(workspace))).CanAcquireWriteAuthority);
            CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
            Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
            AssertNoStages(workspace);
        }
        finally
        {
            File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) & ~FileAttributes.ReadOnly);
        }
    }

    [TestMethod]
    public async Task ChangedJournalProfileIsRefusedBeforeReadOnlySqliteCanCreateDerivatives()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        await source.DisposeAsync();
        workspace.Forget(source);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var plan = await reader.PrepareBackupAsync(Destination(workspace), "copy");
        ChangeFixture(workspace.FilePath, "PRAGMA journal_mode = WAL;");
        var before = await ReadBytesAsync(workspace.FilePath);
        var failure = await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => reader.CreateBackupAsync(plan.PlanId));
        Assert.AreEqual("unsupported-journal", failure.Inspection.Findings.Single().Code);
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task BusySourceDoesNotActivateOrPretendToHaveLostAuthorityAndCanRetry()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        using (var outside = new SqliteConnection(new SqliteConnectionStringBuilder
               { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString()))
        {
            outside.Open();
            using var transaction = outside.BeginTransaction(deferred: false);
            using var command = outside.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "UPDATE __nendo_manifest SET modified_at = '2020-01-01T00:00:00.0000000+00:00';";
            command.ExecuteNonQuery();
            var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => source.CreateBackupAsync(plan.PlanId));
            Assert.AreEqual("backup-source-busy", error.Code);
            Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
            Assert.IsFalse(File.Exists(Destination(workspace)));
            transaction.Rollback();
        }
        Assert.IsFalse((await source.CreateBackupAsync(plan.PlanId)).IsIdempotentReplay);
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task ReopeningCannotInventAReplayForAnUnknownBackupConfirmation()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        await source.CreateBackupAsync(plan.PlanId);
        var committed = await ReadBytesAsync(Destination(workspace));
        await source.DisposeAsync();
        workspace.Forget(source);
        var reopened = await workspace.OpenAsync();
        var error = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reopened.CreateBackupAsync(plan.PlanId));
        Assert.AreEqual("backup-plan-not-found", error.Code);
        await Assert.ThrowsExactlyAsync<IOException>(() => reopened.PrepareBackupAsync(Destination(workspace), "copy"));
        CollectionAssert.AreEqual(committed, await ReadBytesAsync(Destination(workspace)));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task NativeSqliteFullDuringBackupPreservesSourceAndAllowsExactRetry()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await ReadBytesAsync(workspace.FilePath);
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        source.BackupMaximumPageCountForTest = 1;
        var error = await Assert.ThrowsExactlyAsync<SqliteException>(() => source.CreateBackupAsync(plan.PlanId));
        Assert.AreEqual(13, error.SqliteErrorCode);
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        Assert.IsFalse(File.Exists(Destination(workspace)));
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
        source.BackupMaximumPageCountForTest = null;
        Assert.IsFalse((await source.CreateBackupAsync(plan.PlanId)).IsIdempotentReplay);
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task SourceReadTransactionPreventsOutsideCommitUntilActivationFinishes()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var before = await ReadBytesAsync(workspace.FilePath);
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        var blocked = false;
        source.BeforeBackupActivation = () =>
        {
            using var outside = new SqliteConnection(new SqliteConnectionStringBuilder
            { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false, DefaultTimeout = 2 }.ToString());
            outside.Open();
            using var transaction = outside.BeginTransaction(deferred: false);
            using var command = outside.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "UPDATE __nendo_manifest SET modified_at = '2020-01-01T00:00:00.0000000+00:00';";
            command.ExecuteNonQuery();
            var error = Assert.ThrowsExactly<SqliteException>(() => transaction.Commit());
            Assert.AreEqual(5, error.SqliteErrorCode);
            blocked = true;
            transaction.Rollback();
        };
        await source.CreateBackupAsync(plan.PlanId);
        Assert.IsTrue(blocked);
        CollectionAssert.AreEqual(before, await ReadBytesAsync(workspace.FilePath));
        await using var copy = await NendoWriteCoordinator.OpenReadOnlyAsync(Destination(workspace));
        Assert.AreEqual(plan.Source, (await copy.GetSnapshotAsync()).Manifest);
        AssertNoStages(workspace);
    }

    [TestMethod]
    public async Task StudioMutationWaitsUntilBackupActivationAndThenUpdatesOnlySource()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var plan = await source.PrepareBackupAsync(Destination(workspace), "copy");
        Task<NendoApplyResult>? edit = null;
        source.BeforeBackupActivation = () =>
        {
            edit = new NendoApplicationService(source).CreateIdeaSchemaAsync("after-backup");
            Assert.IsFalse(edit.IsCompleted);
        };
        var backup = await source.CreateBackupAsync(plan.PlanId);
        Assert.IsNotNull(edit);
        await edit;
        Assert.AreEqual(0L, backup.Manifest.ChangeSequence);
        Assert.AreEqual(1L, (await source.GetSnapshotAsync()).Manifest.ChangeSequence);
        await using var copy = await NendoWriteCoordinator.OpenReadOnlyAsync(Destination(workspace));
        Assert.AreEqual(0L, (await copy.GetSnapshotAsync()).Manifest.ChangeSequence);
        AssertNoStages(workspace);
    }

    private static string SemanticState(NendoSessionSnapshot snapshot) =>
        JsonSerializer.Serialize(new { snapshot.Manifest, snapshot.Entities, snapshot.Records, snapshot.UiNodes });

    private static string Destination(EngineTestWorkspace workspace, string name = "backup.nendo") =>
        Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, name);

    private static void AssertNoStages(EngineTestWorkspace workspace) =>
        Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*"));

    private static async Task<byte[]> ReadBytesAsync(string path)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var memory = new MemoryStream();
        await file.CopyToAsync(memory);
        return memory.ToArray();
    }

    private static object? ScalarFixture(string path, string sql)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return command.ExecuteScalar();
    }

    private static void ChangeFixture(string path, string sql)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}
