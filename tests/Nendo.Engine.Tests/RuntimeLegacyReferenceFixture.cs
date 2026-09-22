using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>Task-owned reconstruction of a populated legacy Reference field without binding metadata.</summary>
public static class RuntimeLegacyReferenceFixture
{
    public static async Task CreateAsync(string path, int count = 2, bool required = false, bool selfReference = false)
    {
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(path, "legacy-reference-fixture"))
        {
            await coordinator.ApplyAsync(new("fixture", "schema", "test", "Legacy fixture schema", [
                new CreateEntityOperation("source", "source", "Legacy notes", "sources"),
                new AddFieldOperation("title", "source", "title", "Title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("ref", "source", "ref", "Related record", "legacy_ref", NendoStorageKind.Text, required),
                new CreateEntityOperation("target", "target", "Targets", "targets"),
                new AddFieldOperation("label", "target", "label", "Label", "label", NendoStorageKind.Text, true),
            ]));
            var records = new List<NendoOperation>();
            for (var index = 1; index <= count; index++)
                records.Add(new CreateRecordOperation($"s{index}", "source", $"s{index}", new Dictionary<string, object?>
                { ["title"] = $"Legacy note {index}", ["ref"] = $" old value {index} · æøå " }));
            if (!selfReference)
                for (var index = 1; index <= 2; index++)
                    records.Add(new CreateRecordOperation($"t{index}", "target", $"t{index}", new Dictionary<string, object?> { ["label"] = $"Target {index}" }));
            if (records.Count > 0) await coordinator.ApplyAsync(new("fixture", "records", "test", "Reconstructed legacy values", records));
        }
        // Fixture construction only: current production refuses assigning non-null unbound references.
        // Preserve values and physical constraints while reproducing the older unbound metadata shape.
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "UPDATE __nendo_field SET storage_kind='Reference' WHERE field_id='ref';";
        await command.ExecuteNonQueryAsync();
    }
}
