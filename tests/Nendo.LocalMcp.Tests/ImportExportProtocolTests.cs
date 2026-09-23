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
