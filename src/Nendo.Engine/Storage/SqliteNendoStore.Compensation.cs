using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

/// <summary>
/// Who asks for a compensation other than History: a custom view undoing or redoing a batch it
/// wrote (ADR-0023). Its scope keys the exact retry, its origin is the compensation's and must be
/// the revision's, and its label names the compensation in History.
/// </summary>
internal sealed record NendoCompensationCaller(string IdempotencyScope, string Origin, bool Redo, string? Label);

internal sealed partial class SqliteNendoStore
{
    /// <summary>The record operations a revision of record changes is made of (ADR-0023).</summary>
    private static bool IsRecordOperation(string type) => type is
        "data.setField" or "data.backfillRetiredField" or "data.deleteRecord" or "data.createRecord" or "data.restoreDeletedRecord";

    /// <summary>
    /// A record change a revision of record writes may carry: a record operation, or a record's
    /// keep mark (ADR-0022), which a batch can set beside the create and which moves no version.
    /// </summary>
    private static bool IsRecordChange(string type) => IsRecordOperation(type) || type == "data.setKeptInNewFiles";

    private static bool? KeptMark(JsonElement element) =>
        element.ValueKind is JsonValueKind.True or JsonValueKind.False ? element.GetBoolean() : null;

    /// <summary>
    /// Refuses to undo a keep mark that has changed since the revision set it: putting the
    /// previous mark back would overwrite the later one without a word.
    /// </summary>
    private async Task RequireMarksAsLeftAsync(
        IReadOnlyList<(string Type, string Reversibility, string Canonical, string Evidence)> operations,
        CancellationToken cancellationToken)
    {
        var left = new Dictionary<(string Entity, string Record), bool?>();
        foreach (var operation in operations.Where(operation => operation.Type == "data.setKeptInNewFiles"))
        {
            using var canonical = JsonDocument.Parse(operation.Canonical);
            using var evidence = JsonDocument.Parse(operation.Evidence);
            var payload = canonical.RootElement.GetProperty("payload");
            left[(payload.GetProperty("entityId").GetString()!, payload.GetProperty("recordId").GetString()!)] =
                KeptMark(evidence.RootElement.GetProperty("appliedKept"));
        }
        if (left.Count == 0) return;
        var marks = await ReadRecordMarksAsync(null, cancellationToken);
        foreach (var (key, applied) in left)
        {
            bool? current = marks.TryGetValue(key, out var mark) ? mark : null;
            if (current != applied)
                throw new NendoCompensationNotSupportedException(
                    $"Whether record {key.Record} is kept in new files changed after the selected revision, so it is not undone.");
        }
    }

    internal async Task<NendoMutation> CreateCompensationMutationAsync(
        string revisionId,
        string idempotencyKey,
        CancellationToken cancellationToken,
        NendoCompensationCaller? caller = null)
    {
        var scope = caller?.IdempotencyScope ?? "studio.p2.compensation";
        var origin = caller?.Origin ?? "studio";
        if (!await ColumnExistsAsync(
                "__nendo_revision",
                "compensation_of_revision_id",
                null,
                cancellationToken))
        {
            throw new NendoCompensationNotSupportedException(
                "This pre-semantic file has no compensatable revision metadata.");
        }
        const string revisionSql = """
            SELECT description, lane, compensation_of_revision_id, origin, change_sequence, definition_revision_after
            FROM __nendo_revision
            WHERE revision_id = @revisionId;
            """;
        string description;
        string lane;
        bool isCompensation;
        string revisionOrigin;
        long changeSequence;
        long definitionAfter;
        // A change the person folded away (ADR-0021) is gone from the file, and is said to be.
        var fold = await ReadLatestHistoryFoldAsync(null, cancellationToken);
        await using (var revision = Command(revisionSql, null))
        {
            revision.Parameters.AddWithValue("@revisionId", revisionId);
            await using var reader = await revision.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new NendoPreconditionException(
                    "revision-not-found",
                    fold is null
                        ? "The selected history revision does not exist."
                        // The checkpoint's own date, as its text gives it: UTC and the Gregorian
                        // year whatever the regional format (R2LAT-08).
                        : string.Create(CultureInfo.InvariantCulture,
                            $"The selected history revision is not in this file. Its older history was folded on {fold.FoldedAt.ToUniversalTime():yyyy-MM-dd}; a folded change cannot be undone here. The full history is in the backup {fold.BackupLabel}."));
            }
            description = reader.GetString(0);
            lane = reader.GetString(1);
            isCompensation = !reader.IsDBNull(2);
            revisionOrigin = reader.GetString(3);
            changeSequence = reader.GetInt64(4);
            definitionAfter = reader.GetInt64(5);
        }
        // A view reverses only what its own package wrote, and redoes only an undo (ADR-0023).
        if (caller is not null && revisionOrigin != caller.Origin)
        {
            throw new NendoPreconditionException("revision-not-yours",
                "This revision was written by someone else, so it can be undone only from History.");
        }
        if (caller is { Redo: true } && !isCompensation)
        {
            throw new NendoPreconditionException("not-an-undo", "Only an undo can be redone.");
        }
        if (lane == NendoRevisionLane.Genesis.ToString())
        {
            throw new NendoCompensationNotSupportedException("The file-creation revision is irreversible.");
        }
        if (lane == NendoRevisionLane.Checkpoint.ToString())
        {
            throw new NendoCompensationNotSupportedException("Folded history cannot be undone: the checkpoint stands for changes this file no longer holds.");
        }

