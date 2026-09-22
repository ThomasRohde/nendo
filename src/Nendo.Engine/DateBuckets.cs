using System.Globalization;

namespace Nendo.Engine;

/// <summary>
/// The civil-date buckets a <c>trendChart</c> or an <c>activityGrid</c> is drawn from
/// (ADR-0004 2026-09-16 amendment, S5).
/// <para>
/// These are the first groups in this product that are generated rather than declared. A
/// single-choice field's options are written down, so an option nobody has used is still a
/// group; a month is not written down anywhere, so unless the host produces the months
/// itself, a month with no records in it is simply absent and the chart draws the shape of
/// the data instead of the shape of the range. Every key is produced here, from the bounds,
/// before a single row is read — which is the whole of what makes an empty bucket a bucket.
/// </para>
/// <para>
/// A range is a closed word resolved against today each time it is read, never a stored
/// date. That is what keeps a definition written in January from still meaning January in
/// December, and it is why there is no literal alternative to the word.
/// </para>
/// </summary>
internal sealed record DateBuckets(
    DateOnly Start,
    DateOnly End,
    IReadOnlyList<string> Keys,
    string Bucket)
{
    /// <summary>
    /// A grouped read over dates has no unset group: the bounds are two predicates in the
    /// query, so a record with no date, or one outside the range, is never returned. That is
    /// why the ceiling is spent exactly here rather than one short — a day grid over a leap
    /// year is 366 buckets and fits, which is what the published ceiling was chosen for.
    /// </summary>
    internal const int MaximumBuckets = NendoSemanticVocabulary.MaximumAggregateGroups;

    /// <summary>
    /// Resolves a closed range word and a bucket word against a civil today. <paramref
    /// name="today"/> is passed rather than read so that a test states the day it means and
    /// a leap year is an assertion rather than a wait.
    /// </summary>
    internal static DateBuckets Resolve(string range, string bucket, DateOnly today)
    {
        var (start, end) = range switch
        {
            // The calendar months ending with the current one, so the current month is
            // present and partial rather than missing until it completes.
            "last12Months" => (MonthsBack(today, 11), EndOfMonth(today)),
            "last6Months" => (MonthsBack(today, 5), EndOfMonth(today)),
            "last90Days" => (today.AddDays(-89), today),
            "last30Days" => (today.AddDays(-29), today),
            "thisYear" => (new DateOnly(today.Year, 1, 1), new DateOnly(today.Year, 12, 31)),
            // A year back to the day, inclusive of both ends: 365 days, or 366 when a 29
            // February falls inside the window.
            "lastTwelveMonths" => (today.AddYears(-1).AddDays(1), today),
            _ => throw new NendoValidationException(
                $"'{range}' is not a range this host resolves. The closed words are published in the vocabulary."),
        };

        var keys = bucket switch
        {
            "month" => MonthKeys(start, end),
            "week" => WeekKeys(start, end),
            "day" => DayKeys(start, end),
            _ => throw new NendoValidationException(
                $"'{bucket}' is not a bucket this host divides a range into."),
        };

        if (keys.Count > MaximumBuckets)
            throw new NendoValidationException(
                $"That range and bucket make {keys.Count} groups, and a grouped read answers at most {MaximumBuckets}.");
        return new DateBuckets(start, end, keys, bucket);
    }

    /// <summary>
    /// The bucket a stored civil date belongs to. The stored form is the ISO date the file
    /// holds, so a month is its first seven characters and a day is the whole of it; a week
    /// is named by its Monday, which sorts and labels without anyone having to agree on how
    /// week numbers behave at the turn of a year.
    /// </summary>
    internal string? KeyOf(string? storedDate)
    {
        if (string.IsNullOrEmpty(storedDate)) return null;
        if (!DateOnly.TryParseExact(storedDate[..Math.Min(10, storedDate.Length)], "yyyy-MM-dd",
                CultureInfo.InvariantCulture, DateTimeStyles.None, out var date))
            return null;
        if (date < Start || date > End) return null;
        return Bucket switch
        {
            "month" => date.ToString("yyyy-MM", CultureInfo.InvariantCulture),
            "week" => MondayOf(date).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
            _ => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        };
    }

    private static DateOnly MonthsBack(DateOnly today, int months) =>
        new DateOnly(today.Year, today.Month, 1).AddMonths(-months);

    private static DateOnly EndOfMonth(DateOnly day) =>
        new DateOnly(day.Year, day.Month, 1).AddMonths(1).AddDays(-1);

    private static DateOnly MondayOf(DateOnly day) =>
        day.AddDays(-(((int)day.DayOfWeek + 6) % 7));

    private static IReadOnlyList<string> MonthKeys(DateOnly start, DateOnly end)
    {
        var keys = new List<string>();
        for (var month = new DateOnly(start.Year, start.Month, 1); month <= end; month = month.AddMonths(1))
            keys.Add(month.ToString("yyyy-MM", CultureInfo.InvariantCulture));
        return keys;
    }

    private static IReadOnlyList<string> WeekKeys(DateOnly start, DateOnly end)
    {
        var keys = new List<string>();
        for (var week = MondayOf(start); week <= end; week = week.AddDays(7))
            keys.Add(week.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        return keys;
    }

    private static IReadOnlyList<string> DayKeys(DateOnly start, DateOnly end)
    {
        var keys = new List<string>();
        for (var day = start; day <= end; day = day.AddDays(1))
            keys.Add(day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));
        return keys;
    }
}
