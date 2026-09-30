using System.Reflection;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
public sealed class AuthoringCancellationTests
{
    [TestMethod]
    public async Task ARejectCancelledAtTheEngineGateKeepsOwnershipAndAllowsTheExactRetry()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var manifest = (await workspace.Service.GetSnapshotAsync()).Manifest;
        var host = new NendoHostAuthority("cancelled-reject", AgentAccessMode.ApplicationAuthoring,
            new byte[32], manifest.ApplicationId, manifest.InstanceId);
        using var authority = new NendoAgentAuthority(host, new SystemNendoClock(), null);
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(manifest.ApplicationId, manifest.InstanceId);
        using var authoring = new NendoAgentAuthoringService(workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        const string sessionId = "cancellation-session";
        var lease = await authority.AcquireAsync(sessionId, "cancellation fixture", CancellationToken.None);
        var begun = await authoring.BeginAsync(sessionId, lease.LeaseId, "Retain cancelled proposal",
            "begin", CancellationToken.None);
        await authoring.AddOperationsAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
            [new NendoAgentMutationInput("Create Notes", [new NendoAgentOperationInput("schema.createEntity",
                JsonSerializer.SerializeToElement(new { entityId = "notes", displayName = "Notes" }))])],
            "add", CancellationToken.None);
        var preview = await authoring.ValidateAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
            "validate", CancellationToken.None);
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);

        // Hold only the generated fixture's coordinator gate. This controls the
        // cancellation boundary without adding a privileged production test API.
        var coordinator = typeof(LocalMcpTestWorkspace).GetField("_coordinator",
            BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(workspace)!;
        var gate = (SemaphoreSlim)typeof(NendoWriteCoordinator).GetField("_gate",
            BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(coordinator)!;
        using var cancellation = new CancellationTokenSource();
        await gate.WaitAsync();
        int queuedCount;
        try
        {
            var rejection = authoring.RejectAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
                "reject", cancellation.Token);
            Assert.IsFalse(rejection.IsCompleted, "Reject must wait at the held Engine gate.");
            queuedCount = proposals.Snapshot().Count;
            cancellation.Cancel();
            await Assert.ThrowsAsync<OperationCanceledException>(() => rejection);
        }
        finally { gate.Release(); }

        Assert.AreEqual(1, queuedCount, "Reject removed the review queue while waiting for Engine admission.");
        Assert.HasCount(1, proposals.Snapshot(), "Cancellation orphaned the still-previewable proposal.");
        Assert.AreEqual(NendoProposalState.Previewable,
            (await workspace.Service.GetProposalAsync(preview.ProposalId)).State);
        Assert.AreEqual(preview.ProposalId,
            (await authoring.PreviewAsync(sessionId, lease.LeaseId, begun.ChangeSetId, CancellationToken.None)).ProposalId);

        var rejected = await authoring.RejectAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
            "reject", CancellationToken.None);
        Assert.AreEqual("rejected", rejected.State);
        Assert.AreEqual(preview.ProposalId, rejected.ProposalId);
        Assert.IsEmpty(proposals.Snapshot());
        Assert.IsEmpty(await workspace.Service.ListProposalsAsync());
        Assert.AreEqual(rejected, await authoring.RejectAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
            "reject", CancellationToken.None), "The completed rejection's exact retry must replay.");
    }
}
