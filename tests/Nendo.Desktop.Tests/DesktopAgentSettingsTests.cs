using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopAgentSettingsTests
{
    // The defaults are the product promise for a single-user local install.
    [TestMethod]
    public async Task DefaultsAreTheRelaxedLocalOnes()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);

        Assert.IsFalse(store.LeaseExpiry);
        Assert.IsTrue(store.FixedPort);
        Assert.AreEqual(NendoLocalMcpHostOptions.StandardPort, store.Port);
        Assert.IsTrue(store.Persisted);
        Assert.IsFalse(Directory.Exists(workspace.FileHistoryRoot));
    }

    [TestMethod]
    public async Task HardenedChoicesSurviveANewStore()
    {
        await using var workspace = new DesktopTestWorkspace();
        new DesktopAgentSettingsStore(workspace.FileHistoryRoot)
            .Save(leaseExpiry: true, leaseExpirySeconds: 120, fixedPort: false, port: 51000);

        var reopened = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);

        Assert.IsTrue(reopened.LeaseExpiry);
        Assert.AreEqual(120, reopened.LeaseExpirySeconds);
        Assert.IsFalse(reopened.FixedPort);
        Assert.AreEqual(51000, reopened.Port);
    }

    [TestMethod]
    public async Task AStaleWindowSavesOnlyItsChangedPreferences()
    {
        await using var workspace = new DesktopTestWorkspace();
        var first = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);
        var second = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);
        first.Save(true, 120, true, first.Port);
        second.Save(false, 60, false, 51000);
        var reopened = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);
        Assert.IsTrue(reopened.LeaseExpiry, "A stale port edit must preserve another window's lease expiry choice.");
        Assert.AreEqual(120, reopened.LeaseExpirySeconds);
        Assert.IsFalse(reopened.FixedPort);
        Assert.AreEqual(51000, reopened.Port);
        // The first window still holds the old port choices when it edits expiry again.
        first.Save(false, 240, true, first.Port);
        reopened = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);
        Assert.IsFalse(reopened.LeaseExpiry);
        Assert.AreEqual(240, reopened.LeaseExpirySeconds);
        Assert.IsFalse(reopened.FixedPort, "A stale expiry edit must preserve another window's port choice.");
        Assert.AreEqual(51000, reopened.Port);
    }

    [TestMethod]
    public async Task RetryingAnUnsavedChoiceKeepsTheSameIntent()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "agent-settings.json");
        Directory.CreateDirectory(path); // A task-owned obstacle to reading/writing the document.
        store.Save(true, 120, false, 51000);
        Assert.IsFalse(store.Persisted);
        Assert.IsTrue(store.LeaseExpiry);
        Directory.Delete(path);
        store.Save(true, 120, false, 51000);
        Assert.IsTrue(store.Persisted);
        var reopened = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);
        Assert.IsTrue(reopened.LeaseExpiry, "Retrying an unsaved expiry choice must not restore the old disk default.");
        Assert.AreEqual(120, reopened.LeaseExpirySeconds);
        Assert.IsFalse(reopened.FixedPort);
        Assert.AreEqual(51000, reopened.Port);
    }

    // Settings saved before the credential was removed still load; the stale key is ignored.
    [TestMethod]
    public async Task ASettingsDocumentWithTheRetiredCredentialKeyStillLoads()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(
            Path.Combine(workspace.FileHistoryRoot, "agent-settings.json"),
            """{"Version":1,"LeaseExpiry":false,"LeaseExpirySeconds":60,"FixedPort":true,"Port":41763,"StableCredential":true}""");

        var store = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);

        Assert.IsTrue(store.Persisted);
        Assert.IsTrue(store.FixedPort);
        Assert.AreEqual(41763, store.Port);
    }

    [TestMethod]
    [DataRow(14, 41763, DisplayName = "expiry below the floor")]
    [DataRow(86401, 41763, DisplayName = "expiry above the ceiling")]
    [DataRow(60, 80, DisplayName = "privileged port")]
    [DataRow(60, 70000, DisplayName = "port out of range")]
    public async Task OutOfRangeValuesAreRefusedWithoutChangingAnything(int seconds, int port)
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);

        Assert.ThrowsExactly<NendoValidationException>(() =>
            store.Save(leaseExpiry: true, leaseExpirySeconds: seconds, fixedPort: true, port: port));

        Assert.IsFalse(store.LeaseExpiry);
        Assert.AreEqual(NendoLocalMcpHostOptions.StandardPort, store.Port);
        Assert.IsFalse(File.Exists(Path.Combine(workspace.FileHistoryRoot, "agent-settings.json")));
    }

    [TestMethod]
    public async Task UnreadableSettingsFallBackToDefaultsWithANotice()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(
            Path.Combine(workspace.FileHistoryRoot, "agent-settings.json"), "{ not json");

        var store = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);

        Assert.IsFalse(store.LeaseExpiry);
        Assert.IsTrue(store.FixedPort);
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
    }

    [TestMethod]
    public async Task SavingRepairsACorruptSettingsDocument()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        var path = Path.Combine(workspace.FileHistoryRoot, "agent-settings.json");
        await File.WriteAllTextAsync(path, "{ not json");
        var store = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);

        store.Save(leaseExpiry: true, leaseExpirySeconds: 120, fixedPort: true, port: store.Port);

        Assert.IsTrue(store.Persisted, "A corrupt settings document blocked every later save.");
        Assert.IsNull(store.Notice);
        var reopened = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);
        Assert.IsTrue(reopened.Persisted);
        Assert.IsTrue(reopened.LeaseExpiry);
        Assert.AreEqual(120, reopened.LeaseExpirySeconds);
    }

    [TestMethod]
    public async Task ASettingsRequestAdmittedBeforeSwitchCannotChangeTheNewFile()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(Path.Combine(root, "discovery")), root, deviceStateRoot: root);
        await session.SetAgentSettingsAsync(false, 60, true, FreePort());
        var original = await session.CreateAsync(workspace.FilePath);
        var admitted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var continueRequest = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var pending = Task.Run(async () =>
        {
            using (session.BindFileRequest(original.FileSessionId!))
            {
                // The protocol performs this check before dispatch. Pause at the
                // boundary so the native file switch deterministically wins.
                await session.ValidateFileRequestAsync(CancellationToken.None);
                admitted.SetResult();
                await continueRequest.Task;
                return await session.SetAgentSettingsAsync(true, 120, true, FreePort());
            }
        });
        await admitted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await session.CloseAsync();
        var current = await session.CreateAsync(Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "next.nendo"));
        await session.SetAgentModeAsync("editData");
        await using var client = await AcquireLeaseAsync((await session.GetAgentStatusAsync()).Endpoint!);
        var before = await session.GetAgentStatusAsync();
        var settingsBytes = await File.ReadAllBytesAsync(Path.Combine(root, "agent-settings.json"));
        var portsBytes = await File.ReadAllBytesAsync(Path.Combine(root, "agent-ports.json"));

        continueRequest.SetResult();
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => pending);
        Assert.AreEqual("stale-file-session", refusal.Code);
        Assert.AreEqual(current.FileSessionId, (await session.GetViewAsync()).FileSessionId);
        AssertSettingsAndListenerUnchanged(before, await session.GetAgentStatusAsync());
        CollectionAssert.AreEqual(settingsBytes, await File.ReadAllBytesAsync(Path.Combine(root, "agent-settings.json")));
        CollectionAssert.AreEqual(portsBytes, await File.ReadAllBytesAsync(Path.Combine(root, "agent-ports.json")));
    }

    [TestMethod]
    public async Task ARefusedExpiryCannotSaveTheChosenFilePortOrRestartItsListener()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(Path.Combine(root, "discovery")), root, deviceStateRoot: root);
        await session.SetAgentSettingsAsync(false, 60, true, FreePort());
        var current = await session.CreateAsync(workspace.FilePath);
        await session.SetAgentModeAsync("editData");
        await using var client = await AcquireLeaseAsync((await session.GetAgentStatusAsync()).Endpoint!);
        var before = await session.GetAgentStatusAsync();
        var settingsBytes = await File.ReadAllBytesAsync(Path.Combine(root, "agent-settings.json"));
        var portsBytes = await File.ReadAllBytesAsync(Path.Combine(root, "agent-ports.json"));
        var requestedPort = FreePort();
        while (requestedPort == before.PortPreference) requestedPort = FreePort();

        await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            session.SetAgentSettingsAsync(true, 1, true, requestedPort));

        var after = await session.GetAgentStatusAsync();
        Assert.AreEqual(before.PortPreference, after.PortPreference,
            "A refused expiry saved the chosen file port.");
        AssertSettingsAndListenerUnchanged(before, after);
        Assert.AreEqual(before.PortPreference,
            new DesktopAgentPortStore(root).Peek(current.Manifest!.ApplicationId, NendoLocalMcpHostOptions.StandardPort));
        CollectionAssert.AreEqual(settingsBytes, await File.ReadAllBytesAsync(Path.Combine(root, "agent-settings.json")));
        CollectionAssert.AreEqual(portsBytes, await File.ReadAllBytesAsync(Path.Combine(root, "agent-ports.json")));
    }

    private static int FreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static void AssertSettingsAndListenerUnchanged(DesktopAgentStatus before, DesktopAgentStatus after)
    {
        Assert.AreEqual(before.Mode, after.Mode);
        Assert.AreEqual(before.State, after.State);
        Assert.AreEqual(before.Endpoint, after.Endpoint);
        Assert.IsNotNull(before.EditingOwner, "The fixture must hold a lease before the refused request.");
        Assert.AreEqual(before.EditingOwner, after.EditingOwner, "The refused request restarted the listener or ended its lease.");
        Assert.AreEqual(before.LeaseExpiresAt, after.LeaseExpiresAt);
        Assert.AreEqual(before.LeaseExpiry, after.LeaseExpiry);
        Assert.AreEqual(before.LeaseExpirySeconds, after.LeaseExpirySeconds);
        Assert.AreEqual(before.FixedPort, after.FixedPort);
        Assert.AreEqual(before.PortPreference, after.PortPreference);
        Assert.AreEqual(before.SettingsPersisted, after.SettingsPersisted);
        Assert.AreEqual(before.SettingsNotice, after.SettingsNotice);
    }

    private static async Task<McpClient> AcquireLeaseAsync(string endpoint)
    {
        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Endpoint = new Uri(endpoint), TransportMode = HttpTransportMode.StreamableHttp,
            ConnectionTimeout = TimeSpan.FromSeconds(5),
        });
        var client = await McpClient.CreateAsync(transport, new McpClientOptions
        {
            ClientInfo = new Implementation { Name = "agent-settings-tests", Version = "1.0.0" },
            ProtocolVersion = "2026-07-28", InitializationTimeout = TimeSpan.FromSeconds(5),
        });
        var result = await client.CallToolAsync("nendo.lease.acquire", new Dictionary<string, object?>());
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result.Content));
        return client;
    }
}
