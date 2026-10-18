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
    private readonly bool _integral;
    private readonly Dictionary<string, Bucket> _buckets;
    private readonly Bucket _unset;
    private long _unrecognised;

    /// <summary>
    /// An open grouping's groups are the values the data holds rather than a configured list, each
    /// labelled as the record it points at is (W-249); null for a closed grouping.
    /// </summary>
    private readonly Dictionary<string, string?>? _labels;

    internal GroupedAggregateFold(IReadOnlyList<string> keys, string aggregate, bool integral)
    {
        _keys = keys;
        _aggregate = aggregate;
        _integral = integral;
        _buckets = keys.ToDictionary(key => key, _ => new Bucket(aggregate, integral), StringComparer.Ordinal);
        _unset = new Bucket(aggregate, integral);
    }

    private GroupedAggregateFold(string aggregate, bool integral)
        : this([], aggregate, integral) => _labels = new(StringComparer.Ordinal);

    /// <summary>
    /// A fold over a reference's targets (W-249): a group per record the data points at, met as
    /// the rows arrive, bounded like a closed grouping and refused whole past the bound rather
    /// than answered in part.
    /// </summary>
    internal static GroupedAggregateFold Open(string aggregate, bool integral) => new(aggregate, integral);

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

    internal void Add(string? key, decimal? value, string? label = null)
    {
        Bucket bucket;
        if (key is null) bucket = _unset;
        else if (!_buckets.TryGetValue(key, out bucket!))
        {
            if (_labels is null) { _unrecognised++; return; }
            if (_buckets.Count + 1 >= NendoSemanticVocabulary.MaximumAggregateGroups)
                throw new NendoPreconditionException("aggregate-too-many-groups",
                    $"These records point at more than {NendoSemanticVocabulary.MaximumAggregateGroups - 1} different records, " +
                    "so no breakdown is shown rather than part of one. Narrow it with a filter.");
            _buckets[key] = bucket = new Bucket(_aggregate, _integral);
            _labels[key] = label;
        }
        bucket.Count++;
        if (value is { } contributing) bucket.Fold.Add(contributing);
    }

    internal NendoRecordGroupedAggregate Result(NendoRecordGroupedAggregateQuery query, long changeSequence)
    {
        // An open grouping's groups in the order a person reads them: by label, then by record.
        IEnumerable<string> keys = _labels is null
            ? _keys
            : _buckets.Keys.OrderBy(key => _labels[key] ?? string.Empty, StringComparer.CurrentCultureIgnoreCase).ThenBy(key => key, StringComparer.Ordinal);
        var groups = keys.Select(key => Group(key, _buckets[key]) with { Label = _labels?.GetValueOrDefault(key) })
            .Append(Group(null, _unset)).ToArray();
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
