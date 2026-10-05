using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-172: the clauses a person's Filter pick adds, sent through the real host as the Workbench
/// sends them (quick-filter-model.ts, plan-selection.ts): eq on a reference or a choice, isNull
/// for Not set, composed after the screen's own clause, for a list or board window and for a
/// matrix's cells. The preview host has no typed filtering, so this is where the narrowing itself
/// is measured.
/// </summary>
[TestClass]
public sealed class WorkbenchQuickFilterTests
{
    [TestMethod]
    public async Task APickNarrowsTheWindowAndTheCellsAfterTheScreensOwnClause()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "quick-filter-seed"))
        {
            var service = new NendoApplicationService(coordinator);
            await coordinator.ApplyAsync(new("test", "schema", "test", "Issues and debates", [
                new CreateEntityOperation("debates", "debates", "Debates", "debates"),
                new AddFieldOperation("d-name", "debates", "name", "Name", "name", NendoStorageKind.Text, true),
                new CreateEntityOperation("issues", "issues", "Issues", "issues"),
                new AddFieldOperation("i-title", "issues", "title", "Title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("i-status", "issues", "status", "Status", "status", NendoStorageKind.Text, false, "singleChoice", ["open", "done", "dropped"]),
                new AddFieldOperation("i-debate", "issues", "debate", "Debate", "debate_id", NendoStorageKind.Reference, false),
                new AddFieldOperation("i-priority", "issues", "priority", "Priority", "priority", NendoStorageKind.Text, false, "singleChoice", ["high", "low"]),
            ]));
            var revision = (await service.GetDefinitionSnapshotAsync()).Manifest.DefinitionRevision;
            await coordinator.ApplyAsync(new("test", "bind", "test", "Bind debate", [
                new ConfigureReferenceOperation("bind", "issues", "debate", "debates", "name", revision),
            ]));
            foreach (var (id, name) in new[] { ("d1", "Ship it?"), ("d2", "Rename it?") })
                await service.CreateRecordAsync(new("debates", id, new Dictionary<string, object?> { ["name"] = name }, new("test", id, "test")));
            foreach (var (id, status, debate) in new[] { ("i1", "open", "d1"), ("i2", "done", "d1"), ("i3", "open", "d2"), ("i4", "open", (string?)null), ("i5", "dropped", "d1") })
                await service.CreateRecordAsync(new("issues", id,
                    new Dictionary<string, object?> { ["title"] = id, ["status"] = status, ["debate"] = debate, ["priority"] = "high" },
                    new("test", id, "test"), debate is null ? null : new Dictionary<string, long> { ["debate"] = 1 }));
        }
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var opened = await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        // The screen's own clause: it never shows dropped issues.
        var own = new { fieldId = "status", @operator = "ne", value = "dropped" };

        CollectionAssert.AreEqual(new[] { "i1", "i2" }, await IdsAsync(own, new { fieldId = "debate", @operator = "eq", value = "d1" }),
            "A reference pick narrows to its records, after the screen's own clause (i5 is dropped).");
        CollectionAssert.AreEqual(new[] { "i4" }, await IdsAsync(own, new { fieldId = "debate", @operator = "isNull" }), "Not set is isNull.");
        CollectionAssert.AreEqual(new[] { "i1", "i3", "i4" }, await IdsAsync(own, new { fieldId = "status", @operator = "eq", value = "open" }));

        var cells = await handler.HandleAsync(Request(opened.FileSessionId!, WorkbenchMethods.DataCellAggregateRecords, new
        {
            entityId = "issues", rowByFieldId = "status", columnByFieldId = "priority", aggregate = "count", fieldId = (string?)null,
            filters = new object[] { own, new { fieldId = "debate", @operator = "eq", value = "d1" } },
        }));
        Assert.IsTrue(cells.Ok, cells.Error?.Message);
        var counted = JsonSerializer.SerializeToElement(cells.Result, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("cells")
            .EnumerateArray().Sum(cell => cell.GetProperty("contributingRecords").GetInt32());
        Assert.AreEqual(2, counted, "A matrix under the pick counts only the picked debate's issues.");

        async Task<string[]> IdsAsync(params object[] filters)
        {
            var response = await handler.HandleAsync(Request(opened.FileSessionId!, WorkbenchMethods.DataQueryRecords, new
            {
                entityId = "issues", limit = 50, cursor = (string?)null, sortFieldId = "title", descending = false, filters,
            }));
            Assert.IsTrue(response.Ok, response.Error?.Message);
            return ((NendoPage<NendoRecordSnapshot>)response.Result!).Items.Select(record => record.RecordId).ToArray();
        }
    }

    private static string Request(string fileSessionId, string method, object payload) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion,
        requestId = "quick-filter-" + Guid.NewGuid().ToString("N"),
        method,
        fileSessionId,
        boundedRead = true,
        payload,
    });
}
