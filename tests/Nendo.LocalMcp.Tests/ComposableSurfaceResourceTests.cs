using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The surfaces resource used to model contract version 2's four fixed slots, so
/// a version 3 application reported null for every screen it had while claiming
/// to be valid. An agent reading it concluded the file had no screens at all, and
/// the command ID that <c>nendo.data.execute_command</c> needs was discoverable
/// only by guessing. This suite reads the resource the way an agent does.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class ComposableSurfaceResourceTests
{
    [TestMethod]
    public async Task TheSurfacesResourceDescribesAnAcceptedContractVersion3Application()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        // Promotion runs through the proposal store, as the Desktop review does, so
        // the host's own count of outstanding proposals stays true.
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        // An empty file states that it has no custom screens, rather than
        // reporting invalid with nothing to explain it.
        var empty = await ReadSurfacesAsync(client);
        Assert.AreEqual("noCustomSurfaces", empty.State);
        Assert.IsEmpty(empty.Diagnostics);
        Assert.IsNull(empty.ContractVersion);

        await AuthorAndAcceptCrmAsync(workspace, client, proposals);

        var surfaces = await ReadSurfacesAsync(client);
        Assert.IsTrue(surfaces.IsValid);
        Assert.AreEqual("valid", surfaces.State);
        Assert.AreEqual(NendoSemanticVocabulary.ContractVersion, surfaces.ContractVersion);

        var account = surfaces.Applications.Single(app => app.EntityId == CrmAuthoringFixture.AccountEntityId);
        var page = account.Surfaces.Single(node => node.Kind == "detailSurface");
        Assert.AreEqual(CrmAuthoringFixture.AccountPageNodeId, page.NodeId);
        Assert.AreEqual("Account", page.Title);
        Assert.AreEqual(CrmAuthoringFixture.AccountEntityId, page.EntityId);
        Assert.IsTrue(Descendants(page).Any(node => node.Kind == "section"));
        var deals = Descendants(page).Single(node => node.NodeId == CrmAuthoringFixture.AccountDealsNodeId);
        Assert.AreEqual("relatedList", deals.Kind);
        Assert.AreEqual(
            CrmAuthoringFixture.DealEntityId,
            deals.Properties["targetEntityId"].GetString());
        var tile = Descendants(page).Single(node => node.NodeId == CrmAuthoringFixture.AccountDealTotalNodeId);
        Assert.AreEqual("sum", tile.Properties["aggregate"].GetString());

        var deal = surfaces.Applications.Single(app => app.EntityId == CrmAuthoringFixture.DealEntityId);
        var list = deal.Surfaces.Single(node => node.Kind == "recordList");
        Assert.IsTrue(list.Children.Any(child => child.Kind == "filterClause"));
        Assert.IsTrue(deal.Surfaces.Any(node => node.Kind == "boardSurface"));

        // The command ID is stated, not guessed. Executing it proves the stated
        // value is the one the host resolves.
        var command = deal.Surfaces.Single(node => node.Kind == "recordCommand");
        Assert.AreEqual(CrmAuthoringFixture.DealWinCommandId, command.CommandId);
        Assert.AreEqual("Mark won", command.Title, "A command root carries label, not title, and must still be named.");
        Assert.HasCount(2, command.Children.Where(child => child.Kind == "commandStep").ToArray());

        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
        await CallAsync(client, "nendo.data.create_record", new(owned)
        {
            ["entityId"] = CrmAuthoringFixture.DealEntityId,
            ["recordId"] = "deal-north",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                [CrmAuthoringFixture.DealNameFieldId] = "Northwind renewal",
                [CrmAuthoringFixture.DealStageFieldId] = "Negotiation",
                [CrmAuthoringFixture.DealClosedFieldId] = false,
            }),
            ["idempotencyKey"] = "surfaces-create-deal",
        });
        await CallAsync(client, "nendo.data.execute_command", new(owned)
        {
            ["commandId"] = command.CommandId,
            ["recordId"] = "deal-north",
            ["expectedRecordVersion"] = 1L,
            ["idempotencyKey"] = "surfaces-win-deal",
        });

        var records = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRecord>>(
            await ProtocolResourceTests.ReadTextAsync(
                client,
                $"nendo://application/entity/{CrmAuthoringFixture.DealEntityId}/records?limit=10"));
        var won = records.Items.Single(record => record.RecordId == "deal-north");
        Assert.AreEqual("Closed won", won.Values[CrmAuthoringFixture.DealStageFieldId].GetString());
        Assert.IsTrue(won.Values[CrmAuthoringFixture.DealClosedFieldId].GetBoolean());
    }

    internal static async Task AuthorAndAcceptCrmAsync(
        LocalMcpTestWorkspace workspace,
        McpClient client,
        NendoAgentProposalStore proposals)
    {
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
        var begun = Result<NendoChangeSetBeginResult>(await CallAsync(client, "nendo.change_set.begin", new(owned)
        {
            ["title"] = "Build the CRM",
            ["idempotencyKey"] = "crm-begin",
        }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };

        var ordinal = 0;
        async Task AddAsync(string description, IReadOnlyList<NendoAgentOperationInput> operations)
        {
            foreach (var chunk in operations.Chunk(16))
            {
                await CallAsync(client, "nendo.change_set.add_operations", new(scoped)
                {
                    ["mutations"] = new[] { new NendoAgentMutationInput(description, chunk) },
                    ["idempotencyKey"] = $"crm-add-{ordinal++:D2}",
                });
            }
        }

        await AddAsync("Create the CRM record types", CrmAuthoringFixture.SchemaOperations());
        await AddAsync("Bind the CRM references",
            CrmAuthoringFixture.ReferenceOperations(begun.CapturedDefinitionRevision + 1));
        await AddAsync("Shape the CRM surfaces", CrmAuthoringFixture.SurfaceOperations());

        var validated = Result<NendoAgentProposalPreview>(await CallAsync(
            client,
            "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "crm-validate" }));
        Assert.AreEqual(
            NendoProposalState.Previewable,
            validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));

        // What the reviewer is asked to approve must be describable. The previous
        // summary carried one entity name and four contract version 2 slot titles,
        // so this proposal rendered as "Unavailable" in every row.
        var summary = validated.Preview;
        Assert.AreEqual(NendoSemanticVocabulary.ContractVersion, summary.ContractVersion);
        Assert.HasCount(3, summary.Entities);
        Assert.IsGreaterThan(0, summary.FieldCount);
        CollectionAssert.AreEquivalent(
            new[] { "detailSurface", "detailSurface", "recordList", "boardSurface", "recordCommand" },
            summary.Surfaces.Select(surface => surface.Kind).ToArray());
        Assert.IsTrue(
            summary.Surfaces.Any(surface => surface.Kind == "recordCommand" && surface.NodeId == CrmAuthoringFixture.DealWinCommandId),
            "The review summary does not name the command this proposal adds.");
        Assert.IsTrue(summary.Surfaces.Any(surface => surface.Title == "Open deals"));
        Assert.IsTrue(summary.Surfaces.Any(surface => surface.Title == "Mark won"));

        // Acceptance is the owner's act; the test stands in for the click.
        var promotion = await proposals.PromoteAsync(workspace.Service, validated.ProposalId);
        Assert.IsTrue(promotion.Applied, promotion.Message);
        await CallAsync(client, "nendo.lease.release", new(owned));
    }

    private static async Task<NendoMcpSurfaces> ReadSurfacesAsync(McpClient client) =>
        ProtocolResourceTests.Deserialize<NendoMcpSurfaces>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/surfaces"));

    private static IEnumerable<NendoMcpSurfaceNode> Descendants(NendoMcpSurfaceNode node) =>
        node.Children.Concat(node.Children.SelectMany(Descendants));

    internal static async Task<ModelContextProtocol.Protocol.CallToolResult> CallAsync(
        McpClient client,
        string name,
        Dictionary<string, object?> arguments)
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        return result;
    }

    internal static T Result<T>(ModelContextProtocol.Protocol.CallToolResult result) where T : notnull
    {
        Assert.AreNotEqual(true, result.IsError, JsonSerializer.Serialize(result));
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException("The structured tool result was invalid.");
    }
}
