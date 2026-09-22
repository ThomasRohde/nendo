using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class WorkbenchPagedReadTests
{
    [TestMethod]
    public async Task BoundedBridgeSeparatesMetadataPagesAndReceiptAndRejectsStaleContinuation()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var initial = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        for (var index = 0; index < 120; index++)
            await session.CreateIdeaRecordAsync($"record-{index:D3}", $"Title {index}", $"create-{index}");
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null), _ => { });
        var metadata = await SendAsync(WorkbenchMethods.SessionGetSnapshot);
        Assert.IsEmpty(((DesktopSessionView)metadata.Result!).Records);
        Assert.HasCount(120, (await session.GetViewAsync()).Records, "Native and compatibility full inspection stays explicit.");
        var first = (NendoPage<NendoRecordSnapshot>)(await SendAsync(WorkbenchMethods.DataQueryRecords,
            new { entityId = NendoApplicationService.IdeaEntityId, limit = 50 })).Result!;
        Assert.HasCount(50, first.Items);
        Assert.IsNotNull(first.NextCursor);
        var history = (NendoPage<NendoRevisionSummary>)(await SendAsync(WorkbenchMethods.HistoryQuery, new { limit = 50 })).Result!;
        Assert.HasCount(50, history.Items);
        Assert.IsLessThan(64 * 1024, JsonSerializer.SerializeToUtf8Bytes(history).Length);
        var receipt = await SendAsync(WorkbenchMethods.DataSetField, new
        {
            entityId = NendoApplicationService.IdeaEntityId, recordId = "record-000", fieldId = NendoApplicationService.IdeaTitleFieldId,
            expectedRecordVersion = 1, value = "Saved in a bounded view", idempotencyKey = "bounded-edit",
        });
        var outcome = (DesktopMutationView)receipt.Result!;
        Assert.IsNotNull(outcome.Session);
        Assert.IsEmpty(outcome.Session.Records);
        Assert.AreEqual(first.ChangeSequence + 1, outcome.Mutation.ChangeSequence);
        Assert.IsLessThan(32 * 1024, WorkbenchProtocolHandler.Serialize(receipt).Length);
        var stale = await handler.HandleAsync(Request(WorkbenchMethods.DataQueryRecords,
            new { entityId = NendoApplicationService.IdeaEntityId, limit = 50, cursor = first.NextCursor }));
        Assert.AreEqual("stale-cursor", stale.Error!.Code);
        var verified = (NendoStorageHealthSnapshot)(await SendAsync(WorkbenchMethods.HealthVerify)).Result!;
        Assert.AreEqual(outcome.Mutation.ChangeSequence, verified.IntegrityChangeSequence);
        var refreshed = (NendoPage<NendoRecordSnapshot>)(await SendAsync(WorkbenchMethods.DataQueryRecords,
            new { entityId = NendoApplicationService.IdeaEntityId, limit = 50 })).Result!;
        Assert.AreEqual("Saved in a bounded view", refreshed.Items[0].Values[NendoApplicationService.IdeaTitleFieldId].GetString());

        string Request(string method, object? payload = null) => JsonSerializer.Serialize(new
        { protocolVersion = 5, requestId = Guid.NewGuid().ToString("N"), method, fileSessionId = initial.FileSessionId,
            boundedRead = true, payload = payload ?? new { } });
        async Task<WorkbenchResponse> SendAsync(string method, object? payload = null)
        {
            var response = await handler.HandleAsync(Request(method, payload));
            Assert.IsTrue(response.Ok, response.Error?.Message);
            return response;
        }
    }
}