        var exactReplay = false;
        long? compensatedAt = null;
        string? replayedName = null;
        string? replayedRevision = null;
        await using (var existing = Command(
                         "SELECT idempotency_scope, idempotency_key, change_sequence, description, revision_id FROM __nendo_revision WHERE compensation_of_revision_id = @revisionId;",
                         null))
        {
            existing.Parameters.AddWithValue("@revisionId", revisionId);
            await using var reader = await existing.ExecuteReaderAsync(cancellationToken);
            if (await reader.ReadAsync(cancellationToken))
            {
                exactReplay = !reader.IsDBNull(0) && !reader.IsDBNull(1) &&
                    reader.GetString(0) == scope &&
                    reader.GetString(1) == idempotencyKey;
                if (!exactReplay)
                {
                    throw new NendoCompensationNotSupportedException(
                        "This revision already has a compensation revision.");
                }
                compensatedAt = reader.GetInt64(2);
                // An exact retry is rebuilt byte for byte, its name included, whatever this host
                // would call it now: a compensation an earlier host named "Compensate X" is
                // still replayed rather than refused as an idempotency conflict.
                replayedName = reader.GetString(3);
                replayedRevision = reader.GetString(4);
            }
        }
        if (replayedRevision is not null)
        {
            // A retry of an undo that has itself been undone since would answer with a state the
            // file no longer has; it is refused instead, so the caller reads the records again (R2RM-03).
            await using var undone = Command("SELECT EXISTS(SELECT 1 FROM __nendo_revision WHERE compensation_of_revision_id = @revisionId);", null);
            undone.Parameters.AddWithValue("@revisionId", replayedRevision);
            if (Convert.ToInt64(await undone.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture) != 0)
                throw new NendoCompensationNotSupportedException(
                    "This undo has itself been undone since, so it is not repeated. Read the records again before the next step.");
        }

