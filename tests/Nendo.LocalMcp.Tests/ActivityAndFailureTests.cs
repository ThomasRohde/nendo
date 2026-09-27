using System.Text.Json;
using Microsoft.Extensions.Logging;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-085. Measured on 2026-09-27: every successful tool call wrote two activity entries, so
/// the twenty the Agent page shows held ten calls; an import's revisions were attributed to
/// a bare "agent" while every other agent write named its session; and the host cleared
/// every log provider, so a failure inside it left no trace but a type name.
/// </summary>
[TestClass]
public sealed class ActivityAndFailureTests
{
    [TestMethod]
    public async Task EachCallIsOneActivityEntryCarryingWhatItDid()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var entity = NendoApplicationService.IdeaEntityId;
        var record = (await workspace.Service.GetSnapshotAsync()).Records.First(item => item.EntityId == entity);
        var title = NendoApplicationService.IdeaTitleFieldId;

        async Task<NendoAgentActivity> OneEntryAsync(Func<Task> call)
        {
            var before = host.GetActivities().Count;
            await call();
            var after = host.GetActivities();
            Assert.HasCount(before + 1, after, "One call, one entry: " + string.Join(" | ", after.Skip(before).Select(item => $"{item.Category} {item.Name} {item.Outcome}")));
            return after[^1];
        }

        NendoLeaseGrant? grant = null;
        var acquired = await OneEntryAsync(async () => grant = (await client.CallToolAsync("nendo.lease.acquire"))
            .StructuredContent!.Value.Deserialize<NendoLeaseGrant>(NendoMcpJson.Options));
        Assert.AreEqual(("tool", "nendo.lease.acquire", "completed"), (acquired.Category, acquired.Name, acquired.Outcome));

