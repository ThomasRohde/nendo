using System.Text.Json;
using ModelContextProtocol.Client;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class LeaseProtocolTests
{
    // P6-H closes the outstanding lifecycle assertion: an application handle
    // minted before a close must not authorize anything against a later host run.
    // Closure was previously shown only by the old endpoint refusing connections.
    [TestMethod]
    public async Task AnApplicationHandleFromAPreviousHostRunIsRefused()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();

        string staleHandle;
        string staleLease;
        string firstRunId;
        await using (var first = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot)))
        {
            await using var client = await ProtocolResourceTests.ConnectAsync(first);
            var granted = LeaseResult<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
            staleHandle = granted.ApplicationHandle;
            staleLease = granted.LeaseId;
            firstRunId = first.HostRunId;
            Assert.AreNotEqual(string.Empty, staleHandle);
        }

        // A new host run over the same file is a fresh identity, not a continuation.
        await using var second = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        Assert.AreNotEqual(firstRunId, second.HostRunId, "A new host run must not reuse the previous run identity.");

        await using var reconnected = await ProtocolResourceTests.ConnectAsync(second);
        var replayed = await reconnected.CallToolAsync(
            "nendo.change_set.begin",
            new Dictionary<string, object?>
            {
                ["applicationHandle"] = staleHandle,
                ["leaseId"] = staleLease,
                ["title"] = "Replayed authority",
                ["idempotencyKey"] = "replayed-authority",
            });
        Assert.IsTrue(replayed.IsError ?? false, "A handle from a previous host run must not author anything.");

        // The refusal must not have consumed the new run's single writer slot.
        var fresh = LeaseResult<NendoLeaseGrant>(await reconnected.CallToolAsync("nendo.lease.acquire"));
        Assert.AreNotEqual(staleHandle, fresh.ApplicationHandle, "A new run must mint a new handle.");
    }

    private static T LeaseResult<T>(ModelContextProtocol.Protocol.CallToolResult result) where T : notnull
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        if (result.StructuredContent is not { } structured)
        {
            throw new AssertFailedException("The tool did not return structured content.");
        }
        return structured.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }

    [TestMethod]
    [DataRow(AgentAccessMode.ReadOnly, 0)]
    [DataRow(AgentAccessMode.DataMutation, 12)]
    [DataRow(AgentAccessMode.ApplicationAuthoring, 18)]
    [DataRow(AgentAccessMode.Unattended, 19)]
    public async Task OfficialClientSeesOnlyModeAllowlistedLeaseTools(
        AgentAccessMode mode,
        int expectedCount)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            mode,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        IList<McpClientTool> tools;
        if (mode == AgentAccessMode.ReadOnly)
        {
            Assert.IsNotNull(client.ServerCapabilities.Tools);
            tools = await client.ListToolsAsync();
        }
        else
        {
            tools = await client.ListToolsAsync();
        }
        Assert.HasCount(expectedCount, tools);
        var expectedNames = expectedCount switch
        {
            0 => [],
            12 => DataToolNames,
            18 => DataToolNames.Concat(AuthoringToolNames).Order(StringComparer.Ordinal).ToArray(),
            19 => DataToolNames.Concat(AuthoringToolNames).Concat(UnattendedToolNames).Order(StringComparer.Ordinal).ToArray(),
            _ => throw new AssertFailedException($"Unexpected tool count {expectedCount}."),
        };
        CollectionAssert.AreEqual(
            expectedNames,
            tools.Select(tool => tool.Name).Order(StringComparer.Ordinal).ToArray());

        foreach (var tool in tools)
        {
            var schema = tool.ProtocolTool.InputSchema;
            var properties = schema.TryGetProperty("properties", out var value)
                ? value.EnumerateObject().Select(property => property.Name).ToArray()
                : [];
            var expected = ExpectedArguments(tool.Name);
            if (expected.Contains("leaseId")) expected = ["applicationHandle", .. expected];
            CollectionAssert.AreEquivalent(
                expected,
                properties,
                $"Unexpected schema for {mode}/{tool.Name}: {string.Join(", ", properties)}");
            var schemaText = schema.GetRawText();
            Assert.DoesNotContain("clientId", schemaText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("session", schemaText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("applicationId", schemaText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("instanceId", schemaText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("mode", schemaText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("\"operationId\"", schemaText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("\"origin\"", schemaText, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("\"idempotencyScope\"", schemaText, StringComparison.OrdinalIgnoreCase);
        }
    }

    private static string[] ExpectedArguments(string toolName) => toolName switch
    {
        "nendo.data.get_receipt" => ["receiptContext", "idempotencyKey"],
        // Needs no lease and takes no argument: an integrity scan is a question
        // about the file, not an edit to it.
        "nendo.health.verify_integrity" => [],
        "nendo.data.delete_record" => ["leaseId", "entityId", "recordId", "expectedRecordVersion", "idempotencyKey"],
        "nendo.lease.acquire" => [],
        "nendo.lease.status" => ["applicationHandle"],
        "nendo.lease.renew" or "nendo.lease.release" => ["leaseId"],
        "nendo.data.create_record" =>
            ["leaseId", "entityId", "recordId", "values", "idempotencyKey", "expectedTargetVersions"],
        "nendo.data.create_records" => ["leaseId", "entityId", "records", "idempotencyKey"],
        "nendo.data.set_field" =>
            ["leaseId", "entityId", "recordId", "fieldId", "expectedRecordVersion", "value", "idempotencyKey", "expectedTargetRecordVersion"],
        "nendo.data.execute_command" =>
            ["leaseId", "commandId", "recordId", "expectedRecordVersion", "idempotencyKey"],
        "nendo.change_set.begin" => ["leaseId", "title", "idempotencyKey"],
        "nendo.change_set.add_operations" =>
            ["leaseId", "changeSetId", "mutations", "idempotencyKey"],
        "nendo.change_set.amend" =>
            ["leaseId", "changeSetId", "dropFromMutationOrdinal", "mutations", "idempotencyKey"],
        "nendo.change_set.validate" => ["leaseId", "changeSetId", "idempotencyKey"],
        "nendo.change_set.preview" => ["leaseId", "changeSetId"],
        "nendo.change_set.reject" => ["leaseId", "changeSetId", "idempotencyKey"],
        "nendo.change_set.accept" => ["leaseId", "changeSetId", "idempotencyKey"],
        "nendo.data.import_records" =>
            ["leaseId", "entityId", "format", "idempotencyKey", "csv", "columnMappings", "csvProfile", "emptyIsNull", "records"],
        _ => throw new AssertFailedException($"Unexpected tool {toolName}."),
    };

    private static string[] DataToolNames { get; } =
    [
        "nendo.data.create_record",
        "nendo.data.create_records",
        "nendo.data.delete_record",
        "nendo.data.execute_command",
        "nendo.data.get_receipt",
        "nendo.data.import_records",
        "nendo.data.set_field",
        "nendo.health.verify_integrity",
        "nendo.lease.acquire",
        "nendo.lease.release",
        "nendo.lease.renew",
        "nendo.lease.status",
    ];

    private static string[] AuthoringToolNames { get; } =
    [
        "nendo.change_set.add_operations",
        "nendo.change_set.amend",
        "nendo.change_set.begin",
        "nendo.change_set.preview",
        "nendo.change_set.reject",
        "nendo.change_set.validate",
    ];

    // One tool, and the whole of what the fifth level adds. Listed separately so the
    // assertion above reads as three tiers rather than as a number that grew.
    private static string[] UnattendedToolNames { get; } =
    [
        "nendo.change_set.accept",
    ];

    [TestMethod]
    public async Task HandleBoundLeaseRejectsUnknownHandlesAndReleasesIdempotently()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var first = await ProtocolResourceTests.ConnectAsync(host);
        await using var second = await ProtocolResourceTests.ConnectAsync(host);

        var acquired = await first.CallToolAsync("nendo.lease.acquire");
        Assert.IsFalse(acquired.IsError ?? false);
        var lease = acquired.StructuredContent?.Deserialize<NendoLeaseGrant>(NendoMcpJson.Options);
        Assert.IsNotNull(lease);
        Assert.AreEqual(AgentAccessMode.DataMutation, lease.Mode);

        var contention = await second.CallToolAsync("nendo.lease.acquire");
        Assert.IsTrue(contention.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(contention), "NENDO_LEASE_HELD");
        var copied = await second.CallToolAsync(
            "nendo.lease.renew",
            new Dictionary<string, object?> { ["applicationHandle"] = "unknown-handle", ["leaseId"] = lease.LeaseId });
        Assert.IsTrue(copied.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(copied), "NENDO_INVALID_LEASE");

        var renewed = await first.CallToolAsync(
            "nendo.lease.renew",
            new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
        Assert.IsFalse(renewed.IsError ?? false);
        var released = await first.CallToolAsync(
            "nendo.lease.release",
            new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
        var replay = await first.CallToolAsync(
            "nendo.lease.release",
            new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
        Assert.IsFalse(released.IsError ?? false);
        Assert.IsFalse(replay.IsError ?? false);

        var successor = await second.CallToolAsync("nendo.lease.acquire");
        Assert.IsFalse(successor.IsError ?? false);
    }

    [TestMethod]
    public async Task ClientCloseRetainsLeaseUntilExplicitRevocation()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        var first = await ProtocolResourceTests.ConnectAsync(host);
        var acquired = await first.CallToolAsync("nendo.lease.acquire");
        Assert.IsFalse(acquired.IsError ?? false);

        await first.DisposeAsync();

        await using var successor = await ProtocolResourceTests.ConnectAsync(host);
        Assert.IsTrue((await successor.CallToolAsync("nendo.lease.acquire")).IsError);
        Assert.IsTrue((await host.GetLeaseStatusAsync()).HasLease);
        await host.RevokeEditingAsync();
        var next = await successor.CallToolAsync("nendo.lease.acquire");
        Assert.IsFalse(next.IsError ?? false);
    }

    [TestMethod]
    public async Task UnknownLeaseArgumentFailsBeforeAuthorityChanges()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var rejected = await client.CallToolAsync(
            "nendo.lease.acquire",
            new Dictionary<string, object?> { ["clientId"] = "forged-owner" });
        Assert.IsTrue(rejected.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(rejected), "NENDO_INVALID_REQUEST");
        Assert.IsFalse((await host.GetLeaseStatusAsync()).HasLease);
    }
}
