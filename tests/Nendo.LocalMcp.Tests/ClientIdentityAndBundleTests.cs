using System.Text.Json;
using ModelContextProtocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-150: a handshake-era client is named from its User-Agent on the stateless path; one
/// record type is one small read; describe takes the facets a client needs.
/// </summary>
[TestClass]
public sealed class ClientIdentityAndBundleTests
{
    [TestMethod]
    public async Task AHandshakeClientIsNamedFromItsUserAgentOnEveryRequest()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

        using var named = LatestProtocolTests.Client(host);
        named.DefaultRequestHeaders.UserAgent.ParseAdd("Codex/0.42.0");
        named.DefaultRequestHeaders.UserAgent.ParseAdd("(Windows)");
        // A legacy-era request: no clientInfo in _meta, as a handshake client's later requests look.
        var reply = await LatestProtocolTests.Send(named, "resources/read", new() { ["uri"] = "nendo://application/manifest" }, legacy: true);
        Assert.IsTrue(reply.TryGetProperty("result", out _), reply.GetRawText());
        var entry = host.GetActivities().Last(item => item.Name == "nendo://application/manifest");
        Assert.AreEqual("Codex 0.42.0", entry.Client, "The User-Agent's first product token names the client.");

        using var anonymous = LatestProtocolTests.Client(host);
        anonymous.DefaultRequestHeaders.UserAgent.Clear();
        await LatestProtocolTests.Send(anonymous, "resources/read", new() { ["uri"] = "nendo://application/health" }, legacy: true);
        Assert.AreEqual("Local agent", host.GetActivities().Last(item => item.Name == "nendo://application/health").Client);

