using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// What an unattended agent spends to build an application, and what it is told
/// when a write cannot land. Each case here was a finding in the 2026-09-11
/// blackbox review, measured by building a complete CRM through MCP alone.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class AuthoringErgonomicsTests
{
    /// <summary>
    /// A node and its properties can arrive as one operation. The screens that
    /// come out must be the same ones, or this is a shortcut to a different
    /// application: the two forms are compiled and compared whole.
    /// </summary>
    [TestMethod]
    public async Task InlineNodePropertiesBuildTheSameScreensForAThirdOfTheOperations()
    {
        var explicitBuild = await BuildCrmAsync(CrmAuthoringFixture.SurfaceOperations());
        var inlineBuild = await BuildCrmAsync(CrmAuthoringFixture.InlineSurfaceOperations());

        Assert.AreEqual(explicitBuild.Surfaces, inlineBuild.Surfaces,
            "Inline properties must compile to the same screens as one operation per property.");

        // 84 nodes and ~234 operations was what pushed the review's CRM past the
        // change-set ceiling and into three proposals with a human between each.
        Assert.IsLessThan(
            explicitBuild.SubmittedOperations / 2,
            inlineBuild.SubmittedOperations,
            "Inline properties must at least halve what a caller submits.");
        Assert.AreEqual(explicitBuild.SubmittedOperations, inlineBuild.CanonicalOperations,
            "The same canonical operations are stored either way; only the submission is shorter.");
        Assert.IsLessThanOrEqualTo(
            NendoAuthoringLimits.Current.OperationsPerChangeSet,
            inlineBuild.SubmittedOperations,
            "The whole application's screens must fit in one change set, so one approval covers them.");
    }

    /// <summary>
    /// Both budgets are echoed in every response, and the canonical one refuses
    /// with a message that names the expansion rather than an unexplained ceiling.
    /// </summary>
    [TestMethod]
    public async Task TheCanonicalBudgetIsPublishedEchoedAndEnforced()
    {
        var limits = NendoAuthoringLimits.Current;
        Assert.IsGreaterThan(limits.OperationsPerChangeSet, limits.CanonicalOperationsPerChangeSet);

        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var scoped = await BeginAsync(client, session, "Budget");

        var added = await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Add one configured node", [InlineNode("solo", "recordForm", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "solo-entity",
                    ["title"] = "Solo",
                })]),
            },
            ["idempotencyKey"] = "budget-add",
        });
        Assert.AreEqual(1, added.OperationCount);
        Assert.AreEqual(4, added.CanonicalOperationCount, "One node plus one operation per inline property.");
        Assert.AreEqual(limits.OperationsPerChangeSet, added.OperationLimit);
        Assert.AreEqual(limits.CanonicalOperationsPerChangeSet, added.CanonicalOperationLimit);

        // Sixteen properties per node is the published ceiling; one more is refused
        // before it can be counted against anything.
        var tooMany = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (var index = 0; index <= limits.PropertiesPerNodeOperation; index++) tooMany[$"p{index}"] = index;
        var refused = await RefusalAsync(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Too many properties", [InlineNode("wide", "recordForm", 1, tooMany)]),
            },
            ["idempotencyKey"] = "budget-wide",
        });
        StringAssert.Contains(refused, "NENDO_INVALID_REQUEST");

        // An exact decimal arrives as an envelope object. Inline property values
        // are scalars, and the envelope is decoded to one before that is judged,
        // or exact numerics would be the one thing inline properties could not
        // carry.
        var exact = await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Filter on an exact decimal", [InlineNode("threshold", "filterClause", 2, new()
                {
                    ["fieldId"] = "amount",
                    ["operator"] = "gte",
                    ["value"] = JsonSerializer.SerializeToElement(new Dictionary<string, string>
                    {
                        ["$nendoNumber"] = "485000.00",
                    }),
                })]),
            },
            ["idempotencyKey"] = "budget-exact",
        });
        Assert.AreEqual(2, exact.OperationCount);
        Assert.AreEqual(4 + 4, exact.CanonicalOperationCount);
    }

    /// <summary>
    /// The payload specification lives in a resource, not in a tool description
    /// long enough to be truncated mid-token in a client's tool listing. The
    /// published table is the one the boundary enforces.
    /// </summary>
    [TestMethod]
    public async Task TheOperationSpecificationIsAResourceAndTheDescriptionPointsAtIt()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        // The instructions open with what a file holds. A reviewer who had only the
        // tool names could not tell the product had calculations, and the transport
        // paragraph stood first, addressed to someone building an HTTP client.
        var instructions = client.ServerInstructions ?? string.Empty;
        StringAssert.StartsWith(instructions, "This is a Nendo file");
        StringAssert.Contains(instructions, "calculated fields");
        StringAssert.Contains(instructions, "behaviour.setDefinition");
        Assert.IsGreaterThan(instructions.IndexOf("behaviour.setDefinition", StringComparison.Ordinal),
            instructions.IndexOf("server/discover", StringComparison.Ordinal),
            "The transport paragraph belongs after the product, not before it.");

        var vocabulary = ProtocolResourceTests.Deserialize<NendoVocabularyDescription>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"));
        CollectionAssert.AreEquivalent(
            NendoAuthoringOperations.AllowedPayloads.Keys.ToArray(),
            vocabulary.Operations.Select(operation => operation.OperationType).ToArray(),
            "Every operation the boundary accepts must be published, and nothing else.");
        foreach (var operation in vocabulary.Operations)
        {
            Assert.IsNotEmpty(operation.RequiredPayload, operation.OperationType);
            Assert.IsFalse(string.IsNullOrWhiteSpace(operation.Summary), operation.OperationType);
            CollectionAssert.AreEquivalent(
                NendoAuthoringOperations.AllowedPayloads[operation.OperationType].ToArray(),
                operation.RequiredPayload.Concat(operation.OptionalPayload).ToArray(),
                $"{operation.OperationType}: a documented field must be an accepted field.");
        }
        var addNode = vocabulary.Operations.Single(operation => operation.OperationType == "ui.addNode");
        CollectionAssert.Contains(addNode.OptionalPayload.ToArray(), "properties");
        var conversion = vocabulary.Operations.Single(operation => operation.OperationType == "data.convertLegacyReference");
        StringAssert.Contains(conversion.Summary, "unbound legacy Reference field");
        StringAssert.Contains(conversion.Summary, "ordinary text field");

        var tools = await client.ListToolsAsync();
        var description = tools
            .Single(tool => tool.Name == "nendo.change_set.add_operations")
            .Description ?? string.Empty;
        Assert.IsLessThan(2_200, description.Length,
            "A tool listing is where a schema gets truncated, not where it belongs.");
        StringAssert.Contains(description, "nendo://application/vocabulary");
        StringAssert.Contains(description, "nendo://application/examples");
        var healthDescription = (await client.ListResourcesAsync())
            .Single(resource => resource.Name == "nendo.application.health")
            .Description ?? string.Empty;
        StringAssert.Contains(healthDescription, "nendo.health.verify_integrity");
        Assert.IsTrue(tools.Any(tool => tool.Name == "nendo.health.verify_integrity"));
        Assert.DoesNotContain("nendo.application.verify_integrity", healthDescription, StringComparison.Ordinal);
    }

    /// <summary>
    /// A write that depends on an unaccepted proposal used to read as a bad
    /// identifier, which invites deleting the ID and starting again. The host
    /// knows the real cause and now says it.
    /// </summary>
    /// <summary>
    /// F-058: the summary listed every surface by kind and title, which is not enough to
    /// judge one. It did not say that the matrix was nine rows by five columns, or that
    /// the board it listed grouped by a record type holding no records — which was true,
    /// and accepting it produced a board that drew nothing.
    /// </summary>
    [TestMethod]
    public async Task ASurfaceWhoseSizeCannotBeGuessedStatesItInThePreview()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var scoped = await BeginAsync(client, session, "Build the CRM with two sized screens");
        var ordinal = 0;
        async Task AddAsync(string description, IReadOnlyList<NendoAgentOperationInput> operations)
        {
            foreach (var chunk in operations.Chunk(NendoAuthoringLimits.Current.OperationsPerCall))
            {
                await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
                {
                    ["mutations"] = new[] { new NendoAgentMutationInput(description, chunk) },
                    ["idempotencyKey"] = $"shape-add-{ordinal++:D2}",
                });
            }
        }

        await AddAsync("Create the CRM record types", CrmAuthoringFixture.SchemaOperations());
        await AddAsync("Bind the CRM references", CrmAuthoringFixture.ReferenceOperations());
        await AddAsync("Shape the CRM surfaces", CrmAuthoringFixture.SurfaceOperations());
        await AddAsync("Add two screens whose size matters", CrmAuthoringFixture.ShapeProbeSurfaceOperations());
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "shape-validate" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);

        var matrix = validated.Preview.Surfaces.Single(surface => surface.Title == "Stage against closed");
        Assert.AreEqual("4 rows by 2 columns, 8 cells", matrix.Shape,
            "Stage has four options and Closed is a Boolean; the cell count follows and is not a guess.");

        // No Account record exists in the validated clone, so this board has no columns to
        // draw. Said before acceptance rather than discovered after it.
        var referenceBoard = validated.Preview.Surfaces.Single(surface => surface.Title == "Deals by account");
        StringAssert.Contains(referenceBoard.Shape ?? string.Empty, "one column per Account");
        StringAssert.Contains(referenceBoard.Shape ?? string.Empty, "would draw nothing");

        // A choice-grouped board states its column count; a kind with no closed size says
        // nothing rather than something invented.
        var pipeline = validated.Preview.Surfaces.Single(surface => surface.Title == "Pipeline");
        Assert.AreEqual("4 columns", pipeline.Shape);
        Assert.IsNull(validated.Preview.Surfaces.Single(surface => surface.Title == "Account").Shape,
            "A record page has no size a reviewer needs stated.");
    }

    [TestMethod]
    public async Task AWriteBlockedByAnUnacceptedProposalNamesTheProposal()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var scoped = await BeginAsync(client, session, "Create the CRM record types");
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Create the CRM record types", CrmAuthoringFixture.SchemaOperations()),
            },
            ["idempotencyKey"] = "pending-add",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "pending-validate" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);

        // Nobody has accepted it, so the record type is not in the file yet.
        var refused = await RefusalAsync(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = CrmAuthoringFixture.AccountEntityId,
            ["recordId"] = "account-early",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                [CrmAuthoringFixture.AccountNameFieldId] = "Too early",
            }),
            ["idempotencyKey"] = "pending-write",
        });

        StringAssert.Contains(refused, "NENDO_ENTITY_NOT_FOUND");
        StringAssert.Contains(refused, "Create the CRM record types");
        StringAssert.Contains(refused, validated.ProposalId);
        StringAssert.Contains(refused, "accept");

        // The pending proposal is also discoverable on its own, which is what a
        // reconnecting agent has instead of the response it lost.
        var pending = ProtocolResourceTests.Deserialize<NendoAgentProposalSummary[]>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/proposals")).Single();
        Assert.AreEqual(validated.ProposalId, pending.ProposalId);
        Assert.AreEqual("Create the CRM record types", pending.Title);
        Assert.AreEqual(NendoProposalState.Previewable, pending.State);
        Assert.AreEqual(validated.OperationCount, pending.OperationCount);
        Assert.AreEqual(validated.CapturedDefinitionRevision, pending.CapturedDefinitionRevision);

        // A schema-only change set adds no screen, and previews as what it adds
        // rather than as nothing. Field and record counts share one scope.
        Assert.AreEqual("wholeFileAfterChange", validated.Preview.Scope);
        Assert.HasCount(3, validated.Preview.Entities);
        Assert.AreEqual(
            validated.Preview.Entities.Sum(entity => entity.FieldCount),
            validated.Preview.FieldCount);
        Assert.AreEqual(
            validated.Preview.Entities.Sum(entity => entity.RecordCount),
            validated.Preview.RecordCount);
        Assert.IsEmpty(validated.Preview.Surfaces);
        Assert.AreNotEqual(validated.Preview.MinimumHostVersionBefore, validated.Preview.MinimumHostVersionAfter);
        Assert.IsTrue(
            validated.SemanticDiff.Any(entry => entry.Kind == "raiseMinimumHostVersion"),
            "A compatibility change is a line in the diff the person reviews.");
    }

    private sealed record Build(string Surfaces, int SubmittedOperations, int CanonicalOperations);

    /// <summary>Author the whole CRM in one change set and accept it, as the owner would.</summary>
    private static async Task<Build> BuildCrmAsync(IReadOnlyList<NendoAgentOperationInput> surfaceOperations)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var scoped = await BeginAsync(client, session, "Build the CRM");

        var ordinal = 0;
        NendoChangeSetAddResult? progress = null;
        async Task AddAsync(string description, IReadOnlyList<NendoAgentOperationInput> operations)
        {
            foreach (var chunk in operations.Chunk(NendoAuthoringLimits.Current.OperationsPerCall))
            {
                progress = await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
                {
                    ["mutations"] = new[] { new NendoAgentMutationInput(description, chunk) },
                    ["idempotencyKey"] = $"build-add-{ordinal++:D2}",
                });
            }
        }

        await AddAsync("Create the CRM record types", CrmAuthoringFixture.SchemaOperations());
        await AddAsync("Bind the CRM references", CrmAuthoringFixture.ReferenceOperations());
        await AddAsync("Shape the CRM surfaces", surfaceOperations);

        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "build-validate" });
        Assert.AreEqual(
            NendoProposalState.Previewable,
            validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        Assert.IsTrue((await proposals.PromoteAsync(workspace.Service, validated.ProposalId)).Applied);

        var surfaces = ProtocolResourceTests.Deserialize<NendoMcpSurfaces>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/surfaces"));
        Assert.IsTrue(surfaces.IsValid, JsonSerializer.Serialize(surfaces.Diagnostics, NendoMcpJson.Options));
        Assert.IsNotNull(progress);
        return new Build(
            JsonSerializer.Serialize(surfaces.Applications, NendoMcpJson.Options),
            progress.OperationCount,
            progress.CanonicalOperationCount);
    }

    /// <summary>
    /// The board's size sentence embeds the record type's name as the person chose it,
    /// and "one column per Initiatives, 6 of them" is what the owner read (W-044, C-079).
    /// The sentence says "per {name} record" now, which reads the same for Account and
    /// for Initiatives. Asserted here over a plural name with records behind it, in the
    /// size sentence and in the diff line; the singular, empty case is asserted above.
    /// </summary>
    [TestMethod]
    public async Task AReferenceBoardStatesItsColumnsForAPluralRecordTypeName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var ordinal = 0;
        async Task AddAsync(Dictionary<string, object?> scoped, string description, IReadOnlyList<NendoAgentOperationInput> operations)
        {
            foreach (var chunk in operations.Chunk(NendoAuthoringLimits.Current.OperationsPerCall))
            {
                await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
                {
                    ["mutations"] = new[] { new NendoAgentMutationInput(description, chunk) },
                    ["idempotencyKey"] = $"plural-add-{ordinal++:D2}",
                });
            }
        }

        // Round one: the CRM with its Account type named in the plural, accepted, and six
        // of them recorded.
        var schema = await BeginAsync(client, session, "Build the CRM with a plural record type");
        await AddAsync(schema, "Create the CRM record types", CrmAuthoringFixture.SchemaOperations());
        await AddAsync(schema, "Bind the CRM references", CrmAuthoringFixture.ReferenceOperations());
        await AddAsync(schema, "Shape the CRM surfaces", CrmAuthoringFixture.SurfaceOperations());
        await AddAsync(schema, "Name the accounts in the plural",
        [
            new NendoAgentOperationInput("schema.renameEntity", JsonSerializer.SerializeToElement(
                new { entityId = CrmAuthoringFixture.AccountEntityId, displayName = "Accounts" }, NendoMcpJson.Options)),
        ]);
        var accepted = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(schema) { ["idempotencyKey"] = "plural-validate-schema" });
        Assert.AreEqual(NendoProposalState.Previewable, accepted.State, JsonSerializer.Serialize(accepted.Diagnostics, NendoMcpJson.Options));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(accepted.ProposalId)).Applied, "The CRM did not promote.");
        for (var index = 1; index <= 6; index++)
        {
            await workspace.Service.CreateRecordAsync(new(CrmAuthoringFixture.AccountEntityId, $"account-{index}",
                new Dictionary<string, object?> { [CrmAuthoringFixture.AccountNameFieldId] = $"Account {index}" },
                new("test", $"plural-account-{index}", "test")));
        }

        // Round two: a board grouped by the reference to them, read before acceptance.
        var board = await BeginAsync(client, session, "Group deals by account");
        await AddAsync(board, "Add two screens whose size matters", CrmAuthoringFixture.ShapeProbeSurfaceOperations());
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(board) { ["idempotencyKey"] = "plural-validate-board" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State, JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));

        var referenceBoard = validated.Preview.Surfaces.Single(surface => surface.Title == "Deals by account");
        Assert.AreEqual("one column per Accounts record, 6 of them", referenceBoard.Shape);
        var grouping = validated.SemanticDiff.Select(entry => entry.Summary)
            .Single(summary => summary.StartsWith("Give the board", StringComparison.Ordinal));
        // The bound itself is the Engine's to state; SemanticDiffSummaryTests pins the number.
        StringAssert.StartsWith(grouping, "Give the board one column per Accounts record, from Account, and draw nothing above ");
    }

    private static NendoAgentOperationInput InlineNode(
        string nodeId,
        string kind,
        int position,
        Dictionary<string, object?> properties) => new("ui.addNode", JsonSerializer.SerializeToElement(new
        {
            surfaceId = "ergonomics",
            nodeId,
            parentNodeId = (string?)null,
            kind,
            position,
            properties,
        }, NendoMcpJson.Options));

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client)
    {
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        return new(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
    }

    private static async Task<Dictionary<string, object?>> BeginAsync(
        McpClient client,
        Dictionary<string, object?> session,
        string title)
    {
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session)
        {
            ["title"] = title,
            ["idempotencyKey"] = $"begin-{title}",
        });
        return new(session, StringComparer.Ordinal) { ["changeSetId"] = begun.ChangeSetId };
    }

    /// <summary>The text of a refused call, which the transport returns as an error result.</summary>
    private static async Task<string> RefusalAsync(
        McpClient client,
        string name,
        Dictionary<string, object?> arguments)
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.IsTrue(result.IsError, $"{name} was expected to be refused.");
        return string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));
    }

    private static async Task<T> CallAsync<T>(
        McpClient client,
        string name,
        Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }

    /// <summary>
    /// What the published resources say about binding a reference is what the boundary
    /// does, in both arrangements an author might write.
    /// </summary>
    /// <remarks>
    /// The examples resource claimed a Reference field "cannot be bound in the mutation
    /// that creates it", and the operation contract said nothing at all, so F-061 was
    /// opened on the premise that an author reading the operations would be refused by a
    /// rule published only in an example. Measured, neither was true: binding in the same
    /// mutation validates, promotes and leaves the reference bound. The rule was a
    /// documentation artefact, over-generalised from schema.createEntity -- a record type
    /// exists physically from the end of its mutation, while binding is metadata and does
    /// not wait. F-069 records it.
    /// <para>
    /// So this asserts the published text against the boundary in both arrangements. The
    /// one-mutation form is the one that matters: it is what an author writes naturally,
    /// it is what the old rule told them not to, and a wrong rule costs them operations
    /// against the 128 ceiling for no reason.
    /// </para>
    /// </remarks>
    [TestMethod]
    public async Task BindingAReferenceWorksInOneMutationAndInTwo()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var vocabulary = ProtocolResourceTests.Deserialize<NendoVocabularyDescription>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"));
        var addField = vocabulary.Operations.Single(operation => operation.OperationType == "schema.addField");
        var configure = vocabulary.Operations.Single(operation => operation.OperationType == "schema.configureReference");
        StringAssert.Contains(addField.Summary, "same mutation",
            "schema.addField is where an author decides how to make a reference field, so it has to say how binding works. Saying nothing is what opened F-061.");
        StringAssert.Contains(configure.Summary, "same mutation",
            "The operation that does the binding has to say when it can run, and say something true: the examples resource published the opposite for months (F-069).");
        Assert.DoesNotContain("cannot be bound in the mutation", configure.Summary,
            "The constraint this once claimed is not enforced. Publishing it sends an author splitting a change set for no reason.");

        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire", []);
        object[] schema =
        [
            new { operationType = "schema.createEntity", payload = new { entityId = "target", displayName = "Targets" } },
            new { operationType = "schema.addField", payload = new { entityId = "target", fieldId = "label", displayName = "Label", storageKind = "text", required = true } },
            new { operationType = "schema.createEntity", payload = new { entityId = "source", displayName = "Sources" } },
            new { operationType = "schema.addField", payload = new { entityId = "source", fieldId = "ref", displayName = "Target", storageKind = "reference", required = false } },
        ];
        object bind = new { operationType = "schema.configureReference", payload = new { entityId = "source", fieldId = "ref", targetEntityId = "target", labelFieldId = "label" } };

        // The natural way, and the way the contract now warns against.
        var together = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new Dictionary<string, object?>
        { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["title"] = "Bound where it is added", ["idempotencyKey"] = "begin-together" });
        await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = together.ChangeSetId, ["idempotencyKey"] = "add-together",
            ["mutations"] = new object[] { new { description = "Everything in one mutation", operations = schema.Append(bind).ToArray() } },
        });
        var refused = await client.CallToolAsync("nendo.change_set.validate", new Dictionary<string, object?>
        { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = together.ChangeSetId, ["idempotencyKey"] = "validate-together" });
        var refusedState = refused.IsError == true
            ? (NendoProposalState?)null
            : refused.StructuredContent!.Value.Deserialize<NendoAgentProposalPreview>(NendoMcpJson.Options)!.State;
        Assert.AreEqual(NendoProposalState.Previewable, refusedState,
            "Binding a reference in the mutation that adds it is accepted. If that ever changes, the published text has to change with it.");
        var togetherPreview = refused.StructuredContent!.Value.Deserialize<NendoAgentProposalPreview>(NendoMcpJson.Options)!;
        var promoted = await proposals.PromoteAsync(workspace.Service, togetherPreview.ProposalId);
        Assert.IsTrue(promoted.Applied, promoted.Message);
        var bound = (await workspace.Service.GetSnapshotAsync()).Entities
            .Single(entity => entity.EntityId == "source").Fields.Single(field => field.FieldId == "ref");
        Assert.AreEqual("target", bound.Reference?.TargetEntityId,
            "It validated and promoted, so it has to have bound. Anything else would mean the change set reported a success it did not deliver.");

        // The remedy the contract states, followed exactly.
        var split = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new Dictionary<string, object?>
        { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["title"] = "Bound in a second mutation", ["idempotencyKey"] = "begin-split" });
        object[] second =
        [
            new { operationType = "schema.createEntity", payload = new { entityId = "second", displayName = "Seconds" } },
            new { operationType = "schema.addField", payload = new { entityId = "second", fieldId = "ref2", displayName = "Target", storageKind = "reference", required = false } },
        ];
        object bindSecond = new { operationType = "schema.configureReference", payload = new { entityId = "second", fieldId = "ref2", targetEntityId = "target", labelFieldId = "label" } };
        var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = split.ChangeSetId, ["idempotencyKey"] = "add-split",
            ["mutations"] = new object[]
            {
                new { description = "The record type and the unbound field", operations = second },
                new { description = "Bind it, in a second mutation", operations = new[] { bindSecond } },
            },
        });
        Assert.AreNotEqual(true, added.IsError, JsonSerializer.Serialize(added));
        var preview = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new Dictionary<string, object?>
        { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId, ["changeSetId"] = split.ChangeSetId, ["idempotencyKey"] = "validate-split" });
        Assert.AreEqual(NendoProposalState.Previewable, preview.State,
            "Splitting the two across mutations still works, and has to: the older shape is in the examples resource and in every file authored against it.");
    }
}
