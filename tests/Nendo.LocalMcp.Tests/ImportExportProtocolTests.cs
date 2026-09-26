using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// Bulk data in and out over MCP: a paged faithful-CSV export resource, and one import
/// tool that takes CSV text or typed JSON (ADR-0009, 2026-09-22 amendment).
/// <para>
/// The round trip is the point. An export a person could not hand back is a report, not
/// an export, so what the resource emits is fed to the tool and every stored value is
/// compared afterwards.
/// </para>
/// </summary>
[TestClass]
public sealed class ImportExportProtocolTests
{
    [TestMethod]
    public async Task ExportedCsvImportsBackWithEveryValueIntact()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var first = ProtocolResourceTests.Deserialize<NendoMcpCsvPage>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/entity/notes/export?limit=2"));
        Assert.AreEqual("notes", first.EntityId);
        Assert.AreEqual(2, first.RecordCount);
        Assert.IsNotNull(first.NextCursor);
        CollectionAssert.AreEqual(new[] { "label", "note", "count" }, first.FieldIds.ToArray());
        // The header row belongs to the document, not to every page, or the pages do not
        // concatenate into one file.
        StringAssert.StartsWith(first.Csv, "\"Label\",\"Note\",\"Count\"\r\n", StringComparison.Ordinal);

        var second = ProtocolResourceTests.Deserialize<NendoMcpCsvPage>(
            await ProtocolResourceTests.ReadTextAsync(
                client, $"nendo://application/entity/notes/export?cursor={Uri.EscapeDataString(first.NextCursor!)}&limit=2"));
        Assert.IsNull(second.NextCursor);
        Assert.IsFalse(second.Csv.Contains("\"Label\"", StringComparison.Ordinal),
            "Only the first page carries the header.");

