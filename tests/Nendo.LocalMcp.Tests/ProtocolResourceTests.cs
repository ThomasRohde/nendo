using System.Text.Json;
using System.Text.RegularExpressions;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

[TestClass]
[DoNotParallelize]
public sealed class ProtocolResourceTests
{
    [TestMethod]
    public async Task ResourceErrorsUseStableSanitizedCodes()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ConnectAsync(host);

        var missing = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            ReadTextAsync(client, "nendo://application/entity/entity.missing/schema"));
        StringAssert.Contains(missing.Message, "NENDO_ENTITY_NOT_FOUND");
        Assert.DoesNotContain(workspace.FilePath, missing.Message, StringComparison.OrdinalIgnoreCase);

        var invalidLimit = await Assert.ThrowsExactlyAsync<McpProtocolException>(() =>
            ReadTextAsync(
                client,
                $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records?limit=101"));
        StringAssert.Contains(invalidLimit.Message, "NENDO_INVALID_LIMIT");
    }

    [TestMethod]
    public async Task OfficialClientReadsApplicationNeutralDecisionLogResources()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateDecisionLogAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ConnectAsync(host);

        var manifest = Deserialize<NendoMcpManifest>(
            await ReadTextAsync(client, "nendo://application/manifest"));
        var entities = Deserialize<NendoMcpEntity[]>(
            await ReadTextAsync(client, "nendo://application/entities"));
        var schema = Deserialize<NendoMcpEntitySchema>(
            await ReadTextAsync(client, "nendo://application/entity/entity.decision/schema"));
        var records = Deserialize<NendoMcpPage<NendoMcpRecord>>(
            await ReadTextAsync(client, "nendo://application/entity/entity.decision/records?limit=100"));
        var surfaces = Deserialize<NendoMcpSurfaces>(
            await ReadTextAsync(client, "nendo://application/surfaces"));
        var history = Deserialize<NendoMcpPage<NendoMcpRevision>>(
            await ReadTextAsync(client, "nendo://application/history?limit=100"));
        var health = Deserialize<NendoMcpHealth>(
            await ReadTextAsync(client, "nendo://application/health"));

        Assert.AreEqual("nendo.application", manifest.FormatIdentifier);
        Assert.IsTrue(entities.Any(entity => entity.EntityId == "entity.decision"));
        Assert.IsTrue(schema.Fields.Any(field => field.FieldId == "field.decision.context"));
        Assert.HasCount(2, records.Items);
        Assert.IsTrue(surfaces.IsValid);
        Assert.AreEqual("Decision board", surfaces.Applications.Single().Surfaces.Single(node => node.Kind == "boardSurface").Title);
        Assert.IsNotEmpty(history.Items);
        Assert.AreEqual(NendoSessionHealth.Normal, health.State);

        var text = JsonSerializer.Serialize(
            new { manifest, entities, schema, records, surfaces, history, health },
            NendoMcpJson.Options);
        Assert.DoesNotContain("Idea", text, StringComparison.Ordinal);
        Assert.DoesNotContain("decision_records", text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(workspace.FilePath, text, StringComparison.OrdinalIgnoreCase);
    }

    [TestMethod]
    public async Task OfficialClientReadsEveryBoundedIdeaGardenResource()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ConnectAsync(host);

        Assert.AreEqual("2026-07-28", client.NegotiatedProtocolVersion);
        Assert.AreEqual("nendo-local", client.ServerInfo.Name);
        // One product version for the whole tree: the handshake reports the same
        // build the status bar and the installer registration report.
        Assert.AreEqual(NendoProduct.Version, client.ServerInfo.Version);
        Assert.IsNotNull(client.ServerCapabilities.Resources);
        Assert.IsNotNull(client.ServerCapabilities.Tools);
        Assert.IsEmpty(await client.ListToolsAsync());

        var resources = await client.ListResourcesAsync();
        var templates = await client.ListResourceTemplatesAsync();
        CollectionAssert.AreEquivalent(
            new[]
            {
                "nendo.application.describe",
                "nendo.application.entities",
                "nendo.application.examples",
                "nendo.application.extensions",
                "nendo.application.health",
                "nendo.application.manifest",
                "nendo.application.proposals",
                "nendo.application.surfaces",
                "nendo.application.vocabulary",
                // Not about the open file: which Nendos are running and what each has open.
                "nendo.host.instances",
            },
            resources.Select(resource => resource.Name).ToArray());
        CollectionAssert.AreEquivalent(
            new[]
            {
                "nendo.application.entity.export",
                "nendo.application.entity.records",
                "nendo.application.entity.schema",
                "nendo.application.extension.file",
                "nendo.application.history",
                "nendo.application.revision.operations",
            },
            templates.Select(template => template.Name).ToArray());

        // An authoring client must be told exactly the kinds the compiler accepts.
        var vocabularyText = await ReadTextAsync(client, "nendo://application/vocabulary");
        using (var vocabulary = JsonDocument.Parse(vocabularyText))
        {
            Assert.AreEqual(Nendo.Engine.NendoSemanticVocabulary.ContractVersion,
                vocabulary.RootElement.GetProperty("contractVersion").GetInt32());
            Assert.IsTrue(vocabulary.RootElement.GetProperty("kinds").EnumerateArray()
                .Any(kind => kind.GetProperty("kind").GetString() == "relatedList"));
            Assert.IsTrue(vocabulary.RootElement.GetProperty("filterOperators").EnumerateArray()
                .Any(value => value.GetString() == "isNotNull"));
        }

        // The limits an agent plans batches against come off the wire, not from a
        // ceiling discovered two-thirds of the way through a build.
        using (var vocabulary = JsonDocument.Parse(vocabularyText))
        {
            var limits = vocabulary.RootElement.GetProperty("limits");
            Assert.AreEqual(
                NendoAuthoringLimits.Current.OperationsPerChangeSet,
                limits.GetProperty("operationsPerChangeSet").GetInt32());
            Assert.AreEqual(
                NendoAuthoringLimits.Current.OperationsPerCall,
                limits.GetProperty("operationsPerCall").GetInt32());
        }

        // One read describes the whole application, including its screens.
        var describeText = await ReadTextAsync(client, "nendo://application/describe");
        using (var describe = JsonDocument.Parse(describeText))
        {
            // What the file is for comes first: an agent meeting a file it has never seen
            // is told that before it is handed revisions and a schema. Every other
            // assertion here reads members by name and would pass in any order.
            Assert.AreEqual("purpose", describe.RootElement.EnumerateObject().First().Name);
            // Nobody has said what this one is for, so it reads as absent rather than as
            // something composed from its file name.
            Assert.AreEqual(JsonValueKind.Null, describe.RootElement.GetProperty("purpose").ValueKind);
            Assert.AreEqual(
                "nendo.application",
                describe.RootElement.GetProperty("manifest").GetProperty("formatIdentifier").GetString());
            Assert.IsTrue(describe.RootElement.GetProperty("entities").EnumerateArray()
                .Any(entity => entity.GetProperty("entityId").GetString() == NendoApplicationService.IdeaEntityId));
            Assert.AreEqual("valid", describe.RootElement.GetProperty("surfaces").GetProperty("state").GetString());
        }

        var examplesText = await ReadTextAsync(client, "nendo://application/examples");
        using (var examples = JsonDocument.Parse(examplesText))
        {
            Assert.IsTrue(examples.RootElement.GetProperty("examples").EnumerateArray()
                .Any(example => example.GetProperty("name").GetString() == "define-a-command"));
        }

        var manifestText = await ReadTextAsync(client, "nendo://application/manifest");
        var entitiesText = await ReadTextAsync(client, "nendo://application/entities");
        var schemaText = await ReadTextAsync(
            client,
            $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/schema");
        var firstRecordsText = await ReadTextAsync(
            client,
            $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records?limit=1");
        var surfacesText = await ReadTextAsync(client, "nendo://application/surfaces");
        var historyText = await ReadTextAsync(client, "nendo://application/history?limit=100");
        var healthText = await ReadTextAsync(client, "nendo://application/health");

        var manifest = Deserialize<NendoMcpManifest>(manifestText);
        var entities = Deserialize<NendoMcpEntity[]>(entitiesText);
        var schema = Deserialize<NendoMcpEntitySchema>(schemaText);
        var firstPage = Deserialize<NendoMcpPage<NendoMcpRecord>>(firstRecordsText);
        var surfaces = Deserialize<NendoMcpSurfaces>(surfacesText);
        var history = Deserialize<NendoMcpPage<NendoMcpRevision>>(historyText);
        var health = Deserialize<NendoMcpHealth>(healthText);

        Assert.AreEqual("nendo.application", manifest.FormatIdentifier);
        Assert.IsTrue(entities.Any(entity => entity.EntityId == NendoApplicationService.IdeaEntityId));
        Assert.IsTrue(schema.Fields.Any(field => field.FieldId == NendoApplicationService.IdeaTitleFieldId));
        Assert.HasCount(1, firstPage.Items);
        Assert.IsNotNull(firstPage.NextCursor);
        Assert.IsTrue(surfaces.IsValid);
        Assert.AreEqual("Idea board", surfaces.Applications.Single().Surfaces.Single(node => node.Kind == "boardSurface").Title);
        Assert.IsNotEmpty(history.Items);
        Assert.AreEqual(NendoSessionHealth.Normal, health.State);
        Assert.AreEqual("local-coordinated-durable-file", health.DurabilityProfile);
        var populatedRevision = history.Items.First(value => value.OperationCount > 1);
        var operationText = await ReadTextAsync(client, populatedRevision.OperationsUri + "?limit=1");
        var operationPage = Deserialize<NendoMcpPage<NendoMcpOperation>>(operationText);
        Assert.HasCount(1, operationPage.Items);
        Assert.IsNotNull(operationPage.NextCursor);
        var operationRemainder = Deserialize<NendoMcpPage<NendoMcpOperation>>(await ReadTextAsync(client,
            populatedRevision.OperationsUri + $"?cursor={Uri.EscapeDataString(operationPage.NextCursor)}&limit=100"));
        Assert.AreEqual(populatedRevision.OperationCount, operationRemainder.Items.Count + 1);
        Assert.IsNull(operationRemainder.NextCursor);

        var secondPageText = await ReadTextAsync(
            client,
            $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records" +
            $"?cursor={Uri.EscapeDataString(firstPage.NextCursor)}&limit=1");
        var secondPage = Deserialize<NendoMcpPage<NendoMcpRecord>>(secondPageText);
        Assert.HasCount(1, secondPage.Items);
        Assert.AreNotEqual(firstPage.Items[0].RecordId, secondPage.Items[0].RecordId);

        var tampered = firstPage.NextCursor[..^1] +
            (firstPage.NextCursor[^1] == 'a' ? 'b' : 'a');
        var error = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ReadTextAsync(
            client,
            $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records" +
            $"?cursor={Uri.EscapeDataString(tampered)}&limit=1"));
        StringAssert.Contains(error.Message, "NENDO_INVALID_CURSOR");

        var protocolSurface = string.Join(
            '\n',
            JsonSerializer.Serialize(resources, NendoMcpJson.Options),
            JsonSerializer.Serialize(templates, NendoMcpJson.Options),
            describeText,
            examplesText,
            manifestText,
            entitiesText,
            schemaText,
            firstRecordsText,
            surfacesText,
            historyText,
            operationText,
            healthText);
        Assert.DoesNotContain(workspace.FilePath, protocolSurface, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(Path.GetFileName(workspace.FilePath), protocolSurface, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("canonicalJson", protocolSurface, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("operationalSidecars", protocolSurface, StringComparison.OrdinalIgnoreCase);
        Assert.IsFalse(
            new Regex(@"(?i)\bsql(?:ite)?\b|[A-Z]:\\|file://|\\\\").IsMatch(protocolSurface),
            "The protocol exposed storage or filesystem vocabulary.");
    }

    internal static async Task<McpClient> ConnectAsync(NendoLocalMcpHost host)
    {
        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Endpoint = host.Endpoint,
            Name = "nendo-p3-tests",
            TransportMode = HttpTransportMode.StreamableHttp,
            ConnectionTimeout = TimeSpan.FromSeconds(5),
        });
        return await McpClient.CreateAsync(
            transport,
            new McpClientOptions
            {
                ClientInfo = new Implementation
                {
                    Name = "nendo-p3-integration-test",
                    Version = "1.0.0",
                },
                ProtocolVersion = "2026-07-28",
                InitializationTimeout = TimeSpan.FromSeconds(10),
            });
    }

    internal static async Task<string> ReadTextAsync(McpClient client, string uri)
    {
        var result = await client.ReadResourceAsync(uri);
        Assert.HasCount(1, result.Contents);
        var content = result.Contents[0] as TextResourceContents;
        Assert.IsNotNull(content);
        return content.Text;
    }

    internal static T Deserialize<T>(string text) where T : notnull =>
        JsonSerializer.Deserialize<T>(text, NendoMcpJson.Options)
        ?? throw new AssertFailedException($"Could not deserialize {typeof(T).Name}.");
}
