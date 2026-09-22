using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

// Deliberate damage and legacy reconstruction belong only to disposable tests.
public static class RuntimeRecoveryActionsFixture
{
    public static Task SimulateOutsideEditAsync(string path) => ChangeAsync(path,
        "UPDATE idea SET title = 'Outside runtime fixture edit' WHERE __nendo_record_id = 'idea-1';");

    public static async Task CreateAsync(string root, string repositoryRoot)
    {
        Directory.CreateDirectory(root);
        foreach (var name in new[] { "healthy", "broken", "unknown" })
            await RuntimeLifecycleFixture.CreateAsync(Path.Combine(root, name + ".nendo"), "idea-garden", repositoryRoot);
        var unknown = Path.Combine(root, "unknown.nendo");
        await using (var owner = await NendoWriteCoordinator.OpenAsync(unknown, "owned-recovery-fixture"))
            await new NendoApplicationService(owner).SetFieldAsync(new(
                NendoApplicationService.IdeaEntityId, "idea-1", "field.idea.notes", 1,
                "Private unsupported fixture value", new("owned-fixture", "notes", "test")));
        await ChangeAsync(unknown, "UPDATE __nendo_field SET storage_kind = 'FutureScalar' WHERE field_id = 'field.idea.notes';");
        await ChangeAsync(Path.Combine(root, "broken.nendo"),
            "UPDATE __nendo_ui_property SET value_json = '\"unknown-entity\"' WHERE property_name = 'entityId';");
        var legacy = Path.Combine(root, "legacy.nendo");
        await using (var owner = await NendoWriteCoordinator.CreateAsync(legacy, "owned-legacy-fixture"))
        {
            var service = new NendoApplicationService(owner);
            await service.CreateIdeaSchemaAsync("schema");
            await service.CreateIdeaRecordAsync("legacy-1", "Keep the legacy record", "record");
        }
        await SemanticMetadataTests.StripSemanticMetadataAsync(legacy);
        Directory.CreateDirectory(Path.Combine(root, "sync-hint"));
        await RuntimeLifecycleFixture.CreateAsync(Path.Combine(root, "sync-hint", "hinted.nendo"), "idea-garden", repositoryRoot);
    }

    public static async Task<string> InspectAsync(string path)
    {
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(path);
        var snapshot = await reader.GetSnapshotAsync();
        return JsonSerializer.Serialize(new
        {
            reader.Inspection!.Classification, reader.Inspection.Findings, reader.Capabilities,
            snapshot.Manifest, snapshot.Entities, snapshot.Records, snapshot.UiNodes,
            History = await reader.GetHistoryAsync(),
        });
    }

    private static async Task ChangeAsync(string path, string sql)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }
}
