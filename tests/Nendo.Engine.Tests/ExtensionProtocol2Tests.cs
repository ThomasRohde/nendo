using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Protocol 2 (ADR-0013, 2026-09-24; W-060): a view discloses more stored fields and
/// narrows its record types with filters, both as typed child nodes. What reaches the page
/// is exactly what the view names, and a protocol-1 view is unchanged down to its digest.
/// </summary>
[TestClass]
public sealed class ExtensionProtocol2Tests
{
    private static Dictionary<string, object?> Properties(int protocol = 2) => new()
    {
        ["definitionVersion"] = 3, ["entityId"] = "nodes", ["title"] = "Dependencies",
        ["packageId"] = "org.nendo.dependency-graph", ["packageVersion"] = "0.1.0",
        ["packageDigest"] = new string('a', 64), ["protocolVersion"] = protocol,
        ["configurationVersion"] = 1, ["configuration"] = "{}",
        ["edgeEntityId"] = "edges", ["labelFieldId"] = "label", ["sourceFieldId"] = "from", ["targetFieldId"] = "to",
    };

    private sealed record Child(string Kind, Dictionary<string, object?> Properties);
    private static Child Disclose(string fieldId) => new("fieldBinding", new() { ["fieldId"] = fieldId });
    private static Child Filter(string fieldId, string comparison, object? value = null, string? valueKind = null)
    {
        var properties = new Dictionary<string, object?> { ["fieldId"] = fieldId, ["operator"] = comparison };
        if (value is not null) properties["value"] = value;
        if (valueKind is not null) properties["valueKind"] = valueKind;
        return new("filterClause", properties);
    }

    private static NendoProposalRequest Request(string key, Dictionary<string, object?> properties, params Child[] children) => new(
        "proposal-" + Guid.NewGuid().ToString("N"), key, "test", new([
            new("test", key, "test", key, [
                new AddUiNodeOperation(key + "-add", "graph", "graph", null, NendoExtensionViewDefinition.NodeKind, 0),
                .. properties.Select(p => new SetUiPropertyOperation(key + "-" + p.Key, "graph", "graph", p.Key, p.Value)),
                .. children.SelectMany((child, i) => (NendoOperation[])[
                    new AddUiNodeOperation($"{key}-c{i}", "graph", $"graph-c{i}", "graph", child.Kind, i),
                    .. child.Properties.Select(p => new SetUiPropertyOperation($"{key}-c{i}-{p.Key}", "graph", $"graph-c{i}", p.Key, p.Value))]),
            ]),
        ]));

