namespace Nendo.Engine.Tests;

/// <summary>
/// The read behind a <c>trendChart</c> and an <c>activityGrid</c>, ADR-0004 2026-09-16
/// amendment, slice S5.
/// <para>
/// One rule is worth more than the rest and is asserted first: a bucket with nothing in it
/// is still a bucket. Every other chart in this product groups by something written down in
/// the definition, so an unused option is a group without anyone arranging it. A month is
/// written down nowhere, and a grouped read that returned only the months with records in
/// them would draw the shape of the data while looking exactly like the shape of the range.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class DateBucketReadTests
{
    [TestMethod]
    public void EveryBucketOfTheRangeIsAnsweredEvenWhereNothingHappened()
    {
        var today = new DateOnly(2026, 9, 16);
        var buckets = DateBuckets.Resolve("last12Months", "month", today);

        Assert.HasCount(12, buckets.Keys);
        Assert.AreEqual("2025-10", buckets.Keys[0]);
        Assert.AreEqual("2026-09", buckets.Keys[^1]);
        Assert.AreEqual(new DateOnly(2025, 10, 1), buckets.Start);
        // The current month is present and partial rather than missing until it completes.
        Assert.AreEqual(new DateOnly(2026, 9, 30), buckets.End);
    }

    [TestMethod]
    public async Task ATrendStatesAnEmptyMonthAsEmptyRatherThanLeavingItOut()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var today = DateOnly.FromDateTime(DateTime.Now);

        // Two records this month and one the month before last; the month between them has
        // nothing, and is the whole point of the assertion.
        await AddAsync(service, "a", today, 10);
        await AddAsync(service, "b", today, 5);
        await AddAsync(service, "c", today.AddMonths(-2), 7);

        var result = await service.BucketAggregateRecordsAsync(
            new NendoRecordDateBucketQuery("notes", "due", "month", "last6Months", "sum", "amount"));

        Assert.HasCount(6, result.Groups);
        var months = result.Groups.Select(group => group.Key).ToArray();
        Assert.AreEqual(6, months.Distinct().Count(), "Every bucket of the range is answered exactly once.");

        var current = result.Groups.Single(group => group.Key == today.ToString("yyyy-MM"));
        Assert.AreEqual("15", current.ValueLexeme);
        Assert.AreEqual(2, current.ContributingRecords);

        var quiet = result.Groups.Single(group => group.Key == today.AddMonths(-1).ToString("yyyy-MM"));
        Assert.IsNull(quiet.Value, "A month with nothing in it is stated as empty, never as zero.");
        Assert.AreEqual(0, quiet.ContributingRecords);

        var earlier = result.Groups.Single(group => group.Key == today.AddMonths(-2).ToString("yyyy-MM"));
        Assert.AreEqual("7", earlier.ValueLexeme);
    }

    /// <summary>
    /// A count answers zero where a sum answers empty, and that difference is deliberate:
    /// nothing summed is not a number, while nothing counted is none of them.
    /// </summary>
    [TestMethod]
    public async Task AGridCountsEveryDayOfTheYearAndZeroIsAnAnswer()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var today = DateOnly.FromDateTime(DateTime.Now);

        await AddAsync(service, "a", today, 1);
        await AddAsync(service, "b", today, 1);

        var result = await service.BucketAggregateRecordsAsync(
            new NendoRecordDateBucketQuery("notes", "due", "day", "thisYear", "count"));

        var daysInYear = DateTime.IsLeapYear(today.Year) ? 366 : 365;
        Assert.HasCount(daysInYear, result.Groups);
        Assert.AreEqual("2", result.Groups.Single(group => group.Key == today.ToString("yyyy-MM-dd")).ValueLexeme);
        Assert.IsTrue(result.Groups.All(group => group.Value is not null), "A count answers every day, and most of them are zero.");
        Assert.AreEqual(daysInYear - 1, result.Groups.Count(group => group.ValueLexeme == "0"));
    }

    /// <summary>
    /// A day grid over a leap year is 366 buckets, which is exactly the published ceiling.
    /// S1 chose that number "so the day buckets of a later slice have a stated bound rather
    /// than a new rule"; this is that slice, and this asserts the bound was not one short.
    /// </summary>
    [TestMethod]
    public void ALeapYearOfDaysMeetsThePublishedCeilingExactly()
    {
        var leap = DateBuckets.Resolve("thisYear", "day", new DateOnly(2028, 6, 1));
        Assert.HasCount(NendoSemanticVocabulary.MaximumAggregateGroups, leap.Keys,
            "A leap year of days is exactly the published ceiling; a bound one short would refuse it.");
        Assert.HasCount(366, leap.Keys);

        var ordinary = DateBuckets.Resolve("thisYear", "day", new DateOnly(2026, 6, 1));
        Assert.HasCount(365, ordinary.Keys);
    }

    /// <summary>
    /// A record outside the range is not in the unset group, it is not in the read at all:
    /// the bounds are two predicates, so the fold never sees it. This is why the result
    /// carries no unset bucket and why the ceiling above is spent exactly.
    /// </summary>
    [TestMethod]
    public async Task ARecordOutsideTheRangeOrWithNoDateIsNotInTheAnswerAtAll()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var today = DateOnly.FromDateTime(DateTime.Now);

        await AddAsync(service, "inside", today, 3);
        await AddAsync(service, "long-ago", today.AddYears(-4), 100);
        await AddAsync(service, "undated", null, 50);

        var result = await service.BucketAggregateRecordsAsync(
            new NendoRecordDateBucketQuery("notes", "due", "month", "last6Months", "sum", "amount"));

        Assert.IsTrue(result.Groups.All(group => group.Key is not null), "There is no unset bucket over a date range.");
        var total = result.Groups.Where(group => group.ValueLexeme is not null).Sum(group => decimal.Parse(group.ValueLexeme!));
        Assert.AreEqual(3m, total, "Only the record inside the range contributed.");
    }

    /// <summary>
    /// A week is named by its Monday, so the label sorts and nobody has to agree on how week
    /// numbers behave at the turn of a year.
    /// </summary>
    [TestMethod]
    public void AWeekBucketIsNamedByItsMonday()
    {
        // 2026-09-16 is a Wednesday; its week is the Monday two days before.
        var buckets = DateBuckets.Resolve("last30Days", "week", new DateOnly(2026, 9, 16));
        Assert.AreEqual("2026-09-14", buckets.KeyOf("2026-09-16"));
        Assert.AreEqual("2026-09-14", buckets.KeyOf("2026-09-14"));
        Assert.AreEqual("2026-09-07", buckets.KeyOf("2026-09-13"), "Sunday belongs to the week that began on Monday.");
        Assert.IsTrue(buckets.Keys.Contains("2026-09-14"));
    }

    /// <summary>
    /// The range is resolved when it is read, so the same stored definition means something
    /// different in December than it did in January — which is the whole reason the word is
    /// stored instead of the dates.
    /// </summary>
    [TestMethod]
    public void TheSameStoredWordResolvesToDifferentBoundsOnDifferentDays()
    {
        var january = DateBuckets.Resolve("last12Months", "month", new DateOnly(2026, 1, 15));
        var december = DateBuckets.Resolve("last12Months", "month", new DateOnly(2026, 12, 15));

        Assert.AreEqual("2025-02", january.Keys[0]);
        Assert.AreEqual("2026-01", january.Keys[^1]);
        Assert.AreEqual("2026-01", december.Keys[0]);
        Assert.AreEqual("2026-12", december.Keys[^1]);
        Assert.HasCount(12, january.Keys);
        Assert.HasCount(12, december.Keys);
    }

    [TestMethod]
    public void AWordOutsideTheClosedSetIsRefusedByTheResolverToo()
    {
        var refused = Assert.ThrowsExactly<NendoValidationException>(
            () => DateBuckets.Resolve("sinceTheBeginning", "month", new DateOnly(2026, 9, 16)));
        StringAssert.Contains(refused.Message, "sinceTheBeginning");
    }

    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-title", "notes", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("n-due", "notes", "due", "Due", "due", NendoStorageKind.Date, false),
            new AddFieldOperation("n-amount", "notes", "amount", "Amount", "amount", NendoStorageKind.Decimal, false),
        ]));
        return service;
    }

    private static Task AddAsync(NendoApplicationService service, string id, DateOnly? due, decimal amount) =>
        service.CreateRecordAsync(new("notes", id,
            new Dictionary<string, object?>
            {
                ["title"] = id,
                ["due"] = due?.ToString("yyyy-MM-dd"),
                ["amount"] = amount,
            },
            new NendoRequestContext("test", id, "test")));
}
