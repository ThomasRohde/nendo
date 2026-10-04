using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-143: a lost acquire response is recovered by an exact retry, and a session that
/// released or lost its lease takes it again under its own application handle, with the
/// proposals it validated still its own.
/// </summary>
[TestClass]
public sealed class LeaseResumeTests
{
    [TestMethod]
    public async Task AnExactRetryOfAcquireUnderItsKeyReturnsTheSameGrant()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var first = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire", new() { ["idempotencyKey"] = "acquire-1" });
        // The response was lost; the agent sends the same call again.
        var retried = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire", new() { ["idempotencyKey"] = "acquire-1" });
        Assert.AreEqual(first.LeaseId, retried.LeaseId, "The retry must return the grant it already made, not refuse it as held.");
        Assert.AreEqual(first.ApplicationHandle, retried.ApplicationHandle);
        Assert.AreEqual(first.ReceiptContext, retried.ReceiptContext);

        // A different key is a different agent asking: still held, and the refusal says
        // what the retry above does.
        var other = await client.CallToolAsync("nendo.lease.acquire", new Dictionary<string, object?> { ["idempotencyKey"] = "acquire-2" });
        Assert.IsTrue(other.IsError, JsonSerializer.Serialize(other));
        var text = Text(other);
        StringAssert.Contains(text, "NENDO_LEASE_HELD", StringComparison.Ordinal);
        StringAssert.Contains(text, "call nendo.lease.acquire again with the same idempotencyKey", StringComparison.Ordinal);
        Assert.DoesNotContain("as it is after a lost acquire response", text, StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AResumedHandleOwnsTheProposalItValidatedBeforeTheRelease()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var first = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = Session(first);
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session)
        {
            ["title"] = "Notes",
            ["idempotencyKey"] = "begin-notes",
        });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create Notes",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId = "notes", displayName = "Notes" })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId = "notes", fieldId = "label", displayName = "Label", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = "add-notes",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = "validate-notes" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);

        // The queue names the change set and its owner, so a later session can tell
        // whether the proposal is its own before it tries to accept it.
        var pending = host.GetPendingProposals().Single();
        Assert.AreEqual(begun.ChangeSetId, pending.ChangeSetId);
        Assert.AreEqual(first.Owner, pending.Owner);
        var listed = await client.ReadResourceAsync("nendo://application/proposals");
        var listedText = string.Join(' ', listed.Contents.OfType<TextResourceContents>().Select(content => content.Text));
        StringAssert.Contains(listedText, begun.ChangeSetId, StringComparison.Ordinal);
        StringAssert.Contains(listedText, first.Owner, StringComparison.Ordinal);

        await CallAsync<NendoLeaseRelease>(client, "nendo.lease.release", new(session));

        // Back, under the same handle: a new lease, the same owner, the same receipt scope.
        var resumed = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire", new() { ["resumeApplicationHandle"] = first.ApplicationHandle });
        Assert.AreNotEqual(first.LeaseId, resumed.LeaseId);
        Assert.AreEqual(first.ApplicationHandle, resumed.ApplicationHandle);
        Assert.AreEqual(first.Owner, resumed.Owner);
        Assert.AreEqual(first.ReceiptContext, resumed.ReceiptContext);
        var again = Session(resumed);
        var previewed = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.preview", new(again) { ["changeSetId"] = begun.ChangeSetId });
        Assert.AreEqual(validated.ProposalId, previewed.ProposalId);
        var accepted = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(again)
        {
            ["changeSetId"] = begun.ChangeSetId,
            ["idempotencyKey"] = "accept-after-resume",
        });
        Assert.IsTrue(accepted.Applied, accepted.Message);
        Assert.IsEmpty(host.GetPendingProposals());
    }

    [TestMethod]
    public async Task AHandleThisRunNeverMintedCannotBeResumed()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var forged = await client.CallToolAsync("nendo.lease.acquire", new Dictionary<string, object?>
        {
            ["resumeApplicationHandle"] = new string('a', 64),
        });
        Assert.IsTrue(forged.IsError, JsonSerializer.Serialize(forged));
        StringAssert.Contains(Text(forged), "NENDO_HANDLE_UNKNOWN", StringComparison.Ordinal);
        Assert.IsFalse((await host.GetLeaseStatusAsync()).HasLease, "A refused resume must not take the lease.");

        // The holder may ask for its own live lease by its handle and gets it back.
        var granted = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var own = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire", new() { ["resumeApplicationHandle"] = granted.ApplicationHandle });
        Assert.AreEqual(granted.LeaseId, own.LeaseId);
    }

    private static Dictionary<string, object?> Session(NendoLeaseGrant grant) => new(StringComparer.Ordinal)
    {
        ["applicationHandle"] = grant.ApplicationHandle,
        ["leaseId"] = grant.LeaseId,
    };

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
