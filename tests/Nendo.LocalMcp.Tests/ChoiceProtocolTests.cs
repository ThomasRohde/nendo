using System.Text.Json;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class ChoiceProtocolTests
{
    [TestMethod]
    public async Task ChoiceMetadataIsAuthoredThroughClosedMcpAndOnlyAppliedByHostReview()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        var before = await workspace.Service.GetSnapshotAsync();
        var entity = before.Entities.Single();
        var field = entity.Fields.First(field => field.Presentation == "singleChoice");
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot), proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["title"] = "Rename choice", ["idempotencyKey"] = "begin",
        }));
        var arguments = new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "add",
            ["mutations"] = new[] { new NendoAgentMutationInput("Rename choice", [new("schema.setChoiceMetadata",
                JsonSerializer.SerializeToElement(new { entityId = entity.EntityId, fieldId = field.FieldId, choiceId = field.Options[0],
                    displayName = "Renamed by proposal", retired = true, tone = "green", expectedDefinitionRevision = before.Manifest.DefinitionRevision }))]) },
        };
        var added = await client.CallToolAsync("nendo.change_set.add_operations", arguments);
        Assert.IsFalse(added.IsError ?? false, JsonSerializer.Serialize(added.Content));
        var preview = Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?> {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "validate",
        }));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        Assert.AreEqual(JsonSerializer.Serialize(before.Entities), JsonSerializer.Serialize((await workspace.Service.GetSnapshotAsync()).Entities));
        await client.CallToolAsync("nendo.lease.release", new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, preview.ProposalId)).Applied);
        var resource = await client.ReadResourceAsync($"nendo://application/entity/{entity.EntityId}/schema");
        using var json = JsonDocument.Parse(((TextResourceContents)resource.Contents[0]).Text);
        var choice = json.RootElement.GetProperty("fields").EnumerateArray().Single(f => f.GetProperty("fieldId").GetString() == field.FieldId)
            .GetProperty("choices").EnumerateArray().Single(c => c.GetProperty("id").GetString() == field.Options[0]);
        Assert.AreEqual("Renamed by proposal", choice.GetProperty("displayName").GetString());
        Assert.IsTrue(choice.GetProperty("retired").GetBoolean());
        Assert.AreEqual("green", choice.GetProperty("tone").GetString());

        // The tone and the page header are published where an agent reads the rules.
        var vocabulary = await client.ReadResourceAsync("nendo://application/vocabulary");
        using var described = JsonDocument.Parse(((TextResourceContents)vocabulary.Contents[0]).Text);
        var tones = described.RootElement.GetProperty("choiceTones").GetProperty("values").EnumerateArray().Select(value => value.GetString()).ToArray();
        CollectionAssert.Contains(tones, "green");
        Assert.IsTrue(described.RootElement.GetProperty("kinds").EnumerateArray()
            .Single(kind => kind.GetProperty("kind").GetString() == "detailSurface")
            .GetProperty("properties").EnumerateArray().Any(property => property.GetString() == "accentFieldId"));
        Assert.IsTrue(described.RootElement.GetProperty("operations").EnumerateArray()
            .Single(operation => operation.GetProperty("operationType").GetString() == "schema.setChoiceMetadata")
            .GetProperty("optionalPayload").EnumerateArray().Any(field => field.GetString() == "tone"));
        Assert.IsTrue(described.RootElement.GetProperty("propertyNotes").TryGetProperty("tone", out _));
        Assert.AreEqual(JsonSerializer.Serialize(before.Records), JsonSerializer.Serialize((await workspace.Service.GetSnapshotAsync()).Records));
    }
    [TestMethod]
    public async Task ANewOptionIsAuthoredThroughAChangeSetAndAnExistingOneIsRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        var before = await workspace.Service.GetSnapshotAsync();
        var entity = before.Entities.Single();
        var field = entity.Fields.First(field => field.Presentation == "singleChoice");
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot), proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = Result<NendoLeaseGrant>(await client.CallToolAsync("nendo.lease.acquire"));
        async Task<NendoAgentProposalPreview> ValidateAsync(string key, object payload)
        {
            var begun = Result<NendoChangeSetBeginResult>(await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?> {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["title"] = "Add an option", ["idempotencyKey"] = $"begin-{key}",
            }));
            var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?> {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = $"add-{key}",
                ["mutations"] = new[] { new NendoAgentMutationInput("Add an option", [new("schema.addChoice", JsonSerializer.SerializeToElement(payload))]) },
            });
            Assert.IsFalse(added.IsError ?? false, JsonSerializer.Serialize(added.Content));
            return Result<NendoAgentProposalPreview>(await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?> {
                ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = $"validate-{key}",
            }));
        }

        // An option the field already has is refused at validate, naming it and the operation to use.
        var existing = await ValidateAsync("existing", new { entityId = entity.EntityId, fieldId = field.FieldId, choiceId = field.Options[0], displayName = "Again" });
        Assert.AreEqual(NendoProposalState.Invalid, existing.State);
        var diagnostic = existing.Diagnostics.Single(diagnostic => diagnostic.Severity == NendoDiagnosticSeverity.Error);
        Assert.AreEqual("NPROP002", diagnostic.Code);
        StringAssert.Contains(diagnostic.Message, $"already has the option {field.Options[0]}");
        StringAssert.Contains(diagnostic.Message, "schema.setChoiceMetadata");

        // The definition revision is left out, and the host fills it in.
        var preview = await ValidateAsync("new", new { entityId = entity.EntityId, fieldId = field.FieldId, choiceId = "Parked", displayName = "Parked for now", tone = "violet" });
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, JsonSerializer.Serialize(preview.Diagnostics));
        // The colour states its host, and the review says so on a line of its own.
        CollectionAssert.AreEqual(new[] { "addChoice", "raiseMinimumHostVersion" }, preview.SemanticDiff.Select(entry => entry.Kind).ToArray());
        StringAssert.StartsWith(preview.SemanticDiff[0].Summary, $"Add the option Parked for now to {field.DisplayName} on {entity.DisplayName}");
        StringAssert.Contains(preview.SemanticDiff[1].Summary, "to 1.19.0");
        Assert.AreEqual(JsonSerializer.Serialize(before.Entities), JsonSerializer.Serialize((await workspace.Service.GetSnapshotAsync()).Entities));
        await client.CallToolAsync("nendo.lease.release", new Dictionary<string, object?> { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId });
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, preview.ProposalId)).Applied);

        var resource = await client.ReadResourceAsync($"nendo://application/entity/{entity.EntityId}/schema");
        using var json = JsonDocument.Parse(((TextResourceContents)resource.Contents[0]).Text);
        var schema = json.RootElement.GetProperty("fields").EnumerateArray().Single(f => f.GetProperty("fieldId").GetString() == field.FieldId);
        CollectionAssert.AreEqual(field.Options.Append("Parked").ToArray(),
            schema.GetProperty("options").EnumerateArray().Select(option => option.GetString()).ToArray());
        var choice = schema.GetProperty("choices").EnumerateArray().Single(c => c.GetProperty("id").GetString() == "Parked");
        Assert.AreEqual("Parked for now", choice.GetProperty("displayName").GetString());
        Assert.AreEqual("violet", choice.GetProperty("tone").GetString());
        Assert.IsFalse(choice.GetProperty("retired").GetBoolean());

        var vocabulary = await client.ReadResourceAsync("nendo://application/vocabulary");
        using var described = JsonDocument.Parse(((TextResourceContents)vocabulary.Contents[0]).Text);
        var operation = described.RootElement.GetProperty("operations").EnumerateArray()
            .Single(operation => operation.GetProperty("operationType").GetString() == "schema.addChoice");
        CollectionAssert.AreEqual(new[] { "entityId", "fieldId", "choiceId", "displayName" },
            operation.GetProperty("requiredPayload").EnumerateArray().Select(value => value.GetString()).ToArray());
    }

    private static T Result<T>(CallToolResult result) => JsonSerializer.Deserialize<T>(result.StructuredContent!.Value.GetRawText(), NendoMcpJson.Options)!;
}
