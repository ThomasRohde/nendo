using Microsoft.Data.Sqlite;
using Nendo.Engine.Storage;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0021 (W-101): a person folds a file's older history into a checkpoint revision, after a
/// backup, so a file that is used every day keeps accepting writes past the operation-row bound.
/// </summary>
[TestClass]
public sealed class HistoryFoldTests
{
    private static readonly SqliteNendoStore.HistoryFoldPolicy Small = new(5, 1_000, 2);

    /// <summary>
    /// Carries the token a cooperative [Timeout] cancels. Without it the ten-minute bound below
    /// could not stop the test: a run took 14:13 and passed (TST-11).
    /// </summary>
    public TestContext TestContext { get; set; } = null!;

    [TestMethod]
    [Timeout(600_000, CooperativeCancellation = true)]
    public async Task AFileWrittenPastTheRowBoundKeepsAcceptingWritesByFoldingAndStillOpens()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        // Two hundred records of five fields, edited over and over: an operation row per field set,
        // as a file in daily use grows, without passing the separate bound on records in one table.
        await coordinator.ApplyAsync(new NendoMutation("fold-tests", "more-fields", "test", "Four more fields",
            Enumerable.Range(1, 4).Select(index => (NendoOperation)new AddFieldOperation($"n-f{index}", "notes", $"f{index}", $"F{index}", $"f_{index}", NendoStorageKind.Text, false)).ToArray()));
        await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            Enumerable.Range(0, 200).Select(index => new NendoRecordWrite(NendoRecordWriteKind.Create, "notes", $"n-{index}",
                Values("label", "New"))).ToList(), Context("create-all")));
        var version = 1L;
        var edits = 0;
        var timedOut = TestContext.CancellationToken;
        async Task EditAllAsync()
        {
            timedOut.ThrowIfCancellationRequested();
            var written = await service.ApplyRecordWritesAsync(new NendoRecordWritesRequest(
                Enumerable.Range(0, 200).Select(index => new NendoRecordWrite(NendoRecordWriteKind.Update, "notes", $"n-{index}",
                    Values("label", $"Edit {edits}", "f1", $"{edits}", "f2", $"{edits}", "f3", $"{edits}", "f4", $"{edits}"), version)).ToList(),
                Context($"edit-{edits}")), timedOut);
            version = written.Records[0].RecordVersion!.Value;
            edits++;
        }
        // Up to the bound: the next edit would pass 99,000 operation rows and is refused.
        var rows = (await service.PreviewHistoryFoldAsync()).OperationRows;
        while (rows + 2_000 < SqliteNendoStore.WriteCeilingRows) { await EditAllAsync(); rows += 1_000; }
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(async () =>
        {
            for (var more = 0; more < 4; more++) await EditAllAsync();
        });
        Assert.AreEqual("write-ceiling-rows", refused.Code, refused.Message);

        var (bytesBefore, openBefore) = await MeasureAsync(workspace.FilePath);
        var folded = await FoldAsync(workspace, coordinator, service, "at-the-bound");
        var (bytesAfter, openAfter) = await MeasureAsync(workspace.FilePath);
        // ADR-0021 asks for these; the test states them rather than bounding them, since the machine sets the times.
        Console.WriteLine($"history-fold: {folded.OperationRowsBefore:N0} operation rows before, {folded.OperationRowsAfter:N0} after; " +
            $"file {bytesBefore / 1024:N0} KiB before, {bytesAfter / 1024:N0} KiB after; inspection {openBefore:N0} ms before, {openAfter:N0} ms after");
        Assert.IsLessThan(bytesBefore, bytesAfter, "Folding did not give the file's pages back.");
        Assert.IsLessThanOrEqualTo(25_000L, folded.OperationRowsAfter, "The fold kept more than the policy's rows.");
        Assert.IsGreaterThan(98_000L, folded.OperationRowsBefore);

        // And on past the old bound: 60,000 more rows of edits.
        for (var batch = 0; batch < 60; batch++) await EditAllAsync();
        var notes = await ReadNotesAsync(service);
        Assert.HasCount(201, notes, "Records were lost or duplicated across the fold.");
        Assert.IsTrue(notes.Where(line => line.StartsWith("n-", StringComparison.Ordinal)).All(line => line.EndsWith($"|{version}|Edit {edits - 1}", StringComparison.Ordinal)),
            "An edit made after the fold is not in the records.");

        await coordinator.DisposeAsync();
        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.IsEmpty(inspected.Inspection.Findings,
            string.Join("; ", inspected.Inspection.Findings.Select(finding => $"{finding.Code}: {finding.Message}")));
        StringAssert.Contains(inspected.Inspection.Layout, "-look-fold-v1");
        var reopened = await workspace.OpenAsync();
        Assert.AreEqual("ok", (await reopened.VerifyIntegrityAsync()).IntegrityResult);
        await new NendoApplicationService(reopened).ApplyRecordWritesAsync(new NendoRecordWritesRequest(
            [new(NendoRecordWriteKind.Create, "notes", "after-reopen", Values("label", "Still writing"))], Context("after-reopen")));
        await reopened.DisposeAsync();
    }

    [TestMethod]
    public async Task AFoldKeepsRecordsTombstonesCountersAndTheLaterRevisionsExactly()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        coordinator.HistoryFoldPolicy = Small;
        for (var index = 0; index < 20; index++)
            await service.CreateRecordAsync(new("notes", $"note-{index}", Values("label", $"Note {index}"), Context($"create-{index}")));
        await service.DeleteRecordAsync(new("notes", "note-3", 1, Context("delete-3")));
        await service.SetFieldAsync(new("notes", "note-4", "label", 1, "Changed", Context("update-4")));
        var historyBefore = await service.GetHistoryAsync();
        var recordsBefore = await ReadNotesAsync(service);
        var manifestBefore = (await service.GetSnapshotAsync()).Manifest;

        var result = await FoldAsync(workspace, coordinator, service, "keeps");

        var history = await service.GetHistoryAsync();
        Assert.AreEqual(NendoRevisionLane.Genesis, history[0].Lane);
        Assert.AreEqual(NendoRevisionLane.Checkpoint, history[1].Lane, "The fold left no checkpoint after Genesis.");
        Assert.AreEqual(result.CheckpointRevisionId, history[1].RevisionId);
        Assert.AreEqual(result.ThroughChangeSequence, history[1].ChangeSequence);
        Assert.IsEmpty(history[1].Operations);
        var kept = historyBefore.Skip(historyBefore.Count - 5).ToList();
        CollectionAssert.AreEqual(kept.Select(Identity).ToList(), history.Skip(2).Select(Identity).ToList(),
            "The revisions after the checkpoint are not the five most recent ones, unchanged.");
        Assert.AreEqual(historyBefore.Count - 6, result.Revisions, "The fold did not name how many revisions it folded.");
        var manifest = (await service.GetSnapshotAsync()).Manifest;
        Assert.AreEqual(manifestBefore.ChangeSequence, manifest.ChangeSequence);
        Assert.AreEqual(manifestBefore.DefinitionRevision, manifest.DefinitionRevision);
        Assert.AreEqual(manifestBefore.DataRevision, manifest.DataRevision);
        Assert.AreEqual(NendoFormat.RevisionIndexesMinimumHostVersion, manifest.MinimumHostVersion);
        CollectionAssert.AreEqual(recordsBefore, await ReadNotesAsync(service), "A record or a version changed in the fold.");

        // The deleted record's ID stays reserved: its tombstone is not history.
        var reuse = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.CreateRecordAsync(new("notes", "note-3", Values("label", "Again"), Context("reuse-3"))));
        Assert.IsFalse(string.IsNullOrEmpty(reuse.Code));

        // A folded change cannot be undone, and says why; the checkpoint neither; a kept one can.
        var foldedRevision = historyBefore[3].RevisionId;
        var notFound = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CompensateRevisionAsync(foldedRevision, "undo-folded"));
        Assert.AreEqual("revision-not-found", notFound.Code);
        StringAssert.Contains(notFound.Message, "folded");
        StringAssert.Contains(notFound.Message, result.BackupLabel);
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() => service.CompensateRevisionAsync(result.CheckpointRevisionId, "undo-checkpoint"));
        var update = history.Last(revision => revision.Description.Contains("note-4", StringComparison.Ordinal) || revision.IdempotencyKey == "update-4");
        await service.CompensateRevisionAsync(update.RevisionId, "undo-update");
        Assert.AreEqual("Note 4", (await ReadNotesAsync(service)).Single(line => line.StartsWith("note-4", StringComparison.Ordinal)).Split('|')[2]);

        // A kept write retried is recognised; a folded one is not, and meets the record it made.
        var retried = await service.SetFieldAsync(new("notes", "note-4", "label", 1, "Changed", Context("update-4")));
        Assert.IsTrue(retried.IsIdempotentReplay, "A kept write retried was not recognised as the same write.");
        await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.CreateRecordAsync(new("notes", "note-0", Values("label", "Note 0"), Context("create-0"))));
        Assert.IsNull(await coordinator.GetMutationReceiptAsync(new("fold-tests", "create-0")), "A folded write still has a receipt.");
    }

    [TestMethod]
    public async Task AFoldNeedsABackupOfTheFileAsItStandsAndTakesNothingWithoutOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        coordinator.HistoryFoldPolicy = Small;
        for (var index = 0; index < 12; index++)
            await service.CreateRecordAsync(new("notes", $"note-{index}", Values("label", $"Note {index}"), Context($"create-{index}")));
        var before = (await service.GetHistoryAsync()).Count;

        var noBackup = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.FoldHistoryAsync("backup-that-was-never-made"));
        Assert.AreEqual("history-fold-needs-backup", noBackup.Code);
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-change.nendo");
        var plan = await coordinator.PrepareBackupAsync(destination, "stale-backup");
        await coordinator.CreateBackupAsync(plan.PlanId);
        await service.CreateRecordAsync(new("notes", "after-backup", Values("label", "Later"), Context("after-backup")));
        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.FoldHistoryAsync(plan.PlanId));
        Assert.AreEqual("history-fold-backup-stale", stale.Code);
        Assert.HasCount(before + 1, await service.GetHistoryAsync(), "A refused fold changed the history.");
    }

    [TestMethod]
    public async Task AFoldNeverSplitsAProposalAndFoldsAnEarlierCheckpointWithIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        // A proposal of four changes promotes as four revisions, which belong together.
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var changeSet = new NendoChangeSet(Enumerable.Range(0, 4).Select(index => new NendoMutation("fold-tests", $"{proposalId}-{index}", "test",
            $"Field {index}", [new AddFieldOperation($"n-extra-{index}", "notes", $"extra{index}", $"Extra {index}", $"extra_{index}", NendoStorageKind.Text, false)])).ToArray());
        var proposal = await service.PrepareProposalAsync(new NendoProposalRequest(proposalId, "Four fields", "test", changeSet));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        var promoted = (await service.GetHistoryAsync()).Where(revision => revision.ProposalId == proposalId).ToList();
        Assert.HasCount(4, promoted, "The proposal did not promote as four revisions.");
        // Keeping three would cut through the proposal.
        await service.CreateRecordAsync(new("notes", "after-proposal", Values("label", "After"), Context("after-proposal")));
        coordinator.HistoryFoldPolicy = new(3, 1_000_000, 1);
        await FoldAsync(workspace, coordinator, service, "first");
        var history = await service.GetHistoryAsync();
        var keptOfProposal = history.Count(revision => revision.ProposalId == proposalId);
        Assert.AreEqual(4, keptOfProposal, $"The fold split the proposal: {keptOfProposal} of its 4 revisions were kept.");

        // A second fold takes the first checkpoint with it and keeps one checkpoint.
        for (var index = 0; index < 8; index++)
            await service.CreateRecordAsync(new("notes", $"more-{index}", Values("label", $"More {index}"), Context($"more-{index}")));
        coordinator.HistoryFoldPolicy = Small;
        var second = await FoldAsync(workspace, coordinator, service, "second");
        history = await service.GetHistoryAsync();
        Assert.HasCount(1, history.Where(revision => revision.Lane == NendoRevisionLane.Checkpoint));
        Assert.AreEqual(second.CheckpointRevisionId, history[1].RevisionId);
        await coordinator.DisposeAsync();
        var reopened = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.IsEmpty(reopened.Inspection.Findings,
            string.Join("; ", reopened.Inspection.Findings.Select(finding => $"{finding.Code}: {finding.Message}")));
    }

    [TestMethod]
    public void HistoryIsRefusedWhenTheCheckpointOrWhatFollowsItDoesNotMatchTheFold()
    {
        var genesis = Revision("genesis", 0, NendoRevisionLane.Genesis, 0, 0, 0, 0, null);
        var checkpoint = Revision("checkpoint", 40, NendoRevisionLane.Checkpoint, 0, 3, 0, 20, "chain");
        var fold = new HistoryFoldRow("checkpoint", DateTimeOffset.UtcNow, 1, 40, 40, 400, "chain", null, null, "backup.nendo",
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow);
        var next = Revision("next", 41, NendoRevisionLane.Data, 3, 3, 20, 21, null);

        Assert.IsTrue(SqliteNendoStore.HistoryIsConsistent([genesis, checkpoint, next], fold), "A good folded history was refused.");
        Assert.IsFalse(SqliteNendoStore.HistoryIsConsistent([genesis, checkpoint with { OperationDigest = "other" }, next], fold),
            "A checkpoint whose digest is not the fold's was accepted.");
        Assert.IsFalse(SqliteNendoStore.HistoryIsConsistent([genesis, checkpoint with { DataRevisionAfter = 19 }, next], fold),
            "A checkpoint whose counters do not lead to what follows was accepted.");
        Assert.IsFalse(SqliteNendoStore.HistoryIsConsistent([genesis, checkpoint, next with { ChangeSequence = 42 }], fold),
            "A gap after the checkpoint was accepted.");
        Assert.IsFalse(SqliteNendoStore.HistoryIsConsistent([genesis, checkpoint, next], null), "A checkpoint without its fold was accepted.");
        Assert.IsFalse(SqliteNendoStore.HistoryIsConsistent([genesis, next with { ChangeSequence = 1, DefinitionRevisionBefore = 0, DataRevisionBefore = 0 }], fold),
            "A fold whose checkpoint is missing was accepted.");
    }

    [TestMethod]
    public async Task AFoldedFileDeclaringAnOlderHostIsRefusedAsALayoutMismatchAndAnUnfoldedFileKeepsItsLayout()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await SeedAsync(workspace);
        coordinator.HistoryFoldPolicy = Small;
        for (var index = 0; index < 10; index++)
            await service.CreateRecordAsync(new("notes", $"note-{index}", Values("label", $"Note {index}"), Context($"create-{index}")));
        var unfolded = (await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None)).Inspection.Layout!;
        Assert.DoesNotContain("-fold-", unfolded, "A file never folded gained the fold rung.");
        await FoldAsync(workspace, coordinator, service, "layout");
        await coordinator.DisposeAsync();
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_manifest SET minimum_host_version = '1.38.0';";
            await command.ExecuteNonQueryAsync();
        }
        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.AreEqual("layout-version-mismatch", inspected.Inspection.Findings.Single().Code);
    }

    /// <summary>
    /// PERF-01 and PERF-04: a file grown by single edits holds an idempotency row per revision, and
    /// every revision a fold deletes cascades into that table by its revision. Without an index that
    /// is a scan of the whole table per folded revision, minutes at 20,000 revisions. The fold adds
    /// the history indexes before it deletes, and the receipt and compensation reads search them.
    /// </summary>
    [TestMethod]
    [Timeout(600_000, CooperativeCancellation = true)]
    public async Task AFoldOfAFileGrownBySingleEditsIsBoundedAndLeavesItsHistoryIndexed()
    {
        const int revisions = 20_000;
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, _) = await SeedAsync(workspace);
        await coordinator.DisposeAsync();
        // Twenty thousand single-operation revisions, each with its idempotency row, as Studio cell
        // edits leave them. Written directly, since twenty thousand committed writes would take
        // minutes of their own; the history they form passes inspection like any other.
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync();
            long sequence, definition, data;
            await using (var manifest = connection.CreateCommand())
            {
                manifest.Transaction = transaction;
                manifest.CommandText = "SELECT change_sequence, definition_revision, data_revision FROM __nendo_manifest;";
                await using var reader = await manifest.ExecuteReaderAsync();
                await reader.ReadAsync();
                (sequence, definition, data) = (reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2));
            }
            await using var revision = connection.CreateCommand();
            revision.Transaction = transaction;
            revision.CommandText = """
                INSERT INTO __nendo_revision(revision_id, created_at, origin, description, lane, definition_revision_before, definition_revision_after,
                    data_revision_before, data_revision_after, change_sequence, operation_digest, idempotency_scope, idempotency_key)
                VALUES ($id, $at, 'surface', 'Edit', 'Data', $definition, $definition, $before, $after, $sequence, $digest, 'fold-tests', $key);
                INSERT INTO __nendo_operation(revision_id, ordinal, operation_id, operation_type, canonical_json, reversibility, inverse_evidence_json)
                VALUES ($id, 0, $operation, 'data.setField', $canonical, 'Reversible', '{}');
                INSERT INTO __nendo_idempotency(idempotency_scope, idempotency_key, payload_digest, revision_id)
                VALUES ('fold-tests', $key, $digest, $id);
                """;
            var parameters = new[] { "$id", "$at", "$definition", "$before", "$after", "$sequence", "$digest", "$key", "$operation", "$canonical" }
                .ToDictionary(name => name, name => revision.Parameters.Add(name, SqliteType.Text));
            var at = DateTimeOffset.UtcNow.ToString("O", System.Globalization.CultureInfo.InvariantCulture);
            for (var index = 0; index < revisions; index++)
            {
                var operation = $"bulk-op-{index}";
                var canonical = $$"""{"operationId":"{{operation}}","operationType":"data.setField","lane":"Data","reversibility":"Reversible"}""";
                parameters["$id"].Value = $"revision-bulk-{index}";
                parameters["$at"].Value = at;
                parameters["$definition"].Value = definition;
                parameters["$before"].Value = data;
                parameters["$after"].Value = ++data;
                parameters["$sequence"].Value = ++sequence;
                parameters["$digest"].Value = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("[" + canonical + "]"))).ToLowerInvariant();
                parameters["$key"].Value = $"bulk-{index}";
                parameters["$operation"].Value = operation;
                parameters["$canonical"].Value = canonical;
                await revision.ExecuteNonQueryAsync();
            }
            await using (var manifest = connection.CreateCommand())
            {
                manifest.Transaction = transaction;
                manifest.CommandText = $"UPDATE __nendo_manifest SET change_sequence = {sequence}, data_revision = {data};";
                await manifest.ExecuteNonQueryAsync();
            }
            await transaction.CommitAsync();
        }
        coordinator = await workspace.OpenAsync();
        var service = new NendoApplicationService(coordinator);
        for (var index = 0; index < 6; index++)
            await service.CreateRecordAsync(new("notes", $"after-bulk-{index}", Values("label", $"After {index}"), Context($"after-bulk-{index}")));
        coordinator.HistoryFoldPolicy = Small;

        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "before-fold-bulk.nendo");
        var backup = await coordinator.PrepareBackupAsync(destination, "fold-bulk");
        await coordinator.CreateBackupAsync(backup.PlanId);
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var folded = await service.FoldHistoryAsync(backup.PlanId);
        clock.Stop();
        Console.WriteLine($"history-fold of {folded.Revisions:N0} single-operation revisions: {clock.ElapsedMilliseconds:N0} ms");
        Assert.IsGreaterThanOrEqualTo((long)revisions, folded.Revisions);
        // Measured at about 1 s with the index; without it the delete alone takes a minute or more.
        Assert.IsLessThan(30_000L, clock.ElapsedMilliseconds,
            $"Folding {folded.Revisions:N0} single-operation revisions took {clock.ElapsedMilliseconds:N0} ms, as a delete that scans the idempotency rows for each revision does.");
        Assert.AreEqual(NendoFormat.RevisionIndexesMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();

        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Mode=ReadOnly;Pooling=False"))
        {
            await connection.OpenAsync();
            async Task<string> PlanAsync(string sql)
            {
                await using var command = connection.CreateCommand();
                command.CommandText = "EXPLAIN QUERY PLAN " + sql;
                command.Parameters.AddWithValue("$value", "x");
                await using var reader = await command.ExecuteReaderAsync();
                var lines = new List<string>();
                while (await reader.ReadAsync()) lines.Add(reader.GetString(3));
                return string.Join(" / ", lines);
            }
            StringAssert.Contains(await PlanAsync("SELECT 1 FROM __nendo_idempotency WHERE revision_id = $value;"),
                "INDEX __nendo_idempotency_revision", "The cascade a fold's delete makes into the idempotency rows is not served by an index.");
            StringAssert.Contains(await PlanAsync("SELECT revision_id FROM __nendo_revision WHERE proposal_id = $value ORDER BY change_sequence;"),
                "INDEX __nendo_revision_proposal", "The receipt read by proposal scans the revisions.");
            StringAssert.Contains(await PlanAsync("SELECT revision_id FROM __nendo_revision WHERE compensation_of_revision_id = $value;"),
                "INDEX __nendo_revision_compensation", "The compensation read by the revision it reverses scans the revisions.");
        }
        var inspected = await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None);
        Assert.IsEmpty(inspected.Inspection.Findings,
            string.Join("; ", inspected.Inspection.Findings.Select(finding => $"{finding.Code}: {finding.Message}")));
    }

    /// <summary>
    /// The history indexes a fold adds state host 1.50.0 (ADR-0021, 2026-10-13 note): a folded file
    /// that declares less is a layout mismatch, and a file holding only some of them is not a layout
    /// this host knows, since the signature leaves them out only all together.
    /// </summary>
    [TestMethod]
    public async Task AFoldedFileBelowTheIndexHostOrWithoutOneOfItsIndexesIsRefused()
    {
        foreach (var (name, change, code, words) in new[]
        {
            ("below", "UPDATE __nendo_manifest SET minimum_host_version = '1.49.0';", "layout-version-mismatch", "history indexes"),
            ("partial", "DROP INDEX __nendo_revision_compensation;", "unknown-protected-schema", "recognised production layout"),
        })
        {
            await using var workspace = new EngineTestWorkspace();
            var (coordinator, service) = await SeedAsync(workspace);
            coordinator.HistoryFoldPolicy = Small;
            for (var index = 0; index < 10; index++)
                await service.CreateRecordAsync(new("notes", $"note-{index}", Values("label", $"Note {index}"), Context($"create-{index}")));
            await FoldAsync(workspace, coordinator, service, name);
            await coordinator.DisposeAsync();
            Assert.IsEmpty((await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None)).Inspection.Findings);
            await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
            {
                await connection.OpenAsync();
                await using var command = connection.CreateCommand();
                command.CommandText = change;
                await command.ExecuteNonQueryAsync();
            }
            var inspection = (await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None)).Inspection;
            Assert.HasCount(1, inspection.Findings, $"{name}: the file opened as {inspection.Classification} with {inspection.Findings.Count} findings, where {code} was owed.");
            var finding = inspection.Findings.Single();
            Assert.AreEqual(code, finding.Code, $"{name}: {finding.Message}");
            StringAssert.Contains(finding.Message, words, name);
        }
    }

    /// <summary>
    /// A file a newer Nendo wrote says so, even when it carries a layout this host has never seen:
    /// the stated host is read before the layout, so the person is not told the file is unrecognised.
    /// </summary>
    [TestMethod]
    public async Task AFileANewerNendoWroteSaysSoBeforeItsLayoutIsJudged()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, _) = await SeedAsync(workspace);
        await coordinator.DisposeAsync();
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "CREATE TABLE __nendo_from_the_future (x TEXT); UPDATE __nendo_manifest SET minimum_host_version = '9.0.0';";
            await command.ExecuteNonQueryAsync();
        }
        var finding = (await SqliteNendoStore.InspectAsync(workspace.FilePath, CancellationToken.None)).Inspection.Findings.Single();
        Assert.AreEqual("unsupported-host-version", finding.Code, finding.Message);
        StringAssert.Contains(finding.Message, "A newer Nendo may open it.");
    }

    // ---------------------------------------------------------------- helpers

    private static async Task<NendoHistoryFoldResult> FoldAsync(EngineTestWorkspace workspace, NendoWriteCoordinator coordinator,
        NendoApplicationService service, string name)
    {
        var destination = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, $"before-fold-{name}.nendo");
        var plan = await coordinator.PrepareBackupAsync(destination, $"fold-{name}");
        await coordinator.CreateBackupAsync(plan.PlanId);
        var preview = await service.PreviewHistoryFoldAsync();
        Assert.IsTrue(preview.CanFold, preview.Reason);
        var result = await service.FoldHistoryAsync(plan.PlanId);
        Assert.AreEqual(preview.ThroughChangeSequence, result.ThroughChangeSequence, "The fold took other revisions than its preview named.");
        Assert.AreEqual(Path.GetFileName(destination), result.BackupLabel);
        return result;
    }

    private static async Task<(long Bytes, long Milliseconds)> MeasureAsync(string path)
    {
        var clock = System.Diagnostics.Stopwatch.StartNew();
        var inspected = await SqliteNendoStore.InspectAsync(path, CancellationToken.None);
        clock.Stop();
        Assert.IsEmpty(inspected.Inspection.Findings);
        return (new FileInfo(path).Length, clock.ElapsedMilliseconds);
    }

    private static string Identity(NendoRevisionSnapshot revision) =>
        $"{revision.RevisionId}|{revision.ChangeSequence}|{revision.OperationDigest}|{revision.DefinitionRevisionAfter}|{revision.DataRevisionAfter}";

    private static async Task<List<string>> ReadNotesAsync(NendoApplicationService service)
    {
        var lines = new List<string>();
        string? cursor = null;
        do
        {
            var page = await service.QueryRecordsAsync(new("notes", 200, cursor));
            lines.AddRange(page.Items.Select(record => $"{record.RecordId}|{record.RecordVersion}|{record.Values["label"].GetString()}"));
            cursor = page.NextCursor;
        } while (cursor is not null);
        return lines.Order(StringComparer.Ordinal).ToList();
    }

    private static NendoRevisionSnapshot Revision(string id, long sequence, NendoRevisionLane lane, long definitionBefore, long definitionAfter,
        long dataBefore, long dataAfter, string? digest)
    {
        var operations = lane is NendoRevisionLane.Data
            ? new List<NendoStoredOperationSnapshot> { new($"{id}-op", "data.setField", NendoReversibilityClass.Reversible,
                $$"""{"operationId":"{{id}}-op","operationType":"data.setField","lane":"Data","reversibility":"Reversible"}""") }
            : [];
        var canonical = "[" + string.Join(',', operations.Select(operation => operation.CanonicalJson)) + "]";
        var computed = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        return new(id, DateTimeOffset.UtcNow, "test", id, lane, definitionBefore, definitionAfter, dataBefore, dataAfter, sequence,
            digest ?? computed, null, null, null, null, null, operations);
    }

    private static async Task<(NendoWriteCoordinator, NendoApplicationService)> SeedAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("fold-tests", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
        ]));
        await service.CreateRecordAsync(new("notes", "seed", Values("label", "Seed"), Context("seed")));
        return (coordinator, service);
    }

    private static Dictionary<string, object?> Values(params string[] pairs) =>
        Enumerable.Range(0, pairs.Length / 2).ToDictionary(index => pairs[index * 2], index => (object?)pairs[index * 2 + 1]);

    private static NendoRequestContext Context(string key) => new("fold-tests", key, "surface");
}
