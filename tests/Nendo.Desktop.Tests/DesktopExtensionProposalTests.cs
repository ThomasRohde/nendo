using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Views that propose (ADR-0013 Phase 3, W-069): a custom view prepares a definition change in
/// its package's name through the same path as the Workbench's own proposals. The host keeps
/// the view's actor as the proposal's origin, lets one proposal per package wait at a time,
/// shows a view only its own package's proposals, and never lets it promote or reject. What
/// the broker sends is pinned in scripts/extension-broker.test.mjs; this is the host's half.
/// </summary>
[TestClass]
public sealed class DesktopExtensionProposalTests
{
    private static readonly string Package = DesktopExtensionViewJourneyTests.ProbePackages[0];
    private static readonly string Actor = "extension:" + Package;

    [TestMethod]
    public async Task AViewPreparesAProposalInItsPackagesNameAndHistorySaysSoOnceAccepted()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;
        var before = (await session.GetViewAsync()).Manifest!.ChangeSequence;

        var prepared = await handler.HandleAsync(Prepare(fileSessionId, "view.due", Actor));
        Assert.IsTrue(prepared.Ok, prepared.Error?.Message);
        var proposal = (NendoProposalPreview)prepared.Result!;
        Assert.AreEqual(NendoProposalState.Previewable, proposal.State, string.Join("; ", proposal.Diagnostics.Select(d => d.Message)));
        Assert.AreEqual(Actor, proposal.Origin, "The proposal does not carry the view's package as its origin, so the review cannot name it.");
        Assert.AreEqual(before, (await session.GetViewAsync()).Manifest!.ChangeSequence, "Preparing a proposal changed the file.");

