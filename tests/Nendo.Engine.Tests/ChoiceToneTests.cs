using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A choice option's colour, ADR-0004 2026-09-14 amendment, slice S0. A tone is a
/// closed named hue carried by the existing choice-metadata operation: stored in its
/// own protected table at the end of the layout ladder, read back wherever the option
/// already flows, reversed by compensation, and refused by name outside the set.
/// </summary>
[TestClass]
public sealed class ChoiceToneTests
{
    [TestMethod]
    public async Task AToneIsStoredReadBackReversedAndRaisesTheMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
        ]));
        var before = await service.GetSnapshotAsync();
        Assert.AreNotEqual(NendoFormat.ColourAndHeaderMinimumHostVersion, before.Manifest.MinimumHostVersion);

        var toned = await coordinator.ApplyAsync(Mutation("tone", new("tone", "entry", "status", "new", "Fresh", false, before.Manifest.DefinitionRevision, "teal")));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual("teal", Choice(after, "new").Tone);
        Assert.AreEqual("Fresh", Choice(after, "new").DisplayName);
        // The other option is untouched and has no colour.
        Assert.IsNull(Choice(after, "done").Tone);
        // A file with a colour states the host that draws it.
        Assert.AreEqual(NendoFormat.ColourAndHeaderMinimumHostVersion, after.Manifest.MinimumHostVersion);

        // Compensation puts the previous metadata back: the bare ID as its label, and no
        // colour. The minimum is never lowered, so the file keeps stating the host it
        // once needed.
        await service.CompensateRevisionAsync(toned.RevisionId, "undo-tone");
        var undone = await service.GetSnapshotAsync();
        Assert.IsNull(Choice(undone, "new").Tone);
        Assert.AreEqual("new", Choice(undone, "new").DisplayName);
        Assert.AreEqual(NendoFormat.ColourAndHeaderMinimumHostVersion, undone.Manifest.MinimumHostVersion);

        // The operation sets the whole of an option's metadata: a rename that carries
        // the tone keeps it, one that omits it clears it, and compensating the clearing
        // restores the colour it had.
        await coordinator.ApplyAsync(Mutation("amber", new("amber", "entry", "status", "new", "Fresh", false, undone.Manifest.DefinitionRevision, "amber")));
        var amber = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(Mutation("rename", new("rename", "entry", "status", "new", "Fresher", false, amber.Manifest.DefinitionRevision, "amber")));
        var renamed = await service.GetSnapshotAsync();
        Assert.AreEqual("amber", Choice(renamed, "new").Tone);
        Assert.AreEqual("Fresher", Choice(renamed, "new").DisplayName);
        var cleared = await coordinator.ApplyAsync(Mutation("clear", new("clear", "entry", "status", "new", "Fresher", false, renamed.Manifest.DefinitionRevision)));
        Assert.IsNull(Choice(await service.GetSnapshotAsync(), "new").Tone);
        await service.CompensateRevisionAsync(cleared.RevisionId, "undo-clear");
        Assert.AreEqual("amber", Choice(await service.GetSnapshotAsync(), "new").Tone);
    }

    [TestMethod]
    [DataRow("#2458e6")]
    [DataRow("gray")]
    [DataRow("Teal")]
    public async Task AToneOutsideTheClosedSetIsRefusedByNameAndChangesNothing(string tone)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
        ]));
        var before = await service.GetSnapshotAsync();

        var refusal = await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            coordinator.ApplyAsync(Mutation("bad", new("bad", "entry", "status", "new", "Fresh", false, before.Manifest.DefinitionRevision, tone))));

        // The refusal names the set, so the second attempt does not guess.
        StringAssert.Contains(refusal.Message, "teal");
        StringAssert.Contains(refusal.Message, "grey");
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
    }

    [TestMethod]
    public async Task AFileWithAToneLandsOnTheToneLayoutAndReopensWithIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        var fresh = await service.GetSnapshotAsync();
        // The tone rides in the same mutation as the field it colours, which is how
        // the Idea Garden recipe sends it: one definition mutation, one revision.
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
            new SetChoiceMetadataOperation("t", "entry", "status", "done", "Done", false, fresh.Manifest.DefinitionRevision, "green"),
        ]));
        var final = await service.GetSnapshotAsync();
        Assert.AreEqual("green", Choice(final, "done").Tone);
        Assert.AreEqual(NendoFormat.ColourAndHeaderMinimumHostVersion, final.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-retirement-behaviour-tone-v1", inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync(); service = new(coordinator);
        var reopened = await service.GetSnapshotAsync();
        Assert.AreEqual(JsonSerializer.Serialize(final.Entities), JsonSerializer.Serialize(reopened.Entities));
        Assert.AreEqual("green", Choice(reopened, "done").Tone);
    }

    [TestMethod]
    public async Task AFileWithoutAToneKeepsItsLayoutAndItsMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
        ]));
        var before = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(Mutation("rename", new("rename", "entry", "status", "new", "Fresh", false, before.Manifest.DefinitionRevision)));
        var after = await service.GetSnapshotAsync();
        Assert.IsNull(Choice(after, "new").Tone);
        Assert.AreEqual(NendoFormat.ChoiceMinimumHostVersion, after.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);

        // A rename without a colour does not move the file up the ladder.
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-v1", inspection.Layout);
    }

    private static NendoChoiceOption Choice(NendoSessionSnapshot snapshot, string id) =>
        snapshot.Entities.Single().Fields.Single().Choices.Single(choice => choice.Id == id);

    private static NendoMutation Mutation(string key, SetChoiceMetadataOperation operation) => new("test", key, "test", key, [operation]);
}
