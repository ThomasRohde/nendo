using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Search over the Workbench bridge (ADR-0028): refused until the file has an index, built by the
/// person's own request, then answering a word in any text field with an excerpt in the shape the
/// Workbench and custom views read.
/// </summary>
[TestClass]
public sealed class WorkbenchSearchTests
{
    [TestMethod]
    public async Task SearchIsRefusedUntilBuiltThenFindsAWordWithItsExcerpt()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var initial = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        await session.CreateIdeaRecordAsync("compost", "Compost heap by the shed", "create-compost");
        await session.CreateIdeaRecordAsync("roses", "Prune the roses", "create-roses");
        var handler = new WorkbenchProtocolHandler(session, _ => { });

        var missing = await handler.HandleAsync(Request(WorkbenchMethods.DataSearchRecords, new { text = "shed" }));
        Assert.IsFalse(missing.Ok);
        Assert.AreEqual("search-index-missing", missing.Error!.Code);

        var built = (DesktopMutationView)(await SendAsync(WorkbenchMethods.DataBuildSearchIndex, new { idempotencyKey = "build-search" })).Result!;
        Assert.AreEqual(NendoFormat.SearchMinimumHostVersion, built.Session!.Manifest!.MinimumHostVersion);

        var response = await SendAsync(WorkbenchMethods.DataSearchRecords, new { text = "she", limit = 5, entityIds = Array.Empty<string>(), fieldIds = Array.Empty<string>() });
        var page = (NendoPage<NendoSearchHit>)response.Result!;
        var hit = page.Items.Single();
        Assert.AreEqual("compost", hit.RecordId);
        Assert.AreEqual("Compost heap by the shed", hit.Label);

        // The shape on the wire, as the Workbench reads it: camelCase, ranges as start and length.
        using var wire = JsonDocument.Parse(WorkbenchProtocolHandler.Serialize(response));
        var item = wire.RootElement.GetProperty("result").GetProperty("items")[0];
        Assert.AreEqual("compost", item.GetProperty("recordId").GetString());
        var field = item.GetProperty("fields")[0];
        var range = field.GetProperty("ranges")[0];
        Assert.AreEqual("shed", field.GetProperty("snippet").GetString()!.Substring(range.GetProperty("start").GetInt32(), range.GetProperty("length").GetInt32()));

        string Request(string method, object? payload = null) => JsonSerializer.Serialize(new
        { protocolVersion = DesktopShellContract.BridgeProtocolVersion, requestId = Guid.NewGuid().ToString("N"), method, fileSessionId = initial.FileSessionId,
            boundedRead = true, payload = payload ?? new { } });
        async Task<WorkbenchResponse> SendAsync(string method, object? payload = null)
        {
            var result = await handler.HandleAsync(Request(method, payload));
            Assert.IsTrue(result.Ok, result.Error?.Message);
            return result;
        }
    }
}
