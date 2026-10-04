using System.Text.Json;
using System.Text.RegularExpressions;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-149: a tool refusal carries a structured object in the result's <c>_meta</c> beside the
/// text, under the project's reverse-DNS key, so a client reads a code rather than scrapes
/// one; and no tool description repeats a bound the vocabulary publishes.
/// </summary>
[TestClass]
public sealed class StructuredRefusalTests
{
    [TestMethod]
    public async Task EveryToolRefusalCarriesTheStructuredObjectBesideTheText()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };

        // A precondition the Engine refuses.
        var stale = await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>(session)
        {
            ["entityId"] = NendoApplicationService.IdeaEntityId,
            ["recordId"] = "idea-001",
            ["fieldId"] = NendoApplicationService.IdeaTitleFieldId,
            ["expectedRecordVersion"] = 9L,
            ["value"] = JsonSerializer.SerializeToElement("Later"),
            ["idempotencyKey"] = "stale-write",
        });
        var refusal = Refusal(stale);
        Assert.AreEqual("NENDO_RECORD_VERSION_CONFLICT", refusal.Code);
        StringAssert.StartsWith(Text(stale), $"An error occurred invoking 'nendo.data.set_field': {refusal.Code}: {refusal.Message}", StringComparison.Ordinal);
        Assert.IsNull(refusal.PendingProposalId);

        // An authority refusal, and an authoring one.
        var unowned = await client.CallToolAsync("nendo.change_set.begin", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = new string('f', 64), ["title"] = "x", ["idempotencyKey"] = "k",
        });
        Assert.AreEqual("NENDO_INVALID_LEASE", Refusal(unowned).Code);
        var absent = await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>(session) { ["changeSetId"] = "change-set-absent", ["idempotencyKey"] = "v" });
        Assert.AreEqual("NENDO_CHANGE_SET_NOT_FOUND", Refusal(absent).Code);

        // A write blocked by a pending proposal names it in the object as in the text.
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = "Tasks", ["idempotencyKey"] = "begin-tasks" });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create tasks",
                [
                    new NendoAgentOperationInput("schema.createEntity", JsonSerializer.SerializeToElement(new { entityId = "tasks", displayName = "Tasks" })),
                    new NendoAgentOperationInput("schema.addField", JsonSerializer.SerializeToElement(new { entityId = "tasks", fieldId = "title", displayName = "Title", storageKind = "Text", required = true })),
                ]),
            },
            ["idempotencyKey"] = "add-tasks",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = "validate-tasks" });
        var blocked = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks", ["recordId"] = "t1", ["values"] = new { title = "First" }, ["idempotencyKey"] = "create-blocked",
        });
        var pending = Refusal(blocked);
        Assert.AreEqual("NENDO_ENTITY_NOT_FOUND", pending.Code);
        Assert.AreEqual(validated.ProposalId, pending.PendingProposalId);
        StringAssert.Contains(pending.Message, validated.ProposalId, StringComparison.Ordinal);

        // A boundary refusal is not translated by a tool and carries no object: its text is the contract.
        var shape = await client.CallToolAsync("nendo.data.set_field", new Dictionary<string, object?>(session) { ["entityId"] = "x" });
        Assert.IsTrue(shape.IsError);
        Assert.IsTrue(shape.Meta is null || !shape.Meta.ContainsKey(NendoToolRefusal.MetaKey));
    }

    [TestMethod]
    public async Task NoToolDescriptionRepeatsABoundTheVocabularyPublishes()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.Unattended, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var limits = NendoAuthoringLimits.Current;
        var numbers = new[]
        {
            limits.OperationsPerCall, limits.MutationsPerCall, limits.DraftsPerSession, limits.ProposalsPerSession,
            limits.RecordWritesPerCall, limits.RecordsPerCreateBatch, limits.FieldsPerRecordUpdate, limits.IdempotencyKeyCharacters,
            limits.RecordWritesLabelCharacters, limits.Import!.RowsPerCall, limits.Import.RowsPerBatch,
        }.Distinct().ToArray();
        var words = new Dictionary<int, string>
        {
            [8] = "eight", [16] = "sixteen", [50] = "fifty", [64] = "sixty-four", [80] = "eighty", [200] = "two hundred", [500] = "five hundred",
        };
        var pattern = new Regex(@"\b(" + string.Join("|", numbers.Select(number => number.ToString()).Concat(numbers.Where(words.ContainsKey).Select(number => words[number]))) + @")\b", RegexOptions.IgnoreCase);
        var offenders = new List<string>();
        foreach (var tool in await client.ListToolsAsync())
        {
            if (tool.Description is { } description && pattern.IsMatch(description))
                offenders.Add($"{tool.Name}: {pattern.Match(description).Value}");
            if (tool.ProtocolTool.InputSchema.TryGetProperty("properties", out var properties))
                foreach (var property in properties.EnumerateObject())
                    if (property.Value.TryGetProperty("description", out var text) && pattern.IsMatch(text.GetString()!))
                        offenders.Add($"{tool.Name}.{property.Name}: {pattern.Match(text.GetString()!).Value}");
        }
        Assert.IsEmpty(offenders, "A description repeats a published bound; point at limits in nendo://application/vocabulary instead:\n" + string.Join("\n", offenders));
    }

    private static NendoToolRefusal Refusal(CallToolResult result)
    {
        Assert.IsTrue(result.IsError, JsonSerializer.Serialize(result));
        Assert.IsNotNull(result.Meta, "The refusal carries no _meta: " + Text(result));
        Assert.IsTrue(result.Meta.TryGetPropertyValue(NendoToolRefusal.MetaKey, out var node), "The refusal's _meta lacks the refusal key: " + Text(result));
        return node!.Deserialize<NendoToolRefusal>(NendoMcpJson.Options)!;
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
