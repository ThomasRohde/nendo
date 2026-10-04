using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Extensions.Tasks;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-152: a client that declares the Tasks extension runs validate, import and verify as
/// tasks it polls; one that does not is answered as before; every other tool is answered
/// at once whatever the client declares.
/// </summary>
[TestClass]
public sealed class TasksExtensionTests
{
    [TestMethod]
    public async Task ValidateRunsAsATaskForAClientThatDeclaresTheExtensionAndAsBeforeForOneThatDoesNot()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };

        var first = await BeginNotesAsync(client, session, "first");
        var created = await client.CallToolAsTaskAsync(new CallToolRequestParams
        {
            Name = "nendo.change_set.validate",
            Arguments = Arguments(new(first) { ["idempotencyKey"] = "validate-first" }),
        });
        Assert.IsTrue(created.IsTask, "A client that declared the extension was answered synchronously.");
        var task = created.TaskCreated!;
        Assert.AreEqual(McpTaskStatus.Working, task.Status);
        Assert.IsNotNull(task.TimeToLive, "The TTL says task state dies with the listener.");

        GetTaskResult polled;
        var deadline = DateTime.UtcNow.AddSeconds(20);
        do
        {
            await Task.Delay(100);
            polled = await client.GetTaskAsync(task.TaskId);
        } while (polled is WorkingTaskResult && DateTime.UtcNow < deadline);
        var completed = polled as CompletedTaskResult ?? throw new AssertFailedException($"The validate task ended as {polled.Status}.");
        var result = completed.Result.Deserialize<CallToolResult>(NendoMcpJson.Options)!;
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        var preview = result.StructuredContent!.Value.Deserialize<NendoAgentProposalPreview>(NendoMcpJson.Options)!;
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.HasCount(1, host.GetPendingProposals(), "The task's validate did not queue the proposal.");

        // The same call without the extension declared: answered at once, as today.
        var second = await BeginNotesAsync(client, session, "second", entityId: "tasks");
        var direct = await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(second) { ["idempotencyKey"] = "validate-second" });
        Assert.AreNotEqual(true, direct.IsError, JsonSerializer.Serialize(direct));
        Assert.IsNotNull(direct.StructuredContent);
        Assert.HasCount(2, host.GetPendingProposals());

        // A write is never a task, whatever the client declares.
        var begun = await client.CallToolAsTaskAsync(new CallToolRequestParams
        {
            Name = "nendo.change_set.begin",
            Arguments = Arguments(new(session) { ["title"] = "Third", ["idempotencyKey"] = "begin-third" }),
        });
        Assert.IsFalse(begun.IsTask, "begin is answered, not polled for.");
    }

    [TestMethod]
    public async Task ImportAndVerifyRunAsTasksAndACancelledValidateLeavesNoProposal()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "test",
            new([new("test", "schema", "test", "Notes", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };

        var records = Enumerable.Range(1, 60).Select(index => new { recordId = $"n{index:D3}", values = new { label = $"Row {index}" } }).ToArray();
        var imported = await client.CallToolWithPollingAsync(new CallToolRequestParams
        {
            Name = "nendo.data.import_records",
            Arguments = Arguments(new(session) { ["entityId"] = "notes", ["format"] = "json", ["records"] = records, ["idempotencyKey"] = "import-as-task" }),
        }, 100);
        Assert.AreNotEqual(true, imported.IsError, JsonSerializer.Serialize(imported));
        var outcome = imported.StructuredContent!.Value.Deserialize<NendoImportResult>(NendoMcpJson.Options)!;
        Assert.AreEqual(60, outcome.Committed);
        Assert.AreEqual(2, outcome.RevisionCount);

        var verified = await client.CallToolWithPollingAsync(new CallToolRequestParams { Name = "nendo.health.verify_integrity" }, 100);
        Assert.AreNotEqual(true, verified.IsError, JsonSerializer.Serialize(verified));
        StringAssert.Contains(JsonSerializer.Serialize(verified.StructuredContent), "\"ok\"", StringComparison.Ordinal);

        // tasks/cancel on a validate: the task ends cancelled and nothing is queued.
        var scoped = await BeginNotesAsync(client, session, "cancelled", entityId: "tasks");
        var created = await client.CallToolAsTaskAsync(new CallToolRequestParams
        {
            Name = "nendo.change_set.validate",
            Arguments = Arguments(new(scoped) { ["idempotencyKey"] = "validate-cancelled" }),
        });
        Assert.IsTrue(created.IsTask);
        await client.CancelTaskAsync(created.TaskCreated!.TaskId);
        GetTaskResult polled;
        var deadline = DateTime.UtcNow.AddSeconds(20);
        do
        {
            await Task.Delay(100);
            polled = await client.GetTaskAsync(created.TaskCreated.TaskId);
        } while (polled is WorkingTaskResult && DateTime.UtcNow < deadline);
        Assert.IsTrue(polled is CancelledTaskResult or CompletedTaskResult, $"The cancelled task ended as {polled.Status}.");
        // Whether the cancel landed before or after the clone, the file holds no stray proposal
        // the agent cannot reach: either none, or the one its validate queued.
        Assert.IsLessThanOrEqualTo(1, host.GetPendingProposals().Count);
        Assert.IsLessThanOrEqualTo(1, (await workspace.Service.ListProposalsAsync()).Count);
    }

    private static async Task<Dictionary<string, object?>> BeginNotesAsync(McpClient client, Dictionary<string, object?> session, string key, string entityId = "notes")
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = entityId, ["idempotencyKey"] = $"begin-{key}" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput($"Create {entityId}",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId, displayName = entityId })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId, fieldId = $"{entityId}.label", displayName = "Label", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = $"add-{key}",
        });
        return scoped;
    }

    private static Dictionary<string, JsonElement> Arguments(Dictionary<string, object?> values) =>
        values.ToDictionary(pair => pair.Key, pair => JsonSerializer.SerializeToElement(pair.Value, NendoMcpJson.Options), StringComparer.Ordinal);

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
