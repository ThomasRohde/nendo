using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A new option on an existing single-choice field, ADR-0003 2026-10-17 note (W-280). The
/// options were fixed when the field was added, and the metadata operation only names, colours
/// and retires options that exist, so a change set that tried to add one was refused.
/// </summary>
[TestClass]
public sealed class ChoiceAdditionTests
{
    [TestMethod]
    public async Task AnAddedOptionGoesLastIsChosenByRecordsAndTheFileReopensByteIdentical()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateAsync(workspace);
        await service.CreateRecordAsync(new("entry", "r", new Dictionary<string, object?> { ["status"] = "new" }, Context("create")));
        var before = await service.GetSnapshotAsync();

        await coordinator.ApplyAsync(Mutation("add", new("add", "entry", "status", "later", "Later", before.Manifest.DefinitionRevision)));
        var after = await service.GetSnapshotAsync();
        var status = Status(after);
        CollectionAssert.AreEqual(new[] { "new", "done", "later" }, status.Options.ToArray());
        Assert.AreEqual("Later", status.Choices.Single(choice => choice.Id == "later").DisplayName);
        Assert.IsNull(status.Choices.Single(choice => choice.Id == "later").Tone);
        // The other options read back as they did, with their IDs as labels.
        Assert.AreEqual("new", status.Choices.Single(choice => choice.Id == "new").DisplayName);
        Assert.HasCount(3, status.Choices);
        // No record changed: the definition moved, the data did not.
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(after.Records));
        Assert.AreEqual(before.Manifest.DefinitionRevision + 1, after.Manifest.DefinitionRevision);
        Assert.AreEqual(NendoFormat.ChoiceMinimumHostVersion, after.Manifest.MinimumHostVersion);

        // Records take the option at once, on a create and on an edit.
        await service.CreateRecordAsync(new("entry", "r2", new Dictionary<string, object?> { ["status"] = "later" }, Context("create-later")));
        await service.SetFieldAsync(new("entry", "r", "status", 1, "later", Context("edit-later")));
        var final = await service.GetSnapshotAsync();
        Assert.IsTrue(final.Records.All(record => record.Values["status"].GetString() == "later"));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);

        // A label edit's layout, no further rung.
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-v1", inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        coordinator = await workspace.OpenAsync(); service = new(coordinator);
        var reopened = await service.GetSnapshotAsync();
        Assert.AreEqual(JsonSerializer.Serialize(final.Entities), JsonSerializer.Serialize(reopened.Entities));
        Assert.AreEqual(JsonSerializer.Serialize(final.Records), JsonSerializer.Serialize(reopened.Records));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task ATonedOptionCarriesItsColourAndStatesTheColourHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateAsync(workspace);
        var before = await service.GetSnapshotAsync();
        await coordinator.ApplyAsync(Mutation("add", new("add", "entry", "status", "later", "Later", before.Manifest.DefinitionRevision, "teal")));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual("teal", Status(after).Choices.Single(choice => choice.Id == "later").Tone);
        Assert.IsNull(Status(after).Choices.Single(choice => choice.Id == "done").Tone);
        Assert.AreEqual(NendoFormat.ColourAndHeaderMinimumHostVersion, after.Manifest.MinimumHostVersion);
    }

    [TestMethod]
    public async Task AnOptionTheFieldCannotTakeIsRefusedByNameAndChangesNothing()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateAsync(workspace);
        var before = await service.GetSnapshotAsync();
        var revision = before.Manifest.DefinitionRevision;

        // An ID the field already has.
        StringAssert.Contains((await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            coordinator.ApplyAsync(Mutation("again", new("again", "entry", "status", "done", "Finished", revision))))).Message,
            "Status already has the option done");
        // A label another option answers to, compared case-insensitively as a rename is.
        var clash = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            coordinator.ApplyAsync(Mutation("clash", new("clash", "entry", "status", "finished", " DONE ", revision))));
        Assert.AreEqual("label-conflict", clash.Code);
        StringAssert.Contains(clash.Message, "names the option done");
        // A field that is not a single choice.
        StringAssert.Contains((await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            coordinator.ApplyAsync(Mutation("title", new("title", "entry", "title", "x", "X", revision))))).Message,
            "Title is not a single-choice field");
        // A stale definition revision.
        Assert.AreEqual("definition-version-conflict", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            coordinator.ApplyAsync(Mutation("stale", new("stale", "entry", "status", "later", "Later", revision - 1))))).Code);
        // Shapes refused where the operation is made, before it reaches a file.
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() =>
            new AddChoiceOperation("long-id", "entry", "status", new string('x', 121), "Long", revision)).Message, "at most 120 characters");
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() =>
            new AddChoiceOperation("long-label", "entry", "status", "long", new string('x', 201), revision)).Message, "1–200 characters");
        StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() =>
            new AddChoiceOperation("hex", "entry", "status", "hex", "Hex", revision, "#2458e6")).Message, "teal");
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));

        // A retired option still holds its ID.
        await coordinator.ApplyAsync(new("test", "retire-new", "test", "retire-new",
            [new SetChoiceMetadataOperation("retire-new", "entry", "status", "new", "New", true, revision)]));
        var retired = await service.GetSnapshotAsync();
        StringAssert.Contains((await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            coordinator.ApplyAsync(Mutation("revive", new("revive", "entry", "status", "new", "Fresh", retired.Manifest.DefinitionRevision))))).Message,
            "already has the option new, retired");

        // A retired field, and then a retired record type, take no new option.
        await coordinator.ApplyAsync(new("test", "retire-field", "test", "retire-field",
            [new SetRetiredOperation("retire-field", "entry", "status", true, retired.Manifest.DefinitionRevision)]));
        var fieldRetired = await service.GetSnapshotAsync();
        Assert.AreEqual("field-retired", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            coordinator.ApplyAsync(Mutation("on-retired", new("on-retired", "entry", "status", "later", "Later", fieldRetired.Manifest.DefinitionRevision))))).Code);
        await coordinator.ApplyAsync(new("test", "retire-entity", "test", "retire-entity",
            [new SetRetiredOperation("retire-entity", "entry", null, true, fieldRetired.Manifest.DefinitionRevision)]));
        var entityRetired = await service.GetSnapshotAsync();
        Assert.AreEqual("entity-retired", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            coordinator.ApplyAsync(Mutation("on-retired-type", new("on-retired-type", "entry", "status", "later", "Later", entityRetired.Manifest.DefinitionRevision))))).Code);
    }

    [TestMethod]
    public async Task AFieldHoldsAtMostThirtyTwoOptions()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        var options = Enumerable.Range(1, 31).Select(index => $"o{index}").ToArray();
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", options),
        ]));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // The thirty-second is the last one a field takes, as addField allows.
        await coordinator.ApplyAsync(Mutation("o32", new("o32", "entry", "status", "o32", "o32", revision)));
        var full = await service.GetSnapshotAsync();
        Assert.HasCount(32, Status(full).Options);
        StringAssert.Contains((await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            coordinator.ApplyAsync(Mutation("o33", new("o33", "entry", "status", "o33", "o33", full.Manifest.DefinitionRevision))))).Message,
            "holds at most 32");
    }

    [TestMethod]
    public async Task UndoTakesTheOptionAwayAndLeavesTheFieldAsItWas()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateAsync(workspace);
        var before = await service.GetSnapshotAsync();

        // A field with no option metadata gets none back.
        var added = await coordinator.ApplyAsync(Mutation("add", new("add", "entry", "status", "later", "Later", before.Manifest.DefinitionRevision, "teal")));
        await service.CompensateRevisionAsync(added.RevisionId, "undo-add");
        var undone = await service.GetSnapshotAsync();
        Assert.AreEqual(JsonSerializer.Serialize(before.Entities), JsonSerializer.Serialize(undone.Entities));
        Assert.IsEmpty(Status(undone).Choices);

        // A field that had labels keeps them; only the added option goes.
        await coordinator.ApplyAsync(new("test", "label", "test", "label",
            [new SetChoiceMetadataOperation("label", "entry", "status", "new", "Fresh", false, undone.Manifest.DefinitionRevision)]));
        var labelled = await service.GetSnapshotAsync();
        var again = await coordinator.ApplyAsync(Mutation("again", new("again", "entry", "status", "later", "Later", labelled.Manifest.DefinitionRevision)));
        await service.CompensateRevisionAsync(again.RevisionId, "undo-again");
        Assert.AreEqual(JsonSerializer.Serialize(labelled.Entities), JsonSerializer.Serialize((await service.GetSnapshotAsync()).Entities));
    }

    [TestMethod]
    public async Task UndoIsRefusedByNameWhileARecordHoldsTheOption()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateAsync(workspace);
        await service.CreateRecordAsync(new("entry", "r", new Dictionary<string, object?> { ["status"] = "new" }, Context("create")));
        var before = await service.GetSnapshotAsync();
        var added = await coordinator.ApplyAsync(Mutation("add", new("add", "entry", "status", "later", "Later", before.Manifest.DefinitionRevision)));
        await service.SetFieldAsync(new("entry", "r", "status", 1, "later", Context("edit-later")));
        var held = await service.GetSnapshotAsync();

        var refusal = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() => service.CompensateRevisionAsync(added.RevisionId, "undo-held"));
        Assert.AreEqual("Entry r holds Later in Status, so adding Later is not undone. Choose another option on every record that holds it and undo again, or retire Later instead.",
            refusal.Message);
        Assert.AreEqual(JsonSerializer.Serialize(held), JsonSerializer.Serialize(await service.GetSnapshotAsync()));

        // Once nothing holds it, the undo goes through.
        await service.SetFieldAsync(new("entry", "r", "status", 2, "done", Context("edit-done")));
        await service.CompensateRevisionAsync(added.RevisionId, "undo-free");
        CollectionAssert.AreEqual(new[] { "new", "done" }, Status(await service.GetSnapshotAsync()).Options.ToArray());
    }

    [TestMethod]
    public async Task UndoIsRefusedWhileADeletedRecordKeepsTheOptionForItsOwnUndo()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await CreateAsync(workspace);
        var before = await service.GetSnapshotAsync();
        var added = await coordinator.ApplyAsync(Mutation("add", new("add", "entry", "status", "later", "Later", before.Manifest.DefinitionRevision)));
        await service.CreateRecordAsync(new("entry", "gone", new Dictionary<string, object?> { ["status"] = "later" }, Context("create")));
        await service.DeleteRecordAsync(new("entry", "gone", 1, Context("delete")));
        var deleted = await service.GetSnapshotAsync();
        Assert.IsEmpty(deleted.Records);

        var refusal = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() => service.CompensateRevisionAsync(added.RevisionId, "undo-kept"));
        StringAssert.StartsWith(refusal.Message, "The deleted Entry gone held Later in Status, and keeps it so its deletion can be undone");
        Assert.AreEqual(JsonSerializer.Serialize(deleted), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
    }

    [TestMethod]
    public async Task TheReviewLineSaysWhatIsAddedWhereAndInWhichColour()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await CreateAsync(workspace);
        var active = await service.GetSnapshotAsync();
        var changeSet = new NendoChangeSet([new NendoMutation("proposal", "diff", "test", "Add an option",
            [new AddChoiceOperation("add", "entry", "status", "later", "Later", active.Manifest.DefinitionRevision, "teal")])]);
        var entry = SemanticDiff.From(changeSet, active).Single();
        Assert.AreEqual("addChoice", entry.Kind);
        Assert.AreEqual("Add the option Later to Status on Entry, after its other options, and colour it teal; records can choose it at once.", entry.Summary);
        CollectionAssert.AreEqual(new[] { "entry", "status", "later" }, entry.SemanticIds.ToArray());
        Assert.AreEqual(NendoReversibilityClass.ReversibleWithRetainedState, entry.Reversibility);
    }

    [TestMethod]
    public void TheCanonicalPayloadParsesAndAMissingLabelIsRefusedByName()
    {
        using var payload = JsonDocument.Parse("""{"entityId":"entry","fieldId":"status","choiceId":"later","displayName":"Later","tone":"teal","expectedDefinitionRevision":3}""");
        NendoCanonicalOperations.Check("schema.addChoice", payload.RootElement);
        using var missing = JsonDocument.Parse("""{"entityId":"entry","fieldId":"status","choiceId":"later","expectedDefinitionRevision":3}""");
        Assert.AreEqual("Canonical operation property displayName requires text.",
            Assert.ThrowsExactly<NendoValidationException>(() => NendoCanonicalOperations.Check("schema.addChoice", missing.RootElement)).Message);
        // The undo is the host's: no client can send it.
        using var removal = JsonDocument.Parse("""{"entityId":"entry","fieldId":"status","choiceId":"later","expectedDefinitionRevision":3}""");
        Assert.ThrowsExactly<NendoValidationException>(() => NendoCanonicalOperations.Check("schema.removeChoice", removal.RootElement));
    }

    private static async Task<(NendoWriteCoordinator Coordinator, NendoApplicationService Service)> CreateAsync(EngineTestWorkspace workspace)
    {
        var coordinator = await workspace.CreateAsync(); var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Choices", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("t", "entry", "title", "Title", "title", NendoStorageKind.Text, false, "singleLine"),
            new AddFieldOperation("f", "entry", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
        ]));
        return (coordinator, service);
    }

    private static NendoFieldSnapshot Status(NendoSessionSnapshot snapshot) =>
        snapshot.Entities.Single().Fields.Single(field => field.FieldId == "status");

    private static NendoMutation Mutation(string key, AddChoiceOperation operation) => new("test", key, "test", key, [operation]);
}
