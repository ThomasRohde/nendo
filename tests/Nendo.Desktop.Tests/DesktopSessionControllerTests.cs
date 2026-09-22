using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

[TestClass]
public sealed class DesktopSessionControllerTests
{
    [TestMethod]
    public void RecentAgentReportsActivityWithoutClaimingALiveConnection()
    {
        var timestamp = DateTimeOffset.Parse("2026-09-03T16:00:00Z");
        var connected = new NendoAgentActivity(
            timestamp,
            "Local agent (agent-b26345e7426d)",
            "session",
            "connected",
            "completed",
            null,
            null);
        var initialized = new NendoAgentActivity(
            timestamp.AddSeconds(1),
            "codex-mcp-client 0.153.0-alpha.5 (agent-b26345e7426d)",
            "resource",
            "nendo://application/manifest",
            "completed",
            null,
            null);
        var disconnected = new NendoAgentActivity(
            timestamp.AddSeconds(2),
            "codex-mcp-client 0.153.0-alpha.5 (agent-b26345e7426d)",
            "session",
            "disconnected",
            "completed",
            null,
            null);

        Assert.AreEqual(
            initialized.Client,
            DesktopSessionController.ResolveConnectedAgent([connected, initialized]));
        Assert.AreEqual(initialized.Client, DesktopSessionController.ResolveConnectedAgent([connected, initialized, disconnected]));
        Assert.IsNull(DesktopSessionController.ResolveConnectedAgent([]));
    }

    [TestMethod]
    public async Task DesktopOwnsAgentModeRotationAndFileLifecycle()
    {
        await using var workspace = new DesktopTestWorkspace();
        var discoveryRoot = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "agent-discovery");
        await using var session = new DesktopSessionController(
            new NendoLocalMcpHostOptions(discoveryRoot), workspace.FileHistoryRoot);

        var withoutFile = await session.GetAgentStatusAsync();
        Assert.IsFalse(withoutFile.Available);
        Assert.AreEqual("noFile", withoutFile.State);

        await session.CreateAsync(workspace.FilePath);
        var off = await session.GetAgentStatusAsync();
        Assert.IsTrue(off.Available);
        Assert.AreEqual("off", off.Mode);
        Assert.IsFalse(Directory.Exists(discoveryRoot));

        var inspect = await session.SetAgentModeAsync("inspect");
        Assert.AreEqual("inspect", inspect.Mode);
        Assert.AreEqual("ready", inspect.State);
        Assert.HasCount(1, Directory.GetFiles(discoveryRoot, "*.json"));
        var firstDiscovery = Directory.GetFiles(discoveryRoot, "*.json").Single();

        var editing = await session.SetAgentModeAsync("editData");
        Assert.AreEqual("editData", editing.Mode);
        Assert.IsFalse(File.Exists(firstDiscovery));
        Assert.HasCount(1, Directory.GetFiles(discoveryRoot, "*.json"));

        var shaping = await session.SetAgentModeAsync("shapeApp");
        Assert.AreEqual("shapeApp", shaping.Mode);
        Assert.AreEqual("ready", shaping.State);

        // The fifth rung. It rotates like the others; what makes it different is that
        // nothing carries it forward, which the reopen at the end of this test checks.
        var unattended = await session.SetAgentModeAsync("unattended");
        Assert.AreEqual("unattended", unattended.Mode);
        Assert.AreEqual("ready", unattended.State);
        Assert.HasCount(1, Directory.GetFiles(discoveryRoot, "*.json"));

        var revoked = await session.RevokeAgentEditingAsync();
        Assert.IsNull(revoked.EditingOwner);

        var disabled = await session.SetAgentModeAsync("off");
        Assert.AreEqual("off", disabled.Mode);
        Assert.AreEqual("off", disabled.State);
        Assert.IsEmpty(Directory.GetFiles(discoveryRoot, "*.json"));

        // Reopened at Unattended rather than Inspect: the level that must not survive a
        // file closing is the one worth closing the file on.
        await session.SetAgentModeAsync("unattended");
        var closingDiscovery = Directory.GetFiles(discoveryRoot, "*.json").Single();
        await session.CloseAsync();
        Assert.IsFalse(File.Exists(closingDiscovery));
        Assert.IsFalse((await session.GetAgentStatusAsync()).Available);
        var reopened = await session.OpenAsync(workspace.FilePath);
        Assert.IsTrue(reopened.HasFile);
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
    }

    [TestMethod]
    public async Task DesktopOwnsCreateMutateCloseAndReopenWithoutProjectingThePath()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot))
        {
            var empty = await session.CreateAsync(workspace.FilePath);
            Assert.IsTrue(empty.HasFile);
            Assert.AreEqual("desktop-session.nendo", empty.FileName);
            Assert.AreEqual("normal", empty.Health);
            Assert.IsEmpty(empty.Entities);

            await session.CreateIdeaSchemaAsync("schema-controller");
            await session.CreateIdeaRecordAsync("idea-controller", "Controller idea", "record-controller");
            var edited = await session.SetIdeaTitleAsync(
                "idea-controller",
                1,
                "Reopened controller idea",
                "edit-controller");
            Assert.IsNotNull(edited.Session);
            Assert.AreEqual(3L, edited.Session.Manifest!.ChangeSequence);
            Assert.AreEqual("Reopened controller idea", edited.Session.Records[0]
                .Values[NendoApplicationService.IdeaTitleFieldId]
                .GetString());
        }

        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
        await using var reopened = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var view = await reopened.OpenAsync(workspace.FilePath);
        Assert.AreEqual("desktop-session.nendo", view.FileName);
        Assert.AreEqual(3L, view.Manifest!.ChangeSequence);
        Assert.AreEqual(2L, view.Records[0].RecordVersion);
    }

    [TestMethod]
    public async Task MutationWithoutAFileReturnsTheTypedPrecondition()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);

        var exception = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => session.CreateIdeaSchemaAsync("no-file"));

        Assert.AreEqual("no-file-open", exception.Code);
    }

    [TestMethod]
    public async Task DesktopOwnsProposalUseAndHistoryServicesWithoutProjectingStorage()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("p2-controller-schema");

        var proposal = await session.PrepareIdeaGardenProposalAsync();
        Assert.AreEqual(NendoProposalState.Previewable, proposal.State);
        Assert.IsNotEmpty(proposal.PreviewApplications);
        Assert.AreEqual("Idea board", proposal.Root("boardSurface").Title());

        var promoted = await session.PromoteProposalAsync(proposal.ProposalId);
        Assert.IsTrue(promoted.Promotion.Applied);
        Assert.IsNotNull(promoted.Session);
        Assert.IsNotEmpty(promoted.Session.UiNodes);

        var created = await session.CreateIdeaRecordAsync(
            "idea-p2-controller",
            new NendoIdeaDraft(
                "A complete Idea",
                "Notes",
                "Exploring",
                "High",
                "2026-09-03",
                "Test the surface"),
            "p2-controller-record");
        var command = await session.ExecuteIdeaCommandAsync(
            "command.idea.moveToTrying",
            "idea-p2-controller",
            created.Session!.Records.Single().RecordVersion,
            "p2-controller-command");

        var compilation = await session.CompileSemanticUiAsync();
        var history = await session.GetHistoryAsync();
        Assert.IsTrue(compilation.IsValid);
        Assert.AreEqual("Trying", compilation.App().Records.Single()
            .Values[NendoApplicationService.IdeaStatusFieldId].GetString());
        Assert.AreEqual(command.Mutation.RevisionId, history[^1].RevisionId);
    }
}
