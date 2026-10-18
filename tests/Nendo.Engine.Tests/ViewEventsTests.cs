namespace Nendo.Engine.Tests;

/// <summary>
/// W-251: an open file keeps its custom views' recent runtime events, bounded, for an agent to read.
/// Billable's agent built a browser adapter of its own because nothing said what its view did in
/// the embedded host.
/// </summary>
[TestClass]
public sealed class ViewEventsTests
{
    private static NendoViewEvent Event(NendoViewEventKind kind, string? text = null, string? code = null) =>
        new(DateTimeOffset.UnixEpoch, kind, "view.board", kind == NendoViewEventKind.Refused ? "records.batch" : null, code, text);

    [TestMethod]
    public void APackageKeepsItsLastEventsAndSaysHowManyWentBefore()
    {
        var events = new NendoViewEvents();
        for (var index = 0; index < NendoViewEvents.EventsPerPackage + 7; index++)
            events.Record("org.example.board", Event(NendoViewEventKind.Error, $"Error {index}"));
        var log = events.Read("org.example.board").Single();
        Assert.HasCount(NendoViewEvents.EventsPerPackage, log.Events);
        Assert.AreEqual(7, log.Dropped);
        Assert.AreEqual("Error 7", log.Events[0].Text, "The oldest kept event is not the one after those let go.");
        Assert.AreEqual($"Error {NendoViewEvents.EventsPerPackage + 6}", log.Events[^1].Text);
    }

    [TestMethod]
    public void AnEventIsCutToItsBoundsAndOnePackageIsReadAlone()
    {
        var events = new NendoViewEvents();
        events.Record("org.example.board", Event(NendoViewEventKind.Error, new string('x', NendoViewEvents.MaximumText + 100)));
        events.Record("org.example.chart", Event(NendoViewEventKind.Refused, "This view may not read that.", "not-allowed"));
        Assert.AreEqual(NendoViewEvents.MaximumText, events.Read("org.example.board").Single().Events.Single().Text!.Length);
        var chart = events.Read("org.example.chart").Single().Events.Single();
        Assert.AreEqual(("records.batch", "not-allowed"), (chart.Method, chart.Code));
        Assert.HasCount(2, events.Read());
        Assert.IsEmpty(events.Read("org.example.none"));
    }

    [TestMethod]
    public void ThePackageHeardFromLongestAgoGoesFirst()
    {
        var events = new NendoViewEvents();
        for (var index = 0; index < NendoViewEvents.Packages; index++)
            events.Record($"org.example.p{index:D2}", Event(NendoViewEventKind.Loaded));
        // p00 is heard from again, so p01 is now the one heard from longest ago.
        events.Record("org.example.p00", Event(NendoViewEventKind.Stopped));
        events.Record("org.example.new", Event(NendoViewEventKind.Loaded));
        var kept = events.Read().Select(log => log.PackageId).ToArray();
        Assert.HasCount(NendoViewEvents.Packages, kept);
        CollectionAssert.Contains(kept, "org.example.p00");
        CollectionAssert.DoesNotContain(kept, "org.example.p01");
        CollectionAssert.Contains(kept, "org.example.new");
    }

    [TestMethod]
    public async Task EachOpenFileHasItsOwnEventsAndEveryServiceOverItSeesThem()
    {
        await using var one = new EngineTestWorkspace();
        await using var two = new EngineTestWorkspace();
        var first = await one.CreateAsync();
        var second = await two.CreateAsync();
        new NendoApplicationService(first).ViewEvents.Record("org.example.board", Event(NendoViewEventKind.Loaded));
        Assert.HasCount(1, new NendoApplicationService(first).ViewEvents.Read(), "Another service over the same file did not see its views' events.");
        Assert.IsEmpty(new NendoApplicationService(second).ViewEvents.Read(), "One file's views' events reached another file.");
    }
}
