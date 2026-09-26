using System.Globalization;
using System.Numerics;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Exact numeric aggregation, folded in the host rather than by a SQL aggregate.
/// <para>
/// A Decimal column stores its exact text behind a <c>nendo.decimal:</c> marker,
/// which NUMERIC affinity cannot coerce, so the value lands as TEXT and keeps
/// every digit. That is precisely why SQLite must not aggregate it: <c>SUM</c>
/// over such a column coerces each non-numeric string to zero and returns a
/// confident wrong answer. Folding the stored lexemes here is both exact and the
/// only correct reading of the column.
/// </para>
/// <para>
/// Every stored decimal fits <see cref="decimal"/>, because <see cref="ExactDecimal.Read"/>
/// enforces that on write. Only a sum can leave that range, so a sum accumulates
/// as a scaled <see cref="BigInteger"/> and is converted once, at the end.
/// </para>
/// </summary>
internal sealed class ExactAggregate
{
    private readonly string _aggregate;
    private readonly bool _integral;
    private BigInteger _sum;
    private int _scale;
    private decimal _extreme;
    private string? _dateExtreme;
    private long _contributing;

    internal ExactAggregate(string aggregate, bool integral)
    {
        _aggregate = aggregate;
        _integral = integral;
    }

    /// <summary>
    /// Folds one stored civil date, for the range of a Date field (ADR-0004
    /// 2026-09-14 amendment, S4). It shares this class because it is the same
    /// question — the smallest and the largest of a set — but it is deliberately a
    /// separate accumulator: a date has no sum, and an ISO civil date orders
    /// exactly by ordinal comparison, so the extreme is chosen without parsing a
    /// calendar or reaching for arithmetic that would need a rounding rule.
    /// </summary>
    internal void AddDate(string value)
    {
        if (_aggregate is not ("min" or "max"))
            throw new NendoPreconditionException("aggregate-not-exact",
                $"A Date field has a smallest and a largest value, not a '{_aggregate}'.");
        if (!IsCivilDate(value))
            throw new NendoPreconditionException("aggregate-not-exact",
                $"Value '{value}' is not a civil date, so it has no place in a range of one.");

        if (_contributing == 0) _dateExtreme = value;
        else if (_aggregate == "min") { if (string.CompareOrdinal(value, _dateExtreme) < 0) _dateExtreme = value; }
        else if (string.CompareOrdinal(value, _dateExtreme) > 0) _dateExtreme = value;

        _contributing++;
    }

    /// <summary>
    /// Whether a stored value is a civil date this host will order. Checked rather
    /// than assumed, because ordinal comparison is only exact over a fixed-width
    /// ISO form: "2026-9-1" would sort after "2026-10-01".
    /// </summary>
    internal static bool IsCivilDate(string value) =>
        value.Length == 10 && value[4] == '-' && value[7] == '-' &&
        DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);

    internal long ContributingRecords => _contributing;

    /// <summary>Folds one stored value. Nulls never reach this.</summary>
    internal void Add(decimal value)
    {
        if (_aggregate == "sum")
        {
            var (coefficient, scale) = Decompose(value);
            if (scale > _scale) { _sum *= BigInteger.Pow(10, scale - _scale); _scale = scale; }
            else if (scale < _scale) coefficient *= BigInteger.Pow(10, _scale - scale);
            _sum += coefficient;
        }
        else if (_contributing == 0) _extreme = value;
        else if (_aggregate == "min") { if (value < _extreme) _extreme = value; }
        else if (value > _extreme) _extreme = value;

        _contributing++;
    }

    /// <summary>
    /// The aggregate as JSON, or <c>null</c> over a set that contributed no
    /// value. An empty set is stated as empty; it is never reported as zero.
    /// </summary>
    internal JsonElement? Value()
    {
        if (_contributing == 0) return null;
        if (_dateExtreme is not null) return JsonSerializer.SerializeToElement(_dateExtreme);
        if (_aggregate != "sum")
            return _integral
                ? JsonSerializer.SerializeToElement((long)_extreme)
                : JsonSerializer.SerializeToElement(_extreme);

        if (_integral && _scale == 0)
        {
            if (_sum < long.MinValue || _sum > long.MaxValue)
                throw new NendoPreconditionException("aggregate-not-representable",
                    "The exact sum is outside the range this host can represent.");
            return JsonSerializer.SerializeToElement((long)_sum);
        }

        return JsonSerializer.SerializeToElement(Compose(_sum, _scale));
    }

    /// <summary>Reads a stored column value, or null when the field is unset.</summary>
    internal static decimal? Read(object? stored) => stored switch
    {
        null or DBNull => null,
        long integer => integer,
        string text when text.StartsWith("nendo.decimal:", StringComparison.Ordinal) =>
            decimal.Parse(text[14..], NumberStyles.Number, CultureInfo.InvariantCulture),
        string text => decimal.Parse(text, NumberStyles.Number, CultureInfo.InvariantCulture),
        double approximate => throw new NendoPreconditionException("aggregate-not-exact",
            $"Field value {approximate.ToString(CultureInfo.InvariantCulture)} is stored as a floating-point number and cannot be aggregated exactly."),
        _ => Convert.ToDecimal(stored, CultureInfo.InvariantCulture),
    };

    private static (BigInteger Coefficient, int Scale) Decompose(decimal value)
    {
        var bits = decimal.GetBits(value);
        var scale = (bits[3] >> 16) & 0xFF;
        var coefficient = new BigInteger((uint)bits[0]) |
            (new BigInteger((uint)bits[1]) << 32) |
            (new BigInteger((uint)bits[2]) << 64);
        return (value < 0 ? -coefficient : coefficient, scale);
    }

    private static decimal Compose(BigInteger coefficient, int scale)
    {
        var negative = coefficient.Sign < 0;
        var magnitude = BigInteger.Abs(coefficient);
        // Shed only zero digits the scale does not need; never round. A trailing zero
        // goes when the scale is past what a decimal holds, and also when the
        // coefficient is: decimal.MaxValue + 0.0 aligns on scale 1 and carries a
        // coefficient ten times the maximum whose last digit is a removable zero. The
        // same rule ExactDecimal.Read applies to a single value.
        var maximum = (BigInteger.One << 96) - 1;
        while (scale > 0 && (scale > 28 || magnitude > maximum) && magnitude % 10 == 0)
        { magnitude /= 10; scale--; }
        if (scale > 28 || magnitude > maximum)
            throw new NendoPreconditionException("aggregate-not-representable",
                "The exact sum is outside the range this host can represent.");
        return new decimal(
            unchecked((int)(uint)(magnitude & uint.MaxValue)),
            unchecked((int)(uint)((magnitude >> 32) & uint.MaxValue)),
            unchecked((int)(uint)(magnitude >> 64)),
            negative,
            (byte)scale);
    }
}
