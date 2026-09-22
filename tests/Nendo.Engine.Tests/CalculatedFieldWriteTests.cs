namespace Nendo.Engine.Tests;

/// <summary>
/// A calculated field has no column. A write that named one was refused as a field
/// that did not exist, which sent a reviewer to the schema — where it was listed. The
/// refusal says it is calculated, names the calculation, and reaches every write path:
/// a single field, a form of fields, and a create.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class CalculatedFieldWriteTests
{
    [TestMethod]
    public async Task AWriteToACalculatedFieldIsRefusedAsCalculatedOnEveryPath()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
        ]));
        await service.CreateRecordAsync(new("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "First" }, Context("n1")));
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Shout the label", [
            new SetBehaviourDefinitionOperation("c", new NendoCalculationDefinition(
                "note.shout", "notes", "shout", "Shout", NendoBehaviourScalar.Text, false, "Concat(label, '!')",
                [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)]), revision),
        ]));
        var note = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1");
        var history = (await service.GetHistoryAsync()).Count;

        var single = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetFieldAsync(new("notes", "n1", "shout", note.RecordVersion, "Typed", Context("single"))));
        var form = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetFieldsAsync(new("notes", "n1", note.RecordVersion,
                new Dictionary<string, object?> { ["label"] = "Edited", ["shout"] = "Typed" }, Context("form"))));
        var create = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.CreateRecordAsync(new("notes", "n2",
                new Dictionary<string, object?> { ["label"] = "Second", ["shout"] = "Typed" }, Context("create"))));
        foreach (var (path, refusal) in new[] { ("set", single), ("form", form), ("create", create) })
        {
            Assert.AreEqual("field-calculated", refusal.Code, path);
            StringAssert.Contains(refusal.Message, "shout", path);
            StringAssert.Contains(refusal.Message, "note.shout", path);
            StringAssert.Contains(refusal.Message, "read-only", path);
        }

        // Nothing committed — the form's stored field did not land without its
        // partner — and a field that is neither stored nor calculated is still not found.
        Assert.HasCount(history, await service.GetHistoryAsync());
        Assert.AreEqual("First", (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1").Values["label"].GetString());
        var missing = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            service.SetFieldAsync(new("notes", "n1", "nowhere", note.RecordVersion, "Typed", Context("missing"))));
        Assert.AreEqual("field-not-found", missing.Code);
    }

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
