using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

/// <summary>
/// Filtering and sorting on a calculated field (F-222). A calculated field has no column, so
/// the records a query could return are read once, bounded, with their calculations; the
/// ones that pass the calculated filters, and their order under a calculated sort, then enter
/// the ordinary SQL as two functions of the record ID. The page, its continuation, the count
/// and every aggregate read keep their own SQL, so they cannot disagree about the set.
/// </summary>
internal sealed partial class SqliteNendoStore
{
    /// <summary>The calculated part of one query: which records it keeps, and each one's place in its order.</summary>
    private sealed record CalculatedSelection(string? KeepPredicate, string? RankFunction);

    /// <summary>The calculated fields one record type shows, by field ID.</summary>
    private async Task<IReadOnlyDictionary<string, NendoDerivedFieldSnapshot>> DerivedFieldsOfAsync(
        string entityId, SqliteTransaction transaction, CancellationToken ct) =>
        ((await ReadDerivedFieldsAsync(transaction, ct)).GetValueOrDefault(entityId) ?? [])
            .ToDictionary(field => field.FieldId, StringComparer.Ordinal);

    /// <summary>A calculated field's result type as the storage kind a stored field of that type has.</summary>
    internal static NendoStorageKind KindOf(NendoBehaviourScalar type) => type switch
    {
        NendoBehaviourScalar.Integer => NendoStorageKind.Integer,
        NendoBehaviourScalar.Decimal => NendoStorageKind.Decimal,
        NendoBehaviourScalar.Boolean => NendoStorageKind.Boolean,
        NendoBehaviourScalar.Date => NendoStorageKind.Date,
        _ => NendoStorageKind.Text,
    };

    private static List<NendoRecordFilter> StoredFilters(IReadOnlyList<NendoRecordFilter> filters, IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived) =>
        filters.Where(filter => !derived.ContainsKey(filter.FieldId)).ToList();

    /// <summary>
    /// Reads every record the stored filters leave, with its calculations, and registers
    /// <c>{prefix}_keep</c> and <c>{prefix}_rank</c> for the query that follows. Refused past
    /// <see cref="NendoQueryLimits.MaximumCalculatedQueryRecords"/> rather than read slowly.
    /// Returns null when the query names no calculated field, so an ordinary query is unchanged.
    /// </summary>
    private async Task<CalculatedSelection?> SelectByCalculationAsync(
        EntityMapping entity, IReadOnlyList<EntityMapping> mappings, IReadOnlyDictionary<string, NendoDerivedFieldSnapshot> derived,
        IReadOnlyList<NendoRecordFilter> filters, string? sortFieldId, bool descending, string prefix,
        SqliteTransaction transaction, CancellationToken ct)
    {
        var calculatedFilters = filters.Where(filter => derived.ContainsKey(filter.FieldId)).ToArray();
        var sort = sortFieldId is not null && derived.TryGetValue(sortFieldId, out var sorted) ? sorted : null;
        if (calculatedFilters.Length == 0 && sort is null) return null;

        var predicates = new List<string>();
        var parameters = new Dictionary<string, object>();
        await AddFilterPredicatesAsync(entity, StoredFilters(filters, derived), $"{prefix}_stored", predicates, parameters, transaction, ct);
        var where = predicates.Count == 0 ? string.Empty : $" WHERE {string.Join(" AND ", predicates)}";

        await using (var probe = Command(
            $"SELECT COUNT(*) FROM (SELECT 1 FROM {Quote(entity.PhysicalTableName)} source_record{where} LIMIT @limit);", transaction))
        {
            foreach (var parameter in parameters) probe.Parameters.AddWithValue(parameter.Key, parameter.Value);
            probe.Parameters.AddWithValue("@limit", NendoQueryLimits.MaximumCalculatedQueryRecords + 1);
            if (Convert.ToInt64(await probe.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture) > NendoQueryLimits.MaximumCalculatedQueryRecords)
                throw new NendoPreconditionException("calculated-query-too-wide",
                    $"A filter or sort on a calculated field works out every record it could match, and more than " +
                    $"{NendoQueryLimits.MaximumCalculatedQueryRecords} {entity.DisplayName} records could. Narrow it with a filter on a stored field.");
        }

        var (columns, references) = RecordColumns(entity, mappings);
        var records = new List<NendoRecordSnapshot>();
        await using (var read = Command($"SELECT {string.Join(", ", columns)} FROM {Quote(entity.PhysicalTableName)} source_record{where};", transaction))
        {
            foreach (var parameter in parameters) read.Parameters.AddWithValue(parameter.Key, parameter.Value);
            await using var reader = await read.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) records.Add(ReadRecordRow(reader, entity, references));
        }
        var calculated = await WithCalculationsAsync(records, mappings, transaction, ct);

