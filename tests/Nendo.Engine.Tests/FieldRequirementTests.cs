using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class FieldRequirementTests
{
    [TestMethod]
    public async Task RequiredReferenceIsAddedBackfilledAndConstrainedInOneReviewedProposal()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", [
            new CreateEntityOperation("target", "target", "Target", "targets"),
            new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("source", "source", "Source", "sources"),
        ]));
        await service.CreateRecordAsync(new("target", "t", new Dictionary<string, object?> { ["label"] = "Target" }, Context("target")));
        await service.CreateRecordAsync(new("source", "s", new Dictionary<string, object?>(), Context("source")));
        var before = await service.GetSnapshotAsync();
        var change = new NendoChangeSet([
            Mutation("add", new AddFieldOperation("add", "source", "ref", "Target", "target_id", NendoStorageKind.Reference, false),
                new ConfigureReferenceOperation("bind", "source", "ref", "target", "label", before.Manifest.DefinitionRevision)),
            Mutation("fill", new SetFieldOperation("fill", "source", "s", "ref", 1, "t", 1)),
            Mutation("require", new SetFieldRequiredOperation("require", "source", "ref", true, before.Manifest.DefinitionRevision + 1)),
        ]);
        var preview = await service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Required reference", "test", change));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        var after = await service.GetSnapshotAsync();
        Assert.IsTrue(after.Entities.Single(e => e.EntityId == "source").Fields.Single().Required);
        Assert.AreEqual("t", after.Records.Single(r => r.EntityId == "source").Values["ref"].GetString());
        Assert.AreEqual(2L, after.Records.Single(r => r.EntityId == "source").RecordVersion);
        Assert.AreEqual(before.Manifest.DefinitionRevision + 2, after.Manifest.DefinitionRevision);
        Assert.AreEqual(before.Manifest.DataRevision + 1, after.Manifest.DataRevision);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => service.CreateRecordAsync(new("source", "missing", new Dictionary<string, object?>(), Context("missing"))));
        var requiredRevision = (await service.GetHistoryAsync()).Single(r => r.Description == "require");
        await service.CompensateRevisionAsync(requiredRevision.RevisionId, "optional-again");
        Assert.IsFalse((await service.GetSnapshotAsync()).Entities.Single(e => e.EntityId == "source").Fields.Single().Required);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        _ = await workspace.OpenAsync();
    }

    [TestMethod]
    public async Task RetiredRequiredFieldCanBeExplicitlyBackfilledBeforeReactivation()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("schema", new CreateEntityOperation("e", "e", "Entry", "entries"),
            new AddFieldOperation("f", "e", "title", "Title", "title", NendoStorageKind.Text, true)));
        await coordinator.ApplyAsync(Mutation("retire", new SetRetiredOperation("retire", "e", "title", true, 1)));
        await service.CreateRecordAsync(new("e", "r", new Dictionary<string, object?>(), Context("new")));
        var before = await service.GetSnapshotAsync();
        var proposal = await service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Backfill and reactivate", "test", new([
            Mutation("fill", new BackfillRetiredFieldOperation("fill", "e", "r", "title", 1, "Explicit title")),
            Mutation("reactivate", new SetRetiredOperation("reactivate", "e", "title", false, 2)),
        ])));
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        var after = await service.GetSnapshotAsync();
        Assert.IsFalse(after.Entities.Single().Fields.Single().Retired);
        Assert.AreEqual("Explicit title", after.Records.Single().Values["title"].GetString());
        Assert.AreEqual(2L, after.Records.Single().RecordVersion);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task PopulatedLegacyReferenceConversionIsExplicitAndAtomic(bool required)
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("schema",
            new CreateEntityOperation("t", "target", "Target", "targets"),
            new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
            new CreateEntityOperation("s", "source", "Source", "sources"),
            new AddFieldOperation("ref", "source", "ref", "Reference", "legacy_ref", NendoStorageKind.Reference, required)));
        await service.CreateRecordAsync(new("target", "t", new Dictionary<string, object?> { ["label"] = "Chosen target" }, Context("target")));
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        // Fixture for a pre-reference-metadata file: its stored legacy value has no inferred target.
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString()))
        {
            await connection.OpenAsync(); await using var command = connection.CreateCommand();
            command.CommandText = "INSERT INTO sources (__nendo_record_id,__nendo_record_version,legacy_ref) VALUES ('s',1,'old unbound value');";
            await command.ExecuteNonQueryAsync();
        }
        coordinator = await workspace.OpenAsync(); service = new(coordinator);
        var before = await service.GetSnapshotAsync();
        NendoChangeSet Conversion(long targetVersion)
        {
            var mutations = new List<NendoMutation>(); var definition = before.Manifest.DefinitionRevision;
            if (required) mutations.Add(Mutation("optional", new SetFieldRequiredOperation("optional", "source", "ref", false, definition++)));
            mutations.Add(Mutation("clear", new SetFieldOperation("clear", "source", "s", "ref", 1, null)));
            mutations.Add(Mutation("bind", new ConfigureReferenceOperation("bind", "source", "ref", "target", "label", definition++)));
            mutations.Add(Mutation("assign", new SetFieldOperation("assign", "source", "s", "ref", 2, "t", targetVersion)));
            if (required) mutations.Add(Mutation("require", new SetFieldRequiredOperation("require", "source", "ref", true, definition)));
            return new(mutations);
        }
        var invalid = await service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Invalid conversion", "test", Conversion(999)));
        Assert.AreEqual(NendoProposalState.Invalid, invalid.State);
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        var proposal = await service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Explicit conversion", "test", Conversion(1)));
        Assert.AreEqual(NendoProposalState.Previewable, proposal.State);
        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(required, after.Entities.Single(e => e.EntityId == "source").Fields.Single().Required);
        Assert.AreEqual(new NendoReferenceDefinition("target", "label"), after.Entities.Single(e => e.EntityId == "source").Fields.Single().Reference);
        Assert.AreEqual("t", after.Records.Single(r => r.EntityId == "source").Values["ref"].GetString());
        Assert.AreEqual(3L, after.Records.Single(r => r.EntityId == "source").RecordVersion);
        await coordinator.DisposeAsync(); workspace.Forget(coordinator);
        coordinator = await workspace.OpenAsync();
        var reopened = await coordinator.GetSnapshotAsync();
        Assert.AreEqual(after.Manifest, reopened.Manifest);
        Assert.AreEqual(JsonSerializer.Serialize(after.Entities), JsonSerializer.Serialize(reopened.Entities));
        Assert.AreEqual(JsonSerializer.Serialize(after.Records), JsonSerializer.Serialize(reopened.Records));
    }

    [TestMethod]
    public async Task CompensatingABackfillOfAStillRetiredFieldRestoresTheRetainedValue()
    {
        await using var workspace = new EngineTestWorkspace(); var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("schema", new CreateEntityOperation("e", "e", "Entry", "entries"),
            new AddFieldOperation("f", "e", "title", "Title", "title", NendoStorageKind.Text, false)));
        await service.CreateRecordAsync(new("e", "r", new Dictionary<string, object?> { ["title"] = "Original" }, Context("new")));
        await coordinator.ApplyAsync(Mutation("retire", new SetRetiredOperation("retire", "e", "title", true, 1)));

        // Backfill the retained value while the field is still retired, then compensate.
        var backfill = await coordinator.ApplyAsync(Mutation("backfill",
            new BackfillRetiredFieldOperation("backfill", "e", "r", "title", 1, "Changed")));
        // The inverse of a backfill must itself be a backfill, or it refuses "field-retired"
        // on a field the operation is explicitly meant to repair while retired.
        await service.CompensateRevisionAsync(backfill.RevisionId, "undo-backfill");

        var definition = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("reactivate", new SetRetiredOperation("reactivate", "e", "title", false, definition)));
        var record = (await service.GetSnapshotAsync()).Records.Single();
        Assert.AreEqual("Original", record.Values["title"].GetString());
        Assert.AreEqual(3L, record.RecordVersion);
    }

    private static NendoMutation Mutation(string key, params NendoOperation[] operations) => new("test", key, "test", key, operations);
    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