        var read = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ProposalGet, new { proposalId = proposal.ProposalId, actor = Actor }));
        Assert.IsTrue(read.Ok, read.Error?.Message);

        foreach (var method in new[] { WorkbenchMethods.ProposalPromote, WorkbenchMethods.ProposalReject })
        {
            var refused = await handler.HandleAsync(Request(fileSessionId, method,
                new { proposalId = proposal.ProposalId, expectedOperationDigest = proposal.OperationDigest, actor = Actor }));
            Assert.IsFalse(refused.Ok, $"A view's actor reached {method}.");
            Assert.AreEqual("actor-not-allowed", refused.Error!.Code, refused.Error.Message);
        }
        Assert.AreEqual(NendoProposalState.Previewable, (await session.GetProposalAsync(proposal.ProposalId)).State, "A refused promote or reject moved the proposal.");

        var accepted = await session.PromoteProposalAsync(proposal.ProposalId, expectedOperationDigest: proposal.OperationDigest);
        Assert.IsTrue(accepted.Promotion.Applied, accepted.Promotion.Message);
        var decided = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ProposalGet, new { proposalId = proposal.ProposalId, actor = Actor }));
        Assert.IsTrue(decided.Ok, "The view lost its proposal once it was accepted: " + decided.Error?.Message);
        Assert.AreEqual(NendoProposalState.Active, ((DesktopDecidedProposalView)decided.Result!).State,
            "An accepted proposal does not read as active to the view that prepared it.");
        var history = await session.GetHistoryAsync();
        Assert.AreEqual(Actor, history.Single(revision => revision.ChangeSequence == accepted.Promotion.Result!.ChangeSequence).Origin,
            "History does not name the view's package on the change it proposed.");
    }

    [TestMethod]
    public async Task OneProposalOfAPackageWaitsAtATimeAndAPersonsIsNotCounted()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var first = await handler.HandleAsync(Prepare(fileSessionId, "view.first", Actor));
        Assert.IsTrue(first.Ok, first.Error?.Message);
        var firstId = ((NendoProposalPreview)first.Result!).ProposalId;

        var second = await handler.HandleAsync(Prepare(fileSessionId, "view.second", Actor));
        Assert.IsFalse(second.Ok, "A package had two proposals waiting at once.");
        Assert.AreEqual("proposal-waiting", second.Error!.Code, second.Error.Message);
        StringAssert.Contains(second.Error.Message, firstId, "The refusal does not name the proposal that is waiting.");

        var person = await handler.HandleAsync(Prepare(fileSessionId, "person.field", actor: null));
        Assert.IsTrue(person.Ok, "A person's proposal was held back by a view's: " + person.Error?.Message);

        await session.RejectProposalAsync(firstId);
        var rejected = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ProposalGet, new { proposalId = firstId, actor = Actor }));
        Assert.IsTrue(rejected.Ok, rejected.Error?.Message);
        Assert.AreEqual(NendoProposalState.Rejected, ((DesktopDecidedProposalView)rejected.Result!).State,
            "A rejected proposal does not read as rejected to the view that prepared it.");
        var again = await handler.HandleAsync(Prepare(fileSessionId, "view.again", Actor));
        Assert.IsTrue(again.Ok, "Once its proposal was rejected, the view could not ask again: " + again.Error?.Message);
    }

    [TestMethod]
    public async Task AViewReadsOnlyItsOwnPackagesProposals()
    {
        await using var workspace = new DesktopTestWorkspace();
        await DesktopExtensionViewJourneyTests.SeedAsync(workspace.FilePath);
        var (session, handler, fileSessionId) = await OpenAsync(workspace);
        await using var _ = session;

        var person = await handler.HandleAsync(Prepare(fileSessionId, "person.field", actor: null));
        var personId = ((NendoProposalPreview)person.Result!).ProposalId;
        var other = "extension:" + DesktopExtensionViewJourneyTests.ProbePackages[1];
        var otherView = await handler.HandleAsync(Prepare(fileSessionId, "other.field", other));
        var otherId = ((NendoProposalPreview)otherView.Result!).ProposalId;

        foreach (var id in new[] { personId, otherId })
        {
            var read = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ProposalGet, new { proposalId = id, actor = Actor }));
            Assert.IsFalse(read.Ok, "A view read a proposal its package did not prepare.");
            Assert.AreEqual("proposal-not-found", read.Error!.Code, read.Error.Message);
        }
        var own = await handler.HandleAsync(Request(fileSessionId, WorkbenchMethods.ProposalGet, new { proposalId = otherId, actor = other }));
        Assert.IsTrue(own.Ok, own.Error?.Message);
    }

    private static string Prepare(string fileSessionId, string fieldId, string? actor)
    {
        var operation = new
        {
            operationId = "op-" + fieldId,
            operationType = "schema.addField",
            payload = new { entityId = "tasks", fieldId, displayName = "Field " + fieldId, storageKind = "date", required = false, presentation = "date", options = Array.Empty<string>() },
        };
        object payload = actor is null
            ? new { proposalId = NewProposalId(), title = "Add " + fieldId, mutations = new[] { new { idempotencyKey = "m-" + fieldId, description = "Add " + fieldId, operations = new[] { operation } } } }
            : new { proposalId = NewProposalId(), title = "Add " + fieldId, mutations = new[] { new { idempotencyKey = "m-" + fieldId, description = "Add " + fieldId, operations = new[] { operation } } }, actor };
        return Request(fileSessionId, WorkbenchMethods.ProposalPrepareChangeSet, payload);
    }

    private static string NewProposalId() => "proposal-" + Guid.NewGuid().ToString("N");

    private static async Task<(DesktopSessionController Session, WorkbenchProtocolHandler Handler, string FileSessionId)> OpenAsync(DesktopTestWorkspace workspace)
    {
        var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null), () => Task.FromResult<string?>(null), _ => { });
        var view = await session.GetViewAsync();
        Assert.IsTrue(view.Extensions!.Run, "Views are not running in the seeded file.");
        return (session, handler, view.FileSessionId!);
    }

    private static string Request(string fileSessionId, string method, object payload) => JsonSerializer.Serialize(new
    {
        protocolVersion = DesktopShellContract.BridgeProtocolVersion,
        requestId = "proposal-test-" + Guid.NewGuid().ToString("N"),
        method,
        fileSessionId,
        payload,
    });
}
