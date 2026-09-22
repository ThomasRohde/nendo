using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// Stage S8 of ADR-0008: an external agent authors calculations and an automatic
/// action through ordinary discovery and ordinary proposals, and reads the results
/// back exactly.
/// <para>
/// What it must not be able to do is run them. Installing a definition is authoring;
/// letting it act on the owner's data is consent, and consent is a host action with
/// no MCP equivalent.
/// </para>
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class BehaviourAuthoringProtocolTests
{
    [TestMethod]
    public async Task TheVocabularyPublishesEverythingAFormulaMaySay()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var vocabulary = ProtocolResourceTests.Deserialize<NendoVocabularyDescription>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary"));
        var behaviour = vocabulary.Behaviour;
        Assert.IsNotNull(behaviour, "A client cannot author a calculation it has to guess the vocabulary of.");
        Assert.AreEqual(NendoBehaviourContract.Version, behaviour.ContractVersion);

        // The published function set is the enforced one. A second table would be a
        // table that disagrees.
        CollectionAssert.AreEquivalent(
            new[] { "Concat", "Date", "DaysBetween", "Refuse", "RoundAway", "RoundEven", "TextLength" },
            behaviour.Functions.Select(function => function.Name).ToArray());
        foreach (var function in behaviour.Functions)
        {
            Assert.IsNotEmpty(function.ParameterTypes, function.Name);
            Assert.IsFalse(string.IsNullOrWhiteSpace(function.ResultType), function.Name);
            Assert.IsFalse(string.IsNullOrWhiteSpace(function.Summary), function.Name);
            Assert.IsLessThanOrEqualTo(function.MaximumArguments, function.MinimumArguments, function.Name);
        }

        // The ceilings are published as the numbers actually enforced, so a client
        // plans against them instead of discovering them by being refused.
        Assert.AreEqual(NendoBehaviourLimits.Default.RelatedRows, behaviour.Limits.RelatedRows);
        Assert.AreEqual(NendoBehaviourLimits.Default.WorkUnits, behaviour.Limits.WorkUnits);
        Assert.AreEqual(NendoBehaviourLimits.Default.GeneratedChanges, behaviour.Limits.GeneratedChanges);

        CollectionAssert.Contains(behaviour.Operators.ToArray(), "?:");
        CollectionAssert.Contains(behaviour.Scalars.ToArray(), "Decimal");
        CollectionAssert.AreEquivalent(
            new[] { "SameRecordField", "SameRecordCalculation", "ReferenceTraversal", "RelatedAggregate" },
            behaviour.Bindings.Select(binding => binding.Kind).Distinct().ToArray());
        // A related aggregate is published once per aggregate, because the key that
        // names the field differs. A reviewer who could not find the sum's key
        // guessed three spellings and abandoned the calculation.
        var shapes = behaviour.Bindings.Where(binding => binding.Kind == "RelatedAggregate").ToArray();
        CollectionAssert.AreEquivalent(new[] { "Count", "FilteredCount", "Sum" }, shapes.Select(shape => shape.Aggregate).ToArray());
        CollectionAssert.Contains(shapes.Single(shape => shape.Aggregate == "Sum").RequiredFields.ToArray(), "valueFieldId");
        CollectionAssert.Contains(shapes.Single(shape => shape.Aggregate == "FilteredCount").RequiredFields.ToArray(), "predicateFieldId");
        var sum = behaviour.Aggregates.Single(aggregate => aggregate.Aggregate == "Sum");
        Assert.AreEqual("valueFieldId", sum.FieldKey);
        StringAssert.Contains(sum.EmptyRule, "zero", StringComparison.OrdinalIgnoreCase);
        StringAssert.Contains(sum.MissingValueRule, "error", StringComparison.OrdinalIgnoreCase);

        // A property whose value is not what its name suggests is explained beside the
        // kinds, so visibleWhen is not learned by sending the definition ID first.
        StringAssert.Contains(vocabulary.PropertyNotes["visibleWhen"], "fieldId");
        StringAssert.Contains(vocabulary.PropertyNotes["visibleWhen"], "Boolean");

        // Both behaviour operations are in the published authoring union.
        var published = vocabulary.Operations.Select(operation => operation.OperationType).ToArray();
        CollectionAssert.Contains(published, "behaviour.setDefinition");
        CollectionAssert.Contains(published, "behaviour.removeDefinition");

        // An empty target reference selects no record, and a review that expected a
        // refusal got a committed write that reported nothing. The rule is stated on
        // the targets, which the catalogue previously did not list at all.
        CollectionAssert.AreEquivalent(
            new[] { "EventRecord", "ReferencedRecord" },
            behaviour.ActionTargets.Select(target => target.Kind).ToArray());
        var referenced = behaviour.ActionTargets.Single(target => target.Kind == "ReferencedRecord");
        StringAssert.Contains(referenced.Summary, "referenceFieldId");
        StringAssert.Contains(referenced.Summary, "empty reference");
        StringAssert.Contains(referenced.Summary, "alsoChanged");
    }

    [TestMethod]
    public async Task AnAgentAuthorsCalculationsAndAnActionAndReadsTheResultsBackExactly()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await SeedSchemaAsync(workspace);

        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var scoped = await BeginAsync(client, session, "Track project completion");

        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Track project completion",
                [
                    Set("fn.percent", "Function", new
                    {
                        displayName = "Percent",
                        parameters = new[]
                        {
                            new { parameterId = "part", displayName = "Part", parameterType = "Decimal", nullable = false },
                            new { parameterId = "whole", displayName = "Whole", parameterType = "Decimal", nullable = false },
                        },
                        resultType = "Decimal",
                        resultNullable = false,
                        expression = "RoundEven(part / whole * 100, 2)",
                        callAliases = Array.Empty<object>(),
                    }),
                    Set("project.taskCount", "Calculation", new
                    {
                        entityId = "projects",
                        fieldId = "taskCount",
                        displayName = "Tasks",
                        resultType = "Integer",
                        resultNullable = false,
                        expression = "count",
                        bindings = new[]
                        {
                            new
                            {
                                bindingId = "count", kind = "RelatedAggregate", aggregate = "Count",
                                entityId = "projects", relatedEntityId = "tasks", relatedReferenceFieldId = "project",
                                resultType = "Integer", nullable = false,
                            },
                        },
                        callAliases = Array.Empty<object>(),
                    }),
                    // Reads the calculation above rather than counting again, which is
                    // what makes this a dependency and not two copies of one rule.
                    Set("project.completion", "Calculation", new
                    {
                        entityId = "projects",
                        fieldId = "completion",
                        displayName = "Completion",
                        resultType = "Decimal",
                        resultNullable = false,
                        expression = "Percent(1, total)",
                        bindings = new[]
                        {
                            new
                            {
                                bindingId = "total", kind = "SameRecordCalculation", entityId = "projects",
                                calculationId = "project.taskCount", resultType = "Integer", nullable = false,
                            },
                        },
                        callAliases = new[] { new { alias = "Percent", functionId = "fn.percent" } },
                    }),
                    Set("project.close", "Action", new
                    {
                        displayName = "Name the project after its task",
                        steps = new[]
                        {
                            new
                            {
                                stepId = "10-name",
                                kind = "SetField",
                                target = new { kind = "ReferencedRecord", referenceFieldId = "project" },
                                assignments = new[]
                                {
                                    new
                                    {
                                        fieldId = "name",
                                        expression = "Concat('Project: ', title)",
                                        bindings = new[]
                                        {
                                            new
                                            {
                                                bindingId = "title", kind = "SameRecordField", entityId = "tasks",
                                                fieldId = "title", resultType = "Text", nullable = false,
                                            },
                                        },
                                        callAliases = Array.Empty<object>(),
                                    },
                                },
                            },
                        },
                    }),
                    Set("10-name", "Trigger", new
                    {
                        entityId = "tasks",
                        displayName = "Name the project when a task is added",
                        events = "Created",
                        actionId = "project.close",
                        relevantFieldIds = Array.Empty<string>(),
                        conditionBindings = Array.Empty<object>(),
                        callAliases = Array.Empty<object>(),
                    }),
                ]),
            },
            ["idempotencyKey"] = "behaviour-add",
        });

        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "behaviour-validate" });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);

        // Acceptance is the host's, never the agent's.
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(validated.ProposalId)).Applied);

        // The record type now publishes its calculated fields, with the formula, so a
        // client reading the schema knows they exist and knows nothing writes to them.
        var schema = ProtocolResourceTests.Deserialize<NendoMcpEntitySchema>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/entity/projects/schema"));
        CollectionAssert.AreEquivalent(
            new[] { "completion", "taskCount" },
            schema.DerivedFields.Select(field => field.FieldId).ToArray());
        Assert.IsFalse(schema.Fields.Any(field => field.FieldId is "completion" or "taskCount"),
            "A calculated field must never arrive as a stored one.");
        Assert.AreEqual("count", schema.DerivedFields.Single(field => field.FieldId == "taskCount").Expression);

        // And the results read back exactly, as digits rather than as a number some
        // client's JSON parser rounded on the way in.
        var page = ProtocolResourceTests.Deserialize<NendoMcpPage<NendoMcpRecord>>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/entity/projects/records"));
        var project = page.Items.Single(record => record.RecordId == "p1");
        var taskCount = project.Calculations.Single(result => result.FieldId == "taskCount");
        Assert.AreEqual(NendoCalculationState.Value, taskCount.State);
        Assert.AreEqual("3", taskCount.NumericLexeme);
        var completion = project.Calculations.Single(result => result.FieldId == "completion");
        Assert.AreEqual("33.33", completion.NumericLexeme,
            "A third, rounded to two places in the decimal domain, is the number a binary double cannot hold.");
        Assert.AreEqual(NendoBehaviourScalar.Decimal, completion.ResultType);
    }

    [TestMethod]
    public async Task AuthoringAnActionDoesNotLetTheAgentRunIt()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await SeedSchemaAsync(workspace);
        await InstallTriggerAsync(workspace);

        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        // The file now carries an automatic action and nobody at this device has
        // approved it, so an ordinary agent write is refused — the same refusal a
        // person's edit gets, for the same reason.
        var refused = await RefusalAsync(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t-agent",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                ["project"] = "p1",
                ["title"] = "Added by an agent",
            }),
            ["expectedTargetVersions"] = JsonSerializer.SerializeToElement(new Dictionary<string, long> { ["project"] = 1 }),
            ["idempotencyKey"] = "agent-write",
        });
        StringAssert.Contains(refused, "approve", StringComparison.OrdinalIgnoreCase);

        // And there is no agent-facing route to that approval: not a tool, not a
        // resource, not a field on one.
        var tools = await client.ListToolsAsync();
        foreach (var tool in tools)
        {
            var text = tool.Name + " " + (tool.Description ?? string.Empty) + " " + tool.JsonSchema.GetRawText();
            // Narrow on purpose: an unrelated tool may honestly say it "grants no edit
            // access". What must be absent is a route to this device's consent.
            foreach (var forbidden in new[]
                     {
                         "behaviour.approve", "behaviour.revoke", "behaviourGrant",
                         "BehaviourAuthority", "approveBehaviour", "revocationGeneration",
                     })
            {
                Assert.DoesNotContain(forbidden, text, StringComparison.OrdinalIgnoreCase,
                    $"{tool.Name} names a consent route that must stay host-owned.");
            }
        }
    }

    /// <summary>
    /// A save that fired a trigger used to return only the caller's own record. The
    /// review found the other record changed by reading it back; now the result says
    /// so, with the version it left the record at.
    /// </summary>
    [TestMethod]
    public async Task AWriteThatFiresAnActionSaysWhatTheActionChanged()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await SeedSchemaAsync(workspace);
        await InstallTriggerAsync(workspace);
        workspace.ApproveBehaviour(new ApprovingAuthority());

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["applicationHandle"] = grant.ApplicationHandle,
            ["leaseId"] = grant.LeaseId,
        };

        var arguments = new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t-agent",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                ["project"] = "p1",
                ["title"] = "Added by an agent",
            }),
            ["expectedTargetVersions"] = JsonSerializer.SerializeToElement(new Dictionary<string, long> { ["project"] = 1 }),
            ["idempotencyKey"] = "agent-write-approved",
        };
        var created = await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_record", arguments);
        Assert.AreEqual(1L, created.RecordVersion);
        var changed = created.AlsoChanged.Single();
        Assert.AreEqual(("projects", "p1", "updated", 2L), (changed.EntityId, changed.RecordId, changed.Change, changed.RecordVersion));

        // The replay of the same write, and its receipt read back through the
        // unprivileged locator, name the record the action changed. Both used to say
        // nothing, so a caller recovering a lost response had to read every record to
        // learn the side effect. The version is withheld on both, as the caller's own
        // is: the file may have moved since, and a number here would be read as current.
        var replayed = await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_record", arguments);
        Assert.IsTrue(replayed.IsIdempotentReplay);
        Assert.IsNull(replayed.RecordVersion);
        var replayedChange = replayed.AlsoChanged.Single();
        Assert.AreEqual(("projects", "p1", "updated", (long?)null),
            (replayedChange.EntityId, replayedChange.RecordId, replayedChange.Change, replayedChange.RecordVersion));

        var receipt = await CallAsync<NendoDataOutcome>(client, "nendo.data.get_receipt", new()
        {
            ["receiptContext"] = grant.ReceiptContext,
            ["idempotencyKey"] = "agent-write-approved",
        });
        Assert.AreEqual("committed", receipt.State);
        Assert.IsNotNull(receipt.Receipt);
        Assert.AreEqual(created.RevisionId, receipt.Receipt.RevisionId);
        var recovered = receipt.Receipt.GeneratedChanges.Single();
        Assert.AreEqual(("projects", "p1", "updated", (long?)null),
            (recovered.EntityId, recovered.RecordId, recovered.Change, recovered.RecordVersion));
    }

    /// <summary>
    /// A write whose trigger stamps the caller's own record leaves it past the version
    /// the adapter computes arithmetically. The reported version must be the one the
    /// record actually holds, not a stale number one behind it.
    /// </summary>
    [TestMethod]
    public async Task ASelfWritingActionReportsTheVersionTheRecordActuallyHolds()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "test",
            new([new("test", "schema", "test", "Notes", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
                new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "First" }, new("test", "n1", "test")));
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var trigger = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Stamp", "test",
            new([new("test", "behaviour", "test", "Stamp", [
                new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                    "note.stamp", "Stamp the label",
                    [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                        new NendoActionAssignment("stamp", "Concat('Seen ', label)",
                            [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)], []))]), revision),
                new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                    "10-stamp", "notes", "Stamp the label",
                    NendoTriggerEvents.Updated, "note.stamp", ["label"]), revision),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(trigger.ProposalId)).Applied);
        workspace.ApproveBehaviour(new ApprovingAuthority());

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var result = await CallAsync<NendoDataApplyResult>(client, "nendo.data.set_field", new(session)
        {
            ["entityId"] = "notes",
            ["recordId"] = "n1",
            ["fieldId"] = "label",
            ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Renamed"),
            ["idempotencyKey"] = "self-write",
        });

        // The caller's own write took n1 to 2 and the action's stamp took it to 3, so the
        // arithmetic guess of 2 is stale. The reported version must equal the record's own.
        var committedVersion = (await workspace.Service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "n1").RecordVersion;
        Assert.AreEqual(3L, committedVersion);
        Assert.AreEqual(committedVersion, result.RecordVersion,
            "set_field reported a record version the record does not hold.");
    }

    [TestMethod]
    public async Task ABatchInWhichAnActionMovedOnlySomeRecordsDoesNotReportOneVersionForAll()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "test",
            new([new("test", "schema", "test", "Notes", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
                new AddFieldOperation("n-stamp", "notes", "stamp", "Stamp", "stamp", NendoStorageKind.Text, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // Stamps a created note only when its label says so, so one batch holds a
        // record the action moved and records it left alone.
        var trigger = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Stamp", "test",
            new([new("test", "behaviour", "test", "Stamp", [
                new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                    "note.stamp", "Stamp the label",
                    [NendoActionStep.SetField("10-stamp", NendoActionTarget.EventRecord,
                        new NendoActionAssignment("stamp", "Concat('Seen ', label)",
                            [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)], []))]), revision),
                new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                    "10-stamp", "notes", "Stamp the first note",
                    NendoTriggerEvents.Created, "note.stamp", null, "label = 'First'",
                    [NendoBehaviourBinding.SameRecordField("label", "notes", "label", NendoBehaviourScalar.Text, false)]), revision),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(trigger.ProposalId)).Applied);
        workspace.ApproveBehaviour(new ApprovingAuthority());

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var result = await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_records", new(session)
        {
            ["entityId"] = "notes",
            ["records"] = new[]
            {
                new NendoRecordInput("n1", JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["label"] = "First" })),
                new NendoRecordInput("n2", JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["label"] = "Second" })),
            },
            ["idempotencyKey"] = "batch",
        });

        // n1 was stamped to version 2 and n2 stayed at 1, so no single version is true of
        // both. Reporting the highest named n2 at a version it does not hold, and the
        // caller's next write to n2 pinned to it was refused as stale. The response says
        // nothing it cannot say, and alsoChanged carries the record that moved.
        var versions = (await workspace.Service.GetSnapshotAsync()).Records
            .ToDictionary(record => record.RecordId, record => record.RecordVersion, StringComparer.Ordinal);
        Assert.AreEqual(2L, versions["n1"]);
        Assert.AreEqual(1L, versions["n2"]);
        Assert.IsNull(result.RecordVersion,
            $"create_records reported one version, {result.RecordVersion}, for records at 2 and 1.");
        var moved = result.AlsoChanged.Single(change => change.RecordId == "n1");
        Assert.AreEqual(2L, moved.RecordVersion);
    }

    /// <summary>
    /// A calculated field has no column, so a write naming one was refused as a field
    /// that did not exist — while the schema read listed it under derivedFields, and
    /// the records read carried its result. The refusal says it is calculated, names
    /// the calculation, and reaches a create as well as a single-field edit.
    /// </summary>
    [TestMethod]
    public async Task WritingACalculatedFieldIsRefusedAsCalculatedNotMissing()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await SeedSchemaAsync(workspace);
        await InstallCalculationAsync(workspace);

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var edited = await RefusalAsync(client, "nendo.data.set_field", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t1",
            ["fieldId"] = "label",
            ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Typed over"),
            ["idempotencyKey"] = "calculated-set",
        });
        StringAssert.Contains(edited, "NENDO_FIELD_CALCULATED");
        StringAssert.Contains(edited, "task.label");
        StringAssert.Contains(edited, "read-only");
        Assert.DoesNotContain("does not exist", edited, StringComparison.Ordinal);

        var created = await RefusalAsync(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t-calc",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                ["project"] = "p1",
                ["title"] = "Typed",
                ["label"] = "Typed over",
            }),
            ["expectedTargetVersions"] = JsonSerializer.SerializeToElement(new Dictionary<string, long> { ["project"] = 1 }),
            ["idempotencyKey"] = "calculated-create",
        });
        StringAssert.Contains(created, "NENDO_FIELD_CALCULATED");
        StringAssert.Contains(created, "task.label");
        Assert.IsFalse((await workspace.Service.GetSnapshotAsync()).Records.Any(record => record.RecordId == "t-calc"));

        // A field that is neither stored nor calculated is still one that does not exist.
        var unknown = await RefusalAsync(client, "nendo.data.set_field", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t1",
            ["fieldId"] = "nowhere",
            ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Typed"),
            ["idempotencyKey"] = "calculated-unknown",
        });
        StringAssert.Contains(unknown, "NENDO_FIELD_NOT_FOUND");
    }

    /// <summary>
    /// The mistake the published example warns about — an assignment bound to the
    /// event record while writing to the referenced one — installs cleanly and fails
    /// on the first save that fires it. That failure used to reach an agent as an
    /// internal error; it is a refusal that names the action.
    /// </summary>
    [TestMethod]
    public async Task AnActionThatCannotRunRefusesTheSaveAndNamesItself()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await SeedSchemaAsync(workspace);
        await InstallTriggerAsync(workspace, readsTheEventRecord: true);
        workspace.ApproveBehaviour(new ApprovingAuthority());

        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var refused = await RefusalAsync(client, "nendo.data.create_record", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t-broken",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["project"] = "p1", ["title"] = "Fires it" }),
            ["expectedTargetVersions"] = JsonSerializer.SerializeToElement(new Dictionary<string, long> { ["project"] = 1 }),
            ["idempotencyKey"] = "agent-write-broken",
        });
        StringAssert.Contains(refused, "NENDO_CALCULATION_RELATED_UNAVAILABLE");
        StringAssert.Contains(refused, "Name the project after its task");
        StringAssert.Contains(refused, "step 10-name");
        StringAssert.Contains(refused, "nothing changed");
        Assert.IsFalse((await workspace.Service.GetSnapshotAsync()).Records.Any(record => record.RecordId == "t-broken"),
            "A save whose action could not run must not commit the record either.");
    }

    private sealed class ApprovingAuthority : INendoBehaviourAuthority, IApprovesWhatTheFileAsks
    {
        private readonly HashSet<NendoBehaviourGrant> _granted = [];
        public long RevocationGeneration => 0;
        public bool IsGranted(NendoBehaviourGrant required) => _granted.Contains(required);
        public void Approve(NendoBehaviourGrant required) => _granted.Add(required);
    }

    [TestMethod]
    public async Task RemovingADefinitionSomethingElseReadsIsRefused()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await SeedSchemaAsync(workspace);
        await InstallTriggerAsync(workspace);

        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var scoped = await BeginAsync(client, session, "Remove the action");
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Remove the action",
                [
                    new NendoAgentOperationInput("behaviour.removeDefinition",
                        JsonSerializer.SerializeToElement(new { definitionId = "project.close", definitionKind = "Action" })),
                ]),
            },
            ["idempotencyKey"] = "remove-add",
        });

        // Refused as a reviewable diagnostic rather than a transport error: the
        // author gets the proposal back, naming what still uses the definition and
        // what to do about it in the same review.
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate",
            new(scoped) { ["idempotencyKey"] = "remove-validate" });
        Assert.AreEqual(NendoProposalState.Invalid, validated.State);
        var diagnostic = validated.Diagnostics.Single(item => item.Severity == NendoDiagnosticSeverity.Error);
        StringAssert.Contains(diagnostic.Message, "project.close");
        StringAssert.Contains(diagnostic.Message, "10-name");
    }

    private static NendoAgentOperationInput Set(string definitionId, string kind, object body) =>
        new("behaviour.setDefinition", JsonSerializer.SerializeToElement(new
        {
            definitionId,
            definitionKind = kind,
            body,
        }));

    private static async Task SeedSchemaAsync(LocalMcpTestWorkspace workspace)
    {
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Projects and tasks", "test",
            new([new("test", "behaviour-schema", "test", "Projects and tasks", [
                new CreateEntityOperation("projects", "projects", "Projects", "projects"),
                new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
                new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
                new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
                new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
                new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        await workspace.Service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["name"] = "Project" }, new("test", "p1", "test")));
        foreach (var id in new[] { "t1", "t2", "t3" })
        {
            await workspace.Service.CreateRecordAsync(new("tasks", id,
                new Dictionary<string, object?> { ["project"] = "p1", ["title"] = id },
                new("test", id, "test"), new Dictionary<string, long> { ["project"] = 1 }));
        }
    }

    /// <summary>One calculated field on tasks, read from the task's own title.</summary>
    private static async Task InstallCalculationAsync(LocalMcpTestWorkspace workspace)
    {
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposal = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "One calculated field", "test",
            new([new("test", "behaviour-calculation", "test", "One calculated field", [
                new SetBehaviourDefinitionOperation("c", new NendoCalculationDefinition(
                    "task.label", "tasks", "label", "Label", NendoBehaviourScalar.Text, false, "Concat(title, ' (task)')",
                    [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)]), revision),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(proposal.ProposalId)).Applied);
    }

    /// <summary>
    /// One action and its trigger. The action's assignment reads the record it writes
    /// to — the project — which is the rule the published example states. With
    /// <paramref name="readsTheEventRecord"/> it binds the task instead, the mistake
    /// that installs cleanly and fails on the first save that fires it.
    /// </summary>
    private static async Task InstallTriggerAsync(LocalMcpTestWorkspace workspace, bool readsTheEventRecord = false)
    {
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var binding = readsTheEventRecord
            ? NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)
            : NendoBehaviourBinding.SameRecordField("title", "projects", "name", NendoBehaviourScalar.Text, false);
        var proposal = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "One automatic action", "test",
            new([new("test", "behaviour-trigger", "test", "One automatic action", [
                new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                    "project.close", "Name the project after its task",
                    [NendoActionStep.SetField("10-name", NendoActionTarget.Referenced("project"),
                        new NendoActionAssignment("name", "Concat('Project: ', title)", [binding], []))]), revision),
                new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                    "10-name", "tasks", "Name the project when a task is added",
                    NendoTriggerEvents.Created, "project.close"), revision),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(proposal.ProposalId)).Applied);
    }

    private static async Task<Dictionary<string, object?>> AcquireAsync(ModelContextProtocol.Client.McpClient client)
    {
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        return new(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
    }

    private static async Task<Dictionary<string, object?>> BeginAsync(
        ModelContextProtocol.Client.McpClient client,
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

    private static async Task<string> RefusalAsync(
        ModelContextProtocol.Client.McpClient client,
        string name,
        Dictionary<string, object?> arguments)
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.IsTrue(result.IsError, $"{name} was expected to be refused.");
        return string.Join(' ', result.Content.OfType<ModelContextProtocol.Protocol.TextContentBlock>().Select(block => block.Text));
    }

    private static async Task<T> CallAsync<T>(
        ModelContextProtocol.Client.McpClient client,
        string name,
        Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
