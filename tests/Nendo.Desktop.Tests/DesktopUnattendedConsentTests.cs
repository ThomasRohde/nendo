using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The Desktop half of the fifth access level: which listeners are handed the consent
/// delegate, and what it writes when one uses it
/// (ADR-0009, 2026-09-22 amendment).
/// <para>
/// The adapter's own tests substitute a delegate of their own, so this is the only lane
/// that exercises the real one. It is also the only place that can check the two things
/// the amendment promises about it: that the grant is the same one a person's click
/// writes, and that no level below Unattended is given it at all.
/// </para>
/// </summary>
[TestClass]
public sealed class DesktopUnattendedConsentTests
{
    [TestMethod]
    [DataRow("inspect")]
    [DataRow("editData")]
    [DataRow("shapeApp")]
    public async Task NoLevelBelowUnattendedCanRecordConsent(string mode)
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var discoveryRoot = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "discovery-" + mode);
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(discoveryRoot), workspace.FileHistoryRoot,
            deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);

        await session.SetAgentModeAsync(mode);
        Assert.IsFalse((await session.GetViewAsync()).BehaviourTrust!.IsApproved,
            $"{mode} recorded consent nobody gave.");
        // And nothing was written to the device either, which is the durable half.
        Assert.IsFalse(File.Exists(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json")),
            $"{mode} wrote a grant to this device.");
        // And there is nothing here to run: the delegate is the capability, so a level
        // that was never handed one cannot reach consent however it is asked.
        Assert.IsFalse(await session.GrantUnattendedBehaviourForTestAsync(),
            $"{mode} was handed the consent delegate.");
    }

    [TestMethod]
    public async Task UnattendedWritesTheSameGrantAPersonsApprovalWrites()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var grantsPath = Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json");

        // What the person's own click writes, recorded first and then taken away, so the
        // comparison below is against this device's real grant document rather than
        // against a shape this test invented.
        string expected;
        await using (var byHand = new DesktopSessionController(
            null, workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot))
        {
            await byHand.OpenAsync(workspace.FilePath);
            Assert.IsTrue((await byHand.ApproveBehaviourAsync()).BehaviourTrust!.IsApproved);
            expected = await File.ReadAllTextAsync(grantsPath);
            Assert.IsFalse((await byHand.RevokeBehaviourAsync()).BehaviourTrust!.IsApproved);
        }

        var discoveryRoot = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "discovery-unattended");
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(discoveryRoot), workspace.FileHistoryRoot,
            deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var status = await session.SetAgentModeAsync("unattended");
        Assert.AreEqual("unattended", status.Mode);
        Assert.AreEqual("ready", status.State);

        // Choosing the level records nothing. The delegate is handed over; it is the
        // agent's acceptance or its refused write that uses it.
        Assert.IsFalse((await session.GetViewAsync()).BehaviourTrust!.IsApproved,
            "Choosing the level approved the file before anything asked.");

        Assert.IsTrue(await session.GrantUnattendedBehaviourForTestAsync(),
            "Unattended was not handed a consent delegate at all.");

        var view = await session.GetViewAsync();
        Assert.IsTrue(view.BehaviourTrust!.IsApproved);
        Assert.IsTrue(view.Capabilities.Mutate);
        Assert.AreEqual(expected, await File.ReadAllTextAsync(grantsPath),
            "The grant an agent's level records differs from the one a person's click records.");
    }

    [TestMethod]
    public async Task LoweringTheLevelDoesNotWithdrawWhatWasAlreadyGranted()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        var discoveryRoot = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "discovery-lowered");
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(discoveryRoot), workspace.FileHistoryRoot,
            deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        await session.SetAgentModeAsync("unattended");
        await session.GrantUnattendedBehaviourForTestAsync();

        // Consent outlives the level that recorded it, on purpose: it is this device's
        // answer about this file, and it is withdrawn where every other approval is.
        // Saying so here rather than leaving somebody to find out.
        await session.SetAgentModeAsync("off");
        Assert.IsTrue((await session.GetViewAsync()).BehaviourTrust!.IsApproved);
        Assert.IsFalse((await session.RevokeBehaviourAsync()).BehaviourTrust!.IsApproved);
    }

    /// <summary>A file carrying one trigger, closed, as the shell would find it.</summary>
    private static async Task SeedAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "seed");
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("seed", "schema", "seed", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
        ]));
        await service.CreateRecordAsync(new("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "First" },
            new NendoRequestContext("seed", "n1", "seed")));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("seed", "behaviour", "seed", "Stamp", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "note.stamp", "Stamp the label",
                [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("stamp", "Concat('Seen ', label)",
                        [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)], []))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-stamp", "notes", "Stamp the label",
                NendoTriggerEvents.Updated, "note.stamp", ["label"]), revision),
        ]));
    }
}
