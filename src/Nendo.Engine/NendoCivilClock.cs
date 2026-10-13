namespace Nendo.Engine;

/// <summary>
/// The person's civil day as the Engine reads it: a command step's today and a chart range's
/// end (R2LAT-06).
/// <para>
/// .NET keeps the machine's time zone for the life of the process unless told to forget it,
/// while the Workbench's clock follows Windows at once. Nendo stays open in the tray, so after
/// the zone changed (a flight with automatic time zone on) the two named different days until
/// a restart, and a record stamped done today left the screen's own "done today". The zone is
/// read again from Windows at most once every <see cref="RefreshInterval"/>, so the Engine
/// follows a change within a minute and never pays for the read on every call.
/// </para>
/// </summary>
internal static class NendoCivilClock
{
    internal static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(1);

    private static long _refreshedAt = long.MinValue;

    /// <summary>The monotonic clock in milliseconds; a test may stand in for it.</summary>
    internal static Func<long> Ticks { get; set; } = () => Environment.TickCount64;

    /// <summary>Forgets the cached zone; a test may count the calls.</summary>
    internal static Action ForgetZone { get; set; } = TimeZoneInfo.ClearCachedData;

    /// <summary>Forgets when the zone was last read, so the next read asks Windows; a test's tidy-up.</summary>
    internal static void Restart() => Interlocked.Exchange(ref _refreshedAt, long.MinValue);

    /// <summary>The machine's time zone, read again from Windows when the last read is a minute old.</summary>
    internal static TimeZoneInfo LocalZone()
    {
        var now = Ticks();
        var last = Interlocked.Read(ref _refreshedAt);
        if ((last == long.MinValue || now - last >= (long)RefreshInterval.TotalMilliseconds) &&
            Interlocked.CompareExchange(ref _refreshedAt, now, last) == last)
            ForgetZone();
        return TimeZoneInfo.Local;
    }

    private static readonly AsyncLocal<Func<DateTimeOffset>?> StandIn = new();

    /// <summary>The instant the Engine reads its day from: now, or what a test stands in for it.</summary>
    internal static DateTimeOffset Now() => StandIn.Value?.Invoke() ?? DateTimeOffset.UtcNow;

    /// <summary>
    /// Stands in for now in this call and the work it awaits, never in another test's, until the
    /// result is disposed: a test of the person's day runs at the hour it names, such as just
    /// after local midnight, when the civil date and the UTC date differ.
    /// </summary>
    internal static IDisposable StandInFor(Func<DateTimeOffset> now)
    {
        var before = StandIn.Value;
        StandIn.Value = now;
        return new Restore(() => StandIn.Value = before);
    }

    private sealed class Restore(Action restore) : IDisposable
    {
        public void Dispose() => restore();
    }

    /// <summary>Today's civil date where the machine is.</summary>
    internal static DateOnly Today() =>
        DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(Now(), LocalZone()).DateTime);
}
