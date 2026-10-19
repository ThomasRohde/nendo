using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A change set that does not validate reports every independent refusal together,
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

    /// <summary>
    /// A create pointing at a record a refused create would have made, as a CSV batch
    /// writes a child under a parent row, fails only because the parent was left out. It is a
    /// consequence, so only the parent's refusal is reported.
    /// </summary>
    [TestMethod]
    public async Task ACreatePointingAtARefusedCreatesRecordIsNotReported()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var revision = await FixtureAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "tree", "test", "A parent", [
            new AddFieldOperation("t-parent", "tasks", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "tasks", "parent", "tasks", "title", revision)]));

        var preview = await coordinator.BeginProposalAsync(ProposalId(), "A batch", "test",
            new NendoChangeSet([new NendoMutation("test", "batch", "test", "Import CSV rows 2-3", [
                new CreateRecordOperation("row-2", "tasks", "r2", new Dictionary<string, object?> { ["title"] = "Parent", ["missing"] = "x" }),
                new CreateRecordOperation("row-3", "tasks", "r3", new Dictionary<string, object?> { ["title"] = "Child", ["parent"] = "r2" },
                    new Dictionary<string, long> { ["parent"] = 1 }),
            ])]));

        Assert.AreEqual(NendoProposalState.Invalid, preview.State);
        CollectionAssert.AreEqual(new[] { "row-2" }, preview.Diagnostics.Select(diagnostic => diagnostic.OperationId).ToArray(),
            "A child row that fails only because its parent row was left out was reported as a second problem: " + JsonSerializer.Serialize(preview.Diagnostics));
    }

    /// <summary>
    /// Rows under one parent the file already holds are independent. A refused
    /// row does not make its parent something it introduced, so a later row under that parent with
    /// its own mistake is still reported.
    /// </summary>
    [TestMethod]
    public async Task RowsUnderAParentTheFileHoldsStayIndependent()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var revision = await FixtureAsync(coordinator);
        await coordinator.ApplyAsync(new("test", "tree", "test", "A parent", [
            new AddFieldOperation("t-parent", "tasks", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "tasks", "parent", "tasks", "title", revision)]));
        var under = new Dictionary<string, long> { ["parent"] = 1 };

        var preview = await coordinator.BeginProposalAsync(ProposalId(), "A batch", "test",
            new NendoChangeSet([new NendoMutation("test", "batch", "test", "Import CSV rows 2-4", [
                new CreateRecordOperation("row-2", "tasks", "r2", new Dictionary<string, object?> { ["title"] = "One", ["parent"] = "t1", ["bogus"] = "x" }, under),
                new CreateRecordOperation("row-3", "tasks", "r3", new Dictionary<string, object?> { ["title"] = "Two", ["parent"] = "t1" }, under),
                new CreateRecordOperation("row-4", "tasks", "r4", new Dictionary<string, object?> { ["title"] = null, ["parent"] = "t1" }, under),
            ])]));

        CollectionAssert.AreEqual(new[] { "row-2", "row-4" }, preview.Diagnostics.Select(diagnostic => diagnostic.OperationId).ToArray(),
            "A row under the same existing parent as a refused row was taken for its consequence: " + JsonSerializer.Serialize(preview.Diagnostics));
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
