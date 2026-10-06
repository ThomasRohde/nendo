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
            NendoApplicationService.IdeaTitleFieldId, "true", filter, CancellationToken.None);
        CollectionAssert.AreEqual(new[] { "idea-005", "idea-004", "idea-002", "idea-001" }, page.Items.Select(record => record.RecordId).ToArray());
        Assert.AreEqual(1, projection.DefinitionReads, "A sorted four-clause records read takes one definition snapshot.");

        var grid = await projection.GetAggregateAsync(NendoApplicationService.IdeaEntityId, "count", null, null,
            status, NendoApplicationService.IdeaEnergyFieldId, null, null, null, filter, CancellationToken.None);
        Assert.AreEqual("cells", grid.Shape);
        Assert.AreEqual(4, grid.Cells!.Sum(cell => cell.ContributingRecords));
        Assert.AreEqual(2, projection.DefinitionReads, "A filtered grid aggregate takes one definition snapshot.");

        var unknown = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => projection.GetRecordsAsync(
            NendoApplicationService.IdeaEntityId, null, 50, null, "field.idea.colour", null, filter, CancellationToken.None));
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