        // A client that names itself in _meta keeps that name; the header does not override it.
        using var modern = LatestProtocolTests.Client(host);
        modern.DefaultRequestHeaders.UserAgent.ParseAdd("Curl/8.0");
        await LatestProtocolTests.Send(modern, "resources/read", new() { ["uri"] = "nendo://application/entities" });
        Assert.AreEqual("wire-probe 1", host.GetActivities().Last(item => item.Name == "nendo://application/entities").Client);
    }

    [TestMethod]
    public async Task OneRecordTypeIsOneSmallReadAndDescribeTakesFacets()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.ReadOnly, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var wholeText = await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe");
        var whole = ProtocolResourceTests.Deserialize<NendoMcpDescription>(wholeText);
        CollectionAssert.AreEqual(new[] { "manifest", "limits", "entities", "surfaces", "health", "reads", "extensions", "newFile" }, whole.Included.ToArray());
        Assert.IsNotNull(whole.Surfaces);
        Assert.IsNotNull(whole.Entities);

        var bundleText = await ProtocolResourceTests.ReadTextAsync(client, $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}");
        var bundle = ProtocolResourceTests.Deserialize<NendoMcpEntityBundle>(bundleText);
        Assert.AreEqual(NendoApplicationService.IdeaEntityId, bundle.Schema.EntityId);
        Assert.AreEqual(3, bundle.Schema.RecordCount);
        Assert.IsTrue(bundle.Schema.Fields.Any(field => field.FieldId == NendoApplicationService.IdeaTitleFieldId));
        Assert.IsNotEmpty(bundle.Surfaces, "The type's compiled screens belong in its bundle.");
        Assert.IsTrue(bundle.Surfaces.All(surface => surface.EntityId is null || surface.EntityId == NendoApplicationService.IdeaEntityId));
        Assert.IsTrue(bundle.SurfacesValid);
        Assert.IsLessThan(wholeText.Length / 2, bundleText.Length, $"The bundle is {bundleText.Length} characters against describe's {wholeText.Length}.");

        var facetsText = await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe?include=manifest,entities");
        var facets = ProtocolResourceTests.Deserialize<NendoMcpDescription>(facetsText);
        CollectionAssert.AreEqual(new[] { "manifest", "entities" }, facets.Included.ToArray());
        Assert.IsNotNull(facets.Manifest);
        Assert.IsNotNull(facets.Entities);
        Assert.IsNull(facets.Surfaces);
        Assert.IsNull(facets.Health);
        Assert.IsNull(facets.Limits);
        Assert.IsEmpty(facets.Reads);
        Assert.IsLessThan(wholeText.Length / 2, facetsText.Length, $"The facets read is {facetsText.Length} characters against describe's {wholeText.Length}.");

        var unknown = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe?include=manifest,screens"));
        StringAssert.Contains(unknown.Message, "include names screens; the facets are manifest, limits, entities, surfaces, health, reads, extensions, newFile", StringComparison.Ordinal);
    }

    /// <summary>
    /// Review R-010: the bundle read its schema and its screens separately, and describe
    /// its record types, manifest, screens and health, so a change committed between two
    /// of those reads put a screen beside a schema that has no field for it. A change
    /// committed after the first snapshot now starts the read again, and the answer is
    /// one generation of the file.
    /// </summary>
    [TestMethod]
    public async Task ABundleAndDescribeDescribeOneMomentOfTheFile()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await ApplyAsync(workspace, "notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddUiNodeOperation("form-add", "notes-surface", "notesForm", null, "recordForm", 0),
            new SetUiPropertyOperation("form-version", "notes-surface", "notesForm", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("form-entity", "notes-surface", "notesForm", "entityId", "notes"),
            new AddUiNodeOperation("label-add", "notes-surface", "notesLabel", "notesForm", "fieldBinding", 0),
            new SetUiPropertyOperation("label-field", "notes-surface", "notesLabel", "fieldId", "label"),
        ]);
        var projection = new NendoResourceProjection(workspace.Service, new NendoCursorCodec(new byte[32]));

        // A field and the screen binding it, committed right after the bundle's first snapshot.
        projection.AfterRead = Once("definition", () => AddBoundFieldAsync(workspace, "extra"));
        var bundle = await projection.GetEntityBundleAsync("notes", CancellationToken.None);
        var fields = bundle.Schema.Fields.Select(field => field.FieldId).ToHashSet(StringComparer.Ordinal);
        foreach (var bound in Bindings(bundle.Surfaces))
            Assert.Contains(bound, fields, $"The bundle's screens bind {bound}, which its schema does not have.");
        Assert.Contains("extra", fields, "The bundle is the file after the change.");

        projection.AfterRead = Once("definition", () => AddBoundFieldAsync(workspace, "later"));
        var described = await projection.GetDescriptionAsync(null, CancellationToken.None);
        var notes = described.Entities!.Single(entity => entity.EntityId == "notes").Fields.Select(field => field.FieldId).ToHashSet(StringComparer.Ordinal);
        var screens = described.Surfaces!.Applications.Single(app => app.EntityId == "notes").Surfaces;
        foreach (var bound in Bindings(screens))
            Assert.Contains(bound, notes, $"Describe's screens bind {bound}, which its record type does not have.");
        Assert.Contains("later", notes, "Describe is the file after the change.");
        Assert.AreEqual(described.Manifest!.ChangeSequence, described.Health!.ChangeSequence, "Manifest and health are one moment.");

        // A file that moves under every attempt is refused by name, not looped over.
        var reads = projection.DefinitionReads;
        var count = 0;
        projection.AfterRead = read => read == "definition"
            ? workspace.Service.CreateRecordAsync(new("notes", $"busy-{++count}", new Dictionary<string, object?> { ["label"] = "busy" },
                new("test", $"busy-{count}", "test")))
            : Task.CompletedTask;
        var busy = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => projection.GetEntityBundleAsync("notes", CancellationToken.None));
        StringAssert.Contains(busy.Message, "NENDO_READ_INTERRUPTED", StringComparison.Ordinal);
        Assert.AreEqual(NendoResourceProjection.CoherentReadAttempts, projection.DefinitionReads - reads);
    }

    private static Func<string, Task> Once(string read, Func<Task> action)
    {
        var done = false;
        return name =>
        {
            if (done || name != read) return Task.CompletedTask;
            done = true;
            return action();
        };
    }

    private static Task AddBoundFieldAsync(LocalMcpTestWorkspace workspace, string fieldId) => ApplyAsync(workspace, fieldId, [
        new AddFieldOperation($"{fieldId}-field", "notes", fieldId, fieldId, fieldId, NendoStorageKind.Text, false),
        new AddUiNodeOperation($"{fieldId}-add", "notes-surface", $"notes-{fieldId}", "notesForm", "fieldBinding", 1),
        new SetUiPropertyOperation($"{fieldId}-bind", "notes-surface", $"notes-{fieldId}", "fieldId", fieldId),
    ]);

    private static IEnumerable<string> Bindings(IEnumerable<NendoMcpSurfaceNode> nodes) => nodes.SelectMany(node =>
        (node.Properties.TryGetValue("fieldId", out var field) && field.ValueKind == JsonValueKind.String ? [field.GetString()!] : Array.Empty<string>())
            .Concat(Bindings(node.Children)));

    private static async Task ApplyAsync(LocalMcpTestWorkspace workspace, string key, NendoOperation[] operations)
    {
        var preview = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest($"proposal-{Guid.NewGuid():N}", key,
            "test", new([new("test", key, "test", key, operations)])));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, JsonSerializer.Serialize(preview.Diagnostics));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(preview.ProposalId)).Applied);
    }
}
