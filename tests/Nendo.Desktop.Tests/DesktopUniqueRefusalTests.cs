using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// ADR-0020: a duplicate refused on a form reaches the Workbench with the holding record's ID
/// as its own field, so the form can name that record by its label. The sentence itself names
/// it by ID, as every audited refusal does; a refusal about no record carries no ID at all.
/// </summary>
[TestClass]
public sealed class DesktopUniqueRefusalTests
{
    [TestMethod]
    public async Task ADuplicateRefusalNamesItsHolderForTheFormToLabel()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "unique-refusal"))
        {
            var service = new NendoApplicationService(coordinator);
            await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
                new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
                new AddFieldOperation("title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("code", "tasks", "code", "Code", "code", NendoStorageKind.Text, false),
            ]));
            var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
            await coordinator.ApplyAsync(new("test", "unique", "test", "Unique code", [
                new SetFieldUniqueOperation("unique-code", "tasks", "code", true, revision),
            ]));
            await service.CreateRecordAsync(new("tasks", "t1", new Dictionary<string, object?> { ["title"] = "Paint the hall", ["code"] = "T-001" }, new("test", "t1", "test")));
        }
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { });
        var fileSessionId = (await session.GetViewAsync()).FileSessionId!;

        var duplicate = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord, new
        {
            entityId = "tasks", recordId = "t2", values = new Dictionary<string, object?> { ["title"] = "Sweep", ["code"] = "t-001" }, idempotencyKey = "dup",
        }));
        Assert.IsFalse(duplicate.Ok, "A duplicate code was written.");
        Assert.AreEqual("value-not-unique", duplicate.Error!.Code, duplicate.Error.Message);
        Assert.AreEqual("t1", duplicate.Error.RecordId, "The refusal does not say which record holds the value.");
        StringAssert.Contains(duplicate.Error.Message, "already used by t1");
        Assert.IsFalse(duplicate.Error.Message.Contains("Paint", StringComparison.Ordinal), "The host's sentence carried a stored value.");

        var missing = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.DataCreateRecord, new
        {
            entityId = "nowhere", recordId = "t3", values = new Dictionary<string, object?>(), idempotencyKey = "missing",
        }));
        Assert.IsFalse(missing.Ok);
        Assert.IsNull(missing.Error!.RecordId, "A refusal about no record named one.");
        Assert.IsFalse(JsonSerializer.Serialize(missing.Error, new JsonSerializerOptions(JsonSerializerDefaults.Web)).Contains("recordId", StringComparison.Ordinal),
            "A refusal about no record still sends a recordId key.");
    }

    private static string Request(string fileSessionId, string method, object payload) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion,
        requestId = "unique-" + Guid.NewGuid().ToString("N"),
        method,
        fileSessionId,
        payload,
    });
}