        const string operationSql = """
            SELECT operation_type, reversibility, canonical_json, inverse_evidence_json
            FROM __nendo_operation
            WHERE revision_id = @revisionId
            ORDER BY ordinal;
            """;
        var operations = new List<(string Type, string Reversibility, string Canonical, string Evidence)>();
        await using (var operation = Command(operationSql, null))
        {
            operation.Parameters.AddWithValue("@revisionId", revisionId);
            await using var reader = await operation.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                operations.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3)));
            }
        }
        // An embedded picture has no inverse to run: its content stays stored, unreferenced, until
        // the person removes unused media, and what a field showed comes back with that field's
        // own undo (ADR-0031 point 4). A change that only embedded one leaves nothing to undo.
        var held = operations.Count;
        operations.RemoveAll(operation => operation.Type == "media.put");
        if (held > 0 && operations.Count == 0)
            throw new NendoCompensationNotSupportedException(
                "This change only embedded a picture, which stays in the file until unused media is removed. There is nothing else to undo.");
        var recordChanges = operations.Count >= 1 && operations.All(operation => IsRecordChange(operation.Type));
        // A compensation of record changes can itself be compensated: that is redo, and undo
        // again after it (ADR-0023). Anything else a compensation reversed stays where it is.
        if (isCompensation && !recordChanges)
        {
            throw new NendoCompensationNotSupportedException(
                "A compensation revision cannot itself be compensated.");
        }
        if (caller is not null && !recordChanges)
        {
            throw new NendoCompensationNotSupportedException(
                "Only record changes can be undone this way, and this revision changes more than records.");
        }
        if (recordChanges)
        {
            // A causal revision is the initiating edit and everything its actions did,
            // together. Reversing only the part a person typed would leave the stored
            // fields an action maintained holding values nothing now explains.
            // Read as the file stood when an exact retry's compensation was first made, so the
            // retry rebuilds it byte for byte.
            var carried = await TakenBackLaterVersionsAsync(changeSequence, compensatedAt, cancellationToken);
            if (!exactReplay) await RequireMarksAsLeftAsync(operations, cancellationToken);
            var named = replayedName ?? caller?.Label ?? CompensationName(description, isCompensation);
            return new NendoMutation(scope, idempotencyKey, origin, named,
                CreateCausalInverses(operations, idempotencyKey, scope, carried,
                    await FieldsOfAsync(cancellationToken))).Validate();
        }
        if (operations.Count >= 1 && operations.All(operation => IsExtensionOperation(operation.Type)))
        {
            // A package usually arrives with its files in one change, so a revision of
            // package operations is reversed as a whole, files before the package.
            return new NendoMutation("studio.p2.compensation", idempotencyKey, "studio",
                replayedName ?? CompensationName(description, isCompensation), CreateExtensionInverses(operations, idempotencyKey)).Validate();
        }
        if (operations.Count > 1)
        {
            // Record changes were reversed above, as a whole; this names what else the revision holds.
            var inverses = CreateCausalInverses(operations, idempotencyKey, "studio.p2.compensation",
                new Dictionary<(string Entity, string Record), long>(), await FieldsOfAsync(cancellationToken));
            return new NendoMutation("studio.p2.compensation", idempotencyKey, "studio",
                replayedName ?? CompensationName(description, isCompensation), inverses).Validate();
        }
        if (operations.Count != 1)
        {
            throw new NendoCompensationNotSupportedException(
                "Compensation requires one supported operation or a form edit of up to 64 fields on one record.");
        }
        var original = operations[0];
        // Every definition inverse but a package's expects the definition as the revision left
        // it, so only the latest definition change is undone. Refused here in words a person can
        // act on, not by the inverse's agent-facing "Use expectedDefinitionRevision" (R2RM-02).
        if (!exactReplay && lane == NendoRevisionLane.Definition.ToString() && !IsExtensionOperation(original.Type))
            await RequireDefinitionAsLeftAsync(definitionAfter, cancellationToken);
        if (original.Type == "ui.removeNode")
        {
            var restored = await CreateExtensionRemovalInverseAsync(revisionId, original.Evidence,
                idempotencyKey, exactReplay, cancellationToken);
            return new NendoMutation("studio.p2.compensation", idempotencyKey, "studio",
                replayedName ?? CompensationName(description, isCompensation), restored).Validate();
        }
        if (original.Reversibility == NendoReversibilityClass.IrreversibleDeclared.ToString())
        {
            throw new NendoCompensationNotSupportedException(
                "The selected operation declares itself irreversible.");
        }

        NendoOperation inverse = original.Type switch
        {
            "schema.setChoiceMetadata" => CreateChoiceInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setRetired" => CreateRetirementInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setFieldRequired" => CreateRequiredInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.renameEntity" or "schema.renameField" => CreateRenameInverse(original.Canonical, original.Evidence, idempotencyKey),
            "behaviour.setDefinition" or "behaviour.removeDefinition" =>
                CreateBehaviourDefinitionInverse(original.Canonical, original.Evidence, idempotencyKey),
            "ui.setProperty" => await CreateSetUiPropertyInverseAsync(
                original.Canonical,
                original.Evidence,
                idempotencyKey,
                exactReplay,
                definitionAfter,
                cancellationToken),
            "ui.removeProperty" => await CreateRemoveUiPropertyInverseAsync(original.Canonical, original.Evidence, idempotencyKey, exactReplay,
                definitionAfter, cancellationToken),
            "ui.addNode" => await CreateAddUiNodeInverseAsync(original.Canonical, idempotencyKey, exactReplay, definitionAfter, cancellationToken),
            "ui.moveNode" => await CreateMoveUiNodeInverseAsync(original.Canonical, original.Evidence, idempotencyKey, exactReplay,
                definitionAfter, cancellationToken),
            "application.setPurpose" => CreatePurposeInverse(original.Canonical, original.Evidence, idempotencyKey),
            "application.setLook" => CreateLookInverse(original.Evidence, idempotencyKey),
            "application.setNewFileLabel" => CreateNewFileLabelInverse(original.Evidence, idempotencyKey),
            "schema.setKeptInNewFiles" => CreateKeptDefaultInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.declareHierarchy" => CreateDeclareHierarchyInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.declareLinkRule" => CreateDeclareLinkRuleInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.removeLinkRule" => CreateRemoveLinkRuleInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setFieldUnique" => CreateSetFieldUniqueInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setFieldPresentation" => CreateSetFieldPresentationInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setFieldSequence" => CreateSetFieldSequenceInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.removeHierarchy" => CreateRemoveHierarchyInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setReferenceLabel" => CreateSetReferenceLabelInverse(original.Canonical, original.Evidence, idempotencyKey),
            _ => throw new NendoCompensationNotSupportedException(
                $"Compensation is not implemented for {original.Type}."),
        };
        return new NendoMutation(
            "studio.p2.compensation",
            idempotencyKey,
            "studio",
            replayedName ?? CompensationName(description, isCompensation),
            [inverse]).Validate();
    }

    /// <summary>
    /// What a compensation is called when its caller gives no label, for History, a view and an
    /// agent alike: the undo of a change is "Undo X", the undo of an undo is "Redo X", and the
    /// undo of a redo is "Undo X" again, matching History's Undo button. History named every link
    /// "Compensate ...", so a redo read "Compensate Compensate X", and an agent's redo was named
    /// "Undo X", the same as the undo it reversed (R2RM-08).
    /// </summary>
    internal static string CompensationName(string description, bool isCompensation)
    {
        if (!isCompensation) return "Undo " + description;
        if (description.StartsWith("Undo ", StringComparison.Ordinal)) return "Redo " + description[5..];
        if (description.StartsWith("Redo ", StringComparison.Ordinal)) return "Undo " + description[5..];
        // An earlier host named a compensation "Compensate X"; a labelled one keeps its label.
        return description.StartsWith("Compensate ", StringComparison.Ordinal) ? "Redo " + description[11..] : "Redo " + description;
    }

    /// <summary>
    /// The most operations one compensation may reverse together: everything one batch of record
    /// writes can make, 200 writes of up to 64 fields (ADR-0023).
    /// </summary>
    internal const int MaximumCausalInverses = 12_800;

    /// <summary>
    /// Reverses a whole causal revision: the initiating operations and everything the
    /// actions they triggered wrote, in the opposite order.
    /// <para>
    /// Versions come from the revision's own evidence, never from the file as it is
    /// now. Each record's first inverse expects the version that record was left at,
    /// and each later one expects what the previous inverse leaves behind. A record
    /// something else has moved since therefore conflicts loudly rather than being
    /// overwritten — and an exact retry rebuilds the same compensation byte for byte,
    /// which is what makes a lost response safe to repeat.
    /// </para>
    /// <para>
    /// Only record changes are reversed here, which is exactly what an action or a batch of
    /// record writes may produce. A create is answered by deleting the record at the version
    /// the revision left it, and a restore the same way (ADR-0023): the record ID stays
    /// reserved in deletion history, which is why both still declare themselves irreversible.
    /// Anything else in a multi-operation revision is refused by name: a retained backup does
    /// not make an irreversible operation reversible.
    /// </para>
    /// </summary>
    private static NendoOperation[] CreateCausalInverses(
        IReadOnlyList<(string Type, string Reversibility, string Canonical, string Evidence)> operations,
        string idempotencyKey,
        string scope,
        IReadOnlyDictionary<(string Entity, string Record), long> carried,
        Func<string, string, FieldMapping?> fieldOf)
    {
        string? referenceTargetOf(string entity, string field) => fieldOf(entity, field)?.Reference?.TargetEntityId;
        if (operations.Count > MaximumCausalInverses)
        {
            throw new NendoCompensationNotSupportedException(
                $"This revision carries {operations.Count} operations, and a compensation reverses at most {MaximumCausalInverses} together.");
        }
        foreach (var operation in operations)
        {
            if (operation.Reversibility == NendoReversibilityClass.IrreversibleDeclared.ToString() &&
                operation.Type is not ("data.createRecord" or "data.restoreDeletedRecord"))
            {
                throw new NendoCompensationNotSupportedException(
                    $"{operation.Type} in this revision declares itself irreversible, so the revision cannot be reversed as a whole.");
            }
            if (!IsRecordChange(operation.Type))
            {
                throw new NendoCompensationNotSupportedException(
                    $"Compensating a revision of several operations covers record changes; this one also contains {operation.Type}.");
            }
        }
        // A keep mark moves no version, so it has no place in the version arithmetic below.
        var versioned = operations.Where(operation => IsRecordOperation(operation.Type)).ToArray();

        // What each record was left at by the revision being reversed. A record ID is unique
        // only within its record type, so every record here is keyed by both, and a
        // reference's target by the type the reference points at. Keyed by ID alone, a task
        // '1' moved off project '1' was taken for that project, and a clean undo was refused
        // as a conflict (EBH-12).
        var versions = new Dictionary<(string Entity, string Record), long>();
        var deleted = new HashSet<(string Entity, string Record)>();
        foreach (var operation in versioned)
        {
            using var canonical = JsonDocument.Parse(operation.Canonical);
            using var evidence = JsonDocument.Parse(operation.Evidence);
            var payload = canonical.RootElement.GetProperty("payload");
            var key = (payload.GetProperty("entityId").GetString()!, payload.GetProperty("recordId").GetString()!);
            if (operation.Type == "data.deleteRecord") deleted.Add(key);
            versions[key] = operation.Type switch
            {
                "data.deleteRecord" => evidence.RootElement.GetProperty("deletedVersion").GetInt64() + 1,
                "data.createRecord" => evidence.RootElement.GetProperty("createdVersion").GetInt64(),
                "data.restoreDeletedRecord" => evidence.RootElement.GetProperty("restoredVersion").GetInt64(),
                _ => evidence.RootElement.GetProperty("appliedVersion").GetInt64(),
            };
        }
        // A record whose every later change has been taken back is as this revision left it, at the
        // version the taking back left (ADR-0023). A deleted record is not: only its own restore
        // could have touched it since.
        foreach (var key in versions.Keys.ToArray())
            if (!deleted.Contains(key) && carried.TryGetValue(key, out var version))
                versions[key] = version;

        var inverses = new List<NendoOperation>(operations.Count);
        var ordinal = 0;
        foreach (var operation in operations.Reverse())
        {
            using var canonical = JsonDocument.Parse(operation.Canonical);
            using var evidence = JsonDocument.Parse(operation.Evidence);
            var payload = canonical.RootElement.GetProperty("payload");
            var entityId = payload.GetProperty("entityId").GetString()!;
            var recordId = payload.GetProperty("recordId").GetString()!;
            var key = (entityId, recordId);
            var operationId = NendoCanonical.DeterministicId("operation", scope, idempotencyKey, ordinal++);

            if (operation.Type == "data.setKeptInNewFiles")
            {
                // Its previous mark goes back; RequireMarksAsLeftAsync has refused a mark changed since.
                inverses.Add(new SetRecordKeptInNewFilesOperation(operationId, entityId, recordId,
                    KeptMark(evidence.RootElement.GetProperty("previousKept"))));
                continue;
            }

            if (operation.Type is "data.createRecord" or "data.restoreDeletedRecord")
            {
                // Its record is deleted at the version the later inverses have left it; a record
                // pointed at since, or changed, refuses the delete and with it the whole revision.
                inverses.Add(new DeleteRecordOperation(operationId, entityId, recordId, versions[key]));
                continue;
            }

            if (operation.Type == "data.deleteRecord")
            {
                var deletedVersion = evidence.RootElement.GetProperty("deletedVersion").GetInt64();
                // A target the revision also wrote -- a parent whose count the deletion's automatic
                // action updated, or one a batch edited after the delete -- is at the version the
                // planned inverses leave it when the restore runs, as for a reference put back
                // below. Recorded at the delete, it refused every such undo (ESS-02).
                var planned = new SortedDictionary<string, long>(StringComparer.Ordinal);
                if (evidence.RootElement.TryGetProperty("targetVersions", out var recordedTargets) &&
                    evidence.RootElement.TryGetProperty("values", out var held))
                {
                    foreach (var recorded in recordedTargets.EnumerateObject())
                    {
                        if (!held.TryGetProperty(recorded.Name, out var pointedAt) || pointedAt.ValueKind != JsonValueKind.String ||
                            referenceTargetOf(entityId, recorded.Name) is not { } pointedEntity) continue;
                        var pointedKey = (pointedEntity, pointedAt.GetString()!);
                        long? plannedAt = versions.TryGetValue(pointedKey, out var leftThere) ? leftThere
                            : carried.TryGetValue(pointedKey, out var carriedThere) ? carriedThere : null;
                        // Only where it differs, so a restore the recorded version already serves
                        // keeps the shape, and the digest, an earlier host gave it.
                        if (plannedAt is { } differs && differs != recorded.Value.GetInt64()) planned[recorded.Name] = differs;
                    }
                }
                inverses.Add(new RestoreDeletedRecordOperation(operationId, entityId, recordId, deletedVersion)
                    { PlannedTargetVersions = planned.Count == 0 ? null : planned });
                versions[key] = checked(deletedVersion + 1);
                continue;
            }

            var version = versions[key];
            var fieldId = payload.GetProperty("fieldId").GetString()!;
            var previous = RetainedPreviousValue(evidence.RootElement, operation.Type, recordId);
            var targetVersion = evidence.RootElement.TryGetProperty("previousTargetRecordVersion", out var target) &&
                target.ValueKind == JsonValueKind.Number ? target.GetInt64() : (long?)null;
            // A reference put back expects its target at the version the target holds when
            // this inverse runs. The recorded version is right for a target the revision
            // never touched. A target the revision also wrote -- a parent whose count the
            // move's automatic action updated -- is at the version the planned inverses
            // leave it, so its own reversal is not mistaken for someone else's edit. An
            // outside edit since still moves it past that version and still conflicts.
            var targetKey = previous.ValueKind == JsonValueKind.String && referenceTargetOf(entityId, fieldId) is { } targetEntity
                ? (targetEntity, previous.GetString()!)
                : ((string, string)?)null;
            if (targetVersion is not null && targetKey is { } touchedTarget && versions.TryGetValue(touchedTarget, out var leftAt))
            {
                targetVersion = leftAt;
            }
            else if (targetVersion is not null && targetKey is { } carriedKey && carried.TryGetValue(carriedKey, out var carriedTarget))
            {
                targetVersion = carriedTarget;
            }
            // The inverse of a backfill on a field still retired is itself a backfill, so it too may
            // touch the retired field; a plain data.setField would refuse with "field-retired". Once
            // the field is active again -- the Reactivate form fills it and reactivates it in one
            // proposal -- putting the value back is an ordinary edit, and a backfill refused it as
            // field-not-retired. A required field cannot take its empty value back, and says so
            // rather than failing on the null (R2RM-04).
            var backfilled = operation.Type == "data.backfillRetiredField" ? fieldOf(entityId, fieldId) : null;
            if (backfilled is { Retired: false, Required: true } && previous.ValueKind == JsonValueKind.Null)
                throw new NendoCompensationNotSupportedException(
                    $"{backfilled.DisplayName} is required now, so the values filled in to make it active again stay. " +
                    $"Make {backfilled.DisplayName} optional, then undo this again.");
            inverses.Add(operation.Type == "data.backfillRetiredField" && backfilled is not { Retired: false }
                ? new BackfillRetiredFieldOperation(operationId, entityId, recordId, fieldId, version, previous, targetVersion)
                : new SetFieldOperation(operationId, entityId, recordId, fieldId, version, previous, targetVersion));
            versions[key] = checked(version + 1);
        }
        return inverses.ToArray();
    }

    /// <summary>
    /// For each record changed after <paramref name="afterSequence"/> (and before
    /// <paramref name="beforeSequence"/>, for an exact retry) whose every change since has been
    /// taken back, the version it is left at: so an undo of a gesture still finds its record after
    /// a later gesture on it was undone (ADR-0023).
    /// <para>
    /// Compensations form chains -- a change, its undo, the redo, the undo again -- and each link
    /// puts back exactly what the one before it changed, version-checked. A chain of even length
    /// therefore leaves its records as they were before it. A record is carried only when every
    /// chain that touched it is even and the last change left it in the file. Anything else, an
    /// edit by somebody else among them, leaves the record at a version the reversed revision's
    /// evidence does not hold, and its inverse refuses as before.
    /// </para>
    /// </summary>
    /// <summary>Each field as the file declares it now, by (record type, field): what it points at, and whether it is retired or required.</summary>
    private async Task<Func<string, string, FieldMapping?>> FieldsOfAsync(CancellationToken cancellationToken)
    {
        var fields = new Dictionary<(string Entity, string Field), FieldMapping>();
        foreach (var entity in await ReadEntityMappingsAsync(null, cancellationToken))
            foreach (var field in entity.Fields)
                fields[(entity.EntityId, field.FieldId)] = field;
        return (entityId, fieldId) => fields.TryGetValue((entityId, fieldId), out var field) ? field : null;
    }

    private async Task<IReadOnlyDictionary<(string Entity, string Record), long>> TakenBackLaterVersionsAsync(
        long afterSequence,
        long? beforeSequence,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT r.revision_id, r.compensation_of_revision_id, o.operation_type, o.canonical_json, o.inverse_evidence_json
            FROM __nendo_revision r
            JOIN __nendo_operation o ON o.revision_id = r.revision_id
            WHERE r.change_sequence > @after AND (@before IS NULL OR r.change_sequence < @before)
              AND r.lane = 'Data'
            ORDER BY r.change_sequence, o.ordinal;
            """;
        var touched = new Dictionary<(string Entity, string Record), List<string>>();
        var left = new Dictionary<(string Entity, string Record), long?>();
        var compensationOf = new Dictionary<string, string?>(StringComparer.Ordinal);
        await using (var command = Command(sql, null))
        {
            command.Parameters.AddWithValue("@after", afterSequence);
            command.Parameters.AddWithValue("@before", beforeSequence is { } before ? before : DBNull.Value);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var revision = reader.GetString(0);
                compensationOf[revision] = reader.IsDBNull(1) ? null : reader.GetString(1);
                var type = reader.GetString(2);
                if (!IsRecordOperation(type)) continue;
                using var canonical = JsonDocument.Parse(reader.GetString(3));
                using var evidence = JsonDocument.Parse(reader.GetString(4));
                var payload = canonical.RootElement.GetProperty("payload");
                var record = (payload.GetProperty("entityId").GetString()!, payload.GetProperty("recordId").GetString()!);
                if (!touched.TryGetValue(record, out var revisions)) touched[record] = revisions = [];
                if (revisions.Count == 0 || revisions[^1] != revision) revisions.Add(revision);
                left[record] = type switch
                {
                    "data.deleteRecord" => null,
                    "data.createRecord" => evidence.RootElement.GetProperty("createdVersion").GetInt64(),
                    "data.restoreDeletedRecord" => evidence.RootElement.GetProperty("restoredVersion").GetInt64(),
                    _ => evidence.RootElement.GetProperty("appliedVersion").GetInt64(),
                };
            }
        }
        var carried = new Dictionary<(string Entity, string Record), long>();
        foreach (var (record, revisions) in touched)
        {
            if (left[record] is not { } version) continue;
            var members = revisions.ToHashSet(StringComparer.Ordinal);
            var compensatedBy = revisions
                .Where(revision => compensationOf[revision] is { } of && members.Contains(of))
                .ToDictionary(revision => compensationOf[revision]!, revision => revision, StringComparer.Ordinal);
            var even = true;
            foreach (var head in revisions.Where(revision => compensationOf[revision] is not { } of || !members.Contains(of)))
            {
                var length = 1;
                for (var link = head; compensatedBy.TryGetValue(link, out var next); link = next) length++;
                even &= length % 2 == 0;
            }
            if (even) carried[record] = version;
        }
        return carried;
    }

    /// <summary>
    /// The value a field held before the operation being reversed.
    /// <para>
    /// An operation whose evidence did not retain one cannot be reversed by guessing.
    /// The refusal names the record, because "unsupported" tells a person nothing
    /// about which part of their history is unreachable.
    /// </para>
    /// </summary>
    private static JsonElement RetainedPreviousValue(JsonElement evidence, string operationType, string recordId) =>
        evidence.TryGetProperty("previousValue", out var value)
            ? value
            : throw new NendoCompensationNotSupportedException(
                $"The {operationType} on record {recordId} retained no prior value, so it cannot be reversed.");

    /// <summary>
    /// A definition change is reversed only while the definition still stands as that revision
    /// left it. A screen operation carries no expected revision of its own, so the revision's is
    /// compared here: going back over later edits could bring back a field a later revision
    /// retired, and every custom screen with it (ESM-04). Every other definition inverse expects
    /// the revision it left, and refused a later one with agent-facing text (R2RM-02).
    /// </summary>
    private async Task RequireDefinitionAsLeftAsync(long definitionAfter, CancellationToken cancellationToken)
    {
        var current = (await ReadManifestAsync(null, cancellationToken)).DefinitionRevision;
        if (current != definitionAfter)
            throw new NendoCompensationNotSupportedException(
                "Only the latest change to the file's structure can be undone, and the structure has changed since this one " +
                $"(it is at revision {current}; this change left it at {definitionAfter}). Make the change you want in a new proposal instead.");
    }

    /// <summary>A node added on its own goes again, while nothing in the definition has changed since (ESM-12).</summary>
    private async Task<RemoveUiNodeOperation> CreateAddUiNodeInverseAsync(string canonicalJson, string idempotencyKey, bool exactReplay,
        long definitionAfter, CancellationToken cancellationToken)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        var payload = canonical.RootElement.GetProperty("payload");
        if (!exactReplay) await RequireDefinitionAsLeftAsync(definitionAfter, cancellationToken);
        return new RemoveUiNodeOperation(NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0),
            payload.GetProperty("surfaceId").GetString()!, payload.GetProperty("nodeId").GetString()!);
    }

    /// <summary>A move goes back to the parent and position its evidence retained (ESM-12).</summary>
    private async Task<MoveUiNodeOperation> CreateMoveUiNodeInverseAsync(string canonicalJson, string evidenceJson, string idempotencyKey,
        bool exactReplay, long definitionAfter, CancellationToken cancellationToken)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        if (!evidence.RootElement.TryGetProperty("previousPosition", out var position) || !position.TryGetInt32(out var previousPosition))
            throw new NendoCompensationNotSupportedException("The move retained no prior place, so it cannot be reversed.");
        if (!exactReplay) await RequireDefinitionAsLeftAsync(definitionAfter, cancellationToken);
        var parent = evidence.RootElement.TryGetProperty("previousParentNodeId", out var previous) && previous.ValueKind == JsonValueKind.String
            ? previous.GetString()
            : null;
        return new MoveUiNodeOperation(NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0),
            payload.GetProperty("surfaceId").GetString()!, payload.GetProperty("nodeId").GetString()!, parent, previousPosition);
    }

    private async Task<NendoOperation> CreateSetUiPropertyInverseAsync(
        string canonicalJson,
        string evidenceJson,
        string idempotencyKey,
        bool exactReplay,
        long definitionAfter,
        CancellationToken cancellationToken)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var surfaceId = payload.GetProperty("surfaceId").GetString()!;
        var nodeId = payload.GetProperty("nodeId").GetString()!;
        var propertyName = payload.GetProperty("propertyName").GetString()!;
        if (!exactReplay)
        {
            await RequireDefinitionAsLeftAsync(definitionAfter, cancellationToken);
            const string currentSql = """
            SELECT property.value_json
            FROM __nendo_ui_property property
            JOIN __nendo_ui_node node ON node.node_id = property.node_id
            WHERE node.surface_id = @surfaceId AND node.node_id = @nodeId
              AND property.property_name = @propertyName;
            """;
            string? currentJson;
            await using (var current = Command(currentSql, null))
            {
                current.Parameters.AddWithValue("@surfaceId", surfaceId);
                current.Parameters.AddWithValue("@nodeId", nodeId);
                current.Parameters.AddWithValue("@propertyName", propertyName);
                // A missing row must read back as null, not "": Convert.ToString would
                // hide a removed property behind an empty string and send it to
                // JsonDocument.Parse instead of the "no longer exists" refusal below.
                var scalar = await current.ExecuteScalarAsync(cancellationToken);
                currentJson = scalar is null or DBNull
                    ? null
                    : Convert.ToString(scalar, CultureInfo.InvariantCulture);
            }
            if (currentJson is null)
            {
                throw new NendoCompensationNotSupportedException(
                    "The UI property no longer exists at the selected revision's state.");
            }
            using var currentValue = JsonDocument.Parse(currentJson);
            if (!JsonElement.DeepEquals(currentValue.RootElement, payload.GetProperty("value")))
            {
                throw new NendoCompensationNotSupportedException(
                    "The UI property changed after the selected revision and cannot be compensated safely.");
            }
        }
        var operationId = NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0);
        // The first value a property ever took is undone by clearing it again (ESM-11).
        if (!evidence.RootElement.GetProperty("previousValuePresent").GetBoolean())
            return new RemoveUiPropertyOperation(operationId, surfaceId, nodeId, propertyName);
        var previousJson = evidence.RootElement.GetProperty("previousValueJson").GetString()
            ?? throw new NendoCompensationNotSupportedException(
                "The retained UI property state is unavailable.");
        using var previousValue = JsonDocument.Parse(previousJson);
        return new SetUiPropertyOperation(operationId, surfaceId, nodeId, propertyName, previousValue.RootElement);
    }

    private async Task<SetUiPropertyOperation> CreateRemoveUiPropertyInverseAsync(
        string canonicalJson,
        string evidenceJson,
        string idempotencyKey,
        bool exactReplay,
        long definitionAfter,
        CancellationToken cancellationToken)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var surfaceId = payload.GetProperty("surfaceId").GetString()!;
        var nodeId = payload.GetProperty("nodeId").GetString()!;
        var propertyName = payload.GetProperty("propertyName").GetString()!;
        if (!exactReplay)
        {
            await RequireDefinitionAsLeftAsync(definitionAfter, cancellationToken);
            await using var current = Command("""
                SELECT EXISTS(SELECT 1 FROM __nendo_ui_property property
                    JOIN __nendo_ui_node node ON node.node_id = property.node_id
                    WHERE node.surface_id = @surfaceId AND node.node_id = @nodeId AND property.property_name = @propertyName);
                """, null);
            current.Parameters.AddWithValue("@surfaceId", surfaceId);
            current.Parameters.AddWithValue("@nodeId", nodeId);
            current.Parameters.AddWithValue("@propertyName", propertyName);
            if (Convert.ToInt64(await current.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture) != 0)
                throw new NendoCompensationNotSupportedException(
                    "The UI property was given again after the selected revision and cannot be compensated safely.");
        }
        var previousJson = evidence.RootElement.GetProperty("previousValueJson").GetString()
            ?? throw new NendoCompensationNotSupportedException("The retained UI property state is unavailable.");
        using var previousValue = JsonDocument.Parse(previousJson);
        return new SetUiPropertyOperation(NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0),
            surfaceId, nodeId, propertyName, previousValue.RootElement);
    }
}
