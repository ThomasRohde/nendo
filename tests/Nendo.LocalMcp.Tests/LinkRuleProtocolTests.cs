using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// ADR-0026 over MCP: the schema read carries a link type's rule, an agent can author one, and a
/// link no table record allows reaches the agent with its code and the sentence that names it.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class LinkRuleProtocolTests
{
    [TestMethod]
    public async Task ALinkThatIsNotAllowedIsRefusedToAnAgentNamingItsKinds()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        // The rule is declared in the mutation that creates its record types: there is no data to
        // check yet, and the table's index arrives with its columns.
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", "Concepts", "test", new([
            new("test", "schema", "test", "Concepts and what may join them", [
                new CreateEntityOperation("e-types", "types", "Concept types", "types"),
                new AddFieldOperation("f-type-name", "types", "type.name", "Name", "name", NendoStorageKind.Text, true),
                new CreateEntityOperation("e-concepts", "concepts", "Concepts", "concepts"),
                new AddFieldOperation("f-concept-name", "concepts", "concept.name", "Name", "name", NendoStorageKind.Text, false),
                new AddFieldOperation("f-concept-type", "concepts", "concept.type", "Type", "type_id", NendoStorageKind.Reference, true),
                new AddFieldOperation("f-concept-source", "concepts", "concept.source", "Source", "source_id", NendoStorageKind.Reference, false),
                new AddFieldOperation("f-concept-target", "concepts", "concept.target", "Target", "target_id", NendoStorageKind.Reference, false),
                new ConfigureReferenceOperation("b-concept-type", "concepts", "concept.type", "types", "type.name", 0),
                new ConfigureReferenceOperation("b-concept-source", "concepts", "concept.source", "concepts", "concept.name", 0),
                new ConfigureReferenceOperation("b-concept-target", "concepts", "concept.target", "concepts", "concept.name", 0),
                new CreateEntityOperation("e-rules", "rules", "Allowed relationships", "rules"),
                new AddFieldOperation("f-rule-source", "rules", "rule.source", "Source type", "source_id", NendoStorageKind.Reference, true),
                new AddFieldOperation("f-rule-target", "rules", "rule.target", "Target type", "target_id", NendoStorageKind.Reference, true),
                new AddFieldOperation("f-rule-type", "rules", "rule.type", "Relationship type", "type_id", NendoStorageKind.Reference, true),
                new ConfigureReferenceOperation("b-rule-source", "rules", "rule.source", "types", "type.name", 0),
            ]),
            new("test", "schema-2", "test", "The rule", [
                new ConfigureReferenceOperation("b-rule-target", "rules", "rule.target", "types", "type.name", 1),
                new ConfigureReferenceOperation("b-rule-type", "rules", "rule.type", "types", "type.name", 1),
                new DeclareLinkRuleOperation("declare", "concepts", Rule, 1),
            ]),
        ])));
        Assert.AreEqual(NendoProposalState.Previewable, schema.State, string.Join("; ", schema.Diagnostics.Select(item => item.Message)));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        foreach (var type in new[] { "actor", "role", "goal", "assignment" })
            await workspace.Service.CreateRecordAsync(new("types", type, new Dictionary<string, object?> { ["type.name"] = type }, new("test", type, "test")));
        await workspace.Service.CreateRecordAsync(new("rules", "rule-1",
            new Dictionary<string, object?> { ["rule.source"] = "actor", ["rule.target"] = "role", ["rule.type"] = "assignment" }, new("test", "rule-1", "test"),
            new Dictionary<string, long> { ["rule.source"] = 1, ["rule.target"] = 1, ["rule.type"] = 1 }));
        foreach (var (id, type) in new[] { ("a1", "actor"), ("r1", "role"), ("g1", "goal") })
            await workspace.Service.CreateRecordAsync(new("concepts", id, new Dictionary<string, object?> { ["concept.name"] = id, ["concept.type"] = type },
                new("test", id, "test"), new Dictionary<string, long> { ["concept.type"] = 1 }));

        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var read = await client.ReadResourceAsync("nendo://application/entity/concepts/schema");
        using (var document = JsonDocument.Parse(read.Contents.OfType<TextResourceContents>().Single().Text))
        {
            var rule = document.RootElement.GetProperty("linkRule");
            Assert.AreEqual("concept.source", rule.GetProperty("sourceFieldId").GetString());
            Assert.AreEqual("rules", rule.GetProperty("tableEntityId").GetString());
            Assert.AreEqual("rule.type", rule.GetProperty("tableKindFieldId").GetString());
        }
        using (var types = JsonDocument.Parse((await client.ReadResourceAsync("nendo://application/entity/types/schema"))
                   .Contents.OfType<TextResourceContents>().Single().Text))
            Assert.AreEqual(JsonValueKind.Null, types.RootElement.GetProperty("linkRule").ValueKind);

        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        CallToolResult Create(string id, string source) => client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId,
            ["entityId"] = "concepts", ["recordId"] = id, ["idempotencyKey"] = id,
            ["values"] = new Dictionary<string, object?>(),
            ["references"] = new Dictionary<string, object?>
            {
                ["concept.type"] = new Dictionary<string, object?> { ["recordId"] = "assignment" },
                ["concept.source"] = new Dictionary<string, object?> { ["recordId"] = source },
                ["concept.target"] = new Dictionary<string, object?> { ["recordId"] = "r1" },
            },
        }).AsTask().GetAwaiter().GetResult();

        var allowed = Create("rel-1", "a1");
        Assert.AreNotEqual(true, allowed.IsError, Text(allowed));
        var refused = Create("rel-2", "g1");
        Assert.IsTrue(refused.IsError);
        var text = Text(refused);
        StringAssert.Contains(text, "NENDO_LINK_NOT_ALLOWED");
        StringAssert.Contains(text, "Concepts record rel-2 is not an allowed link: no Allowed relationships record holds its Source's Type (goal), " +
            "its Target's Type (role) and its Type (assignment).");
    }

    [TestMethod]
    public void TheAuthoringTableCarriesBothOperationsAndTheCompilerTakesThem()
    {
        var operations = NendoAuthoringOperations.All.ToDictionary(operation => operation.OperationType);
        Assert.HasCount(10, operations["schema.declareLinkRule"].RequiredPayload);
        Assert.AreEqual("entityId", operations["schema.removeLinkRule"].RequiredPayload.Single());
        NendoCanonicalOperations.Check("schema.declareLinkRule", JsonSerializer.SerializeToElement(new
        {
            entityId = "concepts", sourceFieldId = "concept.source", targetFieldId = "concept.target", kindFieldId = "concept.type",
            sourceKindFieldId = "concept.type", targetKindFieldId = "concept.type", tableEntityId = "rules",
            tableSourceFieldId = "rule.source", tableTargetFieldId = "rule.target", tableKindFieldId = "rule.type",
            expectedDefinitionRevision = 3,
        }));
        NendoCanonicalOperations.Check("schema.removeLinkRule", JsonSerializer.SerializeToElement(new { entityId = "concepts", expectedDefinitionRevision = 4 }));
    }

    private static readonly NendoLinkRule Rule = new("concept.source", "concept.target", "concept.type", "concept.type", "concept.type",
        "rules", "rule.source", "rule.target", "rule.type");

    private static string Text(CallToolResult result) => string.Join("\n", result.Content.OfType<TextContentBlock>().Select(block => block.Text));

    private static T Result<T>(CallToolResult result) => JsonSerializer.Deserialize<T>(result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
}
