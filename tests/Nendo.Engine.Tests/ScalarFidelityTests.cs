using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ScalarFidelityTests
{
    [TestMethod]
    public void ExcessPrecisionAndUnderflowAreRejectedRatherThanRounded()
    {
        foreach (var literal in new[] { "0.12345678901234567890123456789", "1e-29", "79228162514264337593543950336" })
        {
            using var value = JsonDocument.Parse(literal);
            Assert.ThrowsExactly<NendoValidationException>(() => ExactDecimal.Read(value.RootElement));
        }
        foreach (var literal in new[] { "0.1234567890123456789012345678", "79228162514264337593543950335", "1e-28", "1.00000000000000000000000000000" })
        {
            using var value = JsonDocument.Parse(literal);
            Assert.AreEqual(value.RootElement.GetDecimal(), ExactDecimal.Read(value.RootElement));
        }
    }

    [TestMethod]
    public async Task LegacyNumericValuesReadWithoutRewriteAndNewWritesRaiseCompatibility()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(Mutation("schema", [new CreateEntityOperation("e", "e", "Entry", "entries"),
            new AddFieldOperation("d", "e", "d", "Decimal", "decimal_value", NendoStorageKind.Decimal, false)]));
        await coordinator.ApplyAsync(Mutation("create", [new CreateRecordOperation("c", "e", "one", new Dictionary<string, object?> { ["d"] = 0.5m })]));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        // A closed fixture reproduces the pre-P5 NUMERIC representation, not a product mutation path.
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = workspace.FilePath, Pooling = false }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE entries SET decimal_value = 0.5; UPDATE __nendo_manifest SET minimum_host_version = '1.1.0';";
            await command.ExecuteNonQueryAsync();
        }
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var legacy = await workspace.OpenAsync();
        var read = await legacy.GetSnapshotAsync();
        Assert.AreEqual(0.5m, read.Records.Single().Values["d"].GetDecimal());
        Assert.AreEqual("1.1.0", read.Manifest.MinimumHostVersion);
        await using (var stream = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            using var copy = new MemoryStream();
            await stream.CopyToAsync(copy);
            CollectionAssert.AreEqual(bytes, copy.ToArray());
        }
        await legacy.ApplyAsync(Mutation("exact", [new SetFieldOperation("exact", "e", "one", "d", 1, 0.1234567890123456789012345678m)]));
        Assert.AreEqual("1.3.0", (await legacy.GetSnapshotAsync()).Manifest.MinimumHostVersion);
    }

    [TestMethod]
    public async Task DecimalIntegerTextAndNullSurviveCompensationAndReopenExactly()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(Mutation("schema", [
            new CreateEntityOperation("entity", "scalar", "Scalars", "scalars"),
            new AddFieldOperation("integer", "scalar", "integer", "Integer", "integer_value", NendoStorageKind.Integer, false),
            new AddFieldOperation("decimal", "scalar", "decimal", "Decimal", "decimal_value", NendoStorageKind.Decimal, false),
            new AddFieldOperation("text", "scalar", "text", "Text", "text_value", NendoStorageKind.Text, false),
            new AddFieldOperation("empty", "scalar", "empty", "Empty", "empty_value", NendoStorageKind.Text, false),
            new AddFieldOperation("null", "scalar", "null", "Null", "null_value", NendoStorageKind.Boolean, false),
        ]));
        var exact = 0.1234567890123456789012345678m;
        await coordinator.ApplyAsync(Mutation("create", [new CreateRecordOperation("create", "scalar", "one",
            new Dictionary<string, object?> { ["integer"] = long.MaxValue, ["decimal"] = exact, ["text"] = "  æøå 🌱\r\nnext  ", ["empty"] = "", ["null"] = null })]));
        var before = await coordinator.GetSnapshotAsync();
        Assert.AreEqual(NendoFormat.ScalarMinimumHostVersion, before.Manifest.MinimumHostVersion);
        var record = before.Records.Single();
        Assert.AreEqual(long.MaxValue, record.Values["integer"].GetInt64());
        Assert.AreEqual(exact, record.Values["decimal"].GetDecimal());
        Assert.AreEqual("", record.Values["empty"].GetString());
        Assert.AreEqual(JsonValueKind.Null, record.Values["null"].ValueKind);
        var edit = await coordinator.ApplyAsync(Mutation("edit", [new SetFieldOperation("edit", "scalar", "one", "decimal", 1, decimal.MaxValue)]));
        Assert.AreEqual(decimal.MaxValue, (await coordinator.GetSnapshotAsync()).Records.Single().Values["decimal"].GetDecimal());
        await new NendoApplicationService(coordinator).CompensateRevisionAsync(edit.RevisionId, "undo");
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var reopened = await workspace.OpenAsync();
        var final = (await reopened.GetSnapshotAsync()).Records.Single();
        foreach (var pair in record.Values) Assert.AreEqual(pair.Value.GetRawText(), final.Values[pair.Key].GetRawText());
    }

    [TestMethod]
    public async Task InvalidTimestampAndUuidRejectTheEntireMutation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await coordinator.ApplyAsync(Mutation("schema", [new CreateEntityOperation("e", "e", "Entry", "entries"),
            new AddFieldOperation("t", "e", "t", "When", "time_value", NendoStorageKind.DateTime, false),
            new AddFieldOperation("u", "e", "u", "UUID", "uuid_value", NendoStorageKind.Uuid, false)]));
        foreach (var values in new[] {
            new Dictionary<string, object?> { ["t"] = "2026-09-06T12:30:00" },
            new Dictionary<string, object?> { ["t"] = "2026-02-30T12:30:00Z" },
            new Dictionary<string, object?> { ["u"] = "not-a-uuid" },
        })
            await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(Mutation(Guid.NewGuid().ToString(), [new CreateRecordOperation("create", "e", "bad", values)])));
        Assert.IsEmpty((await coordinator.GetSnapshotAsync()).Records);
        await coordinator.ApplyAsync(Mutation("valid", [new CreateRecordOperation("valid", "e", "ok", new Dictionary<string, object?> {
            ["t"] = "2026-09-06T12:30:00.1234567+02:00", ["u"] = "95e7a1b4-c54a-41bb-83cc-9eae7adf61bb" })]));
    }

    private static NendoMutation Mutation(string key, IReadOnlyList<NendoOperation> operations) => new("scalar", key, "test", key, operations);
}