        var expected = calculatedFilters.Select(filter => filter.Operator is "isNull" or "isNotNull" ? null
            : Convert.ToString(ConvertValue(Calculated(entity, derived[filter.FieldId]), filter.Value), CultureInfo.InvariantCulture)).ToArray();
        var kept = calculated.Where(record => calculatedFilters.Select((filter, index) => (filter, index)).All(pair =>
        {
            var (known, text) = ValueOf(record, pair.filter.FieldId);
            // A value that could not be worked out matches nothing, not even "is empty":
            // it is not empty, it is unknown.
            return known && RecordQuerySemantics.Matches(pair.filter.Operator, KindOf(derived[pair.filter.FieldId].ResultType), text, expected[pair.index]);
        })).ToArray();

        string? keepPredicate = null;
        if (calculatedFilters.Length > 0)
        {
            var keep = kept.Select(record => record.RecordId).ToHashSet(StringComparer.Ordinal);
            _connection.CreateFunction<string, bool>($"{prefix}_keep", id => keep.Contains(id), isDeterministic: true);
            keepPredicate = $"{prefix}_keep(source_record.{Quote("__nendo_record_id")})";
        }
        string? rankFunction = null;
        if (sort is not null)
        {
            // Empty first as a stored column's null sorts, in either direction's own sense; a
            // value that could not be worked out last in both. Ties fall to the record ID, so
            // the order is total and a page continues exactly where the last one ended.
            var kind = KindOf(sort.ResultType);
            var ordered = kept.Select(record => (record.RecordId, Value: ValueOf(record, sort.FieldId)))
                .OrderBy(entry => entry.Value.Known ? 0 : 1)
                .ThenBy(entry => entry.Value.Text, Comparer<string?>.Create((left, right) =>
                    (descending ? -1 : 1) * RecordQuerySemantics.Compare(kind, left, right)))
                .ThenBy(entry => entry.RecordId, StringComparer.Ordinal)
                .Select((entry, index) => (entry.RecordId, index))
                .ToDictionary(entry => entry.RecordId, entry => (long)entry.index, StringComparer.Ordinal);
            _connection.CreateFunction<string?, long>($"{prefix}_rank",
                id => id is not null && ordered.TryGetValue(id, out var rank) ? rank : long.MaxValue, isDeterministic: true);
            rankFunction = $"{prefix}_rank";
        }
        return new(keepPredicate, rankFunction);
    }

    /// <summary>A calculated value as the text a stored column of its type casts to, or unknown when it has none to give.</summary>
    private static (bool Known, string? Text) ValueOf(NendoRecordSnapshot record, string fieldId)
    {
        var result = record.Calculations.FirstOrDefault(calculation => calculation.FieldId == fieldId);
        return result?.State switch
        {
            NendoCalculationState.Value => (true, RecordQuerySemantics.Text(result.Value)),
            NendoCalculationState.Empty => (true, null),
            _ => (false, null),
        };
    }

    /// <summary>A calculated field as the mapping a filter value is converted against.</summary>
    private static FieldMapping Calculated(EntityMapping entity, NendoDerivedFieldSnapshot field) =>
        new(field.FieldId, entity.EntityId, field.DisplayName, string.Empty, KindOf(field.ResultType), false, null, []);
}
