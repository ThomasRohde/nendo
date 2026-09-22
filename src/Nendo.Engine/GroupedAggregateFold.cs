using System.Globalization;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// One streamed fold of a grouped aggregate: a bucket per configured group, one
/// for the unset group, and a count of everything else. Shared by the SQLite read
/// and the safe-mode snapshot read so the two cannot disagree about which group a
/// stored value lands in. Memory is bounded by the number of groups, never by the
/// number of records.
/// </summary>
internal sealed class GroupedAggregateFold
{
    private sealed class Bucket(string aggregate, bool integral)
    {
        internal long Count;
        internal readonly ExactAggregate Fold = new(aggregate, integral);
    }

    private readonly IReadOnlyList<string> _keys;
    private readonly string _aggregate;
    private readonly Dictionary<string, Bucket> _buckets;
    private readonly Bucket _unset;
    private long _unrecognised;

    internal GroupedAggregateFold(IReadOnlyList<string> keys, string aggregate, bool integral)
    {
        _keys = keys;
        _aggregate = aggregate;
        _buckets = keys.ToDictionary(key => key, _ => new Bucket(aggregate, integral), StringComparer.Ordinal);
        _unset = new Bucket(aggregate, integral);
    }

    /// <summary>
    /// The ordered keys of a closed grouping: a single-choice field's options as
    /// configured, or false then true for a Boolean. Anything else cannot close the
    /// groups of a chart, and is refused by name.
    /// </summary>
    internal static IReadOnlyList<string> KeysOf(NendoStorageKind kind, string? presentation, IReadOnlyList<string> options)
    {
        IReadOnlyList<string> keys = kind == NendoStorageKind.Boolean
            ? ["false", "true"]
            : presentation == "singleChoice" && options.Count > 0
                ? options
                : throw new NendoValidationException("Only a single-choice or Boolean field can group an aggregate; its groups are closed, and no other kind closes them.");
        if (keys.Count + 1 > NendoSemanticVocabulary.MaximumAggregateGroups)
            throw new NendoValidationException($"A grouped aggregate answers at most {NendoSemanticVocabulary.MaximumAggregateGroups} groups.");
        return keys;
    }

    /// <summary>The group a stored column value belongs to, as the key text the result publishes.</summary>
    internal static string? KeyText(object? stored, NendoStorageKind kind) => stored switch
    {
        null or DBNull => null,
        long integer when kind == NendoStorageKind.Boolean => integer != 0 ? "true" : "false",
        string text => text,
        _ => Convert.ToString(stored, CultureInfo.InvariantCulture),
    };

    /// <summary>The same, read from a snapshot value rather than a column.</summary>
    internal static string? KeyText(JsonElement stored) => stored.ValueKind switch
    {
        JsonValueKind.Undefined or JsonValueKind.Null => null,
        JsonValueKind.True => "true",
        JsonValueKind.False => "false",
        JsonValueKind.String => stored.GetString(),
        _ => stored.GetRawText(),
    };

    internal void Add(string? key, decimal? value)
    {
        Bucket bucket;
        if (key is null) bucket = _unset;
        else if (!_buckets.TryGetValue(key, out bucket!)) { _unrecognised++; return; }
        bucket.Count++;
        if (value is { } contributing) bucket.Fold.Add(contributing);
    }

    internal NendoRecordGroupedAggregate Result(NendoRecordGroupedAggregateQuery query, long changeSequence)
    {
        var groups = _keys.Select(key => Group(key, _buckets[key])).Append(Group(null, _unset)).ToArray();
        return new(query.EntityId, query.GroupByFieldId, query.Aggregate, query.FieldId, groups, _unrecognised, changeSequence);
    }

    /// <summary>
    /// The same fold, answered over civil-date buckets. There is no unset group and no
    /// unrecognised count: the range is two predicates in the query, so a record with no
    /// date or a date outside it is never offered to the fold at all, and every key came
    /// from the bounds rather than from the data.
    /// </summary>
    internal NendoRecordDateBucketAggregate Result(
        NendoRecordDateBucketQuery query, DateBuckets buckets, long changeSequence)
    {
        var groups = _keys.Select(key => Group(key, _buckets[key])).ToArray();
        return new(query.EntityId, query.DateFieldId, query.Bucket, query.Range, query.Aggregate, query.FieldId,
            buckets.Start.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            buckets.End.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            groups, changeSequence);
    }

    private NendoRecordAggregateGroup Group(string? key, Bucket bucket) => _aggregate == "count"
        ? new(key, JsonSerializer.SerializeToElement(bucket.Count), bucket.Count)
        : new(key, bucket.Fold.Value(), bucket.Fold.ContributingRecords);
}
