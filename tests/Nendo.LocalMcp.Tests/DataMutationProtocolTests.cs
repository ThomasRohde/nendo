using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DataMutationProtocolTests
{
    [TestMethod]
    public async Task CancelledMutationAdmissionLeavesHistoryAndLeaseIntact()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 0);
        var snapshot = await workspace.Service.GetSnapshotAsync();
        var host = new NendoHostAuthority(
            "cancel-test-run",
            AgentAccessMode.DataMutation,
            new byte[32],
            snapshot.Manifest.ApplicationId,
            snapshot.Manifest.InstanceId);
        var authority = new NendoAgentAuthority(
            host,
            new SystemNendoClock(),
            NendoAgentAuthority.ProductionLeaseTtl);
        var mutations = new NendoDataMutationService(workspace.Service, authority, host,
            new NendoUnattendedAuthority(AgentAccessMode.DataMutation, null),
            new NendoImportService(workspace.Service));
        const string sessionId = "cancel-test-session";
        var lease = await authority.AcquireAsync(sessionId, "test client", CancellationToken.None);
        var historyBefore = await workspace.Service.GetHistoryAsync();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(() => mutations.CreateRecordAsync(
            sessionId,
            lease.LeaseId,
            NendoApplicationService.IdeaEntityId,
            "idea-cancelled",
            JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                [NendoApplicationService.IdeaTitleFieldId] = "Must not commit",
            }),
            "cancelled-create",
            cancellation.Token));

        Assert.HasCount(historyBefore.Count, await workspace.Service.GetHistoryAsync());
        Assert.IsTrue((await authority.GetStatusAsync(CancellationToken.None)).HasLease);
    }

    [TestMethod]
    [DataRow("idea-garden")]
    [DataRow("decision-log")]
    public async Task GenericToolsMatchTypedServiceAndEnforceRetryVersionAndLeaseRules(
        string fixtureName)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        var fixture = await CreateFixtureAsync(workspace, fixtureName);
        var before = await workspace.Service.GetSnapshotAsync();
        var historyBefore = (await workspace.Service.GetHistoryAsync()).Count;

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        await using var otherSession = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));

        var createArguments = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = fixture.EntityId,
            ["recordId"] = fixture.RecordId,
            ["values"] = fixture.Values,
            ["idempotencyKey"] = "create-agent-record",
        };
        var created = Result<NendoApplyResult>(await client.CallToolAsync(
            "nendo.data.create_record",
            createArguments));
        var simulatedDroppedResponseRetry = Result<NendoApplyResult>(await client.CallToolAsync(
            "nendo.data.create_record",
            createArguments));
        Assert.IsFalse(created.IsIdempotentReplay);
        Assert.IsTrue(simulatedDroppedResponseRetry.IsIdempotentReplay);
        Assert.AreEqual(created.RevisionId, simulatedDroppedResponseRetry.RevisionId);

        var alteredRetry = new Dictionary<string, object?>(createArguments, StringComparer.Ordinal)
        {
            ["recordId"] = fixture.RecordId + "-changed",
        };
        await AssertToolErrorAsync(
            client,
            "nendo.data.create_record",
            alteredRetry,
            "NENDO_IDEMPOTENCY_CONFLICT");

        var setArguments = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = fixture.EntityId,
            ["recordId"] = fixture.RecordId,
            ["fieldId"] = fixture.EditFieldId,
            ["expectedRecordVersion"] = 1,
            ["value"] = fixture.EditValue,
            ["idempotencyKey"] = "edit-agent-record",
        };
        var edited = Result<NendoApplyResult>(await client.CallToolAsync(
            "nendo.data.set_field",
            setArguments));
        var editRetry = Result<NendoApplyResult>(await client.CallToolAsync(
            "nendo.data.set_field",
            setArguments));
        Assert.AreEqual(edited.RevisionId, editRetry.RevisionId);
        Assert.IsTrue(editRetry.IsIdempotentReplay);

        var staleArguments = new Dictionary<string, object?>(setArguments, StringComparer.Ordinal)
        {
            ["idempotencyKey"] = "stale-agent-record",
            ["value"] = "must-not-commit",
        };
        await AssertToolErrorAsync(
            client,
            "nendo.data.set_field",
            staleArguments,
            "NENDO_RECORD_VERSION_CONFLICT");

        var copiedLeaseArguments = new Dictionary<string, object?>(setArguments, StringComparer.Ordinal)
        {
            ["applicationHandle"] = "unknown-handle",
            ["idempotencyKey"] = "copied-agent-lease",
            ["expectedRecordVersion"] = 2,
        };
        await AssertToolErrorAsync(
            otherSession,
            "nendo.data.set_field",
            copiedLeaseArguments,
            "NENDO_INVALID_LEASE");

        var command = Result<NendoApplyResult>(await client.CallToolAsync(
            "nendo.data.execute_command",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["commandId"] = fixture.CommandId,
                ["recordId"] = fixture.RecordId,
                ["expectedRecordVersion"] = 2,
                ["idempotencyKey"] = "command-agent-record",
            }));
        Assert.IsFalse(command.IsIdempotentReplay);

        var unknownHistoryCount = (await workspace.Service.GetHistoryAsync()).Count;
        await AssertToolErrorAsync(
            client,
            "nendo.data.create_record",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["entityId"] = "entity.unknown",
                ["recordId"] = "record.must-not-exist",
                ["values"] = new Dictionary<string, object?>(),
                ["idempotencyKey"] = "unknown-agent-entity",
            },
            "NENDO_ENTITY_NOT_FOUND");
        Assert.HasCount(unknownHistoryCount, await workspace.Service.GetHistoryAsync());

        var after = await workspace.Service.GetSnapshotAsync();
        var record = after.Records.Single(value => value.RecordId == fixture.RecordId);
        Assert.AreEqual(3, record.RecordVersion);
        Assert.AreEqual(fixture.EditValue, record.Values[fixture.EditFieldId].GetString());
        Assert.AreEqual(before.Manifest.DataRevision + 3, after.Manifest.DataRevision);

        var history = await workspace.Service.GetHistoryAsync();
        Assert.HasCount(historyBefore + 3, history);
        CollectionAssert.AreEqual(
            new[] { "data.createRecord", "data.setField", "data.setField" },
            history.TakeLast(3).Select(item => item.Operations.Single().OperationType).ToArray());
        Assert.IsTrue(history.TakeLast(3).All(item => item.Origin.StartsWith("agent-", StringComparison.Ordinal)));
        Assert.IsTrue(history.TakeLast(3).All(item =>
            item.IdempotencyScope?.StartsWith($"mcp.data.{host.HostRunId}.agent-", StringComparison.Ordinal) is true));

        var committedActivities = host.GetActivities()
            .Where(item => item.Category == "mutation" && item.RevisionId is not null)
            .ToArray();
        Assert.HasCount(5, committedActivities);
        Assert.HasCount(3, committedActivities.Select(item => item.RevisionId).Distinct());
    }

    [TestMethod]
    public async Task UnknownArgumentsAndNonScalarValuesFailWithoutARevision()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 0);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var historyBefore = (await workspace.Service.GetHistoryAsync()).Count;

        await AssertToolErrorAsync(
            client,
            "nendo.data.create_record",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["entityId"] = NendoApplicationService.IdeaEntityId,
                ["recordId"] = "record.invalid",
                ["values"] = new Dictionary<string, object?>
                {
                    [NendoApplicationService.IdeaTitleFieldId] = new { nested = true },
                },
                ["idempotencyKey"] = "invalid-nested-value",
            },
            "NENDO_INVALID_REQUEST");

        await AssertToolErrorAsync(
            client,
            "nendo.data.create_record",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
                ["entityId"] = NendoApplicationService.IdeaEntityId,
                ["recordId"] = "record.invalid",
                ["values"] = new Dictionary<string, object?>(),
                ["idempotencyKey"] = "unknown-authority-input",
                ["origin"] = "forged-origin",
            },
            "NENDO_INVALID_REQUEST");
        Assert.HasCount(historyBefore, await workspace.Service.GetHistoryAsync());
    }

    /// <summary>
    /// The review's choice-field finding, replayed with the value it actually sent:
    /// the option label with the quote characters still inside it. The refusal names
    /// the field, lists the declared choices and echoes what arrived, which is the
    /// whole diagnosis; one blind sentence had it filed as a broken write path.
    /// </summary>
    [TestMethod]
    public async Task ARefusedValueNamesTheFieldTheChoicesAndWhatArrived()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };

        var quoted = await RefusalAsync(client, "nendo.data.set_field", new Dictionary<string, object?>(owned)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId, ["recordId"] = "idea-001",
            ["fieldId"] = NendoApplicationService.IdeaStatusFieldId, ["expectedRecordVersion"] = 1,
            ["value"] = "\"Trying\"", ["idempotencyKey"] = "quoted-choice",
        });
        StringAssert.Contains(quoted, "NENDO_INVALID_REQUEST");
        StringAssert.Contains(quoted, NendoApplicationService.IdeaStatusFieldId);
        StringAssert.Contains(quoted, "Idea, Exploring, Trying");
        StringAssert.Contains(quoted, "received \"\\\"Trying\\\"\"");

        var missing = await RefusalAsync(client, "nendo.data.create_record", new Dictionary<string, object?>(owned)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId, ["recordId"] = "idea-untitled",
            ["values"] = new Dictionary<string, object?> { [NendoApplicationService.IdeaStatusFieldId] = "Idea" },
            ["idempotencyKey"] = "missing-title",
        });
        StringAssert.Contains(missing, "Required field");
        StringAssert.Contains(missing, NendoApplicationService.IdeaTitleFieldId);

        // The same field, the value itself: the ordinary edit the review believed impossible.
        var edited = Result<NendoDataApplyResult>(await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>(owned)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId, ["recordId"] = "idea-001",
            ["fieldId"] = NendoApplicationService.IdeaStatusFieldId, ["expectedRecordVersion"] = 1,
            ["value"] = "Trying", ["idempotencyKey"] = "plain-choice",
        }));
        Assert.AreEqual(2L, edited.RecordVersion);
    }

    private static async Task<string> RefusalAsync(McpClient client, string name, Dictionary<string, object?> arguments)
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.IsTrue(result.IsError, $"{name} was expected to be refused: {JsonSerializer.Serialize(result)}");
        return string.Join(' ', result.Content.OfType<ModelContextProtocol.Protocol.TextContentBlock>().Select(block => block.Text));
    }

    private static T Result<T>(ModelContextProtocol.Protocol.CallToolResult result)
        where T : notnull
    {
        Assert.IsFalse(result.IsError ?? false, JsonSerializer.Serialize(result));
        if (result.StructuredContent is not { } structured)
        {
            throw new AssertFailedException("The tool did not return structured content.");
        }
        return structured.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }

    private static async Task AssertToolErrorAsync(
        McpClient client,
        string tool,
        IReadOnlyDictionary<string, object?> arguments,
        string code)
    {
        var result = await client.CallToolAsync(tool, arguments);
        Assert.IsTrue(result.IsError, JsonSerializer.Serialize(result));
        StringAssert.Contains(JsonSerializer.Serialize(result), code);
    }

    private static async Task<MutationFixture> CreateFixtureAsync(
        LocalMcpTestWorkspace workspace,
        string fixtureName)
    {
        if (fixtureName == "decision-log")
        {
            await workspace.CreateDecisionLogAsync();
            var fixture = SemanticProtocolFixture.Load(fixtureName);
            return new MutationFixture(
                fixture.Entity.EntityId,
                "decision-agent-created",
                fixture.LoadRecords()[0].Values.ToDictionary(
                    pair => pair.Key,
                    pair => (object?)pair.Value.Clone(),
                    StringComparer.Ordinal),
                "field.decision.context",
                "Context edited by agent",
                fixture.Command.NodeId);
        }

        await workspace.CreateIdeaGardenAsync(recordCount: 0);
        return new MutationFixture(
            NendoApplicationService.IdeaEntityId,
            "idea-agent-created",
            new Dictionary<string, object?>
            {
                [NendoApplicationService.IdeaTitleFieldId] = "Agent-created idea",
                [NendoApplicationService.IdeaNotesFieldId] = "Created through generic data tools",
                [NendoApplicationService.IdeaStatusFieldId] = "Idea",
                [NendoApplicationService.IdeaEnergyFieldId] = "Medium",
                [NendoApplicationService.IdeaCreatedDateFieldId] = "2026-09-03",
                [NendoApplicationService.IdeaNextActionFieldId] = "Verify the result",
            },
            NendoApplicationService.IdeaTitleFieldId,
            "Agent-edited idea",
            "command.idea.moveToTrying");
    }

    private sealed record MutationFixture(
        string EntityId,
        string RecordId,
        IReadOnlyDictionary<string, object?> Values,
        string EditFieldId,
        string EditValue,
        string CommandId);
}
