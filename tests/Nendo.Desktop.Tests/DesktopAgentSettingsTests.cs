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
}
