using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// W-010: a change set that does not validate reports every independent refusal together,
/// and never one that only follows from another.
/// <para>
/// Clone validation stops at its first refusal, so each case here is measured from a
/// real validation: what the author is told, and what the active file holds afterwards.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class IndependentRefusalTests
{
    [TestMethod]
    public async Task TwoUnrelatedMistakesAreReportedTogetherEachByItsOperation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var revision = await FixtureAsync(coordinator);

        var preview = await coordinator.BeginProposalAsync(ProposalId(), "Two mistakes", "test",
            new NendoChangeSet([new NendoMutation("test", "two", "test", "Two unrelated mistakes", [
                new AddFieldOperation("to-nowhere", "ghosts", "note", "Note", "note", NendoStorageKind.Text, false),
                new RenameFieldOperation("rename-missing", "tasks", "missing", "Missing", revision),
            ])]));

        Assert.AreEqual(NendoProposalState.Invalid, preview.State);
        CollectionAssert.AreEqual(
            new[] { "to-nowhere", "rename-missing" },
            preview.Diagnostics.Select(diagnostic => diagnostic.OperationId).ToArray(),
            "Both independent refusals should be reported, first first, each naming its operation: "
                + JsonSerializer.Serialize(preview.Diagnostics));
    }

    [TestMethod]
    public async Task WhatOnlyFollowsFromARefusalIsNotReported()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var revision = await FixtureAsync(coordinator);

        // The record type is refused, so the field added to it fails for the same reason.
        // Saying so twice would send somebody after a second problem that does not exist.
        var preview = await coordinator.BeginProposalAsync(ProposalId(), "A refused record type", "test",
            new NendoChangeSet([new NendoMutation("test", "one", "test", "A record type that cannot be created", [
                new CreateEntityOperation("clash", "notes", "Notes", "tasks"),
                new AddFieldOperation("under-it", "notes", "body", "Body", "body", NendoStorageKind.Text, false),
            ])]));

        Assert.AreEqual(NendoProposalState.Invalid, preview.State);
        CollectionAssert.AreEqual(new[] { "clash" }, preview.Diagnostics.Select(diagnostic => diagnostic.OperationId).ToArray(),
            "A refusal that only follows from the first was reported: " + JsonSerializer.Serialize(preview.Diagnostics));
    }

    [TestMethod]
    public async Task AFieldAddedToARecordTypeThisChangeSetCreatedStaysIndependent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var revision = await FixtureAsync(coordinator);

        // The record type was created cleanly, so two mistakes under it are two mistakes,
        // even though both name it.
        var preview = await coordinator.BeginProposalAsync(ProposalId(), "Two mistakes under a new type", "test",
            new NendoChangeSet([new NendoMutation("test", "new", "test", "A new record type", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("first", "notes", "body", "Body", "body", NendoStorageKind.Text, false),
                new AddFieldOperation("clash-one", "notes", "body", "Body again", "body_again", NendoStorageKind.Text, false),
                new RenameFieldOperation("rename-missing", "notes", "missing", "Missing", revision),
            ])]));

        CollectionAssert.AreEqual(
            new[] { "clash-one", "rename-missing" },
            preview.Diagnostics.Select(diagnostic => diagnostic.OperationId).ToArray(),
            JsonSerializer.Serialize(preview.Diagnostics));
    }

    [TestMethod]
    public async Task TheSearchStopsAtItsBoundAndLeavesTheActiveFileAlone()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var revision = await FixtureAsync(coordinator);
        var service = new NendoApplicationService(coordinator);
        var before = JsonSerializer.Serialize(await service.GetSnapshotAsync());

        var operations = Enumerable.Range(1, 7)
            .Select(index => (NendoOperation)new RenameFieldOperation($"rename-{index}", "tasks", $"missing{index}", "Missing", revision))
            .ToArray();
        var preview = await coordinator.BeginProposalAsync(ProposalId(), "Seven mistakes", "test",
            new NendoChangeSet([new NendoMutation("test", "seven", "test", "Seven mistakes", operations)]));

        Assert.HasCount(5, preview.Diagnostics,
            "The search did not stop at its bound: " + JsonSerializer.Serialize(preview.Diagnostics));
        Assert.AreEqual(before, JsonSerializer.Serialize(await service.GetSnapshotAsync()),
            "Looking for further refusals changed the active file.");
        Assert.IsFalse(
            Directory.EnumerateFiles(Path.Combine(coordinator.ProposalRoot, preview.ProposalId), "proposal-pass-*").Any(),
            "A pass left its copy of the file behind.");
    }

    [TestMethod]
    public async Task ASecondWriteToARecordWhoseFirstWriteWasRefusedIsNotReported()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await FixtureAsync(coordinator);

        // The first write names a field that does not exist. Without it, the second write
        // to the same record expects a version the record never reaches: a consequence of
        // leaving the first out, not a second mistake.
        var preview = await coordinator.BeginProposalAsync(ProposalId(), "Two writes", "test",
            new NendoChangeSet([new NendoMutation("test", "writes", "test", "Two writes to one record", [
                new SetFieldOperation("wrong-field", "tasks", "t1", "missing", 1, "x"),
                new SetFieldOperation("second", "tasks", "t1", "title", 2, "Renamed"),
            ])]));

        CollectionAssert.AreEqual(new[] { "wrong-field" }, preview.Diagnostics.Select(diagnostic => diagnostic.OperationId).ToArray(),
            JsonSerializer.Serialize(preview.Diagnostics));
    }

    [TestMethod]
    public async Task AVersionConflictThatLeavingAMutationOutCausedIsNotReported()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var revision = await FixtureAsync(coordinator);

        // The second mutation names the revision the first would have made. Once the first
        // is left out, that revision never exists, and the conflict is this method's own.
        var preview = await coordinator.BeginProposalAsync(ProposalId(), "Two mutations", "test",
            new NendoChangeSet([
                new NendoMutation("test", "first", "test", "A mistake", [
                    new RenameFieldOperation("rename-missing", "tasks", "missing", "Missing", revision),
                ]),
                new NendoMutation("test", "second", "test", "A correct rename", [
                    new RenameFieldOperation("rename-title", "tasks", "title", "Name", revision + 1),
                ]),
            ]));

        CollectionAssert.AreEqual(new[] { "rename-missing" }, preview.Diagnostics.Select(diagnostic => diagnostic.OperationId).ToArray(),
            "A version conflict caused by leaving a mutation out was reported: " + JsonSerializer.Serialize(preview.Diagnostics));
    }

    private static string ProposalId() => "proposal-" + Guid.NewGuid().ToString("N");

    private static async Task<long> FixtureAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
        ]));
        var service = new NendoApplicationService(coordinator);
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["title"] = "First" }, new("test", "t1", "test")));
        return (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
    }
}
