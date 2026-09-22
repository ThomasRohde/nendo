using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
public sealed class AgentProposalOutcomeTests
{
    [TestMethod]
    public async Task UnappliedProposalRemainsVisibleWithItsCurrentDiagnostics()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var fixture = SemanticProtocolFixture.Load("decision-log");
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var preview = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            proposalId, "Decision Log", "test", fixture.DefinitionChangeSet(proposalId)));
        var store = new NendoAgentProposalStore();
        var manifest = (await workspace.Service.GetSnapshotAsync()).Manifest;
        store.Bind(manifest.ApplicationId, manifest.InstanceId);
        store.Add("change-set", "host", "session", preview);
        await workspace.Service.CreateIdeaSchemaAsync("intervening-definition");
        var sequence = (await workspace.Service.GetSnapshotAsync()).Manifest.ChangeSequence;
        var outcome = await store.PromoteAsync(workspace.Service, proposalId);
        Assert.IsFalse(outcome.Applied);
        Assert.HasCount(1, store.Snapshot());
        Assert.AreEqual(outcome.State, store.Get(proposalId).State);
        Assert.IsNotEmpty(store.Get(proposalId).Diagnostics);
        Assert.AreEqual(sequence, (await workspace.Service.GetSnapshotAsync()).Manifest.ChangeSequence);
    }
}
