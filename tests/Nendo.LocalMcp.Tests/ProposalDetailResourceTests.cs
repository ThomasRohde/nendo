using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-148: one proposal in full by ID, without a lease, with live state; an accept result
/// lists the revisions it committed.
/// </summary>
[TestClass]
public sealed class ProposalDetailResourceTests
{
    [TestMethod]
    public async Task AFreshSessionReadsItsPredecessorsProposalDiffByIdAndAStaleOneReadsStale()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var author = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(author, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };
        var first = await ValidateAsync(author, session, "notes", "first");
        var second = await ValidateAsync(author, session, "tasks", "second");

        // Another client, no lease: the whole preview, and whose it is.
        await using var reader = await ProtocolResourceTests.ConnectAsync(host);
        var detail = ProtocolResourceTests.Deserialize<NendoAgentProposalPreview>(
            await ProtocolResourceTests.ReadTextAsync(reader, $"nendo://application/proposal/{second.ProposalId}"));
        Assert.AreEqual(second.ProposalId, detail.ProposalId);
        Assert.AreEqual(second.ChangeSetId, detail.ChangeSetId);
        Assert.AreEqual(grant.Owner, detail.Owner);
        Assert.AreEqual(NendoProposalState.Previewable, detail.State);
        Assert.IsTrue(detail.SemanticDiff.Any(entry => entry.SemanticIds.Contains("tasks")), JsonSerializer.Serialize(detail.SemanticDiff, NendoMcpJson.Options));
        Assert.IsNotEmpty(detail.Preview.Entities);

        // A proposal the adapter never queued is still readable: the Engine holds it.
        var foreign = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Someone else's", "workbench",
            new([new("test", "schema", "test", "Items", [new CreateEntityOperation("items", "items", "Items", "items")])])));
        var theirs = ProtocolResourceTests.Deserialize<NendoAgentProposalPreview>(
            await ProtocolResourceTests.ReadTextAsync(reader, $"nendo://application/proposal/{foreign.ProposalId}"));
        Assert.AreEqual("Someone else's", theirs.Title);
        Assert.IsNull(theirs.ChangeSetId);
        Assert.IsNull(theirs.Owner);

        // Accepting the first moves the definition; the second now reads stale, with its revisions on the result.
        var accepted = await CallAsync<NendoChangeSetAcceptResult>(author, "nendo.change_set.accept", new(session)
        {
            ["changeSetId"] = first.ChangeSetId, ["idempotencyKey"] = "accept-first",
        });
        Assert.IsTrue(accepted.Applied, accepted.Message);
        Assert.IsNotEmpty(accepted.Revisions, "The accept result must list the revisions it committed.");
        Assert.AreEqual(accepted.DefinitionRevision, accepted.Revisions[^1].DefinitionRevision);
        var history = await workspace.Service.GetHistoryAsync();
        Assert.IsTrue(accepted.Revisions.All(revision => history.Any(entry => entry.RevisionId == revision.RevisionId)));

        var stale = ProtocolResourceTests.Deserialize<NendoAgentProposalPreview>(
            await ProtocolResourceTests.ReadTextAsync(reader, $"nendo://application/proposal/{second.ProposalId}"));
        Assert.AreEqual(NendoProposalState.Stale, stale.State);

        var unknown = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            ProtocolResourceTests.ReadTextAsync(reader, $"nendo://application/proposal/proposal-{new string('0', 32)}"));
        StringAssert.Contains(unknown.Message, "NENDO_", StringComparison.Ordinal);
    }

    private sealed record Validated(string ChangeSetId, string ProposalId);

    private static async Task<Validated> ValidateAsync(McpClient client, Dictionary<string, object?> session, string entityId, string key)
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = entityId, ["idempotencyKey"] = $"begin-{key}" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput($"Create {entityId}",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId, displayName = entityId })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId, fieldId = $"{entityId}.label", displayName = "Label", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = $"add-{key}",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = $"validate-{key}" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        return new Validated(begun.ChangeSetId, validated.ProposalId);
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
