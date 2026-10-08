using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// What a new file of this application keeps (ADR-0022): the last rung of the protected
    /// layout ladder, added by the first mark or label. A record type's default is the row whose
    /// record ID is empty; a record's own mark is the row naming it. No row means left out, so a
    /// file that never marked anything carries neither table and keeps its layout.
    /// <para>
    /// A deleted record keeps its mark: its ID stays reserved by the tombstone, so no other
    /// record can take the mark over, and restoring the record finds it where it was.
    /// </para>
    /// </summary>
    private const string NewFileSchemaSql = """
        CREATE TABLE __nendo_new_file_rule (
            entity_id TEXT NOT NULL,
            record_id TEXT NOT NULL,
            kept INTEGER NOT NULL CHECK (kept IN (0, 1)),
            PRIMARY KEY (entity_id, record_id),
            FOREIGN KEY (entity_id) REFERENCES __nendo_entity(entity_id)
        );
        CREATE TABLE __nendo_new_file_label (
            singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
            label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40)
        );
        """;

    /// <summary>Brings the protected layout up to the new-file rung: the whole ladder, then both tables.</summary>
    private async Task EnsureNewFileLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureHistoryFoldLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_new_file_rule", transaction, ct)) await NonQueryAsync(NewFileSchemaSql, transaction, ct);
    }

    private Task<bool> NewFileLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_new_file_rule", transaction, ct);

    /// <summary>The record types whose records a new file keeps unless a record says otherwise.</summary>
    private async Task<HashSet<string>> ReadKeptTypesAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var kept = new HashSet<string>(StringComparer.Ordinal);
        if (!await NewFileLayoutExistsAsync(transaction, ct)) return kept;
        await using var query = Command("SELECT entity_id FROM __nendo_new_file_rule WHERE record_id = '' AND kept = 1;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) kept.Add(rows.GetString(0));
        return kept;
    }

    /// <summary>Every record's own mark, or one record type's when <paramref name="entityId"/> is given.</summary>
    private async Task<Dictionary<(string Entity, string Record), bool>> ReadRecordMarksAsync(
        SqliteTransaction? transaction, CancellationToken ct, string? entityId = null)
    {
        var marks = new Dictionary<(string, string), bool>();
        if (!await NewFileLayoutExistsAsync(transaction, ct)) return marks;
        await using var query = Command(entityId is null
            ? "SELECT entity_id, record_id, kept FROM __nendo_new_file_rule WHERE record_id <> '';"
            : "SELECT entity_id, record_id, kept FROM __nendo_new_file_rule WHERE record_id <> '' AND entity_id = @entity;", transaction);
        if (entityId is not null) query.Parameters.AddWithValue("@entity", entityId);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) marks[(rows.GetString(0), rows.GetString(1))] = rows.GetInt64(2) == 1;
        return marks;
    }

    /// <summary>The application's name for one new file of it, or null when it gave none.</summary>
    private async Task<string?> ReadNewFileLabelAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_new_file_label", transaction, ct)) return null;
        await using var query = Command("SELECT label FROM __nendo_new_file_label WHERE singleton_id = 1;", transaction);
        return await query.ExecuteScalarAsync(ct) as string;
    }

    /// <summary>Puts each record's own mark on it; a record without one follows its type and carries none.</summary>
    private async Task<IReadOnlyList<NendoRecordSnapshot>> WithKeptMarksAsync(
        IReadOnlyList<NendoRecordSnapshot> records, SqliteTransaction? transaction, CancellationToken ct, string? entityId = null)
    {
        if (records.Count == 0) return records;
        var marks = await ReadRecordMarksAsync(transaction, ct, entityId);
        if (marks.Count == 0) return records;
        return records.Select(record => marks.TryGetValue((record.EntityId, record.RecordId), out var kept)
            ? record with { KeptInNewFiles = kept } : record).ToArray();
    }

    private async Task<OperationEvidence> ExecuteSetKeptInNewFilesDefaultAsync(
        SetKeptInNewFilesDefaultOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var previous = (await ReadKeptTypesAsync(transaction, ct)).Contains(entity.EntityId);
        if (previous == operation.Kept)
            throw new NendoPreconditionException("kept-in-new-files-unchanged",
                $"{entity.DisplayName} records are already {(previous ? "kept in" : "left out of")} new files.");
        // Keeping creates the rung; going back to the default never does, for the purpose's
        // reason: a file told what it already is must not gain a table or a newer host.
        if (operation.Kept)
        {
            await EnsureNewFileLayoutAsync(transaction, ct);
            await using var keep = Command(
                "INSERT INTO __nendo_new_file_rule(entity_id, record_id, kept) VALUES(@entity, '', 1);", transaction);
            keep.Parameters.AddWithValue("@entity", entity.EntityId);
            await keep.ExecuteNonQueryAsync(ct);
        }
        else
        {
            await using var leave = Command("DELETE FROM __nendo_new_file_rule WHERE entity_id = @entity AND record_id = '';", transaction);
            leave.Parameters.AddWithValue("@entity", entity.EntityId);
            await leave.ExecuteNonQueryAsync(ct);
        }
        return new OperationEvidence(operation, Evidence(new
        {
            previousKept = previous,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = operation.Kept ? NendoFormat.NewFileMinimumHostVersion : NendoFormat.MinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteSetRecordKeptInNewFilesAsync(
        SetRecordKeptInNewFilesOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        await using (var exists = Command(
            $"SELECT EXISTS(SELECT 1 FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @record);", transaction))
        {
            exists.Parameters.AddWithValue("@record", operation.RecordId);
            if (Convert.ToInt64(await exists.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) == 0)
                throw new NendoPreconditionException("record-not-found", $"Record {operation.RecordId} of {entity.DisplayName} does not exist.");
        }
        bool? previous = (await ReadRecordMarksAsync(transaction, ct, entity.EntityId))
            .TryGetValue((entity.EntityId, operation.RecordId), out var mark) ? mark : null;
        if (previous == operation.Kept)
            throw new NendoPreconditionException("kept-in-new-files-unchanged", operation.Kept is null
                ? $"Record {operation.RecordId} already follows {entity.DisplayName}'s default."
                : $"Record {operation.RecordId} is already {(operation.Kept.Value ? "kept in" : "left out of")} new files.");
        if (operation.Kept is { } kept)
        {
            await EnsureNewFileLayoutAsync(transaction, ct);
            await using var save = Command("""
                INSERT INTO __nendo_new_file_rule(entity_id, record_id, kept) VALUES(@entity, @record, @kept)
                ON CONFLICT(entity_id, record_id) DO UPDATE SET kept = excluded.kept;
                """, transaction);
            save.Parameters.AddWithValue("@entity", entity.EntityId);
            save.Parameters.AddWithValue("@record", operation.RecordId);
            save.Parameters.AddWithValue("@kept", kept ? 1 : 0);
            await save.ExecuteNonQueryAsync(ct);
        }
        else
        {
            await using var clear = Command("DELETE FROM __nendo_new_file_rule WHERE entity_id = @entity AND record_id = @record;", transaction);
            clear.Parameters.AddWithValue("@entity", entity.EntityId);
            clear.Parameters.AddWithValue("@record", operation.RecordId);
            await clear.ExecuteNonQueryAsync(ct);
        }
        return new OperationEvidence(operation, Evidence(new { previousKept = previous, appliedKept = operation.Kept }))
        {
            RequiredHostVersion = operation.Kept is null ? NendoFormat.MinimumHostVersion : NendoFormat.NewFileMinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteSetNewFileLabelAsync(
        SetNewFileLabelOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        if (operation.Label is not null) await EnsureNewFileLayoutAsync(transaction, ct);
        if (await TableExistsAsync("__nendo_new_file_label", transaction, ct))
        {
            await using var save = Command(operation.Label is null
                ? "DELETE FROM __nendo_new_file_label WHERE singleton_id = 1;"
                : """
                  INSERT INTO __nendo_new_file_label(singleton_id, label) VALUES(1, @label)
                  ON CONFLICT(singleton_id) DO UPDATE SET label = excluded.label;
                  """, transaction);
            if (operation.Label is not null) save.Parameters.AddWithValue("@label", operation.Label);
            await save.ExecuteNonQueryAsync(ct);
        }
        return new OperationEvidence(operation, Evidence(new
        {
            previousLabel = manifest.NewFileLabel,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = operation.Label is null ? NendoFormat.MinimumHostVersion : NendoFormat.NewFileMinimumHostVersion,
        };
    }

    private static SetKeptInNewFilesDefaultOperation CreateKeptDefaultInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            canonical.RootElement.GetProperty("payload").GetProperty("entityId").GetString()!,
            evidence.RootElement.GetProperty("previousKept").GetBoolean(),
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    private static SetNewFileLabelOperation CreateNewFileLabelInverse(string evidenceJson, string key)
    {
        using var evidence = JsonDocument.Parse(evidenceJson);
        var previous = evidence.RootElement.GetProperty("previousLabel");
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            previous.ValueKind == JsonValueKind.String ? previous.GetString() : null,
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    /// <summary>A stored label is one a file may carry.</summary>
    private static bool NewFileLabelIsValid(string? label) => label is null || NendoNewFile.IsLabel(label);

    /// <summary>What a new file of this application would keep and leave out, and what stops one.</summary>
    private sealed record NewFilePlan(
        IReadOnlyList<NendoNewFileTypeCount> Types,
        IReadOnlyList<NendoNewFileConflict> Conflicts,
        long ConflictCount,
        IReadOnlyDictionary<string, IReadOnlyList<string>> LeftOut,
        IReadOnlyDictionary<string, HashSet<string>> Kept);

    private async Task<NewFilePlan> PlanNewFileAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var mappings = await ReadEntityMappingsAsync(transaction, ct);
        var keptTypes = await ReadKeptTypesAsync(transaction, ct);
        var marks = await ReadRecordMarksAsync(transaction, ct);
        var kept = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var leftOut = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var types = new List<NendoNewFileTypeCount>();
        foreach (var entity in mappings)
        {
            var keep = new HashSet<string>(StringComparer.Ordinal);
            var leave = new List<string>();
            await using (var query = Command($"SELECT {Quote("__nendo_record_id")} FROM {Quote(entity.PhysicalTableName)};", transaction))
            await using (var rows = await query.ExecuteReaderAsync(ct))
                while (await rows.ReadAsync(ct))
                {
                    var recordId = rows.GetString(0);
                    if (marks.TryGetValue((entity.EntityId, recordId), out var mark) ? mark : keptTypes.Contains(entity.EntityId)) keep.Add(recordId);
                    else leave.Add(recordId);
                }
            kept[entity.EntityId] = keep;
            leftOut[entity.EntityId] = leave;
            types.Add(new(entity.EntityId, entity.DisplayName, keptTypes.Contains(entity.EntityId), keep.Count, leave.Count));
        }

        // A kept record may point only at kept records, through any reference, its hierarchy
        // parent included: a new file holding a reference to nothing is not consistent.
        var conflicts = new List<NendoNewFileConflict>();
        long conflictCount = 0;
        foreach (var entity in mappings)
        foreach (var field in entity.Fields.Where(field => field.StorageKind == NendoStorageKind.Reference && field.Reference is not null))
        {
            if (kept[entity.EntityId].Count == 0) continue;
            var target = field.Reference!.TargetEntityId;
            var targets = kept.GetValueOrDefault(target) ?? [];
            await using var query = Command(
                $"SELECT {Quote("__nendo_record_id")}, {Quote(field.PhysicalColumnName)} FROM {Quote(entity.PhysicalTableName)} " +
                $"WHERE {Quote(field.PhysicalColumnName)} IS NOT NULL ORDER BY {Quote("__nendo_record_id")};", transaction);
            await using var rows = await query.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct))
            {
                var recordId = rows.GetString(0);
                var targetId = Convert.ToString(rows.GetValue(1), CultureInfo.InvariantCulture)!;
                if (!kept[entity.EntityId].Contains(recordId) || targets.Contains(targetId)) continue;
                conflictCount++;
                if (conflicts.Count < NendoNewFilePreview.MaximumConflictsNamed)
                    conflicts.Add(new(entity.EntityId, recordId, field.FieldId, target, targetId));
            }
        }
        return new(types, conflicts, conflictCount, leftOut, kept);
    }

    /// <summary>What a new file of this application would hold now (ADR-0022), for the person to read first.</summary>
    internal async Task<NendoNewFilePreview> PreviewNewFileAsync(CancellationToken ct)
    {
        using var transaction = _connection.BeginTransaction(deferred: true);
        var plan = await PlanNewFileAsync(transaction, ct);
        var label = await ReadNewFileLabelAsync(transaction, ct);
        var revisions = Convert.ToInt64(await ScalarAsync(
            "SELECT COUNT(*) FROM __nendo_revision WHERE lane <> 'Genesis';", transaction, ct), CultureInfo.InvariantCulture);
        transaction.Rollback();
        return new(NendoNewFile.MenuLabel(label), label, plan.Types, plan.Conflicts, plan.ConflictCount, revisions);
    }

    internal static NendoNewFilePreview PreviewNewFile(NendoSessionSnapshot snapshot, IReadOnlyList<NendoRevisionSnapshot> history)
    {
        var entities = snapshot.Entities.ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
        var recordsByType = snapshot.Records.ToLookup(record => record.EntityId, StringComparer.Ordinal);
        var kept = snapshot.Records.Where(record => record.KeptInNewFiles ??
            entities[record.EntityId].KeptInNewFiles)
            .Select(record => (record.EntityId, record.RecordId)).ToHashSet();
        var types = snapshot.Entities.Select(entity => new NendoNewFileTypeCount(entity.EntityId, entity.DisplayName,
            entity.KeptInNewFiles, recordsByType[entity.EntityId].LongCount(record => kept.Contains((record.EntityId, record.RecordId))),
            recordsByType[entity.EntityId].LongCount(record => !kept.Contains((record.EntityId, record.RecordId))))).ToArray();
        var conflicts = (from entity in snapshot.Entities
            from field in entity.Fields.Where(field => field.StorageKind == NendoStorageKind.Reference && field.Reference is not null)
            from record in recordsByType[entity.EntityId].Where(record => kept.Contains((record.EntityId, record.RecordId))).OrderBy(record => record.RecordId, StringComparer.Ordinal)
            let targetId = record.Values.GetValueOrDefault(field.FieldId)
            where targetId.ValueKind == JsonValueKind.String && !kept.Contains((field.Reference!.TargetEntityId, targetId.GetString()!))
            select new NendoNewFileConflict(entity.EntityId, record.RecordId, field.FieldId, field.Reference!.TargetEntityId, targetId.GetString()!)).ToArray();
        return new(NendoNewFile.MenuLabel(snapshot.Manifest.NewFileLabel), snapshot.Manifest.NewFileLabel, types,
            conflicts.Take(NendoNewFilePreview.MaximumConflictsNamed).ToArray(), conflicts.LongLength,
            history.LongCount(revision => revision.Lane != NendoRevisionLane.Genesis));
    }

    /// <summary>The sentence a refusal gives for the references a new file cannot keep.</summary>
    private static string ConflictMessage(NewFilePlan plan)
    {
        var first = plan.Conflicts[0];
        return string.Create(CultureInfo.InvariantCulture,
            $"{plan.ConflictCount:N0} kept record{(plan.ConflictCount == 1 ? "" : "s")} point at records a new file leaves out, " +
            $"for example {first.EntityId} {first.RecordId} through {first.FieldId} at {first.TargetEntityId} {first.TargetRecordId}. " +
            $"Keep the record it points at, or leave the pointing record out, before making a new file. Nothing was changed.");
    }

    /// <summary>
    /// Turns a staged copy of the source into the start of a new file (ADR-0022), in one write
    /// transaction. Used only on a verified owned stage, never on the active source: removes the
    /// records left out, every tombstone, the marks of removed records, every view's state and
    /// package content no current file uses;
    /// restarts each sequence past what is kept; and folds every revision after Genesis into one
    /// checkpoint (ADR-0021), whose fold row names the source in place of a backup. Returns how
    /// many records were kept and left out, and how many changes were folded.
    /// </summary>
    internal async Task<(long Kept, long LeftOut, long Folded)> TransformIntoNewFileAsync(
        string sourceFileName, DateTimeOffset now, CancellationToken ct)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        RequireUnattachedStage();
        using var transaction = _connection.BeginTransaction(deferred: false);
        var committed = false;
        try
        {
            await RequireSupportedWritableLayoutAsync(transaction, ct);
            var plan = await PlanNewFileAsync(transaction, ct);
            if (plan.ConflictCount > 0) throw new NendoPreconditionException("new-file-reference-left-out", ConflictMessage(plan));

            var mappings = await ReadEntityMappingsAsync(transaction, ct);
            foreach (var entity in mappings)
            foreach (var chunk in plan.LeftOut[entity.EntityId].Chunk(400))
            {
                var names = chunk.Select((_, index) => $"@r{index}").ToArray();
                await using var delete = Command(
                    $"DELETE FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} IN ({string.Join(',', names)});", transaction);
                for (var index = 0; index < chunk.Length; index++) delete.Parameters.AddWithValue(names[index], chunk[index]);
                await delete.ExecuteNonQueryAsync(ct);
            }
            // ADR-0026: a kept link must still be allowed by the kept table, or the new file
            // would start breaking its own rule.
            foreach (var (linkId, rule) in await ReadLinkRulesAsync(transaction, ct))
                if (ResolveLinkRule(linkId, rule, mappings).Rule is { } resolved)
                    await RequireAllowedLinksAsync(resolved, LinkScope.All, transaction, ct, declaring: true);
            // A deleted record's ID is reserved so its deletion can be undone; a new file has no
            // deletions to undo, and starts with every ID free.
            if (await TableExistsAsync("__nendo_deleted_record", transaction, ct))
                await NonQueryAsync("DELETE FROM __nendo_deleted_record;", transaction, ct);
            foreach (var ((entityId, recordId), _) in await ReadRecordMarksAsync(transaction, ct))
            {
                if (plan.Kept.TryGetValue(entityId, out var keep) && keep.Contains(recordId)) continue;
                await using var clear = Command("DELETE FROM __nendo_new_file_rule WHERE entity_id = @entity AND record_id = @record;", transaction);
                clear.Parameters.AddWithValue("@entity", entityId);
                clear.Parameters.AddWithValue("@record", recordId);
                await clear.ExecuteNonQueryAsync(ct);
            }
            // The records left out were deleted outside any mutation, so the index is built again
            // from the records the new file keeps (ADR-0028).
            if (await SearchLayoutExistsAsync(transaction, ct)) await RebuildSearchIndexAsync(transaction, ct);
            // A view keeps what it wrote about this file's records; a new file has other records.
            if (await TableExistsAsync("__nendo_extension_state", transaction, ct))
                await NonQueryAsync("DELETE FROM __nendo_extension_state;", transaction, ct);
            // The one place a sequence goes down (amends ADR-0020): the numbers the work used are
            // gone with it, so a new file numbers from one past what it keeps.
            foreach (var (fieldId, _) in await ReadSequencesAsync(transaction, ct))
            {
                var entity = mappings.SingleOrDefault(candidate => candidate.Fields.Any(field => field.FieldId == fieldId));
                if (entity is null) continue;
                var field = entity.Fields.Single(candidate => candidate.FieldId == fieldId);
                await SetSequenceNextAsync(field, await NextFromDataAsync(entity, field, field.Sequence!, transaction, ct), transaction, ct);
            }

            long folded = 0;
            var (fold, _) = await PlanHistoryFoldAsync(HistoryFoldPolicy.KeepNone, transaction, ct);
            if (fold is not null)
            {
                folded = fold.Revisions;
                var description = string.Create(CultureInfo.InvariantCulture,
                    $"Started from {sourceFileName} at change {fold.Last.ChangeSequence:N0}: its {fold.Revisions:N0} earlier changes ({fold.Operations:N0} operations) " +
                    $"from {fold.FirstAt:yyyy-MM-dd} to {fold.LastAt:yyyy-MM-dd} are folded into this one. The full history stays in {sourceFileName}.");
                await WriteHistoryFoldAsync(fold, sourceFileName, description, now, transaction, ct);
            }
            // Earlier package versions were kept so their changes could be undone. With the history
            // folded nothing can undo them, so only the content a package file uses now is carried.
            if (await TableExistsAsync("__nendo_extension_blob", transaction, ct))
                await NonQueryAsync("DELETE FROM __nendo_extension_blob WHERE sha256 NOT IN (SELECT sha256 FROM __nendo_extension_file);", transaction, ct);
            await using (var manifest = Command("UPDATE __nendo_manifest SET minimum_host_version = $version;", transaction))
            {
                var before = await ReadManifestAsync(transaction, ct);
                manifest.Parameters.AddWithValue("$version", NendoFormat.RequireAtLeast(before.MinimumHostVersion, NendoFormat.NewFileMinimumHostVersion));
                await manifest.ExecuteNonQueryAsync(ct);
            }
            ct.ThrowIfCancellationRequested();
            transaction.Commit();
            committed = true;
            return (plan.Kept.Values.Sum(set => (long)set.Count), plan.LeftOut.Values.Sum(list => (long)list.Count), folded);
        }
        catch
        {
            if (!committed) transaction.Rollback();
            throw;
        }
    }

    /// <summary>The stage's manifest and content digest, from which its identity transition is built.</summary>
    internal async Task<(NendoManifestSnapshot Manifest, string ContentDigest)> ReadStageIdentityAsync(CancellationToken ct)
    {
        RequireUnattachedStage();
        using var transaction = _connection.BeginTransaction(deferred: true);
        var manifest = await ReadManifestAsync(transaction, ct);
        var digest = await ReadContentDigestAsync(ct, transaction);
        transaction.Rollback();
        return (manifest, digest);
    }
}
