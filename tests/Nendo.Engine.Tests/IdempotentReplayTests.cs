using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class IdempotentReplayTests
{
    [TestMethod]
    [DataRow("none", false)]
    [DataRow("none", true)]
    [DataRow("unrelated", false)]
    [DataRow("unrelated", true)]
    [DataRow("same-record", false)]
    [DataRow("same-record", true)]
    [DataRow("definition", false)]
    [DataRow("definition", true)]
    public async Task ExactRetryPreservesOriginalReceiptAndLatestAuthority(string interveningChange, bool reopen)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var request = Edit(1, "Edited", "edit-a");
        var original = await service.SetFieldAsync(request);
        switch (interveningChange)
        {
            case "unrelated":
                await service.CreateRecordAsync(new("entity.entry", "entry-2",
                    new Dictionary<string, object?> { ["field.entry.title"] = "Second" }, Context("create-second")));
                break;
            case "same-record":
                await service.SetFieldAsync(Edit(2, "Later value", "edit-b"));
                break;
            case "definition":
                await coordinator.ApplyAsync(new("replay-tests", "add-entity", "test", "Add unrelated entity",
                    [new CreateEntityOperation("add-entity", "entity.other", "Other", "other")]));
                break;
        }

        if (reopen)
        {
            await coordinator.DisposeAsync();
            workspace.Forget(coordinator);
            coordinator = await workspace.OpenAsync();
            service = new(coordinator);
        }
        var before = await service.GetSnapshotAsync();
        var historyBefore = JsonSerializer.Serialize(await service.GetHistoryAsync());
        var authorityLosses = 0;
        coordinator.WriteAuthorityLost += () => authorityLosses++;

        var replay = await service.SetFieldAsync(request);

        Assert.AreEqual(original with { IsIdempotentReplay = true }, replay);
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
        Assert.AreEqual(0, authorityLosses);
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest, after.Manifest);
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize(after.Records));
        Assert.AreEqual(historyBefore, JsonSerializer.Serialize(await service.GetHistoryAsync()));
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(() =>
            service.SetFieldAsync(request with { Value = "Conflicting payload" }));
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);

        var currentVersion = after.Records.Single(record => record.RecordId == "entry-1").RecordVersion;
        var next = await service.SetFieldAsync(Edit(currentVersion, "Next edit", "edit-next"));
        Assert.AreEqual(before.Manifest.ChangeSequence + 1, next.ChangeSequence);
        Assert.AreEqual("Next edit", (await service.GetSnapshotAsync()).Records.Single(
            record => record.RecordId == "entry-1").Values["field.entry.title"].GetString());
    }

    [TestMethod]
    [DataRow("record")]
    [DataRow("history")]
    [DataRow("operation")]
    [DataRow("inverse")]
    [DataRow("proposal")]
    public async Task ExactRetryDoesNotAdoptOutsideChangesEvenWithUnchangedCounters(string changedState)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var request = Edit(1, "Edited", "edit-a");
        var original = await service.SetFieldAsync(request);
        await service.SetFieldAsync(Edit(2, "Later value", "edit-b"));
        await using (var outside = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString()))
        {
            await outside.OpenAsync();
            await using var command = outside.CreateCommand();
            command.CommandText = changedState switch
            {
                "history" => "UPDATE __nendo_revision SET description = 'outside' WHERE revision_id = @revision;",
                "operation" => "UPDATE __nendo_operation SET canonical_json = '{}' WHERE revision_id = @revision;",
                "inverse" => "UPDATE __nendo_operation SET inverse_evidence_json = '{}' WHERE revision_id = @revision;",
                "proposal" => "UPDATE __nendo_revision SET proposal_id = 'outside' WHERE revision_id = @revision;",
                _ => "UPDATE entry SET title = 'outside' WHERE __nendo_record_id = 'entry-1';",
            };
            command.Parameters.AddWithValue("@revision", original.RevisionId);
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }

        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.SetFieldAsync(request));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, coordinator.Health);
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() =>
            service.SetFieldAsync(Edit(3, "Must be refused", "edit-next")));
    }

    [TestMethod]
    public async Task DelayedCompensationRetryPreservesReceiptAndSubsequentEdit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var edited = await service.SetFieldAsync(Edit(1, "Edited", "edit-a"));
        var compensation = await service.CompensateRevisionAsync(edited.RevisionId, "compensate-a");
        await service.SetFieldAsync(Edit(3, "Later value", "edit-b"));
        var before = await service.GetSnapshotAsync();
        var replay = await service.CompensateRevisionAsync(edited.RevisionId, "compensate-a");
        Assert.AreEqual(compensation with { IsIdempotentReplay = true }, replay);
        Assert.AreEqual(before.Manifest, (await service.GetSnapshotAsync()).Manifest);
        Assert.AreEqual(NendoSessionHealth.Normal, coordinator.Health);
        var next = await service.SetFieldAsync(Edit(4, "Next edit", "edit-next"));
        Assert.AreEqual(before.Manifest.ChangeSequence + 1, next.ChangeSequence);
    }

    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("replay-tests", "schema", "test", "Create entry schema",
        [
            new CreateEntityOperation("create-entity", "entity.entry", "Entry", "entry"),
            new AddFieldOperation("add-title", "entity.entry", "field.entry.title", "Title", "title",
                NendoStorageKind.Text, true),
        ]));
        var service = new NendoApplicationService(coordinator);
        await service.CreateRecordAsync(new("entity.entry", "entry-1",
            new Dictionary<string, object?> { ["field.entry.title"] = "First" }, Context("create-first")));
        return service;
    }

    private static NendoSetFieldRequest Edit(long version, string value, string key) =>
        new("entity.entry", "entry-1", "field.entry.title", version, value, Context(key));

    private static NendoRequestContext Context(string key) => new("replay-tests", key, "test");
}
