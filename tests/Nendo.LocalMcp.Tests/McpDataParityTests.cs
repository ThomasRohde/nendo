using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ModelContextProtocol;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;
using Nendo.Engine.Tests;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-214: the MCP data tools answer as the Workbench does. Imports commit every batch against
/// the file as it stands and retry by their receipts, references by a unique field follow the
/// CSV rule, and refusals, reads and limits say what the person's own paths say.
/// </summary>
[TestClass]
public sealed partial class McpDataParityTests
{
    /// <summary>MTD-01: a batch is resolved just before it commits, after the batches before it moved its target.</summary>
    [TestMethod]
    [DataRow("csv")]
    [DataRow("json")]
    public async Task AnImportWhoseActionMovesItsTargetCommitsEveryBatchInOneCall(string format)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        // Every task created appends to its project's name, so each batch moves the project.
        var touch = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Touch the project", "test",
            new([new("test", "behaviour", "test", "Touch the project", [
                new SetBehaviourDefinitionOperation("a", new NendoActionDefinition("project.touch", "Touch the project",
                    [NendoActionStep.SetField("10-touch", NendoActionTarget.Referenced("project"), new NendoActionAssignment("name", "Concat(name, '+')",
                        [NendoBehaviourBinding.SameRecordField("name", "projects", "name", NendoBehaviourScalar.Text, false)], []))]), revision),
                new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition("10-touch", "tasks", "Touch the project when a task is added",
                    NendoTriggerEvents.Created, "project.touch"), revision),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(touch.ProposalId)).Applied);
        workspace.ApproveBehaviour(new ApprovingAuthority());
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var arguments = new Dictionary<string, object?>(session) { ["entityId"] = "tasks", ["format"] = format, ["idempotencyKey"] = "moving-target" };
        if (format == "csv")
        {
            arguments["csv"] = "Project,Title\r\n" + string.Concat(Enumerable.Range(1, 120).Select(index => $"p1,Task {index}\r\n"));
            arguments["columnMappings"] = new[] { new NendoCsvColumnMapping(0, "project"), new NendoCsvColumnMapping(1, "title") };
        }
        else
        {
            arguments["records"] = Enumerable.Range(1, 120).Select(index => new NendoRecordInput($"task-{index:D3}",
                JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["title"] = $"Task {index}" }))
            {
                References = new Dictionary<string, NendoReferenceInput> { ["project"] = new() { RecordId = "p1" } },
            }).ToArray();
        }

        var result = await client.CallToolAsync("nendo.data.import_records", arguments);
        Assert.AreNotEqual(true, result.IsError, "An import whose action moved its target stopped after a batch: " + Text(result));
        var imported = result.StructuredContent!.Value.Deserialize<NendoImportResult>(NendoMcpJson.Options)!;
        Assert.AreEqual((120, 0, 3), (imported.Committed, imported.Remaining, imported.RevisionCount));
        Assert.AreEqual(120L, (await workspace.Service.CountRecordsAsync(new NendoRecordCountQuery("tasks"))).Count);
    }

    /// <summary>MTD-02: a JSON import resumed after its target was edited replays the batch that committed.</summary>
    [TestMethod]
    public async Task AJsonImportNamingATargetResumesAfterTheTargetIsEdited()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        Dictionary<string, object?> Arguments(bool lastHasTitle) => new(session)
        {
            ["entityId"] = "tasks", ["format"] = "json", ["idempotencyKey"] = "json-resume",
            ["records"] = Enumerable.Range(1, 51).Select(index => new NendoRecordInput($"json-{index:D3}",
                JsonSerializer.SerializeToElement(index == 51 && !lastHasTitle
                    ? new Dictionary<string, object?>()
                    : new Dictionary<string, object?> { ["title"] = $"Row {index}" }))
            {
                References = new Dictionary<string, NendoReferenceInput> { ["project"] = new() { RecordId = "p1" } },
            }).ToArray(),
        };

        // The second batch is refused by the Engine (its record has no title), after the first committed.
        var partial = await client.CallToolAsync("nendo.data.import_records", Arguments(lastHasTitle: false));
        Assert.IsTrue(partial.IsError);
        StringAssert.Contains(Text(partial), "NENDO_IMPORT_PARTIAL: committed=50;", StringComparison.Ordinal);
        await EditProjectAsync(workspace);

        var resumed = await client.CallToolAsync("nendo.data.import_records", Arguments(lastHasTitle: true));
        Assert.AreNotEqual(true, resumed.IsError, "The resume was refused after its reference target was edited: " + Text(resumed));
        var result = resumed.StructuredContent!.Value.Deserialize<NendoImportResult>(NendoMcpJson.Options)!;
        Assert.AreEqual((51, 2, 1), (result.Committed, result.RevisionCount, result.ReplayedRevisions));
        Assert.IsFalse(result.IsIdempotentReplay, "A call that wrote a batch said nothing was written.");
        Assert.HasCount(51, (await workspace.Service.QueryRecordsAsync(new("tasks", 100))).Items, "The resume duplicated or lost a record.");
    }

    /// <summary>MTD-03: a unique whole-number field is matched by its value, and a code without regard to case.</summary>
    [TestMethod]
    public async Task AReferenceByAUniqueFieldFollowsTheCsvRule()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace, withCodes: true);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var byNumber = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks", ["recordId"] = "t-number", ["idempotencyKey"] = "by-number",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["title"] = "By number" }),
            ["references"] = new Dictionary<string, NendoReferenceInput> { ["project"] = new() { MatchFieldId = "number", Value = "42" } },
        });
        Assert.AreNotEqual(true, byNumber.IsError, "A whole-number code was refused: " + Text(byNumber));
        Assert.AreEqual("p1", (await TaskAsync(workspace, "t-number")).Values["project"].GetString());

        var byCase = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks", ["recordId"] = "t-case", ["idempotencyKey"] = "by-case",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["title"] = "By case" }),
            ["references"] = new Dictionary<string, NendoReferenceInput> { ["project"] = new() { MatchFieldId = "code", Value = "prj-1" } },
        });
        Assert.AreNotEqual(true, byCase.IsError, "A code in another case was not found: " + Text(byCase));
        Assert.AreEqual("p1", (await TaskAsync(workspace, "t-case")).Values["project"].GetString());

        // In a batch, a project an earlier write creates is found by its code in another case too.
        var batch = await client.CallToolAsync("nendo.data.apply_writes", new Dictionary<string, object?>(session)
        {
            ["idempotencyKey"] = "batch-case",
            ["writes"] = new object[]
            {
                new { kind = "create", entityId = "projects", recordId = "p2", values = new { name = "Second", code = "PRJ-2", number = 43 } },
                new
                {
                    kind = "create", entityId = "tasks", recordId = "t-batch", values = new { title = "In the batch" },
                    references = new Dictionary<string, object> { ["project"] = new { matchFieldId = "code", value = "prj-2" } },
                },
            },
        });
        Assert.AreNotEqual(true, batch.IsError, "A code in another case was not found in the batch: " + Text(batch));
        Assert.AreEqual("p2", (await TaskAsync(workspace, "t-batch")).Values["project"].GetString());

        var notANumber = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks", ["recordId"] = "t-nan", ["idempotencyKey"] = "not-a-number",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["title"] = "Not a number" }),
            ["references"] = new Dictionary<string, NendoReferenceInput> { ["project"] = new() { MatchFieldId = "number", Value = "forty-two" } },
        });
        StringAssert.EndsWith(Text(notANumber), "NENDO_INVALID_REQUEST: Number of Projects holds whole numbers, and forty-two is not one.", StringComparison.Ordinal);
    }

    /// <summary>MTD-03: a JSON import of a tree names its own earlier rows by code, within a batch and across batches.</summary>
    [TestMethod]
    public async Task AJsonImportNamesItsOwnEarlierRowsByCode()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareTreeAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var records = new List<NendoRecordInput> { new("root", JsonSerializer.SerializeToElement(new { code = "C-1", name = "Root" })) };
        records.AddRange(Enumerable.Range(1, 54).Select(index => new NendoRecordInput($"child-{index:D2}",
            JsonSerializer.SerializeToElement(new { code = $"C-1.{index}", name = $"Child {index}" }))
        {
            References = new Dictionary<string, NendoReferenceInput> { ["parent"] = new() { MatchFieldId = "code", Value = "c-1" } },
        }));

        var result = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "caps", ["format"] = "json", ["records"] = records, ["idempotencyKey"] = "json-tree",
        });
        Assert.AreNotEqual(true, result.IsError, "A JSON import could not name its own earlier row: " + Text(result));
        var all = (await workspace.Service.QueryRecordsAsync(new("caps", 100))).Items;
        Assert.HasCount(55, all);
        Assert.IsTrue(all.Where(record => record.RecordId != "root").All(record => record.Values["parent"].GetString() == "root"),
            "A child of the import was not put under its parent.");
    }

    /// <summary>MTD-04: the export and import descriptions say a later page has no header row.</summary>
    [TestMethod]
    public async Task TheExportAndImportDescriptionsSayALaterPageHasNoHeader()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var export = (await client.ListResourceTemplatesAsync()).Single(template => template.Name == "nendo.application.entity.export").Description!;
        Assert.DoesNotContain("unchanged", export, StringComparison.Ordinal, "The export still says every page imports unchanged.");
        StringAssert.Contains(export, "a later page has no header row", StringComparison.Ordinal);
        var import = string.Join(' ', (await client.ListToolsAsync()).Single(tool => tool.Name == "nendo.data.import_records").Description!
            .Split((char[])[' ', (char)10, (char)13], StringSplitOptions.RemoveEmptyEntries));
        StringAssert.Contains(import, "only its first page has the header row", StringComparison.Ordinal);
    }

    /// <summary>MTD-05: a read's refusal carries the Engine's sentence, as the tool path does.</summary>
    [TestMethod]
    public async Task AReadRefusalCarriesTheSentenceTheToolsShow()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var refused = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client,
            $"nendo://application/entity/tasks/records?filter={Uri.EscapeDataString("[{\"fieldId\":\"project\",\"op\":\"descendantOf\",\"value\":\"p1\"}]")}"));
        StringAssert.Contains(refused.Message,
            "NENDO_HIERARCHY_NOT_DECLARED: descendantOf reads Tasks's declared hierarchy, and Project is not its parent field.", StringComparison.Ordinal);
    }

    /// <summary>MTD-06: an aggregate over or grouped by a calculated field is refused by name.</summary>
    [TestMethod]
    public async Task AnAggregateOverACalculatedFieldIsRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await workspace.Coordinator.ApplyAsync(new("test", "calculation", "test", "Title length", [
            new SetBehaviourDefinitionOperation("length", new NendoCalculationDefinition("tasks.titleLength", "tasks", "titleLength",
                "Title length", NendoBehaviourScalar.Integer, true, "TextLength(title)",
                [NendoBehaviourBinding.SameRecordField("title", "tasks", "title", NendoBehaviourScalar.Text, false)]), revision),
        ]));
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        foreach (var query in new[] { "aggregate=sum&fieldId=titleLength", "groupBy=titleLength" })
        {
            var refused = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client,
                $"nendo://application/entity/tasks/aggregate?{query}"));
            StringAssert.Contains(refused.Message, "NENDO_FIELD_CALCULATED: The ", StringComparison.Ordinal, query);
            StringAssert.Contains(refused.Message, "field titleLength (Title length) is calculated, and an aggregate folds and groups the stored fields of Tasks only.",
                StringComparison.Ordinal, query);
        }
    }

    /// <summary>MTD-07: a CSV import into a record type an unaccepted proposal creates names the proposal.</summary>
    [TestMethod]
    public async Task ACsvImportIntoATypeAProposalCreatesNamesTheProposal()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session)
        {
            ["title"] = "Create the CRM record types", ["idempotencyKey"] = "begin-crm",
        });
        var scoped = new Dictionary<string, object?>(session) { ["changeSetId"] = begun.ChangeSetId };
        await CallAsync<NendoChangeSetAddResult>(client, "nendo.change_set.add_operations", new(scoped)
        {
            ["mutations"] = new[] { new NendoAgentMutationInput("Create the CRM record types", CrmAuthoringFixture.SchemaOperations()) },
            ["idempotencyKey"] = "add-crm",
        });
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = "validate-crm" });

        var refused = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = CrmAuthoringFixture.AccountEntityId, ["format"] = "csv", ["csv"] = "Name\r\nEarly\r\n",
            ["columnMappings"] = new[] { new NendoCsvColumnMapping(0, CrmAuthoringFixture.AccountNameFieldId) },
            ["idempotencyKey"] = "csv-too-early",
        });
        Assert.IsTrue(refused.IsError);
        StringAssert.Contains(Text(refused), "NENDO_ENTITY_NOT_FOUND", StringComparison.Ordinal);
        StringAssert.Contains(Text(refused), validated.ProposalId, StringComparison.Ordinal, "The refusal did not name the proposal that creates the record type.");
    }

    /// <summary>MTD-08: a record ID twice in a JSON import is refused before any batch is written.</summary>
    [TestMethod]
    public async Task ARecordIdRepeatedAcrossBatchesIsRefusedBeforeAnyWrite()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var records = Enumerable.Range(1, 60).Select(index => new NendoRecordInput(index == 55 ? "dup-010" : $"dup-{index:D3}",
            JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["name"] = $"Project {index}" }))).ToArray();
        var refused = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "projects", ["format"] = "json", ["records"] = records, ["idempotencyKey"] = "duplicates",
        });
        Assert.IsTrue(refused.IsError);
        StringAssert.EndsWith(Text(refused),
            "NENDO_INVALID_REQUEST: records[9] and records[54] carry the same record ID dup-010; each record needs its own.", StringComparison.Ordinal);
        Assert.HasCount(1, (await workspace.Service.QueryRecordsAsync(new("projects", 100))).Items, "A batch was written before the duplicate was refused.");
    }

    /// <summary>MTD-10 and MTD-11: an import keyed with surrounding spaces is found by get_receipt, and a replay says so.</summary>
    [TestMethod]
    public async Task APaddedImportKeyIsFoundByItsReceiptAndAReplaySaysItIsOne()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var grant = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        var session = new Dictionary<string, object?>(StringComparer.Ordinal) { ["applicationHandle"] = grant.ApplicationHandle, ["leaseId"] = grant.LeaseId };
        Dictionary<string, object?> Arguments() => new(session)
        {
            ["entityId"] = "projects", ["format"] = "json", ["idempotencyKey"] = " projects-2026 ",
            ["records"] = new[] { new NendoRecordInput("padded", JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["name"] = "Padded" })) },
        };
        var first = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", Arguments());
        Assert.AreEqual((false, 0), (first.IsIdempotentReplay, first.ReplayedRevisions), "A first import said it was a replay.");

        var receipt = await CallAsync<NendoDataOutcome>(client, "nendo.data.get_receipt", new()
        {
            ["receiptContext"] = grant.ReceiptContext, ["idempotencyKey"] = " projects-2026 ",
        });
        Assert.AreEqual("committed", receipt.State, "The receipt of an import sent with a padded key was not found: " + receipt.Message);

        var again = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", Arguments());
        Assert.AreEqual((true, 1, 1), (again.IsIdempotentReplay, again.ReplayedRevisions, again.Committed),
            "An import that wrote nothing now did not say it was a replay.");
    }

    /// <summary>R2AP-03 and MTD-12: an agent writes back a value the person stores, by every write and both import formats.</summary>
    [TestMethod]
    public async Task AnAgentWritesBackAValueThePersonStoresByEveryPath()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        var note = string.Concat(Enumerable.Repeat("A long note line. ", 2_300)); // 41,400 bytes, past the old 32 KiB.
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var updated = await client.CallToolAsync("nendo.data.update_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "projects", ["recordId"] = "p1", ["expectedRecordVersion"] = 1L, ["idempotencyKey"] = "long-update",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["name"] = note }),
        });
        Assert.AreNotEqual(true, updated.IsError, "A value the person stores could not be written back: " + Text(updated));
        var json = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "projects", ["format"] = "json", ["idempotencyKey"] = "long-json",
            ["records"] = new[] { new NendoRecordInput("long-json", JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["name"] = note })) },
        });
        var csv = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "projects", ["format"] = "csv", ["idempotencyKey"] = "long-csv", ["csv"] = $"Name\r\n{note}\r\n",
            ["columnMappings"] = new[] { new NendoCsvColumnMapping(0, "name") },
        });
        Assert.AreEqual((false, false), (json.IsError == true, csv.IsError == true),
            $"The same value imported differently by format: json {Text(json)}; csv {Text(csv)}");
        var limits = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary")).RootElement.GetProperty("limits");
        Assert.AreEqual(limits.GetProperty("requestBodyBytes").GetInt32(), limits.GetProperty("recordValueBytes").GetInt32());
        Assert.AreEqual(limits.GetProperty("requestBodyBytes").GetInt32(), limits.GetProperty("recordValuesBytes").GetInt32());
    }

    /// <summary>MTD-12: a CSV row past one write's value bound is refused before any batch, naming its row.</summary>
    [TestMethod]
    public async Task ACsvRowPastTheValueBoundIsRefusedNamingItsRow()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace, withNote: true);
        var imports = new NendoImportService(workspace.Service);
        // Two cells of 60,000 three-byte characters: each under the CSV cell bound, together past 256 KiB.
        var wide = new string('猫', 60_000);
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => imports.ImportCsvAsync("projects",
            $"Name,Note\r\nShort,Short\r\n{wide},{wide}\r\n", [new NendoCsvColumnMapping(0, "name"), new NendoCsvColumnMapping(1, "note")],
            nendoProfile: false, emptyIsNull: false, "too-wide", "agent-test", CancellationToken.None));
        Assert.AreEqual("values-too-large", refused.Code);
        StringAssert.Contains(refused.Message, "The values of this write in CSV row 3 hold more than 262144 bytes together", StringComparison.Ordinal);
        Assert.HasCount(1, (await workspace.Service.QueryRecordsAsync(new("projects", 10))).Items, "A row was written before the wide one was refused.");
    }

    /// <summary>MTD-13 and MTD-14: an empty recordId or filter, a clause key no clause has and a bucket without its date field are refused.</summary>
    [TestMethod]
    public async Task ReadArgumentsThatWouldBeIgnoredAreRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        foreach (var (uri, sentence) in new[]
        {
            ("nendo://application/entity/projects/records?recordId=", "recordId names one record and is empty here"),
            ("nendo://application/entity/projects/records?filter=", "filter is a JSON array of {fieldId, op, value} and is empty here"),
            ($"nendo://application/entity/projects/records?filter={Uri.EscapeDataString("[{\"fieldId\":\"name\",\"op\":\"eq\",\"value\":\"Project\",\"negate\":true}]")}",
                "A filter clause has fieldId, op and value only; 'negate' is not one of them."),
            ("nendo://application/entity/projects/aggregate?bucket=month&range=thisYear",
                "bucket and range work with dateFieldId, the date field they divide"),
        })
        {
            var refused = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client, uri), uri);
            StringAssert.Contains(refused.Message, "NENDO_INVALID_REQUEST: " + sentence, StringComparison.Ordinal, uri);
        }
    }

    /// <summary>MTD-15: every limits.* a description names is a limit the vocabulary publishes.</summary>
    [TestMethod]
    public async Task EveryLimitADescriptionNamesIsPublished()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.Unattended,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var limits = JsonDocument.Parse(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/vocabulary")).RootElement.GetProperty("limits");
        var tools = await client.ListToolsAsync();
        var texts = tools.Select(tool => (tool.Name, Text: tool.Description ?? ""))
            .Concat(tools.Select(tool => (tool.Name, Text: tool.JsonSchema.GetRawText())))
            .Concat((await client.ListResourceTemplatesAsync()).Select(template => (template.Name, Text: template.Description ?? "")))
            .Concat((await client.ListResourcesAsync()).Select(resource => (resource.Name, Text: resource.Description ?? "")));
        var dangling = new List<string>();
        foreach (var (name, text) in texts)
            foreach (Match match in LimitPath().Matches(text))
            {
                var node = limits;
                if (match.Groups[1].Value.Split('.').Any(segment => !node.TryGetProperty(segment, out node)))
                    dangling.Add($"{name}: limits.{match.Groups[1].Value}");
            }
        Assert.IsEmpty(dangling, "A description names a limit the vocabulary does not publish:\n" + string.Join('\n', dangling.Distinct()));
        Assert.AreEqual(NendoQueryLimits.MaximumCalculatedQueryRecords, limits.GetProperty("calculatedQueryRecords").GetInt32());
    }

    [GeneratedRegex(@"limits\.([a-zA-Z]+(?:\.[a-zA-Z]+)*)")]
    private static partial Regex LimitPath();

    /// <summary>MTD-17: text past ASCII reads back as itself, not as escapes.</summary>
    [TestMethod]
    public async Task TextPastAsciiReadsBackAsItself()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await workspace.Service.CreateRecordAsync(new("projects", "p-dk", new Dictionary<string, object?> { ["name"] = "Smørrebrød & <på> Nørrebro 計画" },
            new("test", "p-dk", "test")));
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var text = await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/entity/projects/records?recordId=p-dk");
        StringAssert.Contains(text, "\"Smørrebrød & <på> Nørrebro 計画\"", StringComparison.Ordinal, "Text past ASCII was escaped: " + text);
        Assert.DoesNotContain("\\u", text, StringComparison.Ordinal);
    }

    /// <summary>MTD-18: a stream that stops reading holds a bounded queue, and is ended rather than grown.</summary>
    [TestMethod]
    public void AStalledListenStreamHoldsABoundedQueueAndIsEnded()
    {
        var feed = new NendoChangeFeed();
        using var listener = feed.TryOpen()!;
        for (var commit = 0; commit < 10_000; commit++) feed.Signal("nendo://application/proposals");
        var held = new List<NendoChangeFeed.Change>();
        while (listener.Reader.TryRead(out var change)) held.Add(change);
        Assert.IsLessThanOrEqualTo(NendoChangeFeed.MaximumQueuedChanges + 1, held.Count, $"A stream that stopped reading held {held.Count} changes.");
        Assert.IsTrue(listener.Reader.Completion.IsCompleted, "A stream past its queue was not ended.");
        Assert.IsTrue(held[^1].Overflowed, "A stream past its queue ended without saying so, so its client would never learn it missed changes.");

        // The overflow names every resource the stream subscribed to, so the client reads each again.
        string[] honoured = ["nendo://application/manifest", NendoChangeFeed.RecordsUri("tasks")];
        CollectionAssert.AreEqual(honoured, NendoChangeFeed.Notifications(held[^1], honoured).Select(item => item.Uri).ToArray(),
            "An overflow did not tell the client that what it subscribed to changed.");
        Assert.IsEmpty(NendoChangeFeed.Notifications(held[0], honoured), "A proposals change was sent to a stream that did not ask for it.");
    }

    /// <summary>
    /// MTD-03 (review): the unique index folds only A to Z, so "Ærø" and "ærø" can both be held. A
    /// code in its exact case finds its own record, by a tool and by a CSV import; one that matches
    /// both only when case is set aside is refused as ambiguous.
    /// </summary>
    [TestMethod]
    public async Task ACodeWithTwinsPastAsciiFindsItsExactCaseAndIsRefusedWhenAmbiguous()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace, withCodes: true);
        foreach (var (id, code, number) in new[] { ("upper", "Ærø", 1L), ("lower", "ærø", 2L) })
            await workspace.Service.CreateRecordAsync(new("projects", id, new Dictionary<string, object?> { ["name"] = code, ["code"] = code, ["number"] = number },
                new("test", id, "test")));
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        ValueTask<CallToolResult> Create(string recordId, string code) => client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks", ["recordId"] = recordId, ["idempotencyKey"] = recordId,
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["title"] = recordId }),
            ["references"] = new Dictionary<string, NendoReferenceInput> { ["project"] = new() { MatchFieldId = "code", Value = code } },
        });

        var exact = await Create("t-lower", "ærø");
        Assert.AreNotEqual(true, exact.IsError, "A code in its exact case was refused because its twin exists: " + Text(exact));
        Assert.AreEqual("lower", (await TaskAsync(workspace, "t-lower")).Values["project"].GetString());
        StringAssert.EndsWith(Text(await Create("t-neither", "ÆRØ")),
            "NENDO_TARGET_NOT_FOUND: More than one Projects record holds ÆRØ in code when case is set aside, and none holds it in exactly that case. " +
            "Name the target in its exact case, or by record ID.", StringComparison.Ordinal);

        var imported = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks", ["format"] = "csv", ["csv"] = "Project,Title\r\nÆrø,By CSV\r\n", ["idempotencyKey"] = "csv-twins",
            ["columnMappings"] = new[] { new NendoCsvColumnMapping(0, "project") { MatchFieldId = "code" }, new NendoCsvColumnMapping(1, "title") },
        });
        Assert.AreNotEqual(true, imported.IsError, Text(imported));
        var byCsv = (await workspace.Service.QueryRecordsAsync(new("tasks", 10) { RecordId = imported.StructuredContent!.Value
            .Deserialize<NendoImportResult>(NendoMcpJson.Options)!.RecordIds.Single() })).Items.Single();
        Assert.AreEqual("upper", byCsv.Values["project"].GetString(), "The CSV import took the first of two twins rather than the one in its exact case.");
    }

    /// <summary>R2AP-03 (review): a change set's record operation carries a value the person stores.</summary>
    [TestMethod]
    public async Task AChangeSetCarriesAValueThePersonStores()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var begun = await CallAsync<NendoChangeSetBeginResult>(client, "nendo.change_set.begin", new(session) { ["title"] = "Long notes", ["idempotencyKey"] = "begin-long" });
        var note = new string('x', 40_000);
        var added = await client.CallToolAsync("nendo.change_set.add_operations", new Dictionary<string, object?>(session)
        {
            ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "add-long",
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Long notes",
                [
                    new NendoAgentOperationInput("data.createRecord", JsonSerializer.SerializeToElement(new
                    {
                        entityId = "projects", recordId = "long", values = new Dictionary<string, object?> { ["name"] = note },
                    })),
                    new NendoAgentOperationInput("data.setField", JsonSerializer.SerializeToElement(new
                    {
                        entityId = "projects", recordId = "p1", fieldId = "name", expectedRecordVersion = 1, value = note,
                    })),
                ]),
            },
        });
        Assert.AreNotEqual(true, added.IsError, "A change set refused a value the person stores: " + Text(added));
        var validated = await CallAsync<NendoAgentProposalPreview>(client, "nendo.change_set.validate", new(session)
        {
            ["changeSetId"] = begun.ChangeSetId, ["idempotencyKey"] = "validate-long",
        });
        Assert.AreEqual(NendoProposalState.Previewable, validated.State);
    }

    /// <summary>MTD-07 (review): a mapped field the record type calculates is refused by its own sentence.</summary>
    [TestMethod]
    public async Task ACsvColumnMappedToACalculatedFieldIsRefusedByName()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await workspace.Coordinator.ApplyAsync(new("test", "calculation", "test", "Name length", [
            new SetBehaviourDefinitionOperation("length", new NendoCalculationDefinition("projects.nameLength", "projects", "nameLength",
                "Name length", NendoBehaviourScalar.Integer, true, "TextLength(name)",
                [NendoBehaviourBinding.SameRecordField("name", "projects", "name", NendoBehaviourScalar.Text, false)]), revision),
        ]));
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => new NendoImportService(workspace.Service).ImportCsvAsync("projects",
            "Name,Length\r\nA,1\r\n", [new NendoCsvColumnMapping(0, "name"), new NendoCsvColumnMapping(1, "nameLength")],
            nendoProfile: false, emptyIsNull: false, "calculated", "agent-test", CancellationToken.None));
        Assert.AreEqual("field-calculated", refused.Code);
        Assert.AreEqual("CSV column 1 maps nameLength (Name length), which Projects calculates; an import writes stored fields only.", refused.Message);
    }

    /// <summary>MTD-20: a value map that repeats a field names the field.</summary>
    [TestMethod]
    public async Task AValueMapThatRepeatsAFieldNamesTheField()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var refused = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "projects", ["recordId"] = "twice", ["idempotencyKey"] = "twice",
            ["values"] = JsonDocument.Parse("{\"name\":\"A\",\"name\":\"B\"}").RootElement,
        });
        Assert.IsTrue(refused.IsError);
        StringAssert.EndsWith(Text(refused), "NENDO_INVALID_REQUEST: values names field name twice; send each field once.", StringComparison.Ordinal);
    }

    /// <summary>MTD-21: skills/get with a uri that is not text is the caller's error, not the host's.</summary>
    [TestMethod]
    public void ASkillUriThatIsNotTextIsAnInvalidRequest()
    {
        foreach (var parameters in new[] { "{\"uri\":5}", "{\"uri\":{\"a\":1}}", "{\"uri\":true}" })
        {
            var refused = Assert.ThrowsExactly<McpProtocolException>(() => NendoHostSkill.GetResult(JsonNode.Parse(parameters), []), parameters);
            Assert.AreEqual(McpErrorCode.InvalidParams, refused.ErrorCode, parameters);
            StringAssert.StartsWith(refused.Message, "NENDO_INVALID_REQUEST: skills/get takes uri as text", StringComparison.Ordinal);
        }
    }

    /// <summary>
    /// R2AP-02: every precondition a data write or read can meet is on the audited list or withheld
    /// with a reason, and a write refusal reaches the agent in the words the person reads.
    /// </summary>
    [TestMethod]
    public async Task EveryDataPathRefusalIsAuditedAndTheWriteRefusalsReachTheAgentWhole()
    {
        var root = TestRepository.Root();
        var unaudited = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var file in DataPathFiles)
        {
            var text = await File.ReadAllTextAsync(Path.Combine(root, file));
            foreach (Match match in PreconditionCode().Matches(text))
                if (!NendoToolErrors.IsDiagnosable(match.Groups[1].Value) && !NendoToolErrors.WithheldPreconditions.ContainsKey(match.Groups[1].Value))
                    unaudited.Add($"{match.Groups[1].Value} ({file})");
        }
        Assert.IsEmpty(unaudited, "A data path refuses with a code that is neither audited nor withheld with a reason:\n" + string.Join('\n', unaudited));

        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await workspace.Service.CreateRecordAsync(new("projects", "gone", new Dictionary<string, object?> { ["name"] = "Gone" }, new("test", "gone", "test")));
        await workspace.Service.DeleteRecordAsync(new("projects", "gone", 1, new("test", "gone-delete", "test")));
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        foreach (var (recordId, expected) in new[]
        {
            ("gone", "NENDO_RECORD_ID_RESERVED: This record ID is retained in deletion history and cannot be reused."),
            ("p1", "NENDO_RECORD_EXISTS_OR_INVALID: Record p1 already exists or violates the entity constraints."),
        })
        {
            var refused = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
            {
                ["entityId"] = "projects", ["recordId"] = recordId, ["idempotencyKey"] = "recreate-" + recordId,
                ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["name"] = "Again" }),
            });
            StringAssert.EndsWith(Text(refused), expected, StringComparison.Ordinal);
        }
    }

    private static readonly string[] DataPathFiles =
    [
        "src/Nendo.Engine/Storage/SqliteNendoStore.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.Operations.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.References.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.Retirement.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.Deletion.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.NewFile.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.Inspection.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.FieldRules.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.Compensation.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.Hierarchy.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.HierarchyReads.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.ReadQueries.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.CalculatedQueries.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.Search.cs",
        "src/Nendo.Engine/Storage/SqliteNendoStore.LinkRules.cs",
        "src/Nendo.Engine/Search.cs",
        "src/Nendo.Engine/ExactAggregate.cs",
        "src/Nendo.Engine/NendoQueryCursor.cs",
        "src/Nendo.Engine/NendoApplicationService.cs",
        "src/Nendo.Engine/NendoApplicationService.Batch.cs",
        "src/Nendo.Engine/NendoApplicationService.Hierarchy.cs",
        "src/Nendo.Engine/NendoWriteCoordinator.cs",
        "src/Nendo.Engine/NendoWriteCoordinator.ReadQueries.cs",
        "src/Nendo.Engine/NendoWriteCoordinator.Hierarchy.cs",
        "src/Nendo.LocalMcp/NendoDataMutationService.cs",
        "src/Nendo.LocalMcp/NendoImportService.cs",
        "src/Nendo.LocalMcp/NendoReceiptContext.cs",
        "src/Nendo.LocalMcp/NendoResourceProjection.cs",
    ];

    [GeneratedRegex("NendoPreconditionException\\(\\s*\"([a-z0-9-]+)\"")]
    private static partial Regex PreconditionCode();

    /// <summary>Projects and tasks, each task referencing a project, with project p1; codes and a note when asked.</summary>
    private static async Task PrepareProjectsAsync(LocalMcpTestWorkspace workspace, bool withCodes = false, bool withNote = false)
    {
        await workspace.CreateEmptyAsync();
        List<NendoOperation> operations =
        [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ];
        if (withCodes)
        {
            operations.Add(new AddFieldOperation("p-code", "projects", "code", "Code", "code", NendoStorageKind.Text, false, "singleLine"));
            operations.Add(new AddFieldOperation("p-number", "projects", "number", "Number", "number", NendoStorageKind.Integer, false));
        }
        if (withNote) operations.Add(new AddFieldOperation("p-note", "projects", "note", "Note", "note", NendoStorageKind.Text, false));
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Projects and tasks", "test", new([new("test", "schema", "test", "Projects and tasks", [.. operations])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        if (withCodes)
        {
            var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
            var unique = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
                $"proposal-{Guid.NewGuid():N}", "Unique codes", "test", new([new("test", "unique", "test", "Unique codes", [
                    new SetFieldUniqueOperation("u-code", "projects", "code", true, revision),
                    new SetFieldUniqueOperation("u-number", "projects", "number", true, revision),
                ])])));
            Assert.IsTrue((await workspace.Service.PromoteProposalAsync(unique.ProposalId)).Applied);
        }
        var values = new Dictionary<string, object?> { ["name"] = "Project" };
        if (withCodes)
        {
            values["code"] = "PRJ-1";
            values["number"] = 42L;
        }
        await workspace.Service.CreateRecordAsync(new("projects", "p1", values, new("test", "p1", "test")));
    }

    /// <summary>A record type whose unique code its own parent reference may name.</summary>
    private static async Task PrepareTreeAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var created = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Capabilities", "test",
            new([new("test", "caps", "test", "Capabilities", [
                new CreateEntityOperation("e", "caps", "Capabilities", "caps"),
                new AddFieldOperation("f-code", "caps", "code", "Code", "code", NendoStorageKind.Text, true),
                new AddFieldOperation("f-name", "caps", "name", "Name", "name", NendoStorageKind.Text, true),
                new AddFieldOperation("f-parent", "caps", "parent", "Parent", "parent_id", NendoStorageKind.Reference, false),
                new ConfigureReferenceOperation("bind", "caps", "parent", "caps", "name", 0),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(created.ProposalId)).Applied);
        var revision = (await workspace.Service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var unique = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Unique code", "test",
            new([new("test", "unique", "test", "Unique code", [new SetFieldUniqueOperation("unique", "caps", "code", true, revision)])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(unique.ProposalId)).Applied);
    }

    private static async Task EditProjectAsync(LocalMcpTestWorkspace workspace) =>
        await workspace.Service.SetFieldAsync(new NendoSetFieldRequest("projects", "p1", "name", 1, "Renamed project", new("test", "p1-rename", "test")));

    private static async Task<NendoRecordSnapshot> TaskAsync(LocalMcpTestWorkspace workspace, string recordId) =>
        (await workspace.Service.QueryRecordsAsync(new("tasks", 1) { RecordId = recordId })).Items.Single();

    private static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client)
    {
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        return new(StringComparer.Ordinal) { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {Text(result)}");
        return result.StructuredContent!.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }

    private sealed class ApprovingAuthority : INendoBehaviourAuthority, IApprovesWhatTheFileAsks
    {
        private readonly HashSet<NendoBehaviourGrant> _granted = [];
        public long RevocationGeneration => 0;
        public bool IsGranted(NendoBehaviourGrant required) => _granted.Contains(required);
        public void Approve(NendoBehaviourGrant required) => _granted.Add(required);
    }
}