        NendoDataApplyResult? written = null;
        var edited = await OneEntryAsync(async () => written = (await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>
        {
            ["applicationHandle"] = grant!.ApplicationHandle,
            ["leaseId"] = grant.LeaseId,
            ["entityId"] = entity,
            ["recordId"] = record.RecordId,
            ["fieldId"] = title,
            ["expectedRecordVersion"] = record.RecordVersion,
            ["value"] = "One entry",
            ["idempotencyKey"] = "one-entry-edit",
        })).StructuredContent!.Value.Deserialize<NendoDataApplyResult>(NendoMcpJson.Options));
        Assert.AreEqual(("mutation", "nendo.data.set_field", "committed"), (edited.Category, edited.Name, edited.Outcome));
        Assert.AreEqual(written!.RevisionId, edited.RevisionId, "The entry names the revision the write committed.");

        var refused = await OneEntryAsync(async () => Assert.IsTrue((await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>
        {
            ["applicationHandle"] = grant!.ApplicationHandle,
            ["leaseId"] = grant.LeaseId,
            ["entityId"] = entity,
            ["recordId"] = record.RecordId,
            ["fieldId"] = title,
            ["expectedRecordVersion"] = record.RecordVersion,
            ["value"] = "Stale",
            ["idempotencyKey"] = "one-entry-stale",
        })).IsError));
        Assert.AreEqual(("nendo.data.set_field", "rejected"), (refused.Name, refused.Outcome));

        var unknown = await OneEntryAsync(() => Assert.ThrowsExactlyAsync<McpProtocolException>(
            () => client.CallToolAsync("nendo.sql.execute").AsTask()));
        Assert.AreEqual(("nendo.sql.execute", "rejected"), (unknown.Name, unknown.Outcome));

        var read = await OneEntryAsync(() => ProtocolResourceTests.ReadTextAsync(client, "nendo://application/manifest"));
        Assert.AreEqual(("resource", "completed"), (read.Category, read.Outcome));
    }

    [TestMethod]
    public async Task AnImportIsAttributedToTheSessionThatImported()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value
            .Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        var snapshot = await workspace.Service.GetSnapshotAsync();
        var template = snapshot.Records.First(item => item.EntityId == NendoApplicationService.IdeaEntityId);
        var records = Enumerable.Range(0, 60).Select(index => new Dictionary<string, object?>
        {
            ["recordId"] = $"imported-{index:00}",
            ["values"] = template.Values.ToDictionary(pair => pair.Key, pair => (object?)pair.Value.Clone()),
        }).ToArray();

        var imported = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>
        {
            ["applicationHandle"] = grant.ApplicationHandle,
            ["leaseId"] = grant.LeaseId,
            ["entityId"] = NendoApplicationService.IdeaEntityId,
            ["format"] = "json",
            ["records"] = records,
            ["idempotencyKey"] = "attributed-import",
        });
        Assert.AreNotEqual(true, imported.IsError, JsonSerializer.Serialize(imported));
        var result = imported.StructuredContent!.Value.Deserialize<NendoImportResult>(NendoMcpJson.Options)!;
        Assert.AreEqual(2, result.RevisionCount, "Sixty rows are two batches, so two revisions are attributed.");

        var history = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRevision>>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history?limit=100"));
        var batches = history.Items.TakeLast(2).ToArray();
        Assert.IsTrue(batches.All(revision => revision.Origin == grant.Owner),
            $"Import revisions name {string.Join(", ", batches.Select(revision => revision.Origin))}, not the session {grant.Owner}.");

        // The origin is part of what a replay matches, so a retry from a new lease -- after a
        // restart, say -- must still replay what the first one wrote rather than conflict.
        Assert.AreNotEqual(true, (await client.CallToolAsync("nendo.lease.release", new Dictionary<string, object?>
        {
            ["applicationHandle"] = grant.ApplicationHandle,
            ["leaseId"] = grant.LeaseId,
        })).IsError);
        var next = (await client.CallToolAsync("nendo.lease.acquire")).StructuredContent!.Value
            .Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        Assert.AreNotEqual(grant.Owner, next.Owner, "A new lease is a new session.");
        var retried = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>
        {
            ["applicationHandle"] = next.ApplicationHandle,
            ["leaseId"] = next.LeaseId,
            ["entityId"] = NendoApplicationService.IdeaEntityId,
            ["format"] = "json",
            ["records"] = records,
            ["idempotencyKey"] = "attributed-import",
        });
        Assert.AreNotEqual(true, retried.IsError, "The retry from a new lease was refused: " + JsonSerializer.Serialize(retried));
        var after = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRevision>>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history?limit=100"));
        Assert.HasCount(history.Items.Count, after.Items, "The retry wrote something new instead of replaying.");
    }

    /// <summary>
    /// Ordinary use — a start, lists, reads, and every kind of refusal an agent reads — is
    /// not a failure, and records nothing. A record that filled with refusals would bury
    /// the one line it exists to keep.
    /// </summary>
    [TestMethod]
    public async Task OrdinaryUseAndEveryRefusalRecordNoFailure()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        var failures = new List<NendoAgentFailure>();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot) { RecordFailure = failure => { lock (failures) failures.Add(failure); } });
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        await client.ListToolsAsync();
        await client.ListResourcesAsync();
        await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe");
        await Assert.ThrowsExactlyAsync<McpProtocolException>(() => client.CallToolAsync("nendo.sql.execute").AsTask());
        await Assert.ThrowsExactlyAsync<McpProtocolException>(() => client.CallToolAsync("nendo.change_set.begin").AsTask());
        await Assert.ThrowsExactlyAsync<McpProtocolException>(
            () => ProtocolResourceTests.ReadTextAsync(client, "nendo://application/history?limit=0"));
        Assert.IsTrue((await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>())).IsError);
        Assert.IsTrue((await client.CallToolAsync("nendo.lease.renew", new Dictionary<string, object?>
        {
            ["applicationHandle"] = "not-a-handle",
            ["leaseId"] = "not-a-lease",
        })).IsError);
        Assert.IsEmpty(failures, "Recorded as failures: " + string.Join(" | ", failures.Select(failure => $"{failure.Source} {failure.Request} {failure.ExceptionType}")));
    }

    /// <summary>
    /// A start that recovers is not a failure. With the preferred port already taken, the
    /// hosting layer logs every refused bind as an error before the host falls back to
    /// another port; recorded, a test run that met a running Nendo on the fixed port wrote
    /// fifty of those lines into the person's device folder.
    /// </summary>
    [TestMethod]
    public async Task AStartThatFallsBackFromABusyPortRecordsNoFailure()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        using var occupied = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        occupied.Start();
        var port = ((System.Net.IPEndPoint)occupied.LocalEndpoint).Port;
        var failures = new List<NendoAgentFailure>();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot)
            {
                PreferredPort = port,
                RecordFailure = failure => { lock (failures) failures.Add(failure); },
            });
        Assert.IsTrue(host.UsedFallbackPort, "The port was free after all, so nothing was exercised.");
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        await client.ListResourcesAsync();
        Assert.IsEmpty(failures, "Recorded as failures: " + string.Join(" | ", failures.Select(failure => failure.ExceptionType)));
    }

    /// <summary>
    /// What the SDK and the web server log is kept by event and exception type only: some
    /// of their events format the request body into the message, so the message never is.
    /// </summary>
    [TestMethod]
    public void TheSdkAndWebServerLogsKeepTheEventAndTypeButNeverTheMessage()
    {
        var failures = new List<NendoAgentFailure>();
        using var provider = new NendoFailureLoggerProvider(failures.Add);
        var sdk = provider.CreateLogger("ModelContextProtocol.Server.McpServer");
        const string body = "{\"applicationHandle\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"}";
        sdk.Log(LogLevel.Error, new EventId(7, "RequestHandlerFailed"), body, new InvalidOperationException(body), (state, _) => state);
        sdk.Log(LogLevel.Error, new EventId(8, "Refused"), body, new McpException("NENDO_INVALID_REQUEST: ordinary"), (state, _) => state);
        sdk.Log(LogLevel.Information, new EventId(9, "Chatter"), body, null, (state, _) => state);
        provider.CreateLogger("Microsoft.AspNetCore.Server.Kestrel").Log(
            LogLevel.Warning, new EventId(10, "ConnectionBadRequest"), body, null, (state, _) => state);

        Assert.HasCount(2, failures, "An error and a warning; not a refusal the agent read, and not information.");
        Assert.AreEqual(("sdk", "RequestHandlerFailed: System.InvalidOperationException"), (failures[0].Source, failures[0].ExceptionType));
        Assert.AreEqual(("web server", "ConnectionBadRequest"), (failures[1].Source, failures[1].ExceptionType));
        Assert.DoesNotContain("0123456789abcdef", JsonSerializer.Serialize(failures), StringComparison.Ordinal);
    }
}
