namespace Nendo.Engine.Tests;

/// <summary>
/// The coordinator says when the file moved, W-034.
/// <para>
/// It exists because nothing else can say it. A surface on screen is compared against the
/// change sequence the renderer holds, and an agent writing through MCP moves the file
/// without moving anything in the renderer's world — so a board stayed on the revision it
/// was drawn at until the person left the view and came back. The host had one unsolicited
/// message to the renderer, <c>navigate</c>, and no way to say this.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class CommittedNotificationTests
{
    [TestMethod]
    public async Task EveryWriterAnnouncesTheSequenceItReached()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var announced = new List<long>();
        coordinator.Committed += sequence => announced.Add(sequence);

        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-title", "notes", "title", "Title", "title", NendoStorageKind.Text, true),
        ]));
        Assert.HasCount(1, announced, "A definition change is a change.");

        var created = await service.CreateRecordAsync(new("notes", "one",
            new Dictionary<string, object?> { ["title"] = "One" }, new NendoRequestContext("test", "one", "test")));
        Assert.HasCount(2, announced);
        Assert.AreEqual(created.ChangeSequence, announced[^1],
            "The sequence announced is the one the write reached, so a listener can tell whether it is already current.");

        await service.CreateRecordsAsync(new("notes",
            [new("two", new Dictionary<string, object?> { ["title"] = "Two" }),
             new("three", new Dictionary<string, object?> { ["title"] = "Three" })],
            new NendoRequestContext("test", "batch", "test")));
        Assert.HasCount(3, announced, "A batch is one commit and says so once.");

        // Monotone, because a listener compares against it rather than counting.
        CollectionAssert.AreEqual(announced.OrderBy(value => value).ToArray(), announced.ToArray());
    }

    /// <summary>
    /// A replay commits nothing, so it announces nothing. Saying otherwise would have every
    /// listener re-read a file that did not move, which is the loop this whole area of the
    /// product has been bitten by twice.
    /// </summary>
    [TestMethod]
    public async Task AnIdempotentReplayIsNotAChange()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-title", "notes", "title", "Title", "title", NendoStorageKind.Text, true),
        ]));

        var context = new NendoRequestContext("test", "same-key", "test");
        var first = await service.CreateRecordAsync(new("notes", "one",
            new Dictionary<string, object?> { ["title"] = "One" }, context));

        var announced = new List<long>();
        coordinator.Committed += sequence => announced.Add(sequence);
        var replay = await service.CreateRecordAsync(new("notes", "one",
            new Dictionary<string, object?> { ["title"] = "One" }, context));

        Assert.IsTrue(replay.IsIdempotentReplay, "This test is worthless if the second write was not a replay.");
        Assert.AreEqual(first.ChangeSequence, replay.ChangeSequence);
        Assert.IsEmpty(announced, "A replay moved nothing, so there is nothing to tell a screen about.");
    }

    /// <summary>
    /// Nobody listening is the ordinary case — the Engine has no idea whether a host is
    /// attached — and it must cost the write nothing and break nothing.
    /// </summary>
    [TestMethod]
    public async Task AWriteWithNobodyListeningIsUnaffected()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-title", "notes", "title", "Title", "title", NendoStorageKind.Text, true),
        ]));
        var created = await service.CreateRecordAsync(new("notes", "one",
            new Dictionary<string, object?> { ["title"] = "One" }, new NendoRequestContext("test", "one", "test")));
        Assert.IsGreaterThan(0, created.ChangeSequence);
    }
}
