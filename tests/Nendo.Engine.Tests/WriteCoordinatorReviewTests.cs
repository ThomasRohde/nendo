using System.Text;
using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// The write coordinator's file lifecycle, its proposals and its read-only sessions: each
/// test holds one defect.
/// </summary>
[TestClass]
public sealed class WriteCoordinatorReviewTests
{
    /// <summary>
    /// A read-only session pinned the file without sharing it for delete, so the writer's
    /// restore failed to rename the original after its recovery record was written, and the file
    /// opened in recovery for a replacement that never moved a byte.
    /// </summary>
    [TestMethod]
    public async Task ARestoreFinishesWhileAReadOnlySessionHoldsTheFile()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        var backup = await BackupAsync(source, workspace, "backup");
        await service.CreateIdeaRecordAsync("idea-1", "After the backup", "record");
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);

        var plan = await service.PrepareRestoreAsync(backup, "restore");
        var result = await service.RestoreAsync(plan.PlanId, confirmDiscardProposals: false);

        Assert.AreEqual(plan.Restored, result.Manifest);
        Assert.IsFalse((await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).HasPendingReplacement,
            "The restore was left as an interrupted replacement.");
        Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*"));
        // The reader still holds what it inspected, and a backup from it says the file moved on.
        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            reader.PrepareBackupAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "late.nendo"), "late"));
        Assert.AreEqual("backup-source-changed", stale.Code);
    }

    /// <summary>
    /// The commit events came after the compaction and the inspection, so a full disk during
    /// the compaction reported a fold that had removed the history as failed, and nothing heard of it.
    /// </summary>
    [TestMethod]
    public async Task AFoldWhoseCompactionFailsIsStillReportedAsTheCommittedFold()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("fold", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
        ]));
        coordinator.HistoryFoldPolicy = new SqliteNendoStore.HistoryFoldPolicy(5, 1_000, 2);
        for (var index = 0; index < 12; index++)
            await service.CreateRecordAsync(new("notes", $"note-{index}", new Dictionary<string, object?> { ["label"] = $"Note {index}" }, new("fold", $"create-{index}", "surface")));
        var backup = await coordinator.PrepareBackupAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-fold.nendo"), "fold-backup");
        await coordinator.CreateBackupAsync(backup.PlanId);
        var committed = 0;
        coordinator.Committed += _ => committed++;
        coordinator.BeforeHistoryFoldVacuum = () => throw new SqliteException("database or disk is full", 13);

        var result = await service.FoldHistoryAsync(backup.PlanId);

        Assert.IsFalse(result.SpaceReclaimed, "A compaction that failed was reported as having given the pages back.");
        Assert.AreEqual(1, committed, "The fold's commit was not told.");
        Assert.AreEqual(NendoRevisionLane.Checkpoint, (await service.GetHistoryAsync())[1].Lane);
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
    }

    /// <summary>
    /// Only the validation's own handler removed a proposal that failed, so a cancel during the
    /// refusal diagnosis or during the proposal's last write left it registered, with a full copy of
    /// the file in its workspace, under an ID the caller never received.
    /// </summary>
    [TestMethod]
    [DataRow("diagnosis")]
    [DataRow("persist")]
    public async Task AProposalCancelledBeforeItsIdIsReturnedIsNotKept(string where)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        // A refused rename reaches the diagnosis; an accepted one reaches the last write.
        var change = new NendoChangeSet([new NendoMutation("test", "rename", "test", "Rename",
            [new RenameEntityOperation("rename", NendoApplicationService.IdeaEntityId, "Ideas", where == "diagnosis" ? revision + 7 : revision)])]);
        if (where == "diagnosis") coordinator.BeforeRefusalDiagnosis = () => throw new OperationCanceledException();
        else coordinator.BeforeProposalPersist = () => throw new OperationCanceledException();

        await Assert.ThrowsExactlyAsync<OperationCanceledException>(() => coordinator.BeginProposalAsync(proposalId, "Cancelled", "test", change));

        Assert.IsEmpty(await coordinator.ListProposalsAsync(), $"A proposal cancelled at the {where} stayed registered.");
        Assert.IsFalse(Directory.Exists(Path.Combine(coordinator.ProposalRoot, proposalId)), "Its workspace and clone were left behind.");
    }

    /// <summary>
    /// The proposal was written as Applying outside the handler that puts it back, so a cancel
    /// during that write left it Applying with nothing committed, and every later accept was refused.
    /// </summary>
    [TestMethod]
    public async Task AnAcceptCancelledWhileItIsWrittenAsApplyingCanBeAcceptedAgain()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema");
        var preview = await service.PrepareIdeaGardenProposalAsync();
        using var cancellation = new CancellationTokenSource();
        coordinator.BeforeApplyingPersist = cancellation.Cancel;

        await Assert.ThrowsAsync<OperationCanceledException>(() => coordinator.PromoteProposalAsync(preview.ProposalId, cancellation.Token));

        coordinator.BeforeApplyingPersist = null;
        Assert.AreEqual(NendoProposalState.Previewable, (await coordinator.GetProposalAsync(preview.ProposalId)).State);
        var retried = await coordinator.PromoteProposalAsync(preview.ProposalId);
        Assert.IsTrue(retried.Applied, retried.Message);
    }

    /// <summary>
    /// Removing a proposal's workspace threw while another program held one of its files, so
    /// a reject failed and left the proposal listed, and a restore that had moved nothing became an
    /// interrupted replacement.
    /// </summary>
    [TestMethod]
    public async Task ALockedProposalFileFailsNeitherARejectNorARestore()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        var backup = await BackupAsync(source, workspace, "backup");
        var root = source.ProposalRoot;
        try
        {
            var rejected = await service.PrepareIdeaGardenProposalAsync();
            using (HoldClone(root, rejected.ProposalId))
            {
                var outcome = await service.RejectProposalAsync(rejected.ProposalId);
                Assert.AreEqual(NendoProposalState.Rejected, outcome.State);
                Assert.IsEmpty(await source.ListProposalsAsync(), "A rejected proposal stayed listed.");
            }

            var discarded = await service.PrepareIdeaGardenProposalAsync();
            var plan = await service.PrepareRestoreAsync(backup, "restore");
            using (HoldClone(root, discarded.ProposalId))
            {
                await service.RestoreAsync(plan.PlanId, confirmDiscardProposals: true);
            }
            Assert.IsFalse((await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).HasPendingReplacement,
                "A restore that moved nothing was left as an interrupted replacement.");
        }
        finally
        {
            ProposalWorkspace.CleanupAbandoned(root);
        }
    }

    /// <summary>
    /// After a definition write committed, the requirement refresh used the caller's token and
    /// the commit events called their observers unguarded, so a cancel or a faulty observer reported a
    /// committed write as failed and kept the others from hearing of it.
    /// </summary>
    [TestMethod]
    public async Task ACommittedDefinitionWriteIsReportedAsCommittedWhateverItsTokenAndObserversDo()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var heard = 0;
        var summaries = 0;
        coordinator.Committed += _ => throw new InvalidOperationException("A faulty observer.");
        coordinator.Committed += _ => heard++;
        coordinator.CommittedChanges += _ => throw new InvalidOperationException("A faulty observer.");
        coordinator.CommittedChanges += _ => summaries++;
        using var cancellation = new CancellationTokenSource();
        coordinator.AfterStoreCommit = cancellation.Cancel;
        var swallowed = new List<Type>();
        coordinator.ObserverFailed = swallowed.Add;

        // The file's first automatic action: the write after which what the file requires is read again.
        var result = await coordinator.ApplyAsync(new NendoMutation("test", "behaviour", "test", "Stamp", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "note.stamp", "Stamp the label",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("stamp", "Concat('Seen ', label)",
                        [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-stamp", "notes", "Stamp the label", NendoTriggerEvents.Updated, "note.stamp", ["label"]), revision),
        ]), cancellation.Token);

        Assert.IsFalse(result.IsIdempotentReplay);
        Assert.IsTrue(coordinator.BehaviourTrust.RequiresApproval, "What the file requires was not read again after the commit.");
        Assert.AreEqual(1, heard, "An observer after a faulty one did not hear of the commit.");
        Assert.AreEqual(1, summaries, "An observer after a faulty one did not hear what the commit changed.");
        CollectionAssert.AreEqual(new[] { typeof(InvalidOperationException), typeof(InvalidOperationException) }, swallowed,
            "A swallowed observer failure was not told to the host by its type.");
    }

    /// <summary>
    /// A read-only session has no store, so its package files and view state were refused as
    /// "open for inspection only": Help lost the file's own pages and a package export failed.
    /// </summary>
    [TestMethod]
    public async Task AReadOnlySessionReadsItsPackageFilesWhileTheFileIsWhatItInspected()
    {
        await using var workspace = new EngineTestWorkspace();
        var writer = await workspace.CreateAsync();
        await writer.ApplyAsync(new NendoMutation("test", "package", "test", "Package", [
            new SetExtensionPackageOperation("package", "org.example.help", "Help", "index.html", "1.0.0"),
            PutExtensionFileOperation.FromContent("put-index", "org.example.help", "index.html", null, Encoding.UTF8.GetBytes("<!doctype html>")),
            PutExtensionFileOperation.FromContent("put-help", "org.example.help", "help/start.md", null, Encoding.UTF8.GetBytes("# Start here\n")),
        ]));
        await writer.DisposeAsync();
        workspace.Forget(writer);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);

        var page = await reader.ReadExtensionFileAsync("org.example.help", "help/start.md");
        Assert.IsNotNull(page);
        Assert.AreEqual("# Start here\n", Encoding.UTF8.GetString(page.Content));
        Assert.IsEmpty(await reader.ReadExtensionStateAsync("org.example.help", "view", null));

        // Once the file moves on, the reader serves nothing it did not inspect.
        var again = await workspace.OpenAsync();
        await again.ApplyAsync(new NendoMutation("test", "more", "test", "More", [
            PutExtensionFileOperation.FromContent("put-more", "org.example.help", "help/more.md", null, Encoding.UTF8.GetBytes("# More\n")),
        ]));
        var moved = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.ReadExtensionFileAsync("org.example.help", "help/start.md"));
        Assert.AreEqual("read-only-file-changed", moved.Code);
        StringAssert.Contains(moved.Message, "Inspect file again");
    }

    /// <summary>
    /// Records a proposal deletes, and those its reference writes point at, were not among the
    /// versions the review captured, so an edit to one after the review made the proposal Failed, with
    /// a form's words, instead of Stale.
    /// </summary>
    [TestMethod]
    [DataRow("delete-target")]
    [DataRow("reference-target")]
    public async Task AnEditToADeleteTargetOrAReferenceTargetStalesTheProposal(string edited)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("test", "schema", "test", "Reference schema", [
            new CreateEntityOperation("target", "target", "Target", "targets"),
            new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("source", "source", "Source", "sources"),
            new AddFieldOperation("ref", "source", "ref", "Reference", "target_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "source", "ref", "target", "label", 0),
        ]));
        await coordinator.ApplyAsync(new NendoMutation("test", "records", "test", "Records", [
            new CreateRecordOperation("t", "target", "t", new Dictionary<string, object?> { ["label"] = "Target" }),
            new CreateRecordOperation("s", "source", "s", new Dictionary<string, object?>()),
        ]));
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        NendoOperation operation = edited == "delete-target"
            ? new DeleteRecordOperation("delete-t", "target", "t", 1)
            : new SetFieldOperation("link-s", "source", "s", "ref", 1, "t", expectedTargetRecordVersion: 1);
        await coordinator.BeginProposalAsync(proposalId, "Change", "test",
            new NendoChangeSet([new NendoMutation("test", proposalId, "test", "Change", [operation])]).Validate());
        await service.SetFieldAsync(new("target", "t", "label", 1, "Edited after the review", new("test", "edit", "surface")));

        var outcome = await coordinator.PromoteProposalAsync(proposalId);

        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(NendoProposalState.Stale, outcome.State, outcome.Message);
        Assert.AreEqual("NPROP003", (await coordinator.GetProposalAsync(proposalId)).Diagnostics.Single().Code);
    }

    /// <summary>
    /// A read-only session took the instance and write leases to restore, and kept them when
    /// the staging failed, so another window could not open the file for editing although nothing was
    /// editing it.
    /// </summary>
    [TestMethod]
    public async Task AFailedReadOnlyRestoreGivesItsLeasesBack()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var backup = await BackupAsync(source, workspace, "backup");
        await source.DisposeAsync();
        workspace.Forget(source);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var plan = await reader.PrepareRestoreAsync(backup, "restore");
        reader.BeforeRestoreValidation = _ => throw new NendoPreconditionException("restore-stage-invalid", "Injected staging failure.");

        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.RestoreAsync(plan.PlanId, false));

        Assert.AreEqual(NendoSessionHealth.ReadOnly, reader.Health);
        await using var editor = await NendoWriteCoordinator.OpenAsync(workspace.FilePath, "another-window");
        Assert.AreEqual(NendoSessionHealth.Normal, editor.Health);
    }

    /// <summary>
    /// An open confirming an earlier observation checked the file's physical facts, but not
    /// the pending replacement record or the read-only mark a fresh inspection refuses on.
    /// </summary>
    [TestMethod]
    [DataRow("pending-marker")]
    [DataRow("read-only-mark")]
    public async Task AnObservedOpenRefusesWhatAFreshInspectionWould(string change)
    {
        await using var workspace = new EngineTestWorkspace();
        var created = await workspace.CreateAsync();
        await created.DisposeAsync();
        workspace.Forget(created);
        var observation = await NendoWriteCoordinator.ObserveAsync(workspace.FilePath);
        Assert.IsTrue(observation.Inspection.CanAcquireWriteAuthority);
        var marker = FileReplacementReceipt.PendingPath(workspace.FilePath);
        try
        {
            if (change == "pending-marker") await File.WriteAllTextAsync(marker, "{}");
            else File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) | FileAttributes.ReadOnly);

            NendoWriteCoordinator? opened = null;
            try { opened = await NendoWriteCoordinator.OpenObservedAsync(workspace.FilePath, "observed", observation); }
            catch (NendoPreconditionException refused) { Assert.AreEqual("file-changed-before-open", refused.Code, refused.Message); }
            if (opened is not null)
            {
                var health = opened.Health;
                await opened.DisposeAsync();
                Assert.Fail($"The observed open trusted the observation over the {change} and opened the file ({health}).");
            }
        }
        finally
        {
            File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) & ~FileAttributes.ReadOnly);
            File.Delete(marker);
        }
    }

    /// <summary>
    /// A restore or an upgrade replaced a file marked read-only with a fresh one without the
    /// mark. The rule is to refuse and ask for the mark to be cleared first.
    /// </summary>
    [TestMethod]
    [DataRow("restore-prepare")]
    [DataRow("restore-after-review")]
    [DataRow("upgrade")]
    public async Task AFileMarkedReadOnlyIsNeitherRestoredNorUpgraded(string action)
    {
        await using var workspace = new EngineTestWorkspace();
        string? backup = null;
        if (action == "upgrade") await LegacyUpgradeTests.CreateLegacyAsync(workspace, true);
        else
        {
            var source = await workspace.CreateAsync();
            backup = await BackupAsync(source, workspace, "backup");
            await source.DisposeAsync();
            workspace.Forget(source);
        }
        try
        {
            if (action != "restore-after-review") Mark(workspace.FilePath);
            var before = await File.ReadAllBytesAsync(workspace.FilePath);
            await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
            NendoPreconditionException refused;
            if (action == "upgrade")
                refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.PrepareUpgradeAsync("upgrade"));
            else if (action == "restore-prepare")
                refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.PrepareRestoreAsync(backup!, "restore"));
            else
            {
                var plan = await reader.PrepareRestoreAsync(backup!, "restore");
                Mark(workspace.FilePath);
                refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.RestoreAsync(plan.PlanId, false));
            }
            Assert.AreEqual("replacement-target-read-only", refused.Code, refused.Message);
            StringAssert.Contains(refused.Message, "Clear Read-only");
            CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
            Assert.AreNotEqual((FileAttributes)0, File.GetAttributes(workspace.FilePath) & FileAttributes.ReadOnly, "The mark was taken off.");
        }
        finally
        {
            File.SetAttributes(workspace.FilePath, File.GetAttributes(workspace.FilePath) & ~FileAttributes.ReadOnly);
        }
    }

    /// <summary>
    /// The file-format versions a file records were worded as Nendo versions, so 'These
    /// surfaces need Nendo 1.11.0' told a person on Nendo 0.19.0 to update a Nendo that reads it.
    /// </summary>
    [TestMethod]
    public async Task FormatVersionsAreWordedAsFileFormatsNotAsNendoVersions()
    {
        await using var workspace = new EngineTestWorkspace();
        var created = await workspace.CreateAsync();
        await created.DisposeAsync();
        workspace.Forget(created);
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_manifest SET minimum_host_version = '999.0.0';";
            await command.ExecuteNonQueryAsync();
        }
        var newer = (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Findings.Single();
        Assert.AreEqual("unsupported-host-version", newer.Code);
        StringAssert.Contains(newer.Message, "file format 999.0.0");
        StringAssert.Contains(newer.Message, NendoFormat.CurrentHostVersion);
        Assert.DoesNotContain("Nendo 999", newer.Message);

        var surfaces = SqliteNendoStore.SurfaceFormatMismatchText("1.11.0", ["composable semantic surfaces"], "1.10.0");
        StringAssert.Contains(surfaces, "file format 1.11.0");
        StringAssert.Contains(surfaces, "records format 1.10.0");
        Assert.DoesNotContain("Nendo 1.", surfaces);
    }

    /// <summary>
    /// A read-only session compares every source with what it inspected at open, so after
    /// a writer commits every backup fails the same way, and the advice to review a new backup could
    /// never work. It now names Inspect file again.
    /// </summary>
    [TestMethod]
    public async Task AReadOnlySessionWhoseFileMovedOnSaysToInspectItAgain()
    {
        await using var workspace = new EngineTestWorkspace();
        var writer = await workspace.CreateAsync();
        var service = new NendoApplicationService(writer);
        await service.CreateIdeaSchemaAsync("schema");
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        await service.CreateIdeaRecordAsync("idea-1", "Written while the reader looks", "record");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;

        var backup = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.PrepareBackupAsync(Path.Combine(folder, "b.nendo"), "b"));
        var copy = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            reader.PrepareIdentityCopyAsync(NendoIdentityCopyKind.Duplicate, Path.Combine(folder, "c.nendo"), "c"));

        Assert.AreEqual("backup-source-changed", backup.Code);
        Assert.AreEqual("identity-source-changed", copy.Code);
        foreach (var refusal in new[] { backup, copy })
        {
            StringAssert.Contains(refusal.Message, "Inspect file again");
            Assert.DoesNotContain("Review a new", refusal.Message);
        }
    }

    /// <summary>
    /// A read-only restore took the file it reviewed from its pin, which follows the
    /// file it opened, while the stage and the digest check read the name. Another file with the same
    /// content at the name passed them, and the rename then interrupted the replacement.
    /// </summary>
    [TestMethod]
    public async Task AReadOnlyRestoreRefusesAnotherFileWithTheSameContentAtTheName()
    {
        await using var workspace = new EngineTestWorkspace();
        var writer = await workspace.CreateAsync();
        var service = new NendoApplicationService(writer);
        await service.CreateIdeaSchemaAsync("schema");
        var backup = await BackupAsync(writer, workspace, "backup");
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        // Another session restores the same content: a new physical file with the digest the reader inspected.
        var same = await service.PrepareRestoreAsync(backup, "same");
        await service.RestoreAsync(same.PlanId, confirmDiscardProposals: false);
        await writer.DisposeAsync();
        workspace.Forget(writer);

        var plan = await reader.PrepareRestoreAsync(backup, "reader");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.RestoreAsync(plan.PlanId, false));

        Assert.AreEqual("backup-source-changed", refused.Code, refused.Message);
        StringAssert.Contains(refused.Message, "Inspect file again");
        Assert.AreEqual(NendoSessionHealth.ReadOnly, reader.Health);
        Assert.IsFalse(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)), "The refused restore left a recovery marker.");
        Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, ".nendo-stage-*"));
    }

    /// <summary>
    /// A reader's handle without delete sharing — another window's Jump List
    /// refresh, a digest check, any program — made the rename fail after the recovery record was
    /// written. The exclusive handle is now taken first: a handle let go within a moment is waited
    /// out, and one held longer is refused with nothing changed and the session still open.
    /// </summary>
    [TestMethod]
    public async Task AReaderAtTheExclusiveHandleIsWaitedOutOrRefusedWithNothingChanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var source = await workspace.CreateAsync();
        var service = new NendoApplicationService(source);
        await service.CreateIdeaSchemaAsync("schema");
        var backup = await BackupAsync(source, workspace, "backup");
        await service.CreateIdeaRecordAsync("idea-1", "After the backup", "record");
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var before = await ReadSharedAsync(workspace.FilePath);

        source.ReplacementAcquireAttempts = 3;
        FileStream? held = null;
        source.RestoreCheckpoint = point => { if (point == "before-exclusive") held = new(workspace.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite); };
        var plan = await service.PrepareRestoreAsync(backup, "held");
        NendoPreconditionException refused;
        try { refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.RestoreAsync(plan.PlanId, false)); }
        finally { held?.Dispose(); }
        Assert.AreEqual("replacement-target-in-use", refused.Code, refused.Message);
        Assert.IsFalse(File.Exists(FileReplacementReceipt.PendingPath(workspace.FilePath)), "A refused restore left a recovery marker.");
        Assert.IsEmpty(Directory.GetFiles(folder, "*.receipt.json"));
        Assert.IsEmpty(Directory.GetFiles(folder, ".nendo-stage-*"));
        CollectionAssert.AreEqual(before, await ReadSharedAsync(workspace.FilePath));
        Assert.AreEqual(NendoSessionHealth.Normal, source.Health);
        await service.CreateIdeaRecordAsync("idea-2", "Still editable", "record-2");

        // A short-lived reader, let go within the wait, does not stop the restore.
        source.ReplacementAcquireAttempts = 20;
        source.RestoreCheckpoint = point =>
        {
            if (point != "before-exclusive") return;
            var brief = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            _ = Task.Delay(200).ContinueWith(_ => brief.Dispose(), TaskScheduler.Default);
        };
        var again = await service.PrepareRestoreAsync(backup, "brief");
        await service.RestoreAsync(again.PlanId, false);
        Assert.IsFalse((await NendoWriteCoordinator.InspectReplacementRecoveryAsync(workspace.FilePath)).HasPendingReplacement);
    }

    /// <summary>
    /// A file moved away or replaced under a read-only session reached the caller as a
    /// raw FileNotFoundException from the read-only-mark check, or a raw SQLite error from a package read.
    /// </summary>
    [TestMethod]
    public async Task AFileMovedOrReplacedUnderAReadOnlySessionSaysItChanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var writer = await workspace.CreateAsync();
        await writer.ApplyAsync(HelpPackage(1));
        var backup = await BackupAsync(writer, workspace, "backup");
        await writer.DisposeAsync();
        workspace.Forget(writer);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var moved = workspace.FilePath + ".moved";
        File.Move(workspace.FilePath, moved);
        try
        {
            var restore = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.PrepareRestoreAsync(backup, "moved"));
            var page = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.ReadExtensionFileAsync("org.example.help", "help/page-0.md"));
            await File.WriteAllTextAsync(workspace.FilePath, new string('x', 4096));
            var replaced = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.ReadExtensionFileAsync("org.example.help", "help/page-0.md"));
            foreach (var refusal in new[] { restore, page, replaced }) Assert.AreEqual("read-only-file-changed", refusal.Code, refusal.Message);
        }
        finally
        {
            File.Delete(workspace.FilePath);
            File.Move(moved, workspace.FilePath);
        }
    }

    /// <summary>
    /// Every package-file read scanned the whole file for its digest, so Help with N
    /// pages was N full scans. One scan now serves every read while the file is unchanged.
    /// </summary>
    [TestMethod]
    public async Task AReadOnlySessionScansItsFileOnceForManyPageReads()
    {
        await using var workspace = new EngineTestWorkspace();
        var writer = await workspace.CreateAsync();
        await writer.ApplyAsync(HelpPackage(3));
        await writer.DisposeAsync();
        workspace.Forget(writer);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);

        for (var page = 0; page < 3; page++) Assert.IsNotNull(await reader.ReadExtensionFileAsync("org.example.help", $"help/page-{page}.md"));
        Assert.IsEmpty(await reader.ReadExtensionStateAsync("org.example.help", "view", null));
        Assert.AreEqual(1, reader.ReadOnlyContentStamp.DigestScans, "Each read scanned the whole file again.");

        var again = await workspace.OpenAsync();
        await again.ApplyAsync(new NendoMutation("test", "more", "test", "More", [
            PutExtensionFileOperation.FromContent("put-more", "org.example.help", "help/more.md", null, Encoding.UTF8.GetBytes("# More\n")),
        ]));
        var changed = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => reader.ReadExtensionFileAsync("org.example.help", "help/page-0.md"));
        Assert.AreEqual("read-only-file-changed", changed.Code);
        Assert.AreEqual(2, reader.ReadOnlyContentStamp.DigestScans, "A changed file was not scanned again.");
    }

    private static NendoMutation HelpPackage(int pages) => new("test", "package", "test", "Package", [
        new SetExtensionPackageOperation("package", "org.example.help", "Help", "index.html", "1.0.0"),
        PutExtensionFileOperation.FromContent("put-index", "org.example.help", "index.html", null, Encoding.UTF8.GetBytes("<!doctype html>")),
        .. Enumerable.Range(0, pages).Select(page => (NendoOperation)PutExtensionFileOperation.FromContent(
            $"put-page-{page}", "org.example.help", $"help/page-{page}.md", null, Encoding.UTF8.GetBytes($"# Page {page}\n"))),
    ]);

    private static async Task<byte[]> ReadSharedAsync(string path)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer);
        return buffer.ToArray();
    }

    private static void Mark(string path) => File.SetAttributes(path, File.GetAttributes(path) | FileAttributes.ReadOnly);

    private static FileStream HoldClone(string root, string proposalId) =>
        new(Path.Combine(root, proposalId, "proposal.nendo"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite);

    private static async Task<string> BackupAsync(NendoWriteCoordinator source, EngineTestWorkspace workspace, string name)
    {
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, $"{name}.nendo");
        var plan = await source.PrepareBackupAsync(destination, name);
        await source.CreateBackupAsync(plan.PlanId);
        return destination;
    }
}
