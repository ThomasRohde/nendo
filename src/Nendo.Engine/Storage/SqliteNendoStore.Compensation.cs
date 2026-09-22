using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    internal async Task<NendoMutation> CreateCompensationMutationAsync(
        string revisionId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
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
            SELECT description, lane, compensation_of_revision_id
            FROM __nendo_revision
            WHERE revision_id = @revisionId;
            """;
        string description;
        string lane;
        await using (var revision = Command(revisionSql, null))
        {
            revision.Parameters.AddWithValue("@revisionId", revisionId);
            await using var reader = await revision.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new NendoPreconditionException(
                    "revision-not-found",
                    "The selected history revision does not exist.");
            }
            description = reader.GetString(0);
            lane = reader.GetString(1);
            if (!reader.IsDBNull(2))
            {
                throw new NendoCompensationNotSupportedException(
                    "A compensation revision cannot itself be compensated.");
            }
        }
        if (lane == NendoRevisionLane.Genesis.ToString())
        {
            throw new NendoCompensationNotSupportedException("The file-creation revision is irreversible.");
        }

        var exactReplay = false;
        await using (var existing = Command(
                         "SELECT idempotency_scope, idempotency_key FROM __nendo_revision WHERE compensation_of_revision_id = @revisionId;",
                         null))
        {
            existing.Parameters.AddWithValue("@revisionId", revisionId);
            await using var reader = await existing.ExecuteReaderAsync(cancellationToken);
            if (await reader.ReadAsync(cancellationToken))
            {
                exactReplay = !reader.IsDBNull(0) && !reader.IsDBNull(1) &&
                    reader.GetString(0) == "studio.p2.compensation" &&
                    reader.GetString(1) == idempotencyKey;
                if (!exactReplay)
                {
                    throw new NendoCompensationNotSupportedException(
                        "This revision already has a compensation revision.");
                }
            }
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
        if (operations.Count > 1)
        {
            // A causal revision is the initiating edit and everything its actions did,
            // together. Reversing only the part a person typed would leave the stored
            // fields an action maintained holding values nothing now explains.
            var inverses = CreateCausalInverses(operations, idempotencyKey);
            return new NendoMutation("studio.p2.compensation", idempotencyKey, "studio",
                $"Compensate {description}", inverses).Validate();
        }
        if (operations.Count != 1)
        {
            throw new NendoCompensationNotSupportedException(
                "Compensation requires one supported operation or a form edit of up to 64 fields on one record.");
        }
        var original = operations[0];
        if (original.Type == "ui.removeNode")
        {
            var restored = await CreateExtensionRemovalInverseAsync(revisionId, original.Evidence,
                idempotencyKey, exactReplay, cancellationToken);
            return new NendoMutation("studio.p2.compensation", idempotencyKey, "studio",
                $"Compensate {description}", restored).Validate();
        }
        if (original.Reversibility == NendoReversibilityClass.IrreversibleDeclared.ToString())
        {
            throw new NendoCompensationNotSupportedException(
                "The selected operation declares itself irreversible.");
        }

        NendoOperation inverse = original.Type switch
        {
            "data.deleteRecord" => CreateDeleteInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setChoiceMetadata" => CreateChoiceInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setRetired" => CreateRetirementInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.setFieldRequired" => CreateRequiredInverse(original.Canonical, original.Evidence, idempotencyKey),
            "data.backfillRetiredField" => CreateBackfillInverse(original.Canonical, original.Evidence, idempotencyKey),
            "schema.renameEntity" or "schema.renameField" => CreateRenameInverse(original.Canonical, original.Evidence, idempotencyKey),
            "data.setField" => CreateSetFieldInverse(original.Canonical, original.Evidence, idempotencyKey),
            "behaviour.setDefinition" or "behaviour.removeDefinition" =>
                CreateBehaviourDefinitionInverse(original.Canonical, original.Evidence, idempotencyKey),
            "ui.setProperty" => await CreateSetUiPropertyInverseAsync(
                original.Canonical,
                original.Evidence,
                idempotencyKey,
                exactReplay,
                cancellationToken),
            "application.setPurpose" => CreatePurposeInverse(original.Canonical, original.Evidence, idempotencyKey),
            _ => throw new NendoCompensationNotSupportedException(
                $"Compensation is not implemented for {original.Type}."),
        };
        return new NendoMutation(
            "studio.p2.compensation",
            idempotencyKey,
            "studio",
            $"Compensate {description}",
            [inverse]).Validate();
    }

    /// <summary>The most operations one compensation may reverse together.</summary>
    private const int MaximumCausalInverses = 128;

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
    /// Only local data writes are reversed here, which is exactly what an action may
    /// produce. Anything else in a multi-operation revision is refused by name: a
    /// retained backup does not make an irreversible operation reversible.
    /// </para>
    /// </summary>
    private static NendoOperation[] CreateCausalInverses(
        IReadOnlyList<(string Type, string Reversibility, string Canonical, string Evidence)> operations,
        string idempotencyKey)
    {
        if (operations.Count > MaximumCausalInverses)
        {
            throw new NendoCompensationNotSupportedException(
                $"This revision carries {operations.Count} operations, and a compensation reverses at most {MaximumCausalInverses} together.");
        }
        foreach (var operation in operations)
        {
            if (operation.Reversibility == NendoReversibilityClass.IrreversibleDeclared.ToString())
            {
                throw new NendoCompensationNotSupportedException(
                    $"{operation.Type} in this revision declares itself irreversible, so the revision cannot be reversed as a whole.");
            }
            if (operation.Type is not ("data.setField" or "data.backfillRetiredField" or "data.deleteRecord"))
            {
                throw new NendoCompensationNotSupportedException(
                    $"Compensating a revision of several operations covers record changes; this one also contains {operation.Type}.");
            }
        }

        // What each record was left at by the revision being reversed.
        var versions = new Dictionary<(string Entity, string Record), long>();
        foreach (var operation in operations)
        {
            using var canonical = JsonDocument.Parse(operation.Canonical);
            using var evidence = JsonDocument.Parse(operation.Evidence);
            var payload = canonical.RootElement.GetProperty("payload");
            var key = (payload.GetProperty("entityId").GetString()!, payload.GetProperty("recordId").GetString()!);
            versions[key] = operation.Type == "data.deleteRecord"
                ? evidence.RootElement.GetProperty("deletedVersion").GetInt64() + 1
                : evidence.RootElement.GetProperty("appliedVersion").GetInt64();
        }

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
            var operationId = NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, ordinal++);

            if (operation.Type == "data.deleteRecord")
            {
                var deletedVersion = evidence.RootElement.GetProperty("deletedVersion").GetInt64();
                inverses.Add(new RestoreDeletedRecordOperation(operationId, entityId, recordId, deletedVersion));
                versions[key] = checked(deletedVersion + 1);
                continue;
            }

            var version = versions[key];
            var fieldId = payload.GetProperty("fieldId").GetString()!;
            var previous = RetainedPreviousValue(evidence.RootElement, operation.Type, recordId);
            var targetVersion = evidence.RootElement.TryGetProperty("previousTargetRecordVersion", out var target) &&
                target.ValueKind == JsonValueKind.Number ? target.GetInt64() : (long?)null;
            // The inverse of a backfill is itself a backfill, so it too may touch a
            // retired field. A plain data.setField would refuse with "field-retired".
            inverses.Add(operation.Type == "data.backfillRetiredField"
                ? new BackfillRetiredFieldOperation(operationId, entityId, recordId, fieldId, version, previous, targetVersion)
                : new SetFieldOperation(operationId, entityId, recordId, fieldId, version, previous, targetVersion));
            versions[key] = checked(version + 1);
        }
        return inverses.ToArray();
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

    private static SetFieldOperation CreateSetFieldInverse(
        string canonicalJson,
        string evidenceJson,
        string idempotencyKey)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var appliedVersion = evidence.RootElement.GetProperty("appliedVersion").GetInt64();
        return new SetFieldOperation(
            NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0),
            payload.GetProperty("entityId").GetString()!,
            payload.GetProperty("recordId").GetString()!,
            payload.GetProperty("fieldId").GetString()!,
            appliedVersion,
            evidence.RootElement.GetProperty("previousValue"),
            evidence.RootElement.TryGetProperty("previousTargetRecordVersion", out var targetVersion) && targetVersion.ValueKind == JsonValueKind.Number
                ? targetVersion.GetInt64() : null);
    }

    private static BackfillRetiredFieldOperation CreateBackfillInverse(
        string canonicalJson,
        string evidenceJson,
        string idempotencyKey)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var appliedVersion = evidence.RootElement.GetProperty("appliedVersion").GetInt64();
        return new BackfillRetiredFieldOperation(
            NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0),
            payload.GetProperty("entityId").GetString()!,
            payload.GetProperty("recordId").GetString()!,
            payload.GetProperty("fieldId").GetString()!,
            appliedVersion,
            evidence.RootElement.GetProperty("previousValue"),
            evidence.RootElement.TryGetProperty("previousTargetRecordVersion", out var targetVersion) && targetVersion.ValueKind == JsonValueKind.Number
                ? targetVersion.GetInt64() : null);
    }

    private static RestoreDeletedRecordOperation CreateDeleteInverse(string canonicalJson, string evidenceJson, string idempotencyKey)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        return new(NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0),
            payload.GetProperty("entityId").GetString()!, payload.GetProperty("recordId").GetString()!,
            evidence.RootElement.GetProperty("deletedVersion").GetInt64());
    }

    private async Task<SetUiPropertyOperation> CreateSetUiPropertyInverseAsync(
        string canonicalJson,
        string evidenceJson,
        string idempotencyKey,
        bool exactReplay,
        CancellationToken cancellationToken)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        if (!evidence.RootElement.GetProperty("previousValuePresent").GetBoolean())
        {
            throw new NendoCompensationNotSupportedException(
                "A UI property with no retained prior value cannot be compensated.");
        }
        var surfaceId = payload.GetProperty("surfaceId").GetString()!;
        var nodeId = payload.GetProperty("nodeId").GetString()!;
        var propertyName = payload.GetProperty("propertyName").GetString()!;
        if (!exactReplay)
        {
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
        var previousJson = evidence.RootElement.GetProperty("previousValueJson").GetString()
            ?? throw new NendoCompensationNotSupportedException(
                "The retained UI property state is unavailable.");
        using var previousValue = JsonDocument.Parse(previousJson);
        return new SetUiPropertyOperation(
            NendoCanonical.DeterministicId("operation", "studio.p2.compensation", idempotencyKey, 0),
            surfaceId,
            nodeId,
            propertyName,
            previousValue.RootElement);
    }
}
