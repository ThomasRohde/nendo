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
        // The suite lets the system pick its ports; without that the port is kept.
        Assert.IsFalse(DesktopRuntimeConfiguration.ResolveAgentPortsBySystem(_ => null));
        Assert.AreEqual(!DesktopRuntimeConfiguration.AgentPortsBySystem, store.FixedPort);
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
        // Saved as the product's defaults, which the suite's own (NENDO_AGENT_PORTS) are not.
        new DesktopAgentSettingsStore(workspace.FileHistoryRoot).Save(false, 60, true, NendoLocalMcpHostOptions.StandardPort);
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
        var path = Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "connection.json");
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
        Directory.CreateDirectory(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot));
        await File.WriteAllTextAsync(
            Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "connection.json"),
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
        Assert.IsFalse(File.Exists(Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "connection.json")));
    }

    /// <summary>
    /// The settings are the device's and every file is a window of its own. Each window
    /// read them once, so a lease expiry chosen in one never reached a listener another window
    /// started later, nor what that window's Agent page showed.
    /// </summary>
    [TestMethod]
    public async Task AChoiceSavedInOneWindowReachesTheNextListenerAnotherWindowStarts()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;
        await using var first = new DesktopSessionController(deviceStateRoot: root);
        await using var second = new DesktopSessionController(deviceStateRoot: root);
        var before = await second.GetAgentStatusAsync();
        Assert.IsFalse(before.LeaseExpiry);
        Assert.IsNull(second.CurrentHostOptions().LeaseTtl);

        await first.SetAgentSettingsAsync(leaseExpiry: true, leaseExpirySeconds: 90, fixedPort: true, port: 51234);

        var options = second.CurrentHostOptions();
        Assert.AreEqual(TimeSpan.FromSeconds(90), options.LeaseTtl, "Another window's listener started without the lease expiry just chosen.");
        Assert.AreEqual(51234, options.PreferredPort);
        var after = await second.GetAgentStatusAsync();
        Assert.IsTrue(after.LeaseExpiry, "Another window's Agent page still showed Lease expiry off.");
        Assert.AreEqual(90, after.LeaseExpirySeconds);
        Assert.AreEqual(51234, after.PortPreference);
    }

    /// <summary>
    /// A read that fails says nothing about the device's settings: the
    /// window keeps what it last read rather than falling back to the defaults, which would turn
    /// a chosen lease expiry off and move the port.
    /// </summary>
    [TestMethod]
    public async Task ARefreshThatCannotReadKeepsTheSettingsItHad()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;
        new DesktopAgentSettingsStore(root).Save(true, 90, true, 51000);
        var store = new DesktopAgentSettingsStore(root);
        var path = Path.Combine(DesktopDeviceStateLayout.Agents(root), "connection.json");
        File.Delete(path);
        Directory.CreateDirectory(path); // A task-owned obstacle: the document cannot be read.
        try
        {
            store.Refresh();
            Assert.IsTrue(store.LeaseExpiry, "One failed read turned the chosen lease expiry off.");
            Assert.AreEqual(90, store.LeaseExpirySeconds);
            Assert.AreEqual(51000, store.Port, "One failed read moved the port back to the default.");
        }
        finally { Directory.Delete(path); }
    }

    /// <summary>
    /// Reading the device's settings again keeps a choice this window could not save:
    /// it is still this session's, and the rest follows the device.
    /// </summary>
    [TestMethod]
    public async Task ARefreshKeepsAnUnsavedChoiceAndFollowsTheDeviceForTheRest()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = workspace.FileHistoryRoot;
        var store = new DesktopAgentSettingsStore(root);
        var path = Path.Combine(DesktopDeviceStateLayout.Agents(root), "connection.json");
        Directory.CreateDirectory(path); // A task-owned obstacle to reading/writing the document.
        store.Save(true, 120, store.FixedPort, store.Port);
        Assert.IsFalse(store.Persisted);
        Directory.Delete(path);
        new DesktopAgentSettingsStore(root).Save(false, 60, true, 51000);

        store.Refresh();
        Assert.IsTrue(store.LeaseExpiry, "The unsaved expiry choice was dropped by a refresh.");
        Assert.AreEqual(120, store.LeaseExpirySeconds);
        Assert.IsTrue(store.FixedPort);
        Assert.AreEqual(51000, store.Port, "The port another window saved was not picked up.");
        Assert.IsFalse(store.Persisted, "The notice that the choice is this session's went before it was saved.");
    }

    [TestMethod]
    public async Task UnreadableSettingsFallBackToDefaultsWithANotice()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot));
        await File.WriteAllTextAsync(
            Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "connection.json"), "{ not json");

        var store = new DesktopAgentSettingsStore(workspace.FileHistoryRoot);

        Assert.IsFalse(store.LeaseExpiry);
        Assert.AreEqual(DesktopAgentSettingsStore.DefaultFixedPort, store.FixedPort);
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
    }

    [TestMethod]
    public async Task SavingRepairsACorruptSettingsDocument()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot));
        var path = Path.Combine(DesktopDeviceStateLayout.Agents(workspace.FileHistoryRoot), "connection.json");
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
        var settingsBytes = await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "connection.json"));
        var portsBytes = await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "ports.json"));

        continueRequest.SetResult();
        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => pending);
        Assert.AreEqual("stale-file-session", refusal.Code);
        Assert.AreEqual(current.FileSessionId, (await session.GetViewAsync()).FileSessionId);
        AssertSettingsAndListenerUnchanged(before, await session.GetAgentStatusAsync());
        CollectionAssert.AreEqual(settingsBytes, await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "connection.json")));
        CollectionAssert.AreEqual(portsBytes, await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "ports.json")));
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
        var settingsBytes = await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "connection.json"));
        var portsBytes = await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "ports.json"));
        var requestedPort = FreePort();
        while (requestedPort == before.PortPreference) requestedPort = FreePort();

        await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            session.SetAgentSettingsAsync(true, 1, true, requestedPort));

        var after = await session.GetAgentStatusAsync();
        Assert.AreEqual(before.PortPreference, after.PortPreference,
            "A refused expiry saved the chosen file port.");
        AssertSettingsAndListenerUnchanged(before, after);
        Assert.AreEqual(before.PortPreference,
            new DesktopAgentPortStore(root).Peek(current.Manifest!.ApplicationId, current.Manifest.InstanceId, NendoLocalMcpHostOptions.StandardPort));
        CollectionAssert.AreEqual(settingsBytes, await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "connection.json")));
        CollectionAssert.AreEqual(portsBytes, await File.ReadAllBytesAsync(Path.Combine(DesktopDeviceStateLayout.Agents(root), "ports.json")));
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
        var client = await DesktopMcpClient.ConnectAsync(endpoint, "agent-settings-tests");
        var result = await client.CallToolAsync("nendo.lease.acquire", new Dictionary<string, object?>());
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result.Content));
        return client;
    }
}
