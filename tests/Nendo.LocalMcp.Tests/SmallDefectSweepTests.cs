using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-144: the smaller defects of the 2026-10-04 MCP review, one measuring guard each.
/// </summary>
[TestClass]
public sealed class SmallDefectSweepTests
{
    /// <summary>The proposals read says stale once the definition moved under a proposal, not previewable until an accept is tried.</summary>
    [TestMethod]
    public async Task TheProposalsReadSaysStaleOnceTheDefinitionMovedUnderAProposal()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var first = await ValidateEntityAsync(client, session, "notes", "first");
        var second = await ValidateEntityAsync(client, session, "tasks", "second");

        // The person accepts the first; the second captured the revision it just advanced.
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(first.ProposalId, CancellationToken.None, first.OperationDigest)).Applied);

        var listed = await ReadProposalsAsync(client);
        var stale = listed.Single(summary => summary.ProposalId == second.ProposalId);
        Assert.AreEqual(NendoProposalState.Stale, stale.State, "The read reported the state as of validate time.");
        Assert.AreEqual(second.ChangeSetId, stale.ChangeSetId);
    }

    /// <summary>Validated proposals are bounded per session, and the bound is the published one.</summary>
    [TestMethod]
    public async Task ValidatedProposalsAreCappedPerSessionAtThePublishedLimit()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var limit = NendoAuthoringLimits.Current.ProposalsPerSession;
        for (var index = 0; index < limit; index++)
        {
            await ValidateEntityAsync(client, session, $"entity{index:D2}", $"cap-{index:D2}");
        }
        Assert.HasCount(limit, host.GetPendingProposals());

        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session)
        {
            ["title"] = "One too many", ["idempotencyKey"] = "begin-over",
        });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[] { EntityMutation("over") }, ["idempotencyKey"] = "add-over",
        });
        var refused = await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "validate-over" });
        Assert.IsTrue(refused.IsError, JsonSerializer.Serialize(refused));
        var text = Text(refused);
        StringAssert.Contains(text, "NENDO_PROPOSAL_LIMIT", StringComparison.Ordinal);
        StringAssert.Contains(text, $"already owns {limit} validated proposals", StringComparison.Ordinal);
        Assert.HasCount(limit, host.GetPendingProposals(), "The refused validate must not have queued a proposal.");
        Assert.HasCount(limit, await workspace.Service.ListProposalsAsync(), "The refused validate must not have cloned the file.");
    }

    /// <summary>Closing the file session rejects every clone even when one reject fails.</summary>
    [TestMethod]
    public async Task ClosingTheFileSessionRejectsTheRemainingClonesAfterOneRejectFails()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var manifest = (await workspace.Service.GetSnapshotAsync()).Manifest;
        var store = new NendoAgentProposalStore();
        store.Bind(manifest.ApplicationId, manifest.InstanceId);
        var fixture = SemanticProtocolFixture.Load("decision-log");
        var real = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Decision Log", "test", fixture.DefinitionChangeSet($"proposal-{Guid.NewGuid():N}")));
        // A proposal the Engine does not hold, listed first: its reject fails.
        var phantom = real with { ProposalId = $"proposal-{new string('0', 32)}" };
        store.Add("change-set-phantom", "host", "session", phantom);
        store.Add("change-set-real", "host", "session", real);
        Assert.HasCount(1, await workspace.Service.ListProposalsAsync());

        var failed = await Assert.ThrowsAsync<Exception>(() => store.CloseFileSessionAsync(workspace.Service));
        Assert.IsNotNull(failed);
        Assert.IsEmpty(await workspace.Service.ListProposalsAsync(), "The clone after the failed reject was left in place.");
        Assert.IsEmpty(store.Snapshot());
    }

    /// <summary>A failure that is not a Nendo refusal, after a committed batch, is still reported as partial with its counts.</summary>
    [TestMethod]
    public async Task AnIoFailureAfterACommittedBatchIsReportedAsPartialWithItsCounts()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareNotesAsync(workspace);
        var imports = new NendoImportService(workspace.Service)
        {
            BeforeBatch = committed =>
            {
                if (committed == 50) throw new IOException("The volume went away after the first batch.");
            },
        };
        var records = Enumerable.Range(1, 51).Select(index => new NendoRecordInput(
            $"io-{index:D3}", JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["label"] = $"Row {index}" }))).ToArray();

        var partial = await Assert.ThrowsExactlyAsync<NendoImportPartialException>(() => imports.ImportRecordsAsync(
            "notes", records, ReadLabel, "io-import", "agent-test", CancellationToken.None));
        Assert.AreEqual(50, partial.Committed);
        Assert.AreEqual(1, partial.Remaining);
        Assert.AreEqual(51, partial.FirstUncommittedRow);
        Assert.HasCount(1, partial.RevisionIds);
        Assert.IsInstanceOfType<IOException>(partial.Cause);
        var translated = NendoToolErrors.Translate(partial).Message;
        StringAssert.Contains(translated, "NENDO_IMPORT_PARTIAL: committed=50; remaining=1; firstUncommittedRow=51;", StringComparison.Ordinal);

        // The same after a cancellation: the counts, not a bare cancellation.
        imports.BeforeBatch = null;
        using var cancellation = new CancellationTokenSource();
        imports.BeforeBatch = committed => { if (committed == 50) cancellation.Cancel(); };
        var cancelled = await Assert.ThrowsExactlyAsync<NendoImportPartialException>(() => imports.ImportRecordsAsync(
            "notes", records.Select(record => record with { RecordId = "c" + record.RecordId }).ToArray(), ReadLabel, "cancelled-import", "agent-test", cancellation.Token));
        Assert.AreEqual(50, cancelled.Committed);
        StringAssert.Contains(NendoToolErrors.Translate(cancelled).Message, "cause=NENDO_CANCELLED", StringComparison.Ordinal);
    }

    /// <summary>get_receipt answers for an import key, batch by batch, and for an accepted proposal by its ID.</summary>
    [TestMethod]
    public async Task GetReceiptAnswersForAnImportKeyAndForAnAcceptedProposal()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareNotesAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = Session(grant);
        var records = Enumerable.Range(1, 51).Select(index => new NendoRecordInput(
            $"json-{index:D3}", JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["label"] = $"Row {index}" }))).ToArray();
        var imported = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", new(session)
        {
            ["entityId"] = "notes", ["format"] = "json", ["records"] = records, ["idempotencyKey"] = "json-bulk",
        });
        Assert.AreEqual(2, imported.RevisionCount);

        var receipt = await CallAsync<NendoDataOutcome>(client, "nendo.data.get_receipt", new()
        {
            ["receiptContext"] = grant.ReceiptContext, ["idempotencyKey"] = "json-bulk",
        });
        Assert.AreEqual("committed", receipt.State, receipt.Message);
        Assert.IsNotNull(receipt.Revisions);
        Assert.HasCount(2, receipt.Revisions, "Both batches answer for the key they were sent under.");
        StringAssert.Contains(receipt.Message, "committed 2 batch(es)", StringComparison.Ordinal);

        var validated = await ValidateEntityAsync(client, session, "tasks", "accepted");
        var accepted = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(session)
        {
            ["changeSetId"] = validated.ChangeSetId, ["idempotencyKey"] = "accept-tasks",
        });
        Assert.IsTrue(accepted.Applied, accepted.Message);
        var acceptance = await CallAsync<NendoDataOutcome>(client, "nendo.data.get_receipt", new()
        {
            ["receiptContext"] = grant.ReceiptContext, ["proposalId"] = validated.ProposalId,
        });
        Assert.AreEqual("committed", acceptance.State, acceptance.Message);
        Assert.IsNotNull(acceptance.Revisions);
        Assert.IsNotEmpty(acceptance.Revisions);
        StringAssert.Contains(acceptance.Message, $"definition revision {accepted.DefinitionRevision}", StringComparison.Ordinal);

        var unknown = await CallAsync<NendoDataOutcome>(client, "nendo.data.get_receipt", new()
        {
            ["receiptContext"] = grant.ReceiptContext, ["proposalId"] = $"proposal-{new string('1', 32)}",
        });
        Assert.AreEqual("unresolved", unknown.State);
    }

    /// <summary>The three authoring refusals whose messages are adapter constants reach the wire.</summary>
    [TestMethod]
    public async Task AnAuthoringIdempotencyConflictSaysWhatItIs()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ApplicationAuthoring, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = "First", ["idempotencyKey"] = "begin-same" });
        var conflict = await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>(session) { ["title"] = "Second", ["idempotencyKey"] = "begin-same" });
        Assert.IsTrue(conflict.IsError, JsonSerializer.Serialize(conflict));
        var text = Text(conflict);
        StringAssert.Contains(text, "NENDO_IDEMPOTENCY_CONFLICT: The idempotency key was already used for a different request.", StringComparison.Ordinal);
        Assert.DoesNotContain("could not be completed", text, StringComparison.Ordinal);
    }

    /// <summary>An accept that did not apply is not replayed: once the cause is gone, the same key tries again.</summary>
    [TestMethod]
    public async Task AnAcceptThatDidNotApplyIsTriedAgainUnderTheSameKeyOnceTheCauseIsGone()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var first = await ValidateEntityAsync(client, session, "notes", "first");
        var second = await ValidateEntityAsync(client, session, "tasks", "second");
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(first.ProposalId, CancellationToken.None, first.OperationDigest)).Applied);

        var stale = await CallAsync<NendoChangeSetAcceptResult>(client, "nendo.change_set.accept", new(session)
        {
            ["changeSetId"] = second.ChangeSetId, ["idempotencyKey"] = "accept-second",
        });
        Assert.IsFalse(stale.Applied);
        Assert.AreEqual("stale", stale.State);

        // The cause here cannot be removed (the file moved), so the retry must at least
        // try again and report the live answer rather than the cached one: the proposal
        // was rejected meanwhile, and the retry says so instead of replaying stale.
        await CallAsync<NendoChangeSetRejectResult>(client, "nendo.change_set.reject", new(session)
        {
            ["changeSetId"] = second.ChangeSetId, ["idempotencyKey"] = "reject-second",
        });
        var retried = await client.CallToolAsync("nendo.change_set.accept", new Dictionary<string, object?>(session)
        {
            ["changeSetId"] = second.ChangeSetId, ["idempotencyKey"] = "accept-second",
        });
        Assert.IsTrue(retried.IsError, "The retry replayed the cached applied=false instead of looking again: " + JsonSerializer.Serialize(retried));
        StringAssert.Contains(Text(retried), "NENDO_CHANGE_SET_NOT_FOUND", StringComparison.Ordinal);
    }

    private static NendoAgentMutationInput EntityMutation(string entityId) => new($"Create {entityId}",
    [
        new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId, displayName = entityId })),
        new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId, fieldId = $"{entityId}.label", displayName = "Label", storageKind = "Text", required = true })),
    ]);

    private sealed record Validated(string ChangeSetId, string ProposalId, string OperationDigest);

    private static async Task<Validated> ValidateEntityAsync(McpClient client, Dictionary<string, object?> session, string entityId, string key)
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = entityId, ["idempotencyKey"] = $"begin-{key}" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped) { ["mutations"] = new[] { EntityMutation(entityId) }, ["idempotencyKey"] = $"add-{key}" });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = $"validate-{key}" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        return new Validated(begun.ChangeSetId, validated.ProposalId, validated.OperationDigest);
    }

    private static async Task<IReadOnlyList<NendoAgentProposalSummary>> ReadProposalsAsync(McpClient client)
    {
        var read = await client.ReadResourceAsync("nendo://application/proposals");
        var text = read.Contents.OfType<TextResourceContents>().Single().Text;
        return JsonSerializer.Deserialize<IReadOnlyList<NendoAgentProposalSummary>>(text, NendoMcpJson.Options)!;
    }

    private static Task<NendoCreateRecordEntry> ReadLabel(NendoRecordInput record) => Task.FromResult(new NendoCreateRecordEntry(
        record.RecordId,
        record.Values.Element.EnumerateObject().ToDictionary(property => property.Name, property => (object?)property.Value.GetString(), StringComparer.Ordinal)));

    private static async Task PrepareNotesAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "test",
            new([new("test", "schema", "test", "Notes", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
    }

    private static Dictionary<string, object?> Session(NendoLeaseGrant grant) => new(StringComparer.Ordinal)
    {
        ["applicationHandle"] = grant.ApplicationHandle,
        ["leaseId"] = grant.LeaseId,
    };

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client) =>
        Session(await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire"));

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
