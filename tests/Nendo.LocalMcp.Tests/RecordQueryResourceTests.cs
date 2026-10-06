using ModelContextProtocol;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-145 and W-146: the records read takes recordId, sort, desc and filter; the aggregate
/// read answers a count, a sum and a grouped count in one call; describe counts records.
/// </summary>
[TestClass]
public sealed class RecordQueryResourceTests
{
    private const string Records = $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/records";
    private const string Aggregate = $"nendo://application/entity/{NendoApplicationService.IdeaEntityId}/aggregate";

    [TestMethod]
    public async Task OneRecordIsReadByIdAndAFilteredSortedPageReturnsOnlyWhatMatches()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var one = await ReadAsync(client, $"{Records}?recordId=idea-002");
        Assert.AreEqual("idea-002", one.Items.Single().RecordId);
        Assert.IsNull(one.NextCursor);

        var trying = await ReadAsync(client, $"{Records}?filter={Filter($"[{{\"fieldId\":\"{NendoApplicationService.IdeaStatusFieldId}\",\"op\":\"eq\",\"value\":\"Trying\"}}]")}");
        CollectionAssert.AreEqual(new[] { "idea-003" }, trying.Items.Select(record => record.RecordId).ToArray());

        var ideas = await ReadAsync(client, $"{Records}?sort={NendoApplicationService.IdeaTitleFieldId}&desc=true&filter={Filter($"[{{\"fieldId\":\"{NendoApplicationService.IdeaStatusFieldId}\",\"op\":\"eq\",\"value\":\"Idea\"}}]")}");
        CollectionAssert.AreEqual(new[] { "idea-002", "idea-001" }, ideas.Items.Select(record => record.RecordId).ToArray());

        // The two vocabulary spellings the Engine does not use are mapped, not refused.
        var early = await ReadAsync(client, $"{Records}?filter={Filter($"[{{\"fieldId\":\"{NendoApplicationService.IdeaCreatedDateFieldId}\",\"op\":\"lte\",\"value\":\"2026-09-02\"}}]")}");
        Assert.HasCount(2, early.Items);

        // A filtered page keeps the revision-bound cursor: the second page continues the same query.
        var first = await ReadAsync(client, $"{Records}?limit=1&filter={Filter($"[{{\"fieldId\":\"{NendoApplicationService.IdeaStatusFieldId}\",\"op\":\"eq\",\"value\":\"Idea\"}}]")}");
        Assert.IsNotNull(first.NextCursor);
        var second = await ReadAsync(client, $"{Records}?cursor={Uri.EscapeDataString(first.NextCursor)}&limit=1&filter={Filter($"[{{\"fieldId\":\"{NendoApplicationService.IdeaStatusFieldId}\",\"op\":\"eq\",\"value\":\"Idea\"}}]")}");
        Assert.AreEqual("idea-002", second.Items.Single().RecordId);
    }

    [TestMethod]
    public async Task AnUnknownOperatorOrFieldIsRefusedNamingTheOnesAccepted()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var operation = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(
            client, $"{Records}?filter={Filter($"[{{\"fieldId\":\"{NendoApplicationService.IdeaStatusFieldId}\",\"op\":\"like\",\"value\":\"Idea\"}}]")}"));
        StringAssert.Contains(operation.Message, "NENDO_INVALID_REQUEST", StringComparison.Ordinal);
        StringAssert.Contains(operation.Message, "'like' is not one of eq, ne, lt, lte, gt, gte, contains, isNull, isNotNull, descendantOf", StringComparison.Ordinal);

        var field = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(
            client, $"{Records}?filter={Filter("[{\"fieldId\":\"field.idea.colour\",\"op\":\"eq\",\"value\":\"red\"}]")}"));
        StringAssert.Contains(field.Message, "The filter field 'field.idea.colour' is not a field of entity.idea; its fields are", StringComparison.Ordinal);
        StringAssert.Contains(field.Message, NendoApplicationService.IdeaStatusFieldId, StringComparison.Ordinal);

        var sort = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(
            client, $"{Records}?sort=field.idea.colour"));
        StringAssert.Contains(sort.Message, "The sort field 'field.idea.colour' is not a field of entity.idea", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task ACountASumAndAGroupedCountEachComeBackInOneRead()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var count = Read<NendoMcpAggregate>(await ProtocolResourceTests.ReadTextAsync(client, Aggregate));
        Assert.AreEqual("whole", count.Shape);
        Assert.AreEqual("3", count.Value);
        Assert.AreEqual(3, count.ContributingRecords);

        var filtered = Read<NendoMcpAggregate>(await ProtocolResourceTests.ReadTextAsync(client,
            $"{Aggregate}?aggregate=count&filter={Filter($"[{{\"fieldId\":\"{NendoApplicationService.IdeaStatusFieldId}\",\"op\":\"eq\",\"value\":\"Idea\"}}]")}"));
        Assert.AreEqual("2", filtered.Value);

        var grouped = Read<NendoMcpAggregate>(await ProtocolResourceTests.ReadTextAsync(client,
            $"{Aggregate}?aggregate=count&groupBy={NendoApplicationService.IdeaStatusFieldId}"));
        Assert.AreEqual("grouped", grouped.Shape);
        Assert.IsNotNull(grouped.Groups);
        Assert.AreEqual("2", grouped.Groups.Single(group => group.Key == "Idea").Value);
        Assert.AreEqual("1", grouped.Groups.Single(group => group.Key == "Trying").Value);
        Assert.AreEqual(0, grouped.Unrecognised);

        var avg = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client, $"{Aggregate}?aggregate=avg&fieldId=x"));
        StringAssert.Contains(avg.Message, "avg is refused", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task ASumIsAnExactLexemeAndDescribeCountsEveryRecordType()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Items", "test",
            new([new("test", "schema", "test", "Items", [
                new CreateEntityOperation("items", "items", "Items", "items"),
                new AddFieldOperation("i-label", "items", "label", "Label", "label", NendoStorageKind.Text, true),
                new AddFieldOperation("i-amount", "items", "amount", "Amount", "amount", NendoStorageKind.Decimal, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        foreach (var (id, amount) in new[] { ("a", "0.10"), ("b", "0.20"), ("c", "123456789012345678.90") })
        {
            await workspace.Service.CreateRecordAsync(new("items", id,
                new Dictionary<string, object?> { ["label"] = id, ["amount"] = decimal.Parse(amount, System.Globalization.CultureInfo.InvariantCulture) },
                new("test", $"create-{id}", "test")));
        }
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var sum = Read<NendoMcpAggregate>(await ProtocolResourceTests.ReadTextAsync(client,
            "nendo://application/entity/items/aggregate?aggregate=sum&fieldId=amount"));
        Assert.AreEqual("123456789012345679.20", sum.Value, "The sum must be exact, not a double.");
        Assert.AreEqual(3, sum.ContributingRecords);

        var described = Read<NendoMcpDescription>(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/describe"));
        Assert.AreEqual(3, described.Entities!.Single(entity => entity.EntityId == "items").RecordCount);
        var one = Read<NendoMcpEntitySchema>(await ProtocolResourceTests.ReadTextAsync(client, "nendo://application/entity/items/schema"));
        Assert.AreEqual(3, one.RecordCount);
    }

    /// <summary>
    /// Review R-004: each filter clause, the sort and each aggregate field read the whole
    /// definition again, so a sorted four-clause read took five snapshots before the query.
    /// One request now takes one, with the same rows and the same unknown-field refusal.
    /// </summary>
    [TestMethod]
    public async Task AFilteredSortedReadAndAGridAggregateEachReadTheDefinitionOnce()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync(6);
        var projection = new NendoResourceProjection(workspace.Service, new NendoCursorCodec(new byte[32]));
        var status = NendoApplicationService.IdeaStatusFieldId;
        var filter = "[" +
            $"{{\"fieldId\":\"{status}\",\"op\":\"eq\",\"value\":\"Idea\"}}," +
            $"{{\"fieldId\":\"{NendoApplicationService.IdeaTitleFieldId}\",\"op\":\"isNotNull\"}}," +
            $"{{\"fieldId\":\"{NendoApplicationService.IdeaCreatedDateFieldId}\",\"op\":\"lte\",\"value\":\"2026-09-05\"}}," +
            $"{{\"fieldId\":\"{status}\",\"op\":\"ne\",\"value\":\"Trying\"}}]";

        var page = await projection.GetRecordsAsync(NendoApplicationService.IdeaEntityId, null, 50, null,
            NendoApplicationService.IdeaTitleFieldId, "true", filter, null, CancellationToken.None);
        CollectionAssert.AreEqual(new[] { "idea-005", "idea-004", "idea-002", "idea-001" }, page.Items.Select(record => record.RecordId).ToArray());
        Assert.AreEqual(1, projection.DefinitionReads, "A sorted four-clause records read takes one definition snapshot.");

        var grid = await projection.GetAggregateAsync(NendoApplicationService.IdeaEntityId, "count", null, null,
            status, NendoApplicationService.IdeaEnergyFieldId, null, null, null, filter, CancellationToken.None);
        Assert.AreEqual("cells", grid.Shape);
        Assert.AreEqual(4, grid.Cells!.Sum(cell => cell.ContributingRecords));
        Assert.AreEqual(2, projection.DefinitionReads, "A filtered grid aggregate takes one definition snapshot.");

        var unknown = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => projection.GetRecordsAsync(
            NendoApplicationService.IdeaEntityId, null, 50, null, "field.idea.colour", null, filter, null, CancellationToken.None));
        StringAssert.Contains(unknown.Message, "The sort field 'field.idea.colour' is not a field of entity.idea; its fields are", StringComparison.Ordinal);
        Assert.AreEqual(3, projection.DefinitionReads, "A refused field is named from the same one snapshot.");
    }

    /// <summary>
    /// Review R-009: a records page carried no revision, so comparing it with an aggregate
    /// took a later manifest read, which is not the revision the page saw. Each page now
    /// carries the change sequence the Engine returned with it, even when a commit lands
    /// between the Engine's answer and the page being put together.
    /// </summary>
    [TestMethod]
    public async Task APageReportsTheRevisionItReadNotALaterOne()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateIdeaGardenAsync();
        var projection = new NendoResourceProjection(workspace.Service, new NendoCursorCodec(new byte[32]));
        var count = await projection.GetAggregateAsync(NendoApplicationService.IdeaEntityId, "count", null, null, null, null, null, null, null, null, CancellationToken.None);
        var commits = 0;
        Func<Task> Commit() => () => workspace.Service.CreateRecordAsync(new(NendoApplicationService.IdeaEntityId, $"idea-late-{++commits}",
            new Dictionary<string, object?> { [NendoApplicationService.IdeaTitleFieldId] = "Late", [NendoApplicationService.IdeaStatusFieldId] = "Idea" },
            new("test", $"late-{commits}", "test")));

        projection.AfterRead = Once("records", Commit());
        var records = await projection.GetRecordsAsync(NendoApplicationService.IdeaEntityId, null, 50, CancellationToken.None);
        Assert.AreEqual(count.ChangeSequence, records.ChangeSequence, "The page reports the revision the count also read.");
        Assert.HasCount(3, records.Items);

        projection.AfterRead = Once("history", Commit());
        var history = await projection.GetHistoryAsync(null, 100, "true", CancellationToken.None);
        Assert.AreEqual(history.Items[0].ChangeSequence, history.ChangeSequence, "The history page reports the revision it read.");
        Assert.AreEqual(count.ChangeSequence + 1, history.ChangeSequence);

        projection.AfterRead = null;
        var now = (await projection.GetManifestAsync(CancellationToken.None)).ChangeSequence;
        Assert.AreEqual(count.ChangeSequence + 2, now, "Both commits landed after their pages were read.");
        var again = await projection.GetRecordsAsync(NendoApplicationService.IdeaEntityId, null, 50, CancellationToken.None);
        Assert.AreEqual(now, again.ChangeSequence);
        Assert.HasCount(5, again.Items);

        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var wire = await ProtocolResourceTests.ReadTextAsync(client, $"{Records}?limit=1");
        StringAssert.Contains(wire, $"\"changeSequence\":{now}", StringComparison.Ordinal);
    }

    /// <summary>
    /// Review R-007: a records read always carried every value, so triage over long bodies
    /// paid for the bodies. fields names the ones wanted; IDs, versions, order and exact
    /// numbers are unchanged, and only the wire bytes shrink -- the Engine still reads the
    /// whole record.
    /// </summary>
    [TestMethod]
    public async Task AProjectedReadCarriesOnlyTheNamedFieldsWithTheSameRecords()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Items", "test",
            new([new("test", "schema", "test", "Items", [
                new CreateEntityOperation("items", "items", "Items", "items"),
                new AddFieldOperation("i-label", "items", "label", "Label", "label", NendoStorageKind.Text, true),
                new AddFieldOperation("i-amount", "items", "amount", "Amount", "amount", NendoStorageKind.Decimal, false),
                new AddFieldOperation("i-body", "items", "body", "Body", "body", NendoStorageKind.Text, false),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied);
        var body = string.Concat(Enumerable.Repeat("A long body of acceptance prose. ", 60));
        for (var index = 0; index < 100; index++)
        {
            await workspace.Service.CreateRecordAsync(new("items", $"item-{index:D3}", new Dictionary<string, object?>
            {
                ["label"] = $"Item {index}",
                ["amount"] = decimal.Parse($"123456789012345678.{index % 100:D2}", System.Globalization.CultureInfo.InvariantCulture),
                ["body"] = body,
            }, new("test", $"item-{index}", "test")));
        }
        await using var host = await NendoLocalMcpHost.StartAsync(workspace.Service, AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        const string items = "nendo://application/entity/items/records";

        async Task<(List<NendoMcpRecord> Records, long Bytes)> ReadAllAsync(string query)
        {
            var records = new List<NendoMcpRecord>();
            long bytes = 0;
            string? cursor = null;
            do
            {
                var text = await ProtocolResourceTests.ReadTextAsync(client,
                    $"{items}?limit=50{query}{(cursor is null ? string.Empty : $"&cursor={Uri.EscapeDataString(cursor)}")}");
                bytes += System.Text.Encoding.UTF8.GetByteCount(text);
                var page = Read<NendoMcpPage<NendoMcpRecord>>(text);
                records.AddRange(page.Items);
                cursor = page.NextCursor;
            }
            while (cursor is not null);
            return (records, bytes);
        }

        var whole = await ReadAllAsync(string.Empty);
        var projected = await ReadAllAsync("&fields=label,amount");
        Assert.HasCount(100, projected.Records);
        CollectionAssert.AreEqual(whole.Records.Select(record => (record.EntityId, record.RecordId, record.RecordVersion)).ToArray(),
            projected.Records.Select(record => (record.EntityId, record.RecordId, record.RecordVersion)).ToArray(),
            "The same records, in the same order, at the same versions.");
        Assert.IsTrue(projected.Records.All(record => record.Values.Keys.Order(StringComparer.Ordinal).SequenceEqual(["amount", "label"])),
            "A projected record carries only the named fields.");
        Assert.IsTrue(whole.Records.All(record => record.Values.ContainsKey("body")), "Without fields the record is whole.");
        Assert.AreEqual("123456789012345678.07", projected.Records[7].NumericLexemes["amount"], "Exact lexemes survive the projection.");
        Assert.IsLessThan(whole.Bytes / 10, projected.Bytes, $"Projected {projected.Bytes} bytes against {whole.Bytes} whole.");

        var unknown = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client, $"{items}?fields=label,colour"));
        StringAssert.Contains(unknown.Message, "The projected field 'colour' is not a field of items; its fields are amount, body, label", StringComparison.Ordinal);
        var many = string.Join(",", Enumerable.Repeat("label", NendoResourceProjection.MaximumProjectedFields + 1));
        var tooMany = await Assert.ThrowsExactlyAsync<McpProtocolException>(() => ProtocolResourceTests.ReadTextAsync(client, $"{items}?fields={many}"));
        StringAssert.Contains(tooMany.Message, "fields names at most 64 field IDs", StringComparison.Ordinal);
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

    private static string Filter(string json) => Uri.EscapeDataString(json);

    private static Task<NendoMcpPage<NendoMcpRecord>> ReadAsync(McpClient client, string uri) =>
        ProtocolResourceTests.ReadTextAsync(client, uri).ContinueWith(task => Read<NendoMcpPage<NendoMcpRecord>>(task.Result), TaskScheduler.Default);

    private static T Read<T>(string text) where T : notnull => ProtocolResourceTests.Deserialize<T>(text);
}
