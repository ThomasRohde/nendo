using System.Reflection;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// PERF-07: the authoring calls check the open file's identity, and that reads the manifest. They
/// read the whole snapshot for it, every record with its calculations, on each begin, validate,
/// revalidate, promote and reject. Counted with the Engine's own count of full record reads.
/// </summary>
[TestClass]
public sealed class AuthoringReadCostTests
{
    [TestMethod]
    public async Task AuthoringChecksTheFilesIdentityWithoutReadingItsRecords()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var manifest = (await workspace.Service.GetDefinitionSnapshotAsync()).Manifest;
        var host = new NendoHostAuthority("read-cost", AgentAccessMode.ApplicationAuthoring,
            new byte[32], manifest.ApplicationId, manifest.InstanceId);
        using var authority = new NendoAgentAuthority(host, new SystemNendoClock(), null);
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(manifest.ApplicationId, manifest.InstanceId);
        using var authoring = new NendoAgentAuthoringService(workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        var coordinator = typeof(LocalMcpTestWorkspace).GetField("_coordinator", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(workspace)!;
        long FullRecordReads()
        {
            var diagnostics = typeof(NendoWriteCoordinator).GetProperty("ReadDiagnostics", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(coordinator)!;
            return (long)diagnostics.GetType().GetProperty("FullRecordReads")!.GetValue(diagnostics)!;
        }

        // What preparing and promoting a proposal read by themselves, so the authoring calls are measured against them.
        var reads = FullRecordReads();
        var direct = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Direct", "test",
            new NendoChangeSet([new NendoMutation("test", "direct", "test", "Direct",
                [new CreateEntityOperation("direct", "direct", "Direct", "direct")])])));
        var prepareReads = FullRecordReads() - reads;
        reads = FullRecordReads();
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(direct.ProposalId)).Applied);
        var promoteReads = FullRecordReads() - reads;

        const string sessionId = "read-cost-session";
        var lease = await authority.AcquireAsync(sessionId, "read cost fixture", CancellationToken.None);
        reads = FullRecordReads();
        var begun = await authoring.BeginAsync(sessionId, lease.LeaseId, "Notes", "begin", CancellationToken.None);
        Assert.AreEqual(0L, FullRecordReads() - reads, "change_set.begin read every record to check the file's identity.");

        await authoring.AddOperationsAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
            [new NendoAgentMutationInput("Add Notes", [new NendoAgentOperationInput("schema.createEntity",
                JsonSerializer.SerializeToElement(new { entityId = "notes", displayName = "Notes" }))])], "add", CancellationToken.None);
        reads = FullRecordReads();
        var validated = await authoring.ValidateAsync(sessionId, lease.LeaseId, begun.ChangeSetId, "validate", CancellationToken.None);
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, string.Join("; ", validated.Diagnostics.Select(diagnostic => diagnostic.Message)));
        Assert.AreEqual(prepareReads, FullRecordReads() - reads, "change_set.validate read every record once more than preparing the proposal does.");

        reads = FullRecordReads();
        var revalidated = await authoring.RevalidateAsync(sessionId, lease.LeaseId, begun.ChangeSetId, "revalidate", CancellationToken.None);
        Assert.AreEqual(NendoProposalState.Previewable, revalidated.State);
        Assert.AreEqual(prepareReads, FullRecordReads() - reads, "change_set.revalidate read every record once more than preparing the proposal does.");

        reads = FullRecordReads();
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, revalidated.ProposalId)).Applied);
        Assert.AreEqual(promoteReads, FullRecordReads() - reads, "Promoting a proposal read every record once more than the promotion itself does.");

        var second = await authoring.BeginAsync(sessionId, lease.LeaseId, "Tags", "begin-second", CancellationToken.None);
        await authoring.AddOperationsAsync(sessionId, lease.LeaseId, second.ChangeSetId,
            [new NendoAgentMutationInput("Add Tags", [new NendoAgentOperationInput("schema.createEntity",
                JsonSerializer.SerializeToElement(new { entityId = "tags", displayName = "Tags" }))])], "add-second", CancellationToken.None);
        var toReject = await authoring.ValidateAsync(sessionId, lease.LeaseId, second.ChangeSetId, "validate-second", CancellationToken.None);
        reads = FullRecordReads();
        await proposals.RejectAsync(workspace.Service, toReject.ProposalId);
        Assert.AreEqual(0L, FullRecordReads() - reads, "Rejecting a proposal read every record to check the file's identity.");
    }
}
