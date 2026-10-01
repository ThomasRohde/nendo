using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

/// <summary>What one fold of a file's older history left behind as evidence (ADR-0021).</summary>
internal sealed record HistoryFoldRow(
    string CheckpointRevisionId,
    DateTimeOffset FoldedAt,
    long FirstChangeSequence,
    long LastChangeSequence,
    long Revisions,
    long Operations,
    string ChainDigest,
    string? LineageApplicationId,
    string? LineageInstanceId,
    string BackupLabel,
    DateTimeOffset FirstAt,
    DateTimeOffset LastAt);

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// What a fold keeps (ADR-0021): the most recent 1,000 revisions, or fewer when those hold
    /// more than 25,000 operation rows, and never fewer than the last 20 unless those alone hold
    /// more than half the bound. A file written in large batches reaches the row bound in far
    /// fewer than 1,000 revisions.
    /// </summary>
    internal sealed record HistoryFoldPolicy(int KeepRevisions, long KeepRows, int KeepAtLeast)
    {
        internal static readonly HistoryFoldPolicy Default = new(1_000, 25_000, 20);

        /// <summary>Folds every revision after Genesis: a new file of the application starts from one checkpoint (ADR-0022).</summary>
        internal static readonly HistoryFoldPolicy KeepNone = new(0, 0, 0);
    }

    /// <summary>
    /// The evidence of each fold of older history (ADR-0021): the last rung of the protected
    /// layout ladder, added by a file's first fold. One row per fold; the latest is the one the
    /// file's checkpoint revision answers to. A Nendo that predates the rung refuses the file as
    /// a newer layout rather than reading a history that starts late as a broken one.
    /// </summary>
    private const string HistoryFoldSchemaSql = """
        CREATE TABLE __nendo_history_fold (
            checkpoint_revision_id TEXT NOT NULL PRIMARY KEY,
            folded_at TEXT NOT NULL,
            first_change_sequence INTEGER NOT NULL,
            last_change_sequence INTEGER NOT NULL,
            revisions INTEGER NOT NULL,
            operations INTEGER NOT NULL,
            chain_digest TEXT NOT NULL,
            lineage_application_id TEXT NULL,
            lineage_instance_id TEXT NULL,
            backup_label TEXT NOT NULL,
            first_at TEXT NOT NULL,
            last_at TEXT NOT NULL,
            CHECK (first_change_sequence >= 1 AND last_change_sequence >= first_change_sequence AND revisions >= 1 AND operations >= 0)
        );
        """;

    /// <summary>Brings the protected layout up to the fold rung: the whole ladder, then the fold table.</summary>
    private async Task EnsureHistoryFoldLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureApplicationLookLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_history_fold", transaction, ct)) await NonQueryAsync(HistoryFoldSchemaSql, transaction, ct);
    }

    /// <summary>The latest fold, or null for a file that was never folded.</summary>
    internal async Task<HistoryFoldRow?> ReadLatestHistoryFoldAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_history_fold", transaction, ct)) return null;
        await using var command = Command("""
            SELECT checkpoint_revision_id, folded_at, first_change_sequence, last_change_sequence, revisions, operations,
                   chain_digest, lineage_application_id, lineage_instance_id, backup_label, first_at, last_at
            FROM __nendo_history_fold ORDER BY last_change_sequence DESC LIMIT 1;
            """, transaction);
        await using var reader = await command.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return new(reader.GetString(0), ParseTimestamp(reader.GetString(1)), reader.GetInt64(2), reader.GetInt64(3),
            reader.GetInt64(4), reader.GetInt64(5), reader.GetString(6), reader.IsDBNull(7) ? null : reader.GetString(7),
            reader.IsDBNull(8) ? null : reader.GetString(8), reader.GetString(9),
            ParseTimestamp(reader.GetString(10)), ParseTimestamp(reader.GetString(11)));
    }

    private sealed record FoldCandidate(string RevisionId, long ChangeSequence, NendoRevisionLane Lane, DateTimeOffset CreatedAt,
        string OperationDigest, string? ProposalId, long DefinitionAfter, long DataAfter);

    private sealed record FoldPlan(
        IReadOnlyList<FoldCandidate> Folded, FoldCandidate Last, HistoryFoldRow? Previous, long Revisions, long Operations,
        DateTimeOffset FirstAt, DateTimeOffset LastAt, long OperationRows, int Kept);

    /// <summary>
    /// What a fold would take now, or why it would take nothing. Everything after Genesis up to
    /// the change that keeps the most recent <see cref="HistoryFoldKeep"/> revisions, moved down
    /// until no proposal's revisions are split, and any earlier checkpoint with it.
    /// </summary>
    private async Task<(FoldPlan? Plan, string? Reason)> PlanHistoryFoldAsync(HistoryFoldPolicy policy, SqliteTransaction? transaction, CancellationToken ct)
    {
        var all = new List<FoldCandidate>();
        await using (var command = Command("""
            SELECT revision_id, change_sequence, lane, created_at, operation_digest, proposal_id,
                   definition_revision_after, data_revision_after
            FROM __nendo_revision ORDER BY change_sequence;
            """, transaction))
        await using (var reader = await command.ExecuteReaderAsync(ct))
            while (await reader.ReadAsync(ct))
                all.Add(new(reader.GetString(0), reader.GetInt64(1), Enum.Parse<NendoRevisionLane>(reader.GetString(2)),
                    ParseTimestamp(reader.GetString(3)), reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetString(5),
                    reader.GetInt64(6), reader.GetInt64(7)));
        var perRevision = new Dictionary<string, long>(StringComparer.Ordinal);
        await using (var command = Command("SELECT revision_id, COUNT(*) FROM __nendo_operation GROUP BY revision_id;", transaction))
        await using (var reader = await command.ExecuteReaderAsync(ct))
            while (await reader.ReadAsync(ct)) perRevision[reader.GetString(0)] = reader.GetInt64(1);
        var operationRows = perRevision.Values.Sum();
        // How many recent revisions stay: up to the policy's count, fewer once they would hold
        // more than its rows, never fewer than its floor.
        var keep = 0;
        var keptRows = 0L;
        for (var index = all.Count - 1; index > 0 && all[index].Lane != NendoRevisionLane.Checkpoint && keep < policy.KeepRevisions; index--)
        {
            var rows = perRevision.GetValueOrDefault(all[index].RevisionId);
            if (keep >= policy.KeepAtLeast && keptRows + rows > policy.KeepRows || keptRows + rows > WriteCeilingRows / 2) break;
            keep++;
            keptRows += rows;
        }
        var fresh = all.Count(revision => revision.Lane is not (NendoRevisionLane.Genesis or NendoRevisionLane.Checkpoint));
        if (fresh <= keep)
            return (null, $"This file has {fresh:N0} changes since its start or its last fold, and a fold keeps the most recent {keep:N0} of them.");
        // The last revision the fold takes: all but the kept ones, and never one that leaves part
        // of a proposal behind, since a proposal's receipt needs its revisions together.
        var cut = all.Count - 1 - keep;
        while (cut > 0 && cut + 1 < all.Count && all[cut].ProposalId is { } proposal && all[cut + 1].ProposalId == proposal) cut--;
        var folded = all.Skip(1).Take(cut).ToList();
        if (folded.Count == 0 || folded.All(revision => revision.Lane == NendoRevisionLane.Checkpoint))
            return (null, "Every change old enough to fold belongs to a proposal that also has newer changes. Nothing would be folded.");
        var previous = await ReadLatestHistoryFoldAsync(transaction, ct);
        var newlyFolded = folded.Where(revision => revision.Lane != NendoRevisionLane.Checkpoint).ToList();
        var operations = 0L;
        await using (var command = Command("""
            SELECT COUNT(*) FROM __nendo_operation o JOIN __nendo_revision r ON r.revision_id = o.revision_id
            WHERE r.change_sequence > 0 AND r.change_sequence <= $last;
            """, transaction))
        {
            command.Parameters.AddWithValue("$last", folded[^1].ChangeSequence);
            operations = Convert.ToInt64(await command.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
        }
        return (new FoldPlan(folded, folded[^1], previous,
            newlyFolded.Count + (previous?.Revisions ?? 0), operations + (previous?.Operations ?? 0),
            previous?.FirstAt ?? newlyFolded[0].CreatedAt, newlyFolded[^1].CreatedAt, operationRows, all.Count - 1 - cut), null);
    }

    /// <summary>What folding the file's older history would do now (ADR-0021), for the person to read first.</summary>
    internal async Task<NendoHistoryFoldPreview> PreviewHistoryFoldAsync(HistoryFoldPolicy policy, CancellationToken ct)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        var (plan, reason) = await PlanHistoryFoldAsync(policy, transaction, ct);
        var rows = plan?.OperationRows ?? Convert.ToInt64(await ScalarAsync("SELECT COUNT(*) FROM __nendo_operation;", transaction, ct), CultureInfo.InvariantCulture);
        var previous = plan?.Previous ?? await ReadLatestHistoryFoldAsync(transaction, ct);
        transaction.Rollback();
        return new NendoHistoryFoldPreview(
            plan is not null, reason, plan?.Kept ?? 0,
            plan is null ? 0 : plan.Folded.Count(revision => revision.Lane != NendoRevisionLane.Checkpoint),
            plan is null ? 0 : plan.Operations - (plan.Previous?.Operations ?? 0),
            plan?.Last.ChangeSequence, plan?.FirstAt, plan?.LastAt,
            rows, WriteCeilingRows, previous?.FoldedAt);
    }

    /// <summary>
    /// Folds the file's older history into one checkpoint revision (ADR-0021), in one write
    /// transaction. The folded revisions go with their operations, attributions and idempotency
    /// rows; every record, tombstone, blob and later revision stays as it was, and the manifest's
    /// counters and change sequence do not move. The caller has made the backup it names.
    /// </summary>
    internal async Task<(NendoHistoryFoldResult Result, NendoAuthoritySnapshot Authority)> FoldHistoryAsync(
        NendoAuthoritySnapshot expectedAuthority, string backupLabel, HistoryFoldPolicy policy, DateTimeOffset now, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        ArgumentException.ThrowIfNullOrWhiteSpace(backupLabel);
        using var transaction = _connection.BeginTransaction(deferred: false);
        var committed = false;
        try
        {
            var currentAuthority = await ReadAuthoritySnapshotAsync(transaction, ct);
            if (currentAuthority != expectedAuthority)
                throw new NendoRecoveryRequiredException("The open Nendo state changed outside the write coordinator; recovery is required before folding its history.");
            await RequireSupportedWritableLayoutAsync(transaction, ct);
            var (plan, reason) = await PlanHistoryFoldAsync(policy, transaction, ct);
            if (plan is null) throw new NendoPreconditionException("history-fold-nothing", reason!);
            var description = string.Create(CultureInfo.InvariantCulture,
                $"Earlier history folded: {plan.Revisions:N0} changes ({plan.Operations:N0} operations) from {plan.FirstAt:yyyy-MM-dd} to {plan.LastAt:yyyy-MM-dd}. The full history is in the backup {backupLabel}.");
            var checkpointId = await WriteHistoryFoldAsync(plan, backupLabel, description, now, transaction, ct);
            await using (var manifest = Command("UPDATE __nendo_manifest SET minimum_host_version = $version;", transaction))
            {
                var before = await ReadManifestAsync(transaction, ct);
                manifest.Parameters.AddWithValue("$version", NendoFormat.RequireAtLeast(before.MinimumHostVersion, NendoFormat.HistoryFoldMinimumHostVersion));
                await manifest.ExecuteNonQueryAsync(ct);
            }
            var committedAuthority = await PrepareCommittedAuthorityAsync(transaction, ct);
            var remaining = Convert.ToInt64(await ScalarAsync("SELECT COUNT(*) FROM __nendo_operation;", transaction, ct), CultureInfo.InvariantCulture);
            ct.ThrowIfCancellationRequested();
            transaction.Commit();
            committed = true;
            _authorityCache = committedAuthority;
            _verifiedContentDigest = null;
            return (new NendoHistoryFoldResult(checkpointId, plan.Last.ChangeSequence, plan.Revisions, plan.Operations,
                plan.OperationRows, remaining, backupLabel, now), committedAuthority);
        }
        catch
        {
            if (!committed) transaction.Rollback();
            throw;
        }
    }

    /// <summary>
    /// Replaces the planned revisions with one checkpoint and records the fold, inside the
    /// caller's write transaction. The folded revisions go with their operations, attributions
    /// and idempotency rows. Returns the checkpoint's revision ID; the minimum host is the caller's.
    /// </summary>
    private async Task<string> WriteHistoryFoldAsync(
        FoldPlan plan, string backupLabel, string description, DateTimeOffset now, SqliteTransaction transaction, CancellationToken ct)
    {
        // The chain digest: what was folded, verifiable against the backup's history.
        var chain = new StringBuilder(plan.Previous?.ChainDigest ?? "");
        foreach (var revision in plan.Folded.Where(revision => revision.Lane != NendoRevisionLane.Checkpoint))
            chain.Append('\n').Append(revision.RevisionId).Append('|').Append(revision.ChangeSequence.ToString(CultureInfo.InvariantCulture)).Append('|').Append(revision.OperationDigest);
        var chainDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(chain.ToString()))).ToLowerInvariant();

        // The identity lineage the folded transitions leave, so the chain after the fold still starts somewhere.
        var (lineageApplication, lineageInstance) = (plan.Previous?.LineageApplicationId, plan.Previous?.LineageInstanceId);
        await using (var command = Command("""
            SELECT o.canonical_json FROM __nendo_operation o JOIN __nendo_revision r ON r.revision_id = o.revision_id
            WHERE o.operation_type = 'identity.transition' AND r.change_sequence > 0 AND r.change_sequence <= $last
            ORDER BY r.change_sequence, o.ordinal;
            """, transaction))
        {
            command.Parameters.AddWithValue("$last", plan.Last.ChangeSequence);
            await using var reader = await command.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct))
            {
                var transition = IdentityTransitionOperation.ParseCanonical(reader.GetString(0));
                (lineageApplication, lineageInstance) = (transition.ResultApplicationId, transition.ResultInstanceId);
            }
        }

        await EnsureHistoryFoldLayoutAsync(transaction, ct);
        await using (var delete = Command("DELETE FROM __nendo_revision WHERE change_sequence > 0 AND change_sequence <= $last;", transaction))
        {
            delete.Parameters.AddWithValue("$last", plan.Last.ChangeSequence);
            await delete.ExecuteNonQueryAsync(ct);
        }
        var checkpointId = $"revision-{Guid.NewGuid():N}";
        await using (var insert = Command("""
            INSERT INTO __nendo_revision(revision_id, created_at, origin, description, lane,
                definition_revision_before, definition_revision_after, data_revision_before, data_revision_after,
                change_sequence, operation_digest, idempotency_scope, idempotency_key, proposal_id, proposal_digest, compensation_of_revision_id)
            VALUES ($id, $at, 'kernel', $description, 'Checkpoint', 0, $definition, 0, $data, $sequence, $digest, NULL, NULL, NULL, NULL, NULL);
            """, transaction))
        {
            insert.Parameters.AddWithValue("$id", checkpointId);
            insert.Parameters.AddWithValue("$at", now.ToString("O", CultureInfo.InvariantCulture));
            insert.Parameters.AddWithValue("$description", description);
            insert.Parameters.AddWithValue("$definition", plan.Last.DefinitionAfter);
            insert.Parameters.AddWithValue("$data", plan.Last.DataAfter);
            insert.Parameters.AddWithValue("$sequence", plan.Last.ChangeSequence);
            insert.Parameters.AddWithValue("$digest", chainDigest);
            await insert.ExecuteNonQueryAsync(ct);
        }
        await using (var fold = Command("""
            INSERT INTO __nendo_history_fold(checkpoint_revision_id, folded_at, first_change_sequence, last_change_sequence,
                revisions, operations, chain_digest, lineage_application_id, lineage_instance_id, backup_label, first_at, last_at)
            VALUES ($id, $at, 1, $last, $revisions, $operations, $digest, $application, $instance, $backup, $first, $lastAt);
            """, transaction))
        {
            fold.Parameters.AddWithValue("$id", checkpointId);
            fold.Parameters.AddWithValue("$at", now.ToString("O", CultureInfo.InvariantCulture));
            fold.Parameters.AddWithValue("$last", plan.Last.ChangeSequence);
            fold.Parameters.AddWithValue("$revisions", plan.Revisions);
            fold.Parameters.AddWithValue("$operations", plan.Operations);
            fold.Parameters.AddWithValue("$digest", chainDigest);
            fold.Parameters.AddWithValue("$application", (object?)lineageApplication ?? DBNull.Value);
            fold.Parameters.AddWithValue("$instance", (object?)lineageInstance ?? DBNull.Value);
            fold.Parameters.AddWithValue("$backup", backupLabel);
            fold.Parameters.AddWithValue("$first", plan.FirstAt.ToString("O", CultureInfo.InvariantCulture));
            fold.Parameters.AddWithValue("$lastAt", plan.LastAt.ToString("O", CultureInfo.InvariantCulture));
            await fold.ExecuteNonQueryAsync(ct);
        }
        return checkpointId;
    }

    /// <summary>Gives the folded pages back to the file system. Outside any transaction, on the owning connection.</summary>
    internal async Task VacuumAsync(CancellationToken ct) => await NonQueryAsync("VACUUM;", null, ct);
}
