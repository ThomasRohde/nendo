using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Stage S7: the shell's route to approving a file's automatic actions.
/// <para>
/// The Engine refuses unapproved edits on its own; these cases are about the part a
/// person touches — that the shell says what the file will do, that saying yes is
/// what makes editing available, and that the yes stays on this device rather than
/// travelling with the file.
/// </para>
/// </summary>
[TestClass]
public sealed class WorkbenchBehaviourApprovalTests
{
    [TestMethod]
    public async Task AFileWithTriggersSaysWhatTheyDoAndCannotBeEditedUntilApproved()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        await using var session = Session(workspace);
        await session.OpenAsync(workspace.FilePath);

        var trust = (await session.GetViewAsync()).BehaviourTrust;
        Assert.IsNotNull(trust);
        Assert.IsTrue(trust.RequiresApproval);
        Assert.IsFalse(trust.IsApproved);

        // Described by what happens to the owner's data, which is the part they can
        // weigh. This file's action only sets a field.
        Assert.IsTrue(trust.UpdatesRecords);
        Assert.IsFalse(trust.CreatesRecords);
        Assert.IsFalse(trust.DeletesRecords);
        Assert.IsNotNull(trust.BehaviourDigest);

        var view = await session.GetViewAsync();
        Assert.IsTrue(view.Capabilities.ReadData, "An unapproved file hid the owner's data.");
        Assert.IsTrue(view.Capabilities.Export);
        Assert.IsFalse(view.Capabilities.Mutate);
    }

    [TestMethod]
    public async Task ApprovingMakesEditingAvailableAndWithdrawingTakesItBack()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        await using var session = Session(workspace);
        await session.OpenAsync(workspace.FilePath);

        var approved = await session.ApproveBehaviourAsync();
        Assert.IsTrue(approved.BehaviourTrust!.IsApproved);
        Assert.IsTrue(approved.Capabilities.Mutate);

        var withdrawn = await session.RevokeBehaviourAsync();
        Assert.IsFalse(withdrawn.BehaviourTrust!.IsApproved);
        Assert.IsFalse(withdrawn.Capabilities.Mutate);
    }

    [TestMethod]
    public async Task ApprovalIsRememberedNextLaunchAndDoesNotTravelWithTheFile()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath);
        await using (var session = Session(workspace))
        {
            await session.OpenAsync(workspace.FilePath);
            await session.ApproveBehaviourAsync();
        }

        // The same device remembers.
        await using (var reopened = Session(workspace))
        {
            await reopened.OpenAsync(workspace.FilePath);
            var view = await reopened.GetViewAsync();
            Assert.IsTrue(view.BehaviourTrust!.IsApproved);
            Assert.IsTrue(view.Capabilities.Mutate);
        }

        // Another device has never been asked. Nothing was written into the file to
        // record the approval, so sending the file to somebody else does not send them
        // the choice to trust it.
        var elsewhere = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "other-device");
        await using var stranger = new DesktopSessionController(
            null, elsewhere, deviceStateRoot: elsewhere);
        await stranger.OpenAsync(workspace.FilePath);
        var strangerView = await stranger.GetViewAsync();
        Assert.IsFalse(strangerView.BehaviourTrust!.IsApproved,
            "Approval travelled with the file rather than staying on the device that gave it.");
        Assert.IsFalse(strangerView.Capabilities.Mutate);
    }

    [TestMethod]
    public async Task AFileWithNoAutomaticActionsIsNeverAskedAbout()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = Session(workspace);
        await session.CreateAsync(workspace.FilePath);

        var view = await session.GetViewAsync();
        Assert.IsFalse(view.BehaviourTrust!.RequiresApproval);
        Assert.IsTrue(view.Capabilities.Mutate);
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => session.ApproveBehaviourAsync());
    }

    private static DesktopSessionController Session(DesktopTestWorkspace workspace) =>
        new(null, workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);

    /// <summary>
    /// Builds a file that carries one trigger, through the Engine, and closes it —
    /// which is the state the shell finds a file in when somebody opens one they were
    /// sent or made elsewhere.
    /// </summary>
    private static async Task SeedAsync(string path)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "seed");
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("seed", "schema", "seed", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 0L },
            new NendoRequestContext("seed", "p1", "seed")));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("seed", "behaviour", "seed", "Totals", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.setTotal", "Set the project total",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "doneCount",
                        [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done")], []))]),
                revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-total", "tasks", "Keep the project total current",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted,
                "project.setTotal", ["done", "project"]), revision),
        ]));
    }
}
