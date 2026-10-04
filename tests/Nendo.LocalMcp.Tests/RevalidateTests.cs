using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-157: a proposal the file moved under is validated again in one call, with the same
/// operations, as a new proposal at the current revision; the old one is rejected.
/// </summary>
[TestClass]
public sealed class RevalidateTests
{
    [TestMethod]
    public async Task AStaleProposalIsRevalidatedInOneCallAndThenAccepted()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };

        var mine = await ValidateAsync(client, session, "tasks", "mine");
        // The person accepts somebody else's proposal: the definition moves.
        var theirs = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "workbench",
            new([new("test", "schema", "test", "Notes", [new CreateEntityOperation("notes", "notes", "Notes", "notes")])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(theirs.ProposalId)).Applied);
        var stale = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(session) { ["changeSetId"] = mine.ChangeSetId, ["idempotencyKey"] = "accept-stale" });
        Assert.IsFalse(stale.Applied);
        Assert.AreEqual("stale", stale.State);

        var revalidated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.revalidate", new(session) { ["changeSetId"] = mine.ChangeSetId, ["idempotencyKey"] = "revalidate" });
        Assert.AreEqual(NendoProposalState.Previewable, revalidated.State, JsonSerializer.Serialize(revalidated.Diagnostics, NendoMcpJson.Options));
        Assert.AreNotEqual(mine.ProposalId, revalidated.ProposalId);
        Assert.AreEqual(mine.OperationCount, revalidated.OperationCount, "The same operations, not fewer or more.");
        Assert.AreEqual((await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision, revalidated.CapturedDefinitionRevision);
        var pending = host.GetPendingProposals();
        Assert.IsFalse(pending.Any(entry => entry.ProposalId == mine.ProposalId), "The stale proposal is gone.");
        Assert.AreEqual(mine.ChangeSetId, pending.Single(entry => entry.ProposalId == revalidated.ProposalId).ChangeSetId);
        Assert.HasCount(1, await workspace.Service.ListProposalsAsync(), "One clone, not two.");

        // An exact retry replays; then the new proposal is accepted as any other.
        var replayed = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.revalidate", new(session) { ["changeSetId"] = mine.ChangeSetId, ["idempotencyKey"] = "revalidate" });
        Assert.AreEqual(revalidated.ProposalId, replayed.ProposalId);
        var accepted = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(session) { ["changeSetId"] = mine.ChangeSetId, ["idempotencyKey"] = "accept-again" });
        Assert.IsTrue(accepted.Applied, accepted.Message);
        Assert.IsTrue((await workspace.Service.GetSnapshotAsync()).Entities.Any(entity => entity.EntityId == "tasks"));

        // After acceptance the operations are gone with the proposal; a draft is not a proposal.
        var gone = await client.CallToolAsync("nendo.change_set.revalidate", new Dictionary<string, object?>(session) { ["changeSetId"] = mine.ChangeSetId, ["idempotencyKey"] = "revalidate-gone" });
        StringAssert.Contains(Text(gone), "NENDO_CHANGE_SET_NOT_FOUND", StringComparison.Ordinal);
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = "Draft", ["idempotencyKey"] = "begin-draft" });
        var draft = await client.CallToolAsync("nendo.change_set.revalidate", new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "revalidate-draft" });
        StringAssert.Contains(Text(draft), "NENDO_CHANGE_SET_NOT_VALIDATED", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AProposalThatNoLongerValidatesComesBackAsAnAmendableDraft()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };

        var mine = await ValidateAsync(client, session, "notes", "mine");
        // The person creates the same record type first: mine cannot create it again.
        var theirs = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "workbench",
            new([new("test", "schema", "test", "Notes", [new CreateEntityOperation("notes", "notes", "Notes", "notes")])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(theirs.ProposalId)).Applied);

        var invalid = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.revalidate", new(session) { ["changeSetId"] = mine.ChangeSetId, ["idempotencyKey"] = "revalidate" });
        Assert.AreEqual(NendoProposalState.Invalid, invalid.State);
        Assert.IsNotEmpty(invalid.Diagnostics);
        Assert.IsEmpty(host.GetPendingProposals(), "The old proposal is gone and nothing new was queued.");
        Assert.IsEmpty(await workspace.Service.ListProposalsAsync());

        // The draft is open: amend it to add a field to the type that now exists, and validate.
        var amended = await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.amend", new(session)
        {
            ["changeSetId"] = mine.ChangeSetId, ["dropFromMutationOrdinal"] = 0,
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Add a label",
                [
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId = "notes", fieldId = "notes.label", displayName = "Label", storageKind = "Text", required = false })),
                ]),
            },
            ["idempotencyKey"] = "amend",
        });
        Assert.AreEqual(1, amended.MutationCount);
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(session) { ["changeSetId"] = mine.ChangeSetId, ["idempotencyKey"] = "validate-again" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
    }

    private sealed record Validated(string ChangeSetId, string ProposalId, int OperationCount);

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
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId, fieldId = $"{entityId}.title", displayName = "Title", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = $"add-{key}",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = $"validate-{key}" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        return new Validated(begun.ChangeSetId, validated.ProposalId, validated.OperationCount);
    }

    private static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
