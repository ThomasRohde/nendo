namespace Nendo.Engine.Tests;

/// <summary>
/// Instants for tests of the person's day. Between local and UTC midnight the civil date and the
/// UTC date differ, and a test that compared with the UTC date failed every night in that window.
/// </summary>
internal static class CivilTime
{
    /// <summary>Half past midnight today where the machine is, as an instant.</summary>
    internal static DateTimeOffset JustAfterLocalMidnight() =>
        JustAfterLocalMidnight(DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, NendoCivilClock.LocalZone()).DateTime));

    /// <summary>Half past midnight on a given civil date where the machine is, as an instant.</summary>
    internal static DateTimeOffset JustAfterLocalMidnight(DateOnly date)
    {
        var local = date.ToDateTime(new TimeOnly(0, 30), DateTimeKind.Unspecified);
        return new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(local, NendoCivilClock.LocalZone()), TimeSpan.Zero);
    }
}