        var document = first.Csv + second.Csv;
        var session = await AcquireAsync(client);
        var imported = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", new(session)
        {
            ["entityId"] = "notes",
            ["format"] = "csv",
            ["csv"] = document,
            ["csvProfile"] = "nendo",
            ["columnMappings"] = Mappings(first.FieldIds),
            ["idempotencyKey"] = "round-trip",
        });
        Assert.AreEqual(3, imported.Committed);
        Assert.AreEqual(0, imported.Remaining);
        Assert.AreEqual(1, imported.RevisionCount);
        Assert.AreEqual(500, imported.MaximumRowsPerCall);

        // Every stored value survived, compared as a multiset: import creates records, so
        // the copies carry new IDs and nothing else about them may differ.
        var all = (await workspace.Service.QueryRecordsAsync(new("notes", 50))).Items;
        Assert.HasCount(6, all);
        var originals = all.Where(record => !imported.RecordIds.Contains(record.RecordId)).Select(Describe).Order(StringComparer.Ordinal).ToArray();
        var copies = all.Where(record => imported.RecordIds.Contains(record.RecordId)).Select(Describe).Order(StringComparer.Ordinal).ToArray();
        CollectionAssert.AreEqual(originals, copies, "A value changed on the way out and back.");
    }

    [TestMethod]
    public async Task AnExactRetryOfAnImportWritesTheSameRecordsRatherThanASecondCopy()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var arguments = new Dictionary<string, object?>(session)
        {
            ["entityId"] = "notes",
            ["format"] = "csv",
            ["csv"] = "Label,Note,Count\r\nRetried,Once,7\r\n",
            ["columnMappings"] = Mappings(["label", "note", "count"]),
            ["idempotencyKey"] = "retry-me",
        };
        var first = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", new(arguments));
        var second = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", new(arguments));
        CollectionAssert.AreEqual(first.RecordIds.ToArray(), second.RecordIds.ToArray());
        Assert.HasCount(4, (await workspace.Service.QueryRecordsAsync(new("notes", 50))).Items);
    }

    [TestMethod]
    public async Task JsonImportTakesTheSameShapeAsACreateAndCommitsInBatches()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        // Past one batch on purpose: fifty-one records is two revisions, and the answer
        // must say so rather than implying the call was atomic.
        var records = Enumerable.Range(1, 51)
            .Select(index => new NendoRecordInput($"json-{index:D3}", JsonSerializer.SerializeToElement(
                new Dictionary<string, object?>
                {
                    ["label"] = $"Row {index:D3}",
                    ["note"] = "From JSON",
                    ["count"] = new Dictionary<string, string> { ["$nendoNumber"] = index.ToString() },
                })))
            .ToArray();
        var imported = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", new(session)
        {
            ["entityId"] = "notes",
            ["format"] = "json",
            ["records"] = records,
            ["idempotencyKey"] = "json-bulk",
        });
        Assert.AreEqual(51, imported.Committed);
        Assert.AreEqual(2, imported.RevisionCount);
        Assert.HasCount(54, (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items);
    }

    [TestMethod]
    public async Task ARefusedLaterBatchReportsWhatCommittedAndAnExactRetryDoesNotDuplicateIt()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var records = Enumerable.Range(1, 51).Select(index => new NendoRecordInput(
            $"partial-{index:D3}", JsonSerializer.SerializeToElement(
                new Dictionary<string, object?> { ["label"] = index == 51 ? null : $"Row {index}" }))).ToArray();
        var arguments = new Dictionary<string, object?>(session)
        {
            ["entityId"] = "notes", ["format"] = "json", ["records"] = records,
            ["idempotencyKey"] = "partial-import",
        };

        foreach (var attempt in Enumerable.Range(1, 2))
        {
            var response = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(arguments));
            Assert.IsTrue(response.IsError);
            var text = JsonSerializer.Serialize(response);
            StringAssert.Contains(text, "NENDO_IMPORT_PARTIAL", StringComparison.Ordinal);
            StringAssert.Contains(text, "committed=50", StringComparison.Ordinal);
            StringAssert.Contains(text, "remaining=1", StringComparison.Ordinal);
            StringAssert.Contains(text, "firstUncommittedRow=51", StringComparison.Ordinal);
            StringAssert.Contains(text, "revision-", StringComparison.Ordinal);
            Assert.HasCount(53, (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items,
                $"Exact attempt {attempt} duplicated an earlier batch.");
        }
        var before = await workspace.Service.GetSnapshotAsync();
        var optional = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Allow optional label", "test",
            new([new("test", "optional-label", "test", "Allow optional label", [
                new SetFieldRequiredOperation("optional-label", "notes", "label", false,
                    before.Manifest.DefinitionRevision),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(optional.ProposalId)).Applied);
        var resumed = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(arguments));
        Assert.AreNotEqual(true, resumed.IsError, JsonSerializer.Serialize(resumed));
        StringAssert.Contains(JsonSerializer.Serialize(resumed.StructuredContent), "\"committed\":51", StringComparison.Ordinal);
        Assert.HasCount(54, (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items);
    }

    /// <summary>
    /// R-006: CSV decoding reads each reference target's current version into the payload.
    /// Once the target is edited, an exact retry used to be refused as a different payload,
    /// because the committed batch had been written with the old version.
    /// </summary>
    [TestMethod]
    public async Task AnExactCsvRetryReplaysAfterAReferencedTargetIsEdited()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        Dictionary<string, object?> Arguments(string csv) => new(session)
        {
            ["entityId"] = "tasks", ["format"] = "csv", ["csv"] = csv,
            ["columnMappings"] = Mappings(["project", "title"]), ["idempotencyKey"] = "reference-retry",
        };
        const string Csv = "Project,Title\r\np1,First\r\np1,Second\r\n";

        var first = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", Arguments(Csv));
        await EditProjectAsync(workspace);

        var retried = await client.CallToolAsync("nendo.data.import_records", Arguments(Csv));
        Assert.AreNotEqual(true, retried.IsError, "An exact retry was refused after its reference target was edited: " + JsonSerializer.Serialize(retried));
        var replay = retried.StructuredContent!.Value.Deserialize<NendoImportResult>(NendoMcpJson.Options)!;
        CollectionAssert.AreEqual(first.RecordIds.ToArray(), replay.RecordIds.ToArray());
        Assert.HasCount(2, (await workspace.Service.QueryRecordsAsync(new("tasks", 50))).Items, "The retry wrote a second copy.");

        // Replaying with the committed evidence does not loosen what the key stands for: the
        // same key with a different payload is still a conflict and writes nothing.
        var changed = await client.CallToolAsync("nendo.data.import_records", Arguments("Project,Title\r\np1,First\r\np1,Changed\r\n"));
        Assert.IsTrue(changed.IsError, "A different payload under a used key was accepted.");
        StringAssert.Contains(JsonSerializer.Serialize(changed), "NENDO_IDEMPOTENCY_CONFLICT", StringComparison.Ordinal);
        Assert.HasCount(2, (await workspace.Service.QueryRecordsAsync(new("tasks", 50))).Items);
    }

    /// <summary>
    /// R-006, partial resume: the committed first batch replays with the version it was
    /// written at, and the batch that never committed is resolved and validated against the
    /// file as it is now.
    /// </summary>
    [TestMethod]
    public async Task APartialCsvImportResumesAfterAReferencedTargetIsEdited()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareProjectsAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        const string Key = "reference-partial";
        string Csv(string lastProject) => "Project,Title\r\n" +
            string.Concat(Enumerable.Range(1, 51).Select(index => $"{(index == 51 ? lastProject : "p1")},Row {index}\r\n"));
        Dictionary<string, object?> Arguments(string lastProject) => new(session)
        {
            ["entityId"] = "tasks", ["format"] = "csv", ["csv"] = Csv(lastProject),
            ["columnMappings"] = Mappings(["project", "title"]), ["idempotencyKey"] = Key,
        };

        // An import interrupted after its first batch landed: exactly the revision the first
        // call writes -- same scope, key, origin, record IDs and values, with the project at
        // version 1 -- and then the response was lost. Written directly, because no refusal
        // the decoder does not already catch can stop a CSV import between its batches.
        var seed = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Key)))[..16].ToLowerInvariant();
        await workspace.Service.CreateRecordsAsync(new NendoCreateRecordsRequest("tasks",
            Enumerable.Range(0, 50).Select(index => new NendoCreateRecordEntry($"import.{seed}.{index}",
                new Dictionary<string, object?> { ["project"] = "p1", ["title"] = $"Row {index + 1}" },
                new Dictionary<string, long> { ["project"] = 1 })).ToArray(),
            new("agent.import", Key + "#0", "agent")));
        await EditProjectAsync(workspace);

        // The row that never committed is still resolved against the file as it is now: a
        // target that does not exist refuses the call before anything is written.
        var missing = await client.CallToolAsync("nendo.data.import_records", Arguments("p404"));
        Assert.IsTrue(missing.IsError, "An uncommitted row naming a missing target was accepted.");
        StringAssert.Contains(JsonSerializer.Serialize(missing), "Reference target does not exist", StringComparison.Ordinal);
        Assert.HasCount(50, (await workspace.Service.QueryRecordsAsync(new("tasks", 100))).Items);

        var resumed = await client.CallToolAsync("nendo.data.import_records", Arguments("p1"));
        Assert.AreNotEqual(true, resumed.IsError, "The resume was refused after the referenced target was edited: " + JsonSerializer.Serialize(resumed));
        var result = resumed.StructuredContent!.Value.Deserialize<NendoImportResult>(NendoMcpJson.Options)!;
        Assert.AreEqual(51, result.Committed);
        Assert.AreEqual(2, result.RevisionCount);
        var tasks = (await workspace.Service.QueryRecordsAsync(new("tasks", 100))).Items;
        // The new row committed, so it was checked against the project's current version:
        // the Engine refuses a create whose target version is not the one the file holds.
        Assert.HasCount(51, tasks, "The resume duplicated or lost a row.");
        Assert.IsTrue(tasks.Any(task => task.RecordId == $"import.{seed}.50"));
    }

    /// <summary>
    /// R-007: the public key may be two hundred characters, and each batch's internal key
    /// must still fit the Engine's bound. Two batches, an exact replay and a changed payload
    /// at each of the lengths around the edge.
    /// </summary>
    [TestMethod]
    [DataRow(198)]
    [DataRow(199)]
    [DataRow(200)]
    public async Task AnImportKeyOfAnyAdmittedLengthImportsReplaysAndRefusesAChangedPayload(int length)
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var key = new string('k', length);
        Dictionary<string, object?> Arguments(string note) => new(session)
        {
            ["entityId"] = "notes", ["format"] = "json", ["idempotencyKey"] = key,
            ["records"] = Enumerable.Range(1, 51).Select(index => new NendoRecordInput($"long-key-{index:D3}",
                JsonSerializer.SerializeToElement(new Dictionary<string, object?> { ["label"] = $"Row {index}", ["note"] = note }))).ToArray(),
        };

        var imported = await client.CallToolAsync("nendo.data.import_records", Arguments("First"));
        Assert.AreNotEqual(true, imported.IsError, $"A {length}-character key was admitted and then could not import: " + JsonSerializer.Serialize(imported));
        var first = imported.StructuredContent!.Value.Deserialize<NendoImportResult>(NendoMcpJson.Options)!;
        Assert.AreEqual(51, first.Committed);
        Assert.AreEqual(2, first.RevisionCount);

        var replay = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", Arguments("First"));
        CollectionAssert.AreEqual(first.RecordIds.ToArray(), replay.RecordIds.ToArray());
        Assert.HasCount(54, (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items, "The replay wrote a second copy.");

        var changed = await client.CallToolAsync("nendo.data.import_records", Arguments("Changed"));
        Assert.IsTrue(changed.IsError, "A changed payload under a used key was accepted.");
        StringAssert.Contains(JsonSerializer.Serialize(changed), "NENDO_IDEMPOTENCY_CONFLICT", StringComparison.Ordinal);
        Assert.HasCount(54, (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items);
    }

    [TestMethod]
    public void BatchKeysStayWithinTheEngineBoundAndKeepTheirOldFormWhereItFits()
    {
        // A key that leaves room keeps the form its receipts were written under.
        Assert.AreEqual("short#0", NendoImportService.BatchKey("short", 0));
        var roomy = new string('a', 198);
        Assert.AreEqual(roomy + "#9", NendoImportService.BatchKey(roomy, 9));

        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var length in new[] { 199, 200 })
        {
            foreach (var fill in new[] { 'a', 'b' })
            {
                var key = new string(fill, length);
                for (var ordinal = 0; ordinal < 10; ordinal++)
                {
                    var batch = NendoImportService.BatchKey(key, ordinal);
                    Assert.IsLessThanOrEqualTo(200, batch.Length, batch);
                    Assert.AreEqual(batch, NendoImportService.BatchKey(key, ordinal), "A batch key is not stable.");
                    Assert.IsTrue(seen.Add(batch), $"Two batches share the key {batch}.");
                }
            }
        }
    }

    [TestMethod]
    public async Task InvalidCsvMappingsAreTypedRefusalsBeforeAnyWrite()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var cases = new (string Name, NendoCsvColumnMapping[] Mappings)[]
        {
            ("unknown", [new(0, "missing.field")]),
            ("duplicate", [new(0, "label"), new(1, "label")]),
            ("column", [new(2, "label")]),
        };
        foreach (var (name, mappings) in cases)
        {
            var response = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
            {
                ["entityId"] = "notes", ["format"] = "csv", ["csv"] = "Label,Note\r\nValue,Text\r\n",
                ["columnMappings"] = mappings, ["idempotencyKey"] = $"bad-mapping-{name}",
            });
            Assert.IsTrue(response.IsError, name);
            StringAssert.Contains(JsonSerializer.Serialize(response), "NENDO_INVALID_REQUEST", StringComparison.Ordinal);
            Assert.HasCount(3, (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items, name);
        }
    }

    [TestMethod]
    public async Task MixedFormatPayloadsAreRefusedBeforeAnyWrite()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var records = new[] { new NendoRecordInput("json-intended", JsonSerializer.SerializeToElement(
            new Dictionary<string, object?> { ["label"] = "JSON intended" })) };
        foreach (var format in new[] { "csv", "json" })
        {
            var response = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
            {
                ["entityId"] = "notes", ["format"] = format, ["csv"] = "Label\r\nCSV intended\r\n",
                ["columnMappings"] = Mappings(["label"]), ["records"] = records,
                ["idempotencyKey"] = $"mixed-{format}",
            });
            Assert.IsTrue(response.IsError, format);
            StringAssert.Contains(JsonSerializer.Serialize(response), "NENDO_INVALID_REQUEST", StringComparison.Ordinal);
            Assert.HasCount(3, (await workspace.Service.QueryRecordsAsync(new("notes", 100))).Items, format);
        }
    }

    [TestMethod]
    public async Task TheBoundsAreStatedRatherThanMet()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.DataMutation,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var rows = string.Concat(Enumerable.Range(1, 501).Select(index => $"Row {index},note,1\r\n"));
        var refused = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "notes",
            ["format"] = "csv",
            ["csv"] = "Label,Note,Count\r\n" + rows,
            ["columnMappings"] = Mappings(["label", "note", "count"]),
            ["idempotencyKey"] = "too-many",
        });
        Assert.IsTrue(refused.IsError);
        var text = JsonSerializer.Serialize(refused);
        // The refusal carries both numbers: a caller cannot write the loop from "too many".
        StringAssert.Contains(text, "500", StringComparison.Ordinal);
        StringAssert.Contains(text, "501", StringComparison.Ordinal);
        Assert.HasCount(3, (await workspace.Service.QueryRecordsAsync(new("notes", 50))).Items);

        // A format nobody implements is named, not guessed at.
        var wrongFormat = await client.CallToolAsync("nendo.data.import_records", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "notes",
            ["format"] = "xlsx",
            ["idempotencyKey"] = "wrong-format",
        });
        Assert.IsTrue(wrongFormat.IsError);
        StringAssert.Contains(JsonSerializer.Serialize(wrongFormat), "csv", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task InspectSeesTheExportAndStillHasNoTools()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        // Reading is a resource in this product, which is what keeps the level that can
        // only read genuinely unable to change anything.
        Assert.IsEmpty(await client.ListToolsAsync());
        var page = ProtocolResourceTests.Deserialize<NendoMcpCsvPage>(
            await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/entity/notes/export"));
        Assert.AreEqual(3, page.RecordCount);
    }

    /// <summary>Three records covering the values a CSV profile is easy to lose.</summary>
    private static async Task PrepareAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Notes", "test",
            new([new("test", "schema", "test", "Notes", [
                new CreateEntityOperation("notes", "notes", "Notes", "notes"),
                new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true),
                new AddFieldOperation("n-note", "notes", "note", "Note", "note", NendoStorageKind.Text, false),
                new AddFieldOperation("n-count", "notes", "count", "Count", "count", NendoStorageKind.Integer, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);

        // A null, an empty string, a quote, a newline, a leading backslash, formula-like
        // text and an integer past what a double holds. Each one is a way the profile has
        // to be wrong for this to pass by accident.
        await CreateAsync(workspace, "n1", "Plain", null, 1);
        await CreateAsync(workspace, "n2", "Quoted \"and\" newline\nhere", "", 9007199254740993L);
        await CreateAsync(workspace, "n3", "\\N is text, =SUM(A1) is text", "Unicode 猫 — dash", -42L);
    }

    /// <summary>Projects and tasks, each task referencing a project; one project, no tasks.</summary>
    private static async Task PrepareProjectsAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Projects and tasks", "test",
            new([new("test", "schema", "test", "Projects and tasks", [
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
    }

    /// <summary>An ordinary edit of the referenced project, which moves it to version 2.</summary>
    private static async Task EditProjectAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.Service.SetFieldAsync(new NendoSetFieldRequest("projects", "p1", "name", 1, "Renamed project",
            new("test", "p1-rename", "test")));
        Assert.AreEqual(2, (await workspace.Service.QueryRecordsAsync(new("projects", 1) { RecordId = "p1" })).Items.Single().RecordVersion);
    }

    private static Task CreateAsync(LocalMcpTestWorkspace workspace, string recordId, string label, string? note, long count) =>
        workspace.Service.CreateRecordAsync(new("notes", recordId,
            new Dictionary<string, object?>
            {
                ["label"] = label,
                ["note"] = note,
                ["count"] = count,
            },
            new("test", recordId, "test")));

    private static NendoCsvColumnMapping[] Mappings(IReadOnlyList<string> fieldIds) =>
        fieldIds.Select((fieldId, column) => new NendoCsvColumnMapping(column, fieldId)).ToArray();

    private static string Describe(NendoRecordSnapshot record) =>
        string.Join('', record.Values.OrderBy(value => value.Key, StringComparer.Ordinal)
            .Select(value => $"{value.Key}={value.Value.GetRawText()}"));

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client)
    {
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        return new(StringComparer.Ordinal)
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
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
}
