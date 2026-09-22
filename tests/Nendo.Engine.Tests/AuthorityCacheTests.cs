using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class AuthorityCacheTests
{
    [TestMethod]
    [DataRow("record", "page")]
    [DataRow("history", "history")]
    [DataRow("inverse", "receipt")]
    [DataRow("schema", "definition")]
    [DataRow("operation", "write")]
    [DataRow("missing-manifest", "definition")]
    public async Task RepeatedLocalCommitsDoNotHideUncountedOutsideChanges(string target, string read)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        NendoApplyResult? last = null;
        for (var index = 1; index <= 12; index++)
            last = await service.SetFieldAsync(Edit(index, $"edit-{index}"));
        Assert.AreEqual(1L, coordinator.ReadDiagnostics.FullAuthorityScans);
        await OutsideAsync(workspace.FilePath, target switch
        {
            "history" => "UPDATE __nendo_revision SET description = 'outside' WHERE revision_id = @revision;",
            "inverse" => "UPDATE __nendo_operation SET inverse_evidence_json = '{}' WHERE revision_id = @revision;",
            "schema" => "UPDATE __nendo_field SET display_name = 'outside';",
            "operation" => "UPDATE __nendo_operation SET canonical_json = '{}' WHERE revision_id = @revision;",
            "missing-manifest" => "DELETE FROM __nendo_manifest;",
            _ => "UPDATE data_cache SET text = 'outside';",
        }, last!.RevisionId);
        var notifications = 0;
        coordinator.WriteAuthorityLost += () => notifications++;
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(async () =>
        {
            switch (read)
            {
                case "page": await service.QueryRecordsAsync(new("entity.cache")); break;
                case "history": await service.QueryHistoryAsync(new()); break;
                case "receipt": await service.GetMutationReceiptAsync(new("cache", "edit-12")); break;
                case "definition": await service.GetDefinitionSnapshotAsync(); break;
                default: await service.SetFieldAsync(Edit(13, "refuse")); break;
            }
        });
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, coordinator.Health);
        Assert.AreEqual(1, notifications);
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.QueryRecordsAsync(new("entity.cache")));
        Assert.AreEqual(1, notifications);
    }

    [TestMethod]
    public async Task ReadOnlyExternalConnectionAndRolledBackMutationPreserveCachedAuthority()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        var before = await service.GetDefinitionSnapshotAsync();
        var metrics = coordinator.ReadDiagnostics;
        await OutsideAsync(workspace.FilePath, "SELECT COUNT(*) FROM data_cache;", "unused");
        await OutsideAsync(workspace.FilePath, "BEGIN; UPDATE data_cache SET text = 'rolled back outside'; ROLLBACK;", "unused");
        coordinator.BeforeCommitAuthorityRead = () => throw new IOException("Injected before commit");
        await Assert.ThrowsExactlyAsync<IOException>(() => service.SetFieldAsync(Edit(1, "rollback")));
        coordinator.BeforeCommitAuthorityRead = null;
        Assert.IsNull(await service.GetMutationReceiptAsync(new("cache", "rollback")));
        Assert.AreEqual(before.Manifest, (await service.GetDefinitionSnapshotAsync()).Manifest);
        var edited = await service.SetFieldAsync(Edit(1, "rollback"));
        Assert.AreEqual(before.Manifest.ChangeSequence + 1, edited.ChangeSequence);
        for (var index = 0; index < 8; index++)
        {
            Assert.HasCount(1, (await service.QueryRecordsAsync(new("entity.cache"))).Items);
            Assert.IsNotEmpty((await service.QueryHistoryAsync(new())).Items);
            Assert.IsEmpty((await service.GetDefinitionSnapshotAsync()).Records);
        }
        Assert.AreEqual(metrics, coordinator.ReadDiagnostics, "Ordinary reads and writes must not run full projections or integrity scans.");
        var verified = await service.VerifyIntegrityAsync();
        Assert.AreEqual(edited.ChangeSequence, verified.IntegrityChangeSequence);
        Assert.IsNotNull(verified.IntegrityCheckedAt);
        Assert.AreEqual(metrics.IntegrityChecks + 1, coordinator.ReadDiagnostics.IntegrityChecks);
    }

    [TestMethod]
    public async Task OutsideCommitImmediatelyAfterLocalCommitIsDetectedBeforeNextRead()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        coordinator.AfterCommit = () => OutsideAsync(workspace.FilePath, "UPDATE data_cache SET text = 'outside';", "unused").GetAwaiter().GetResult();
        var receipt = await service.SetFieldAsync(Edit(1, "committed"));
        Assert.IsFalse(receipt.IsIdempotentReplay, "The local commit succeeded before the later outside commit.");
        coordinator.AfterCommit = null;
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => service.GetSnapshotAsync());
        Assert.AreEqual(NendoSessionHealth.RecoveryRequired, coordinator.Health);
    }

    [TestMethod]
    public async Task CachedDefinitionProjectsCurrentRecordsAndRecompilesOnDefinitionChange()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        Assert.IsTrue((await service.PromoteProposalAsync(proposal.ProposalId)).Applied);
        var first = await service.CompileSemanticDefinitionAsync();
        Assert.IsTrue(first.IsValid);
        Assert.IsEmpty(first.App().Records);
        await service.CreateRecordAsync(new(NendoApplicationService.IdeaEntityId, "idea-one", new Dictionary<string, object?>
        {
            [NendoApplicationService.IdeaTitleFieldId] = "Current title",
            [NendoApplicationService.IdeaNotesFieldId] = "A note",
            [NendoApplicationService.IdeaStatusFieldId] = "Idea",
            [NendoApplicationService.IdeaEnergyFieldId] = "Medium",
            [NendoApplicationService.IdeaCreatedDateFieldId] = "2026-09-05",
            [NendoApplicationService.IdeaNextActionFieldId] = "Try",
        }, new("cache", "create-idea", "test")));
        var current = await service.CompileSemanticUiAsync();
        Assert.AreEqual(1L, service.DefinitionCompilationCount);
        Assert.HasCount(1, current.App().Records);
        Assert.AreNotEqual(first.App().Digest, current.App().Digest);
        var direct = new NendoSemanticCompiler().Compile(await service.GetSnapshotAsync());
        Assert.AreEqual(direct.App().Digest, current.App().Digest);
        var metrics = coordinator.ReadDiagnostics;
        for (var index = 0; index < 8; index++) await service.CompileSemanticDefinitionAsync();
        Assert.AreEqual(metrics, coordinator.ReadDiagnostics);
        Assert.AreEqual(1L, service.DefinitionCompilationCount);
        await coordinator.ApplyAsync(new("cache", "new-definition", "test", "Add other type", [
            new CreateEntityOperation("add-other", "entity.other", "Other", "data_other")]));
        var changed = await service.CompileSemanticUiAsync();
        Assert.AreEqual(2L, service.DefinitionCompilationCount);
        Assert.AreEqual(current.App().Records[0].Version, changed.App().Records[0].Version);
        Assert.AreEqual(new NendoSemanticCompiler().Compile(await service.GetSnapshotAsync()).App().Digest, changed.App().Digest);
    }

    private static NendoSetFieldRequest Edit(long version, string key) =>
        new("entity.cache", "record-one", "field.cache", version, key, new("cache", key, "test"));

    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("cache", "schema", "test", "Create type", [
            new CreateEntityOperation("create-type", "entity.cache", "Cache", "data_cache"),
            new AddFieldOperation("create-field", "entity.cache", "field.cache", "Text", "text", NendoStorageKind.Text, true)]));
        var service = new NendoApplicationService(coordinator);
        await service.CreateRecordAsync(new("entity.cache", "record-one", new Dictionary<string, object?> { ["field.cache"] = "Original" }, new("cache", "create", "test")));
        return service;
    }

    private static async Task OutsideAsync(string path, string sql, string revision)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("@revision", revision);
        await command.ExecuteNonQueryAsync();
    }
}
