using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Net;
using System.Text;
using Nendo.Engine;
using Microsoft.Data.Sqlite;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DiscoveryLifecycleTests
{
    [TestMethod]
    public async Task EngineRecoveryClosesLiveEndpointEvenWithoutDesktopPolling()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service,
            AgentAccessMode.DataMutation, new(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var leaseResult = await client.CallToolAsync("nendo.lease.acquire");
        var lease = leaseResult.StructuredContent!.Value.Deserialize<NendoLeaseGrant>(NendoMcpJson.Options)!;
        await using (var outside = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString()))
        {
            await outside.OpenAsync();
            await using var command = outside.CreateCommand();
            command.CommandText = "UPDATE idea SET title = 'Outside' WHERE __nendo_record_id = 'idea-001';";
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync());
        }
        var rejected = await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["entityId"] = NendoApplicationService.IdeaEntityId,
            ["recordId"] = "idea-001", ["fieldId"] = NendoApplicationService.IdeaTitleFieldId,
            ["expectedRecordVersion"] = 1, ["value"] = "Denied", ["idempotencyKey"] = "outside-edit",
        });
        Assert.IsTrue(rejected.IsError);
        Assert.IsFalse(host.IsReady);
        Assert.IsFalse(workspace.Service.Capabilities.ReadData);
        // Listener and discovery deliberately remain; the closed host is denied
        // by the synchronous Engine-to-host notification, not disposal or polling.
        Assert.IsTrue(File.Exists(host.DiscoveryPath));
        using var http = new HttpClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, host.Endpoint);
        request.Content = new StringContent("""{"jsonrpc":"2.0","id":11,"method":"tools/list","params":{}}""", Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request);
        Assert.AreEqual(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [TestMethod]
    public async Task AdmissionClosesBeforeListenerDisposalAndAClosedHostCannotReachTheFile()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var before = (await workspace.Service.GetSnapshotAsync()).Manifest;
        var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new(workspace.DiscoveryRoot));
        try
        {
            await using var client = await ProtocolResourceTests.ConnectAsync(host);
            var lease = await client.CallToolAsync("nendo.lease.acquire");
            Assert.IsFalse(lease.IsError ?? false);
            host.CloseAdmission();
            Assert.IsFalse(host.IsReady);
            // The listener is deliberately still present, proving that rejection
            // comes from closed authority rather than a refused TCP connection.
            using var http = new HttpClient();
            using var request = new HttpRequestMessage(HttpMethod.Post, host.Endpoint);
            request.Content = new StringContent("""{"jsonrpc":"2.0","id":9,"method":"tools/list","params":{}}""", Encoding.UTF8, "application/json");
            using var response = await http.SendAsync(request);
            Assert.AreEqual(HttpStatusCode.Unauthorized, response.StatusCode);
            Assert.AreEqual(before, (await workspace.Service.GetSnapshotAsync()).Manifest);
        }
        finally { await host.DisposeAsync(); }
        Assert.IsFalse(File.Exists(host.DiscoveryPath));
        Assert.IsFalse((await host.GetLeaseStatusAsync()).HasLease);
    }
    [TestMethod]
    [DataRow(AgentAccessMode.ReadOnly)]
    [DataRow(AgentAccessMode.DataMutation)]
    [DataRow(AgentAccessMode.ApplicationAuthoring)]
    public async Task InspectionOnlyFileCannotPublishAnyAgentMode(AgentAccessMode mode)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var before = (await workspace.Service.GetSnapshotAsync()).Manifest;
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        var readOnlyService = new NendoApplicationService(reader);
        await Assert.ThrowsExactlyAsync<NendoRecoveryRequiredException>(() => NendoLocalMcpHost.StartAsync(
            readOnlyService, mode, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot)));
        Assert.IsFalse(Directory.Exists(workspace.DiscoveryRoot));
        Assert.AreEqual(before, (await workspace.Service.GetSnapshotAsync()).Manifest);
    }

    [TestMethod]
    public async Task FailedDiscoveryPublicationLeavesNoDiscoverableHostAndPreservesTheFile()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var before = await workspace.Service.GetSnapshotAsync();
        await File.WriteAllTextAsync(workspace.DiscoveryRoot, "not-a-directory");

        await Assert.ThrowsExactlyAsync<IOException>(() => NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot)));

        Assert.IsFalse(Directory.Exists(workspace.DiscoveryRoot));
        Assert.AreEqual("not-a-directory", await File.ReadAllTextAsync(workspace.DiscoveryRoot));
        Assert.IsEmpty(Directory.EnumerateFiles(Path.GetDirectoryName(workspace.FilePath)!, "*.json"));
        var after = await workspace.Service.GetSnapshotAsync();
        Assert.AreEqual(before.Manifest.ChangeSequence, after.Manifest.ChangeSequence);
        Assert.AreEqual(before.Manifest.InstanceId, after.Manifest.InstanceId);
    }

    [TestMethod]
    public async Task ModeRestartRotatesEndpointAuthorityAndRevokesThePriorLease()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        var options = new NendoLocalMcpHostOptions(workspace.DiscoveryRoot);
        var first = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            options);
        var firstRun = first.HostRunId;
        var firstPath = first.DiscoveryPath;
        await using (var client = await ProtocolResourceTests.ConnectAsync(first))
        {
            var acquired = await client.CallToolAsync("nendo.lease.acquire");
            Assert.IsFalse(acquired.IsError ?? false);
        }
        await first.DisposeAsync();

        Assert.IsFalse(File.Exists(firstPath));
        Assert.IsFalse((await first.GetLeaseStatusAsync()).HasLease);
        await using var second = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            options);
        Assert.AreNotEqual(firstRun, second.HostRunId);
        Assert.AreEqual(AgentAccessMode.ReadOnly, second.Mode);
        await using var secondClient = await ProtocolResourceTests.ConnectAsync(second);
        Assert.IsEmpty(await secondClient.ListToolsAsync());
    }

    [TestMethod]
    public async Task DiscoveryIsRandomProtectedAndDeletedBeforeShutdownCompletes()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var options = new NendoLocalMcpHostOptions(workspace.DiscoveryRoot);
        string firstRun;
        string firstPath;

        await using (var first = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            options))
        {
            firstRun = first.HostRunId;
            firstPath = first.DiscoveryPath;
            Assert.IsTrue(File.Exists(firstPath));
            Assert.AreEqual(64, firstRun.Length);

            var text = await File.ReadAllTextAsync(firstPath);
            var document = JsonSerializer.Deserialize<NendoDiscoveryDocument>(text, NendoMcpJson.Options);
            Assert.IsNotNull(document);
            Assert.AreEqual(1, document.SchemaVersion);
            Assert.AreEqual(first.Endpoint.AbsoluteUri, document.Endpoint);
            Assert.IsTrue(document.Protocol.InitializeHandshake);
            Assert.DoesNotContain("bearer", text, StringComparison.OrdinalIgnoreCase);
            Assert.AreEqual(Environment.ProcessId, document.ProcessId);
            Assert.AreEqual(AgentAccessMode.ReadOnly, document.Mode);
            Assert.DoesNotContain(workspace.FilePath, text, StringComparison.OrdinalIgnoreCase);
            AssertProtectedAcl(firstPath, isDirectory: false);
            AssertProtectedAcl(workspace.DiscoveryRoot, isDirectory: true);
        }
        Assert.IsFalse(File.Exists(firstPath));

        await using (var second = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            options))
        {
            Assert.AreNotEqual(firstRun, second.HostRunId);
            Assert.AreNotEqual(firstPath, second.DiscoveryPath);
        }
        Assert.IsEmpty(Directory.EnumerateFiles(workspace.DiscoveryRoot, "*.json"));
    }

    [TestMethod]
    public async Task StartupDeletesOnlyInvalidOrProvablyStaleEntries()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        Directory.CreateDirectory(workspace.DiscoveryRoot);
        var invalid = Path.Combine(workspace.DiscoveryRoot, "invalid.json");
        var stale = Path.Combine(workspace.DiscoveryRoot, "stale.json");
        await File.WriteAllTextAsync(invalid, "not-json");
        await File.WriteAllTextAsync(stale, JsonSerializer.Serialize(
            new NendoDiscoveryDocument(
                1,
                "http://127.0.0.1:12345/mcp",
                "stale",
                int.MaxValue,
                DateTimeOffset.UtcNow.AddDays(-1),
                AgentAccessMode.ReadOnly,
                "app",
                "instance",
                "stale.nendo"),
            NendoMcpJson.Options));

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

        Assert.IsFalse(File.Exists(invalid));
        Assert.IsFalse(File.Exists(stale));
        Assert.IsTrue(File.Exists(host.DiscoveryPath));
    }

    private static void AssertProtectedAcl(string path, bool isDirectory)
    {
        FileSystemSecurity security = isDirectory
            ? new DirectoryInfo(path).GetAccessControl()
            : new FileInfo(path).GetAccessControl();
        Assert.IsTrue(security.AreAccessRulesProtected);
        var allowed = NendoDiscoveryStore.AllowedIdentityValues();
        var rules = security.GetAccessRules(
                includeExplicit: true,
                includeInherited: true,
                typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .ToArray();
        Assert.IsNotEmpty(rules);
        Assert.IsFalse(rules.Any(rule => rule.IsInherited));
        Assert.IsFalse(rules.Any(rule => rule.AccessControlType == AccessControlType.Deny));
        Assert.IsTrue(rules.All(rule => allowed.Contains(rule.IdentityReference.Value)));
        foreach (var identity in allowed)
        {
            Assert.IsTrue(rules.Any(rule => rule.IdentityReference.Value == identity));
        }
    }

    /// <summary>
    /// A client can see every running Nendo and which file each has open, and can tell
    /// which one it is talking to.
    /// </summary>
    /// <remarks>
    /// The host has written this directory since discovery existed and nothing read it
    /// (F-064), so an agent could not tell the person which file it was about to write to.
    /// Two hosts are started here because one proves nothing: the entry that matters is
    /// the one that is <em>not</em> this session's, and a list of length one cannot show
    /// that isThisOne picks the right row.
    /// </remarks>
    [TestMethod]
    public async Task ARunningNendoIsVisibleToAClientAlongWithWhichFileItHasOpen()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var other = new LocalMcpTestWorkspace();
        await other.CreateIdeaGardenAsync(recordCount: 1);

        // Both hosts advertise into one directory, which is what a device with two Nendos
        // open looks like.
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service,
            AgentAccessMode.DataMutation, new(workspace.DiscoveryRoot));
        await using var second = await NendoLocalMcpHost.StartAsync(other.Service,
            AgentAccessMode.ReadOnly, new(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var instances = ProtocolResourceTests.Deserialize<NendoRunningInstances>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://host/instances"));

        Assert.HasCount(2, instances.Instances,
            "Both running hosts advertise into this directory and both are live, so both are answers.");
        var mine = instances.Instances.Single(instance => instance.IsThisOne);
        Assert.AreEqual(host.Endpoint.AbsoluteUri, mine.Endpoint,
            "isThisOne has to mark the host answering the read, or a client reports the wrong file as the one it is about to write to.");
        Assert.AreEqual(Path.GetFileName(workspace.FilePath), mine.DisplayName);
        var theirs = instances.Instances.Single(instance => !instance.IsThisOne);
        Assert.AreEqual(Path.GetFileName(other.FilePath), theirs.DisplayName,
            "The other Nendo's open file is named, which is the whole point: an agent can say which file is which.");
        Assert.AreNotEqual(mine.Endpoint, theirs.Endpoint);

        // No path reaches an agent, by any route. The file is named, never located.
        foreach (var instance in instances.Instances)
        {
            Assert.AreEqual(Path.GetFileName(instance.DisplayName), instance.DisplayName);
            Assert.DoesNotContain(Path.DirectorySeparatorChar.ToString(), instance.DisplayName);
            Assert.DoesNotContain(Path.AltDirectorySeparatorChar.ToString(), instance.DisplayName);
            Assert.DoesNotContain(":", instance.DisplayName);
        }
        Assert.DoesNotContain(Path.GetDirectoryName(workspace.FilePath)!, instances.Note);
    }

    /// <summary>
    /// A host that has exited is not reported as somewhere to work.
    /// </summary>
    [TestMethod]
    public async Task AHostThatHasGoneIsNotOfferedAsAPlaceToWork()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 1);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service,
            AgentAccessMode.DataMutation, new(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        // An entry naming a process that is not running. The sweep would delete this on the
        // next write; the read has to refuse it now, because a client asked before then.
        var stale = Path.Combine(workspace.DiscoveryRoot, "ghost-run.json");
        await File.WriteAllTextAsync(stale, JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            endpoint = "http://127.0.0.1:65000/mcp",
            hostRunId = "ghost-run",
            processId = 999_999_998,
            createdAt = DateTimeOffset.UtcNow,
            mode = "DataMutation",
            applicationId = "application-ghost",
            instanceId = "instance-ghost",
            displayName = "ghost.nendo",
        }, NendoMcpJson.Options));

        var instances = ProtocolResourceTests.Deserialize<NendoRunningInstances>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://host/instances"));

        Assert.HasCount(1, instances.Instances,
            "A dead host was offered as a place to work. An entry the sweep would delete is not an entry worth reporting.");
        Assert.IsTrue(instances.Instances[0].IsThisOne);
    }
}
