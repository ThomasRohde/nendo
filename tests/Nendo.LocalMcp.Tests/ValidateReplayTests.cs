using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-142: an exact retry of validate replays its verdict only while the draft still holds
/// what that verdict was about. Amend already forgot the replays; add_operations did not,
/// so validate (invalid), add the fix, validate again under the same key answered with the
/// old diagnostics and never compiled the fix.
/// </summary>
[TestClass]
public sealed class ValidateReplayTests
{
    [TestMethod]
    public async Task AValidateRetriedAfterAddOperationsCompilesTheAddedOperations()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var manifest = (await workspace.Service.GetSnapshotAsync()).Manifest;
        var host = new NendoHostAuthority("validate-replay-after-add", AgentAccessMode.ApplicationAuthoring,
            new byte[32], manifest.ApplicationId, manifest.InstanceId);
        using var authority = new NendoAgentAuthority(host, new SystemNendoClock(), null);
        var proposals = new NendoAgentProposalStore();
        proposals.Bind(manifest.ApplicationId, manifest.InstanceId);
        using var authoring = new NendoAgentAuthoringService(workspace.Service, authority, host, proposals,
            new NendoUnattendedAuthority(AgentAccessMode.ApplicationAuthoring, null));
        const string sessionId = "validate-replay-session";
        var lease = await authority.AcquireAsync(sessionId, "replay fixture", CancellationToken.None);
        var begun = await authoring.BeginAsync(sessionId, lease.LeaseId, "Notes list", "begin", CancellationToken.None);

        // A list with no field bindings: the clone validates every operation and the
        // compiler then refuses the surface (NUI211), so the draft stays open.
        await authoring.AddOperationsAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
        [
            new NendoAgentMutationInput("Notes and an empty list",
            [
                Operation("schema.createEntity", new { entityId = "notes", displayName = "Notes" }),
                Operation("schema.addField", new { entityId = "notes", fieldId = "label", displayName = "Label", storageKind = "Text", required = true }),
                Operation("ui.addNode", new
                {
                    surfaceId = "surface.notes.list", nodeId = "node.notes.list", parentNodeId = (string?)null,
                    kind = "recordList", position = 0,
                    properties = new { definitionVersion = 3, entityId = "notes", title = "Notes" },
                }),
            ]),
        ], "add-list", CancellationToken.None);
        var invalid = await authoring.ValidateAsync(sessionId, lease.LeaseId, begun.ChangeSetId, "validate", CancellationToken.None);
        Assert.AreEqual(NendoProposalState.Invalid, invalid.State);
        Assert.IsTrue(invalid.Diagnostics.Any(diagnostic => diagnostic.Code == "NUI211"),
            JsonSerializer.Serialize(invalid.Diagnostics, NendoMcpJson.Options));

        // The fix is one appended operation, which is what add_operations is for.
        var added = await authoring.AddOperationsAsync(sessionId, lease.LeaseId, begun.ChangeSetId,
        [
            new NendoAgentMutationInput("Show the label",
            [
                Operation("ui.addNode", new
                {
                    surfaceId = "surface.notes.list", nodeId = "node.notes.list.label", parentNodeId = "node.notes.list",
                    kind = "fieldBinding", position = 0,
                    properties = new { fieldId = "label" },
                }),
            ]),
        ], "add-binding", CancellationToken.None);
        Assert.AreEqual(2, added.MutationCount);

        // The same key as the invalid validate. The draft changed under it, so this is
        // a new validation, not a replay of a verdict about three operations.
        var retried = await authoring.ValidateAsync(sessionId, lease.LeaseId, begun.ChangeSetId, "validate", CancellationToken.None);
        Assert.AreEqual(NendoProposalState.Previewable, retried.State,
            $"The retry replayed the stale verdict: {JsonSerializer.Serialize(retried.Diagnostics, NendoMcpJson.Options)}");
        Assert.AreEqual(6, invalid.OperationCount);
        Assert.AreEqual(8, retried.OperationCount, "The retry did not compile the operations added after the first validate.");
        Assert.HasCount(1, proposals.Snapshot());
        await authoring.RejectAsync(sessionId, lease.LeaseId, begun.ChangeSetId, "reject", CancellationToken.None);
    }

    private static NendoAgentOperationInput Operation(string type, object payload) =>
        new(type, JsonSerializer.SerializeToElement(payload));
}
