using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The costs a real authoring session paid, each asserted at the point it was
/// paid: a failed validation that ended the draft, a limit that named neither the
/// limit nor the usage, a materialization refusal that named no field, and two
/// proposals that only discovered each other at the approval dialog.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class AuthoringRecoveryTests
{
    [TestMethod]
    public async Task AFailedValidationLeavesTheDraftAmendableRatherThanSpent()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var owned = await AcquireAsync(client);
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "Reopen after failure", ["idempotencyKey"] = "reopen-begin" }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };

        await AddAsync(client, scoped, "Create the CRM record types", CrmAuthoringFixture.SchemaOperations(), "reopen-add-00");
        await AddAsync(client, scoped, "Bind the CRM references", CrmAuthoringFixture.ReferenceOperations(), "reopen-add-01");
        // A related list whose reference does not point back at this record type.
        await AddAsync(client, scoped, "A broken record page", BrokenPageOperations(), "reopen-add-02");

        var failed = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "reopen-validate-1" }));
        Assert.AreEqual(NendoProposalState.Invalid, failed.State);
        Assert.IsNotEmpty(failed.Diagnostics);

        // The draft survived: correcting the last mutation costs one amend, not a
        // rebuilt change set, and the discarded clone left no pending proposal.
        Assert.IsEmpty(host.GetPendingProposals());
        var amended = Result<NendoChangeSetAddResult>(await client.CallToolAsync("nendo.change_set.amend",
            new Dictionary<string, object?>(scoped)
            {
                ["dropFromMutationOrdinal"] = 2,
                ["mutations"] = new[]
                {
                    new NendoAgentMutationInput("Shape the CRM surfaces", CrmAuthoringFixture.SurfaceOperations().Take(16).ToArray()),
                },
                ["idempotencyKey"] = "reopen-amend",
            }));
        Assert.AreEqual(3, amended.MutationCount);
        Assert.AreEqual(NendoAuthoringLimits.Current.OperationsPerChangeSet, amended.OperationLimit);

        foreach (var (chunk, index) in CrmAuthoringFixture.SurfaceOperations().Skip(16).Chunk(16).Select((value, index) => (value, index)))
        {
            await AddAsync(client, scoped, "Shape the CRM surfaces", chunk, $"reopen-add-1{index}");
        }

        var validated = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "reopen-validate-2" }));
        Assert.AreEqual(
            NendoProposalState.Previewable,
            validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
    }

    [TestMethod]
    public async Task AMaterializationRefusalNamesTheFieldAndBothRemedies()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var owned = await AcquireAsync(client);
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "Split the entity from its fields", ["idempotencyKey"] = "split-begin" }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };

        // The mutation, not the change set, is the materialization boundary: the
        // entity exists physically from the end of mutation one.
        await AddAsync(client, scoped, "Create the record type", CrmAuthoringFixture.SchemaOperations().Take(1).ToArray(), "split-add-00");
        await AddAsync(client, scoped, "Add its required field", CrmAuthoringFixture.SchemaOperations().Skip(1).Take(1).ToArray(), "split-add-01");

        var failed = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "split-validate" }));
        Assert.AreEqual(NendoProposalState.Invalid, failed.State);
        var diagnostic = failed.Diagnostics.Single();
        Assert.AreEqual("NPROP004", diagnostic.Code);
        StringAssert.Contains(diagnostic.Message, CrmAuthoringFixture.AccountNameFieldId);
        StringAssert.Contains(diagnostic.Message, CrmAuthoringFixture.AccountEntityId);
        StringAssert.Contains(diagnostic.Message, "schema.createEntity");
        StringAssert.Contains(diagnostic.Message, "schema.setFieldRequired");

        // Co-locating them is the remedy the diagnostic names, and it works.
        await client.CallToolAsync("nendo.change_set.amend", new Dictionary<string, object?>(scoped)
        {
            ["dropFromMutationOrdinal"] = 0,
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create the record type with its fields", CrmAuthoringFixture.SchemaOperations().Take(3).ToArray()),
            },
            ["idempotencyKey"] = "split-amend",
        });
        var validated = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "split-validate-2" }));
        Assert.AreEqual(
            NendoProposalState.Previewable,
            validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
    }

    [TestMethod]
    public async Task TheChangeSetCeilingNamesItselfAndBeginWarnsAboutOtherProposals()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var owned = await AcquireAsync(client);
        var first = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "First", ["idempotencyKey"] = "ceiling-begin-1" }));
        Assert.AreEqual(0, first.OutstandingProposals);
        Assert.IsNull(first.Advisory);

        // Nothing warned at begin, and the human discovered it at the approval
        // dialog. Now the second draft is told before a single operation is sent.
        var second = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "Second", ["idempotencyKey"] = "ceiling-begin-2" }));
        Assert.AreEqual(1, second.OutstandingProposals);
        Assert.IsNotNull(second.Advisory);
        StringAssert.Contains(second.Advisory, first.CapturedDefinitionRevision.ToString());

        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = first.ChangeSetId };
        var progress = Result<NendoChangeSetAddResult>(await AddAsync(
            client, scoped, "Create the CRM record types", CrmAuthoringFixture.SchemaOperations(), "ceiling-add-00"));
        Assert.AreEqual(NendoAuthoringLimits.Current.OperationsPerChangeSet, progress.OperationLimit);
        Assert.AreEqual(NendoAuthoringLimits.Current.MutationsPerChangeSet, progress.MutationLimit);

        // Fill the change set to its published ceiling, then cross it.
        var filler = CrmAuthoringFixture.SurfaceOperations().Take(16).ToArray();
        var added = progress.OperationCount;
        var key = 0;
        while (added + 16 <= NendoAuthoringLimits.Current.OperationsPerChangeSet)
        {
            await AddAsync(client, scoped, "Filler", filler, $"ceiling-fill-{key++:D2}");
            added += 16;
        }
        var refused = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput("Over the ceiling", filler) },
            ["idempotencyKey"] = "ceiling-over",
        });
        Assert.IsTrue(refused.IsError);
        var message = JsonSerializer.Serialize(refused);
        StringAssert.Contains(message, "NENDO_CHANGE_SET_LIMIT");
        StringAssert.Contains(message, NendoAuthoringLimits.Current.OperationsPerChangeSet.ToString());
        StringAssert.Contains(message, added.ToString());
    }

    /// <summary>
    /// The review's most expensive finding, replayed: a sum whose field key was guessed
    /// three ways. Each guess used to reach validate, throw with no diagnostic, and
    /// leave the draft frozen — so a wrong key cost ninety operations. Now the shape
    /// is checked where the operation is sent, the refusal names the mutation, the
    /// operation, the binding and the key, and nothing has entered the draft.
    /// </summary>
    [TestMethod]
    public async Task AMisshapenBehaviourBodyIsRefusedWhereItIsSentAndCostsNoDraft()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var owned = await AcquireAsync(client);
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "Total the deals", ["idempotencyKey"] = "sum-begin" }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };
        // A required Integer to total, created beside its record type so the
        // materialization rule is satisfied; a sum over an optional field is refused
        // at validate because a member with no value is an error, not a zero.
        await AddAsync(client, scoped, "Create the CRM record types",
            [.. CrmAuthoringFixture.SchemaOperations(), Operation("schema.addField", new
            {
                entityId = CrmAuthoringFixture.DealEntityId, fieldId = "dealHours", displayName = "Hours",
                storageKind = "Integer", required = true,
            })], "sum-add-00");
        await AddAsync(client, scoped, "Bind the CRM references", CrmAuthoringFixture.ReferenceOperations(), "sum-add-01");

        var invented = await RefusedAddAsync(client, scoped, "Sum with an invented key", [DealTotal(new { aggregateFieldId = "dealHours" })], "sum-add-invented");
        StringAssert.Contains(invented, "NENDO_INVALID_REQUEST");
        StringAssert.Contains(invented, "Mutation 2, operation 0");
        StringAssert.Contains(invented, "behaviour.setDefinition 'account.dealTotal'");
        StringAssert.Contains(invented, "Binding 'amount'");
        StringAssert.Contains(invented, "does not define: aggregateFieldId");
        StringAssert.Contains(invented, "valueFieldId");

        var omitted = await RefusedAddAsync(client, scoped, "Sum with no key", [DealTotal(new { })], "sum-add-omitted");
        StringAssert.Contains(omitted, "needs valueFieldId");
        StringAssert.Contains(omitted, "the Integer or Decimal field it totals");

        // Neither refusal cost anything: the draft still holds exactly the two
        // mutations that were accepted, and takes the correct shape on top of them.
        var accepted = Result<NendoChangeSetAddResult>(await AddAsync(client, scoped, "Total the deals",
            [DealTotal(new { valueFieldId = "dealHours" })], "sum-add-right"));
        Assert.AreEqual(3, accepted.MutationCount);
        var validated = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "sum-validate" }));
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
    }

    /// <summary>
    /// A validate that ends without a verdict — here, the definition moving under the
    /// draft — used to leave it frozen, so the only tool that answered was reject.
    /// </summary>
    [TestMethod]
    public async Task AValidateThatThrowsLeavesTheDraftOpenRatherThanFrozen()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(recordCount: 0);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var owned = await AcquireAsync(client);
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "Rename under a moving file", ["idempotencyKey"] = "stale-begin" }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };
        await AddAsync(client, scoped, "Rename the record type",
            [Operation("schema.renameEntity", new { entityId = NendoApplicationService.IdeaEntityId, displayName = "Sparks" })], "stale-add");

        // The person renames it first, through the host.
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var theirs = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Theirs first", "test",
            new([new("test", "theirs", "test", "Theirs first",
                [new RenameEntityOperation("theirs-rename", NendoApplicationService.IdeaEntityId, "Notions", revision)])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(theirs.ProposalId)).Applied);

        var stale = await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "stale-validate" });
        Assert.IsTrue(stale.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(stale), "NENDO_CHANGE_SET_STALE");

        // Amend still answers, and so does reject; neither says the draft is frozen.
        var amended = await client.CallToolAsync("nendo.change_set.amend", new Dictionary<string, object?>(scoped)
        {
            ["dropFromMutationOrdinal"] = 0,
            ["mutations"] = new[] { new NendoAgentMutationInput("Rename it again",
                [Operation("schema.renameEntity", new { entityId = NendoApplicationService.IdeaEntityId, displayName = "Sparks" })]) },
            ["idempotencyKey"] = "stale-amend",
        });
        Assert.AreNotEqual(true, amended.IsError, JsonSerializer.Serialize(amended));
        var rejected = Result<NendoChangeSetRejectResult>(await client.CallToolAsync("nendo.change_set.reject",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "stale-reject" }));
        Assert.AreEqual("rejected", rejected.State);
    }

    /// <summary>
    /// A change set that validated is a proposal waiting for a person, and stops being
    /// a draft. An agent that then sent it more operations was told it did not exist —
    /// with even that sentence withheld — and went looking for a typo in an ID it had
    /// just used. The refusal now says what the change set became and what to do.
    /// </summary>
    [TestMethod]
    public async Task AValidatedChangeSetSaysItIsFrozenAndNamesTheRemedy()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var owned = await AcquireAsync(client);
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin",
            new Dictionary<string, object?>(owned) { ["title"] = "Frozen after validate", ["idempotencyKey"] = "frozen-begin" }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };
        await AddAsync(client, scoped, "Create the CRM record types", CrmAuthoringFixture.SchemaOperations(), "frozen-add-00");
        var validated = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "frozen-validate" }));
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));

        var amend = await client.CallToolAsync("nendo.change_set.amend", new Dictionary<string, object?>(scoped)
        {
            ["dropFromMutationOrdinal"] = 0,
            ["mutations"] = new[] { new NendoAgentMutationInput("Create the CRM record types", CrmAuthoringFixture.SchemaOperations()) },
            ["idempotencyKey"] = "frozen-amend",
        });
        var add = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput("Bind the CRM references", CrmAuthoringFixture.ReferenceOperations()) },
            ["idempotencyKey"] = "frozen-add-01",
        });
        var revalidate = await client.CallToolAsync("nendo.change_set.validate",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "frozen-validate-2" });
        foreach (var (name, refused) in new[] { ("amend", amend), ("add_operations", add), ("validate", revalidate) })
        {
            Assert.IsTrue(refused.IsError, name);
            var message = Text(refused);
            StringAssert.Contains(message, "NENDO_CHANGE_SET_FROZEN", name);
            StringAssert.Contains(message, begun.ChangeSetId, name);
            StringAssert.Contains(message, validated.ProposalId, name);
            StringAssert.Contains(message, "nendo.change_set.reject", name);
            Assert.DoesNotContain("does not exist", message, StringComparison.Ordinal, name);
        }

        // An ID this session never had is still one that does not exist, said out loud.
        var unknown = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(owned)
        {
            ["changeSetId"] = "change-set-00000000000000000000000000000000",
            ["mutations"] = new[] { new NendoAgentMutationInput("Nowhere", CrmAuthoringFixture.SchemaOperations().Take(1).ToArray()) },
            ["idempotencyKey"] = "frozen-unknown",
        });
        Assert.IsTrue(unknown.IsError);
        StringAssert.Contains(Text(unknown), "NENDO_CHANGE_SET_NOT_FOUND: The change set does not exist.");

        // The remedy the refusal names works, and says which proposal it withdrew.
        var rejected = Result<NendoChangeSetRejectResult>(await client.CallToolAsync("nendo.change_set.reject",
            new Dictionary<string, object?>(scoped) { ["idempotencyKey"] = "frozen-reject" }));
        Assert.AreEqual(validated.ProposalId, rejected.ProposalId);
        Assert.IsEmpty(host.GetPendingProposals());
    }

    private static string Text(ModelContextProtocol.Protocol.CallToolResult result) =>
        string.Join(' ', result.Content.OfType<ModelContextProtocol.Protocol.TextContentBlock>().Select(block => block.Text));

    private static NendoAgentOperationInput DealTotal(object fieldKey)
    {
        var binding = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["bindingId"] = "amount", ["kind"] = "RelatedAggregate", ["aggregate"] = "Sum",
            ["entityId"] = CrmAuthoringFixture.AccountEntityId, ["relatedEntityId"] = CrmAuthoringFixture.DealEntityId,
            ["relatedReferenceFieldId"] = CrmAuthoringFixture.DealAccountFieldId, ["resultType"] = "Integer", ["nullable"] = false,
        };
        foreach (var property in fieldKey.GetType().GetProperties()) binding[property.Name] = property.GetValue(fieldKey);
        return Operation("behaviour.setDefinition", new
        {
            definitionId = "account.dealTotal",
            definitionKind = "Calculation",
            body = new
            {
                entityId = CrmAuthoringFixture.AccountEntityId, fieldId = "dealTotal", displayName = "Deal hours",
                resultType = "Integer", resultNullable = false, expression = "amount",
                bindings = new[] { binding }, callAliases = Array.Empty<object>(),
            },
        });
    }

    private static async Task<string> RefusedAddAsync(
        McpClient client,
        Dictionary<string, object?> scoped,
        string description,
        IReadOnlyList<NendoAgentOperationInput> operations,
        string idempotencyKey)
    {
        var result = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput(description, operations) },
            ["idempotencyKey"] = idempotencyKey,
        });
        Assert.IsTrue(result.IsError, JsonSerializer.Serialize(result));
        return string.Join(' ', result.Content.OfType<ModelContextProtocol.Protocol.TextContentBlock>().Select(block => block.Text));
    }

    private static IReadOnlyList<NendoAgentOperationInput> BrokenPageOperations() =>
    [
        Operation("ui.addNode", new { surfaceId = "broken", nodeId = "brokenPage", parentNodeId = (string?)null, kind = "detailSurface", position = 0 }),
        Operation("ui.setProperty", new { surfaceId = "broken", nodeId = "brokenPage", propertyName = "definitionVersion", value = 3 }),
        Operation("ui.setProperty", new { surfaceId = "broken", nodeId = "brokenPage", propertyName = "entityId", value = CrmAuthoringFixture.AccountEntityId }),
        Operation("ui.addNode", new { surfaceId = "broken", nodeId = "brokenRelation", parentNodeId = "brokenPage", kind = "relatedList", position = 0 }),
        // contactAccount points at account, not at deal, so this relation cannot resolve.
        Operation("ui.setProperty", new { surfaceId = "broken", nodeId = "brokenRelation", propertyName = "targetEntityId", value = CrmAuthoringFixture.DealEntityId }),
        Operation("ui.setProperty", new { surfaceId = "broken", nodeId = "brokenRelation", propertyName = "viaFieldId", value = CrmAuthoringFixture.ContactAccountFieldId }),
        Operation("ui.addNode", new { surfaceId = "broken", nodeId = "brokenBinding", parentNodeId = "brokenRelation", kind = "fieldBinding", position = 0 }),
        Operation("ui.setProperty", new { surfaceId = "broken", nodeId = "brokenBinding", propertyName = "fieldId", value = CrmAuthoringFixture.DealNameFieldId }),
    ];

    private static NendoAgentOperationInput Operation(string type, object payload) =>
        new(type, JsonSerializer.SerializeToElement(payload, NendoMcpJson.Options));

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client)
    {
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        return new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
    }

    private static async Task<ModelContextProtocol.Protocol.CallToolResult> AddAsync(
        McpClient client,
        Dictionary<string, object?> scoped,
        string description,
        IReadOnlyList<NendoAgentOperationInput> operations,
        string idempotencyKey)
    {
        var result = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput(description, operations) },
            ["idempotencyKey"] = idempotencyKey,
        });
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result;
    }

    private static T Result<T>(ModelContextProtocol.Protocol.CallToolResult result) where T : notnull
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }
}
