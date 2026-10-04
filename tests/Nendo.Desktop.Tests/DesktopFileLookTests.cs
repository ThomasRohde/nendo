using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-089. The window, the notification area and every notification draw the open file's look,
/// and the About page lets the person choose one. The host hands the look out with the view,
/// and a chosen look arrives by the same reviewed change set as any other edit to the file.
/// </summary>
[TestClass]
public sealed class DesktopFileLookTests
{
    [TestMethod]
    public async Task TheViewCarriesTheLookAsDrawnAndAChosenOneReplacesTheDefaults()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        Assert.IsNull((await session.GetViewAsync()).Look, "No file, nothing to draw.");
        Assert.IsNull(session.CurrentLook);

        await session.CreateAsync(workspace.FilePath);
        var view = await session.GetViewAsync();
        var applicationId = view.Manifest!.ApplicationId;
        var tone = NendoLook.DefaultTone(applicationId);
        Assert.AreEqual(new NendoResolvedLook(tone, "D", false, false, tone, "D"), view.Look,
            "desktop-session.nendo is drawn in its application's tone with its first letter.");
        Assert.AreEqual(view.Look, session.CurrentLook, "The window reads the look the view last read.");

        // What the About page sends, through the bridge the page uses.
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var id = Guid.NewGuid().ToString("N");
        var prepared = await handler.HandleAsync(JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId = "look-" + id,
            method = WorkbenchMethods.ProposalPrepareChangeSet,
            fileSessionId = view.FileSessionId,
            payload = new
            {
                proposalId = $"proposal-{id}",
                title = "Give this file its own look",
                mutations = new[]
                {
                    new
                    {
                        idempotencyKey = $"look-{id}",
                        description = "Give this file its own look",
                        operations = new[]
                        {
                            new
                            {
                                operationId = $"look-{id}",
                                operationType = "application.setLook",
                                payload = new { tone = "violet", letter = "p", expectedDefinitionRevision = view.Manifest.DefinitionRevision },
                            },
                        },
                    },
                },
            },
        }));
        Assert.IsTrue(prepared.Ok, prepared.Error?.Message);
        var proposal = (NendoProposalPreview)prepared.Result!;
        Assert.AreEqual(NendoProposalState.Previewable, proposal.State, string.Join("; ", proposal.Diagnostics.Select(d => d.Message)));
        Assert.AreEqual(new NendoApplicationLook("violet", "P"), proposal.LookAfter, "The review says what the file would look like.");
        Assert.IsTrue(proposal.SemanticDiff.Any(entry => entry.Summary == "Give this file its own icon: violet, the letter P."));

        var accepted = await session.PromoteProposalAsync(proposal.ProposalId, expectedOperationDigest: proposal.OperationDigest);
        Assert.IsTrue(accepted.Promotion.Applied, accepted.Promotion.Message);
        var after = await session.GetViewAsync();
        Assert.AreEqual(new NendoResolvedLook("violet", "P", true, true, tone, "D"), after.Look,
            "What the file chose, and still what it would have by default.");
        Assert.AreEqual(after.Look, session.CurrentLook);

        await session.CloseAsync();
        Assert.IsNull((await session.GetViewAsync()).Look);
        Assert.IsNull(session.CurrentLook, "A closed file leaves the window nothing of its look.");
    }
}
