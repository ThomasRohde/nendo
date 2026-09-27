using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>Each sequence field's prefix, width and next number, from the rule table.</summary>
    private async Task<Dictionary<string, (NendoFieldSequence Sequence, long Next)>> ReadSequencesAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var sequences = new Dictionary<string, (NendoFieldSequence, long)>(StringComparer.Ordinal);
        if (!await TableExistsAsync("__nendo_field_rule", transaction, ct)) return sequences;
        await using var query = Command(
            "SELECT field_id,sequence_prefix,sequence_width,sequence_next FROM __nendo_field_rule WHERE sequence_prefix IS NOT NULL;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
            sequences[rows.GetString(0)] = (new(rows.GetString(1), rows.GetInt32(2)), rows.GetInt64(3));
        return sequences;
    }

    /// <summary>Reads each field's sequence back onto its mapping, on both read paths.</summary>
    private async Task PopulateFieldSequencesAsync(List<FieldMapping> fields, SqliteTransaction? transaction, CancellationToken ct)
    {
        var sequences = await ReadSequencesAsync(transaction, ct);
        if (sequences.Count == 0) return;
        for (var index = 0; index < fields.Count; index++)
            if (sequences.TryGetValue(fields[index].FieldId, out var sequence))
                fields[index] = fields[index] with { Sequence = sequence.Sequence };
    }

    /// <summary>The number in a value of the sequence's shape — the prefix, ignoring ASCII case, then only digits — or null.</summary>
    private static long? SequenceNumber(NendoFieldSequence sequence, string? value)
    {
        if (value is null || value.Length <= sequence.Prefix.Length || value.Length > sequence.Prefix.Length + 18 ||
            !value.StartsWith(sequence.Prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var digits = value.AsSpan(sequence.Prefix.Length);
        foreach (var character in digits) if (!char.IsAsciiDigit(character)) return null;
        return long.Parse(digits, NumberStyles.None, CultureInfo.InvariantCulture);
    }

    private static string SequenceValue(NendoFieldSequence sequence, long number) =>
        sequence.Prefix + number.ToString(CultureInfo.InvariantCulture).PadLeft(sequence.Width, '0');

    /// <summary>One past the largest number any stored value of this shape carries, or 1.</summary>
    private async Task<long> NextFromDataAsync(EntityMapping entity, FieldMapping field, NendoFieldSequence sequence, SqliteTransaction transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct) ||
            !await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) return 1;
        var column = Quote(field.PhysicalColumnName);
        long highest = 0;
        await using var query = Command(
            $"SELECT {column} FROM {Quote(entity.PhysicalTableName)} WHERE substr({column}, 1, @length) = @prefix COLLATE NOCASE;", transaction);
        query.Parameters.AddWithValue("@length", sequence.Prefix.Length);
        query.Parameters.AddWithValue("@prefix", sequence.Prefix);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
            if (SequenceNumber(sequence, rows.GetString(0)) is { } number && number > highest) highest = number;
        return highest + 1;
    }

    private async Task<OperationEvidence> ExecuteSetFieldSequenceAsync(SetFieldSequenceOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var field = entity.Fields.SingleOrDefault(candidate => candidate.FieldId == operation.FieldId)
            ?? throw new NendoPreconditionException("field-not-found", $"Field {operation.FieldId} does not belong to {entity.DisplayName}.");
        RequireActive(entity, field);
        var previous = (await ReadSequencesAsync(transaction, ct)).TryGetValue(field.FieldId, out var found) ? found : ((NendoFieldSequence, long)?)null;

        long? next = null;
        if (operation.Prefix is { } prefix)
        {
            if (!field.Unique || field.StorageKind != NendoStorageKind.Text)
                throw new NendoPreconditionException("field-sequence-invalid",
                    $"{field.DisplayName} must be a unique single-line Text field to carry a sequence. Declare it unique first.");
            var sequence = new NendoFieldSequence(prefix, operation.Width!.Value);
            if (previous?.Item1 == sequence)
                throw new NendoPreconditionException("field-sequence-unchanged", $"{field.DisplayName} already has this sequence.");
            next = Math.Max(await NextFromDataAsync(entity, field, sequence, transaction, ct), operation.MinimumNext ?? 1);
            // The same prefix keeps its high-water mark, so a number handed out and then deleted stays spent.
            if (previous is { } kept && string.Equals(kept.Item1.Prefix, prefix, StringComparison.OrdinalIgnoreCase))
                next = Math.Max(next.Value, kept.Item2);
        }
        else if (previous is null)
            throw new NendoPreconditionException("field-sequence-unchanged", $"{field.DisplayName} has no sequence to remove.");

        await using (var update = Command(
            "UPDATE __nendo_field_rule SET sequence_prefix=@prefix, sequence_width=@width, sequence_next=@next WHERE field_id=@field;", transaction))
        {
            update.Parameters.AddWithValue("@prefix", (object?)operation.Prefix ?? DBNull.Value);
            update.Parameters.AddWithValue("@width", (object?)operation.Width ?? DBNull.Value);
            update.Parameters.AddWithValue("@next", (object?)next ?? DBNull.Value);
            update.Parameters.AddWithValue("@field", field.FieldId);
            await update.ExecuteNonQueryAsync(ct);
        }
        return new OperationEvidence(operation, Evidence(new
        {
            previousPrefix = previous?.Item1.Prefix,
            previousWidth = previous?.Item1.Width,
            previousNext = previous?.Item2,
            appliedNext = next,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = NendoFormat.FieldRuleMinimumHostVersion,
        };
    }

    /// <summary>The inverse puts the previous sequence back, and never below the number the undone one reached.</summary>
    private static SetFieldSequenceOperation CreateSetFieldSequenceInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var payload = canonical.RootElement.GetProperty("payload");
        var prior = evidence.RootElement;
        var prefix = prior.GetProperty("previousPrefix");
        long? floor = prior.GetProperty("previousNext").ValueKind == JsonValueKind.Number ? prior.GetProperty("previousNext").GetInt64() : null;
        if (prior.GetProperty("appliedNext").ValueKind == JsonValueKind.Number)
            floor = Math.Max(floor ?? 1, prior.GetProperty("appliedNext").GetInt64());
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            payload.GetProperty("entityId").GetString()!, payload.GetProperty("fieldId").GetString()!,
            prefix.ValueKind == JsonValueKind.String ? prefix.GetString() : null,
            prior.GetProperty("previousWidth").ValueKind == JsonValueKind.Number ? prior.GetProperty("previousWidth").GetInt32() : null,
            prior.GetProperty("appliedDefinitionRevision").GetInt64(),
            prefix.ValueKind == JsonValueKind.String ? floor : null);
    }

    /// <summary>
    /// Fills each empty sequence field of a new record with the next code, inside this write's
    /// transaction, and advances the counter. Returns the create as history should record it —
    /// with the codes in it, so a replay or a restore writes the same ones — and what was assigned.
    /// </summary>
    private async Task<(CreateRecordOperation Operation, IReadOnlyList<NendoAssignedValue> Assigned)> AssignSequencesAsync(
        EntityMapping entity, CreateRecordOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var sequenced = entity.Fields.Where(field => field.Sequence is not null && !field.Retired).ToArray();
        if (sequenced.Length == 0) return (operation, []);
        var assigned = new List<NendoAssignedValue>();
        var values = operation.Values.ToDictionary(pair => pair.Key, pair => (object?)pair.Value, StringComparer.Ordinal);
        var counters = await ReadSequencesAsync(transaction, ct);
        foreach (var field in sequenced)
        {
            if (operation.Values.TryGetValue(field.FieldId, out var supplied) &&
                !(supplied.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) &&
                !(supplied.ValueKind == JsonValueKind.String && supplied.GetString()!.Length == 0)) continue;
            var next = counters[field.FieldId].Next;
            var code = SequenceValue(field.Sequence!, next);
            await SetSequenceNextAsync(field, next + 1, transaction, ct);
            values[field.FieldId] = code;
            assigned.Add(new(entity.EntityId, operation.RecordId, field.FieldId, code));
        }
        return assigned.Count == 0 ? (operation, assigned)
            : (new CreateRecordOperation(operation.OperationId, operation.EntityId, operation.RecordId, values, operation.ExpectedTargetVersions), assigned);
    }

    /// <summary>
    /// A code of the sequence's shape written by a client — an import carrying its own, a
    /// correction — raises the counter past it, so the host never hands out the same number.
    /// </summary>
    private async Task RaiseSequenceAsync(FieldMapping field, JsonElement value, SqliteTransaction transaction, CancellationToken ct)
    {
        if (field.Sequence is null || value.ValueKind != JsonValueKind.String) return;
        if (SequenceNumber(field.Sequence, value.GetString()) is not { } number) return;
        var current = (await ReadSequencesAsync(transaction, ct))[field.FieldId].Next;
        if (number >= current) await SetSequenceNextAsync(field, number + 1, transaction, ct);
    }

    private async Task SetSequenceNextAsync(FieldMapping field, long next, SqliteTransaction transaction, CancellationToken ct)
    {
        await using var update = Command("UPDATE __nendo_field_rule SET sequence_next=@next WHERE field_id=@field;", transaction);
        update.Parameters.AddWithValue("@next", next);
        update.Parameters.AddWithValue("@field", field.FieldId);
        await update.ExecuteNonQueryAsync(ct);
    }

    /// <summary>What a mutation's creates had assigned, read back from their evidence.</summary>
    private static IReadOnlyList<NendoAssignedValue> AssignedValues(IEnumerable<OperationEvidence> evidence)
    {
        var assigned = new List<NendoAssignedValue>();
        foreach (var item in evidence.Where(item => item.Operation is CreateRecordOperation))
        {
            using var document = JsonDocument.Parse(item.EvidenceJson);
            if (!document.RootElement.TryGetProperty("assigned", out var list)) continue;
            foreach (var entry in list.EnumerateArray())
                assigned.Add(new(entry.GetProperty("entityId").GetString()!, entry.GetProperty("recordId").GetString()!,
                    entry.GetProperty("fieldId").GetString()!, entry.GetProperty("value").GetString()!));
        }
        // The shared empty list when nothing was numbered: the result is a record, and a receipt
        // read back for an exact retry must compare equal to the write it describes.
        return assigned.Count == 0 ? Array.Empty<NendoAssignedValue>() : assigned;
    }
}