    private static async Task<NendoApplicationService> Seed(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Graph data", [
            new CreateEntityOperation("nodes", "nodes", "Nodes", "nodes"),
            new AddFieldOperation("label", "nodes", "label", "Label", "label", NendoStorageKind.Text, true),
            new AddFieldOperation("owner", "nodes", "owner", "Owner", "owner", NendoStorageKind.Text, false),
            new AddFieldOperation("weight", "nodes", "weight", "Weight", "weight", NendoStorageKind.Integer, false),
            new AddFieldOperation("secret", "nodes", "secret", "Secret", "secret", NendoStorageKind.Text, false),
            new AddFieldOperation("parent", "nodes", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
            new CreateEntityOperation("edges", "edges", "Edges", "edges"),
            new AddFieldOperation("from", "edges", "from", "From", "from_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("to", "edges", "to", "To", "to_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("kind", "edges", "kind", "Kind", "kind", NendoStorageKind.Text, false),
            new AddFieldOperation("note", "edges", "note", "Note", "note", NendoStorageKind.Text, false),
            new ConfigureReferenceOperation("bind-from", "edges", "from", "nodes", "label", 0),
            new ConfigureReferenceOperation("bind-to", "edges", "to", "nodes", "label", 0),
            new ConfigureReferenceOperation("bind-parent", "nodes", "parent", "nodes", "label", 0),
        ]));
        await coordinator.ApplyAsync(new("test", "data", "test", "Graph records", [
            new CreateRecordOperation("n1", "nodes", "n1", new Dictionary<string, object?> { ["label"] = "Light", ["owner"] = "Ada", ["weight"] = 1L, ["secret"] = "never sent" }),
            new CreateRecordOperation("n2", "nodes", "n2", new Dictionary<string, object?> { ["label"] = "Middle", ["owner"] = "Bo", ["weight"] = 2L, ["secret"] = "never sent" }),
        ]));
        await coordinator.ApplyAsync(new("test", "child", "test", "A record with a parent", [
            new CreateRecordOperation("n3", "nodes", "n3", new Dictionary<string, object?> { ["label"] = "Heavy", ["weight"] = 3L, ["secret"] = "never sent", ["parent"] = "n2" },
                new Dictionary<string, long> { ["parent"] = 1 }),
        ]));
        await coordinator.ApplyAsync(new("test", "links", "test", "Graph links", [
            new CreateRecordOperation("e1", "edges", "e1", new Dictionary<string, object?> { ["from"] = "n2", ["to"] = "n3", ["kind"] = "blocks", ["note"] = "never sent" },
                new Dictionary<string, long> { ["from"] = 1, ["to"] = 1 }),
            new CreateRecordOperation("e2", "edges", "e2", new Dictionary<string, object?> { ["from"] = "n1", ["to"] = "n2", ["kind"] = "relates", ["note"] = "never sent" },
                new Dictionary<string, long> { ["from"] = 1, ["to"] = 1 }),
        ]));
        return new(coordinator);
    }

    private static async Task<NendoApplicationService> Pinned(EngineTestWorkspace workspace, params Child[] children)
    {
        var service = await Seed(await workspace.CreateAsync());
        var preview = await service.PrepareProposalAsync(Request("graph", Properties(), children));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, string.Join(";", preview.Diagnostics.Select(d => d.Code + " " + d.Message)));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId, expectedOperationDigest: preview.OperationDigest)).Applied);
        return service;
    }

    [TestMethod]
    public async Task TheProjectionCarriesExactlyTheDisclosedFieldsOfTheRecordsTheFiltersKeep()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Pinned(workspace, Disclose("owner"), Disclose("weight"), Disclose("parent"), Disclose("kind"), Filter("weight", "gte", 2));
        var view = await service.ReadExtensionViewAsync("graph");
        var projection = view.Projection;

        CollectionAssert.AreEqual(new[] { "owner:node:text", "weight:node:integer", "parent:node:reference", "kind:edge:text" },
            projection.Fields!.Select(f => $"{f.Id}:{f.Of}:{f.Type}").ToArray());
        CollectionAssert.AreEqual(new[] { "n2", "n3" }, projection.Nodes.Select(n => n.Id).ToArray());
        // Exactly the disclosed keys on every record, and nothing the view did not name.
        foreach (var node in projection.Nodes)
            CollectionAssert.AreEquivalent(new[] { "owner", "weight", "parent" }, node.Values!.Keys.ToArray(), $"Node {node.Id} carried {string.Join(", ", node.Values.Keys)}.");
        Assert.AreEqual("Bo", projection.Nodes[0].Values!["owner"]);
        Assert.AreEqual("3", projection.Nodes[1].Values!["weight"]);
        Assert.IsNull(projection.Nodes[1].Values!["owner"]);
        // A reference reaches the page as the label of the record it points at, never as its ID.
        Assert.AreEqual("Middle", projection.Nodes[1].Values!["parent"]);
        Assert.IsNull(projection.Nodes[0].Values!["parent"]);
        var edge = projection.Edges.Single();
        Assert.AreEqual("e1", edge.Id);
        CollectionAssert.AreEquivalent(new[] { "kind" }, edge.Values!.Keys.ToArray());
        Assert.AreEqual("blocks", edge.Values["kind"]);
        // e2 runs from a node the filter left out: dropped and counted, never refused.
        Assert.AreEqual(1, projection.HiddenEdges);
        Assert.AreEqual(NendoFormat.ExtensionProtocol2MinimumHostVersion, (await service.GetDefinitionSnapshotAsync()).Manifest.MinimumHostVersion);

        // What the page receives, byte for byte through the session: no undisclosed value anywhere.
        var grant = new NendoExtensionGrant(view.ApplicationId, view.InstanceId, "graph", view.Definition.PackageDigest,
            view.Definition.ComputeBindingDigest(), view.Definition.ProtocolVersion);
        using var session = new NendoExtensionViewSession(grant, new Authority(grant), projection);
        var sent = Encoding.UTF8.GetString(session.GetInitialization("light", "en"));
        Assert.IsFalse(sent.Contains("never sent", StringComparison.Ordinal), sent);
        using var document = JsonDocument.Parse(sent);
        Assert.AreEqual(2, document.RootElement.GetProperty("version").GetInt32());
        Assert.AreEqual(1, document.RootElement.GetProperty("projection").GetProperty("hiddenEdges").GetInt32());
    }

    [TestMethod]
    public async Task AnEdgeFilterNarrowsLinksAndAnUnfilteredViewStillRefusesAMissingEndpoint()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Pinned(workspace, Filter("kind", "eq", "blocks"));
        var projection = (await service.ReadExtensionViewAsync("graph")).Projection;
        Assert.HasCount(3, projection.Nodes);
        Assert.AreEqual("e1", projection.Edges.Single().Id);
        // An edge filter says which links the author wants; none of the others is "hidden".
        Assert.AreEqual(0, projection.HiddenEdges);
        Assert.IsEmpty(projection.Fields!);
    }

    [TestMethod]
    public async Task AProtocolOneViewKeepsItsDigestAndItsProjectionShape()
    {
        var definition = NendoExtensionViewDefinition.Read("graph", Json(Properties(protocol: 1)));
        // The digest a protocol-1 grant was approved against before protocol 2 existed:
        // the same serialization of the same five bindings, so every saved permission holds.
        var legacy = Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            Binding = new { NodeEntityId = "nodes", LabelFieldId = "label", EdgeEntityId = "edges", SourceFieldId = "from", TargetFieldId = "to", StatusFieldId = (string?)null },
            ProtocolVersion = 1, ConfigurationVersion = 1, Configuration = "{}",
        }))).ToLowerInvariant();
        Assert.AreEqual(legacy, definition.ComputeBindingDigest());

        await using var workspace = new EngineTestWorkspace();
        var service = await Seed(await workspace.CreateAsync());
        var preview = await service.PrepareProposalAsync(Request("graph", Properties(protocol: 1)));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId, expectedOperationDigest: preview.OperationDigest)).Applied);
        Assert.AreEqual(NendoFormat.ExtensionViewsMinimumHostVersion, (await service.GetDefinitionSnapshotAsync()).Manifest.MinimumHostVersion);
        var projection = (await service.ReadExtensionViewAsync("graph")).Projection;
        var json = JsonSerializer.Serialize(projection, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        foreach (var key in new[] { "\"values\"", "\"fields\"", "\"hiddenEdges\"" })
            Assert.IsFalse(json.Contains(key, StringComparison.Ordinal), $"A protocol-1 projection carried {key}: {json}");
    }

    [TestMethod]
    public void DisclosingOrFilteringChangesTheBindingDigestSoConsentIsAskedAgain()
    {
        string Digest(params Child[] children) => NendoExtensionViewDefinition.Read("graph", Json(Properties()),
            children.Select((c, i) => new NendoUiNodeSnapshot("graph", $"c{i}", "graph", c.Kind, i, Json(c.Properties))).ToArray()).ComputeBindingDigest();
        var digests = new[]
        {
            Digest(),
            Digest(Disclose("owner")),
            Digest(Disclose("owner"), Disclose("weight")),
            Digest(Disclose("weight"), Disclose("owner")),
            Digest(Disclose("owner"), Filter("weight", "gte", 2)),
            Digest(Disclose("owner"), Filter("weight", "gte", 3)),
        };
        Assert.HasCount(digests.Length, digests.Distinct().ToArray(), string.Join("\n", digests));
    }

    [TestMethod]
    public async Task TheCompilerRefusesWhatProtocolTwoDoesNotAllow()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Seed(await workspace.CreateAsync());
        async Task Refused(string why, Dictionary<string, object?> properties, params Child[] children) =>
            await RefusedAs("NUI450", why, properties, children);
        async Task RefusedAs(string code, string why, Dictionary<string, object?> properties, params Child[] children)
        {
            var preview = await service.PrepareProposalAsync(Request("graph", properties, children));
            Assert.AreNotEqual(NendoProposalState.Previewable, preview.State, why);
            Assert.IsTrue(preview.Diagnostics.Any(d => d.Code == code), $"{why}: {string.Join(";", preview.Diagnostics.Select(d => d.Code + " " + d.Message))}");
        }
        await Refused("a protocol-1 view with a child", Properties(protocol: 1), Disclose("owner"));
        await Refused("a reference disclosed", Properties(), Disclose("from"));
        await Refused("the label disclosed again", Properties(), Disclose("label"));
        await Refused("a field that does not exist", Properties(), Disclose("nowhere"));
        await Refused("a field disclosed twice", Properties(), Disclose("owner"), Disclose("owner"));
        await Refused("a filter relative to the clock", Properties(), Filter("weight", "gte", 1, valueKind: "today"));
        await Refused("an operator outside the set", Properties(), Filter("weight", "contains", 1));
        // The vocabulary refuses this before the view reads its children: the kind is not
        // one a view takes at any protocol.
        await RefusedAs("NUI013", "a child kind a view does not take", Properties(), new Child("summaryTile", new() { ["aggregate"] = "count" }));
    }

    [TestMethod]
    public void TheSessionRefusesAValueForAFieldTheProjectionDoesNotName()
    {
        var grant = new NendoExtensionGrant("app", "instance", "view", new('a', 64), new('b', 64), 2);
        NendoGraphProjection With(Dictionary<string, string?> values) => new(1,
            [new("n1", "One") { Values = values }], [])
        { Fields = [new("owner", "Owner", "text", "node")], HiddenEdges = 0 };
        using (new NendoExtensionViewSession(grant, new Authority(grant), With(new() { ["owner"] = "Ada" }))) { }
        Assert.ThrowsExactly<ArgumentException>(() => new NendoExtensionViewSession(grant, new Authority(grant),
            With(new() { ["owner"] = "Ada", ["secret"] = "never sent" })));
        // And protocol 1 carries none at all.
        var first = grant with { ProtocolVersion = 1 };
        Assert.ThrowsExactly<ArgumentException>(() => new NendoExtensionViewSession(first, new Authority(first), With(new() { ["owner"] = "Ada" })));
    }

    private static Dictionary<string, JsonElement> Json(Dictionary<string, object?> properties) =>
        properties.ToDictionary(p => p.Key, p => JsonSerializer.SerializeToElement(p.Value), StringComparer.Ordinal);

    private sealed class Authority(NendoExtensionGrant expected) : INendoExtensionAuthority
    {
        public long RevocationGeneration => 0;
        public bool IsGranted(NendoExtensionGrant grant) => grant == expected;
    }
}
