using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class P1MutationTests
{
    [TestMethod]
    public async Task IdeaSchemaRecordAndEditReopenWithExactCountersAndAudit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);

        var schema = await service.CreateIdeaSchemaAsync("schema-1");
        var created = await service.CreateIdeaRecordAsync("idea-1", "First idea", "record-1");
        var edited = await service.SetIdeaTitleAsync("idea-1", 1, "Durable idea", "edit-1");

        Assert.AreEqual((1L, 0L, 1L), (schema.DefinitionRevision, schema.DataRevision, schema.ChangeSequence));
        Assert.AreEqual((1L, 1L, 2L), (created.DefinitionRevision, created.DataRevision, created.ChangeSequence));
        Assert.AreEqual((1L, 2L, 3L), (edited.DefinitionRevision, edited.DataRevision, edited.ChangeSequence));
        Assert.IsFalse(string.IsNullOrWhiteSpace(schema.OperationDigest));
        Assert.IsFalse(string.IsNullOrWhiteSpace(created.OperationDigest));
        Assert.IsFalse(string.IsNullOrWhiteSpace(edited.OperationDigest));

        var beforeClose = await service.GetSnapshotAsync();
        var applicationId = beforeClose.Manifest.ApplicationId;
        var instanceId = beforeClose.Manifest.InstanceId;
        AssertIdea(beforeClose, "idea-1", "Durable idea", 2);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var reopened = await workspace.OpenAsync();
        var reopenedService = new NendoApplicationService(reopened);
        var snapshot = await reopenedService.GetSnapshotAsync();
        var history = await reopenedService.GetHistoryAsync();

        Assert.AreEqual(applicationId, snapshot.Manifest.ApplicationId);
        Assert.AreEqual(instanceId, snapshot.Manifest.InstanceId);
        Assert.AreEqual((1L, 2L, 3L), (
            snapshot.Manifest.DefinitionRevision,
            snapshot.Manifest.DataRevision,
            snapshot.Manifest.ChangeSequence));
        AssertIdea(snapshot, "idea-1", "Durable idea", 2);
        Assert.HasCount(4, history);
        Assert.AreEqual(NendoRevisionLane.Genesis, history[0].Lane);
        Assert.AreEqual(NendoRevisionLane.Definition, history[1].Lane);
        Assert.HasCount(2, history[1].Operations);
        CollectionAssert.AreEqual(
            new[] { "schema.createEntity", "schema.addField" },
            history[1].Operations.Select(operation => operation.OperationType).ToArray());
        Assert.AreEqual(NendoRevisionLane.Data, history[2].Lane);
        Assert.AreEqual(NendoRevisionLane.Data, history[3].Lane);
        Assert.AreEqual(NendoReversibilityClass.ReversibleWithRetainedState, history[3].Operations[0].Reversibility);
        Assert.AreEqual("edit-1", history[3].IdempotencyKey);
        Assert.AreEqual(edited.OperationDigest, history[3].OperationDigest);
    }

    [TestMethod]
    public async Task ExactRetryReturnsOriginalResultAndChangedPayloadConflicts()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema-1");
        await service.CreateIdeaRecordAsync("idea-1", "First", "record-1");

        var first = await service.SetIdeaTitleAsync("idea-1", 1, "Edited", "edit-retry");
        var replay = await service.SetIdeaTitleAsync("idea-1", 1, "Edited", "edit-retry");

        Assert.IsFalse(first.IsIdempotentReplay);
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.AreEqual(first.RevisionId, replay.RevisionId);
        Assert.AreEqual(first.OperationDigest, replay.OperationDigest);
        Assert.AreEqual(first.ChangeSequence, replay.ChangeSequence);
        await Assert.ThrowsExactlyAsync<NendoIdempotencyConflictException>(
            () => service.SetIdeaTitleAsync("idea-1", 1, "Different", "edit-retry"));

        var snapshot = await service.GetSnapshotAsync();
        Assert.AreEqual(3L, snapshot.Manifest.ChangeSequence);
        AssertIdea(snapshot, "idea-1", "Edited", 2);
        Assert.HasCount(4, await service.GetHistoryAsync());
    }

    [TestMethod]
    public async Task ConcurrentStudioWritesAreSerializedByOneCoordinator()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema-1");

        await Task.WhenAll(
            service.CreateIdeaRecordAsync("idea-a", "Alpha", "record-a"),
            service.CreateIdeaRecordAsync("idea-b", "Beta", "record-b"));

        var snapshot = await service.GetSnapshotAsync();
        Assert.AreEqual(2L, snapshot.Manifest.DataRevision);
        Assert.AreEqual(3L, snapshot.Manifest.ChangeSequence);
        Assert.HasCount(2, snapshot.Records);
        CollectionAssert.AreEquivalent(
            new[] { "idea-a", "idea-b" },
            snapshot.Records.Select(record => record.RecordId).ToArray());
    }

    [TestMethod]
    public async Task OutsideRecordChangeFailsClosedBeforeNextMutation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await service.CreateIdeaSchemaAsync("schema-1");
        await service.CreateIdeaRecordAsync("idea-1", "Trusted", "record-1");
        var authorityLosses = 0;
        coordinator.WriteAuthorityLost += () => throw new InvalidOperationException("Faulty test observer");
        service.WriteAuthorityLost += () =>
        {
            Assert.IsFalse(service.Capabilities.ReadData);
            authorityLosses++;
        };

        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath,
            Mode = SqliteOpenMode.ReadWrite,
            Pooling = false,
            DefaultTimeout = 2,
        };
        await using (var outside = new SqliteConnection(builder.ToString()))
        {
            await outside.OpenAsync();
            await using var command = outside.CreateCommand();
            command.CommandText = "UPDATE idea SET title = 'outside' WHERE __nendo_record_id = 'idea-1';";
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }

        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(
            () => service.SetIdeaTitleAsync("idea-1", 1, "Host edit", "edit-after-outside"));
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, coordinator.Health);
        Assert.AreEqual(1, authorityLosses);
        Assert.AreEqual("authority-lost", coordinator.Inspection!.Findings.Single().Code);
        Assert.IsNull(coordinator.Inspection.Manifest);
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.GetSnapshotAsync());
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.GetHistoryAsync());
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.SetIdeaTitleAsync("idea-1", 1, "Denied again", "retry"));
        Assert.AreEqual(1, authorityLosses);
        // Only an explicit fresh, read-only classification may adopt these bytes.
        await coordinator.DisposeAsync();
        await using var inspected = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var snapshot = await inspected.GetSnapshotAsync();
        AssertIdea(snapshot, "idea-1", "outside", 1);
        Assert.AreEqual(2L, snapshot.Manifest.ChangeSequence);
        Assert.AreEqual(1, authorityLosses);
    }

    private static void AssertIdea(
        NendoSessionSnapshot snapshot,
        string recordId,
        string title,
        long version)
    {
        Assert.HasCount(1, snapshot.Entities);
        var entity = snapshot.Entities[0];
        Assert.AreEqual(NendoApplicationService.IdeaEntityId, entity.EntityId);
        Assert.AreEqual("Idea", entity.DisplayName);
        Assert.HasCount(1, entity.Fields);
        Assert.AreEqual(NendoApplicationService.IdeaTitleFieldId, entity.Fields[0].FieldId);
        Assert.IsTrue(entity.Fields[0].Required);
        var record = snapshot.Records.Single(value => value.RecordId == recordId);
        Assert.AreEqual(version, record.RecordVersion);
        Assert.AreEqual(title, record.Values[NendoApplicationService.IdeaTitleFieldId].GetString());
    }
}
