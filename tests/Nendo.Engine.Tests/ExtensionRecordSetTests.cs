using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A custom view of one record type as typed columns (ADR-0013, 2026-09-24 record-set
/// amendment; W-061): no edge type, protocol 2 only, and the page receives records.
/// </summary>
[TestClass]
public sealed class ExtensionRecordSetTests
{
    private static Dictionary<string, object?> Properties(int protocol = 2) => new()
    {
        ["definitionVersion"] = 3, ["entityId"] = "tasks", ["title"] = "Schedule",
        ["packageId"] = "org.nendo.gantt", ["packageVersion"] = "0.1.0",
        ["packageDigest"] = new string('a', 64), ["protocolVersion"] = protocol,
        ["configurationVersion"] = 1, ["configuration"] = "{}", ["labelFieldId"] = "title",
    };

    private static NendoProposalRequest Request(string kind, Dictionary<string, object?> properties, params (string Kind, Dictionary<string, object?> Properties)[] children) =>
        Keyed("view", kind, properties, children);

    // The first view is "schedule"; any other key pins a view whose node ID is the key.
    private static NendoProposalRequest Keyed(string key, string kind, Dictionary<string, object?> properties, params (string Kind, Dictionary<string, object?> Properties)[] children)
    {
        var node = key == "view" ? "schedule" : key;
        return new("proposal-" + Guid.NewGuid().ToString("N"), key, "test", new([
            new("test", key, "test", key, [
                new AddUiNodeOperation(key + "-add", "schedule", node, null, kind, 0),
                .. properties.Select(p => new SetUiPropertyOperation(key + "-" + p.Key, "schedule", node, p.Key, p.Value)),
                .. children.SelectMany((child, i) => (NendoOperation[])[
                    new AddUiNodeOperation($"{key}-c{i}", "schedule", $"{node}-c{i}", node, child.Kind, i),
                    .. child.Properties.Select(p => new SetUiPropertyOperation($"{key}-c{i}-{p.Key}", "schedule", $"{node}-c{i}", p.Key, p.Value))]),
            ]),
        ]));
    }

    private static (string, Dictionary<string, object?>) Disclose(string fieldId) => ("fieldBinding", new() { ["fieldId"] = fieldId });

    private static async Task<NendoApplicationService> Seed(NendoWriteCoordinator coordinator, int count = 3)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Tasks", [
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("starts", "tasks", "starts", "Starts", "starts", NendoStorageKind.Date, false),
            new AddFieldOperation("ends", "tasks", "ends", "Ends", "ends", NendoStorageKind.Date, false),
            new AddFieldOperation("secret", "tasks", "secret", "Secret", "secret", NendoStorageKind.Text, false),
            new CreateEntityOperation("other", "other", "Other", "other"),
            new AddFieldOperation("elsewhere", "other", "elsewhere", "Elsewhere", "elsewhere", NendoStorageKind.Text, false),
        ]));
        for (var start = 0; start < count; start += 100)
            await coordinator.ApplyAsync(new("test", "data" + start, "test", "Tasks", Enumerable.Range(start, Math.Min(100, count - start)).Select(i =>
                (NendoOperation)new CreateRecordOperation("t" + i, "tasks", "t" + i.ToString("D4"), new Dictionary<string, object?>
                {
                    ["title"] = "Task " + i, ["starts"] = $"2026-10-{1 + i % 28:D2}", ["ends"] = i % 2 == 0 ? $"2026-11-{1 + i % 28:D2}" : null, ["secret"] = "never sent",
                })).ToArray()));
        return new(coordinator);
    }

    private static async Task Pin(NendoApplicationService service, Dictionary<string, object?> properties, params (string, Dictionary<string, object?>)[] children) =>
        await PinAs("view", service, properties, children);

    private static async Task PinAs(string key, NendoApplicationService service, Dictionary<string, object?> properties, params (string, Dictionary<string, object?>)[] children)
    {
        var preview = await service.PrepareProposalAsync(Keyed(key, NendoExtensionViewDefinition.RecordsKind, properties, children));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State, string.Join(";", preview.Diagnostics.Select(d => d.Code + " " + d.Message)));
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId, expectedOperationDigest: preview.OperationDigest)).Applied);
    }

    [TestMethod]
    public async Task ARecordSetSendsItsRecordsWithExactlyTheDisclosedColumns()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Seed(await workspace.CreateAsync());
        await Pin(service, Properties(), Disclose("starts"), Disclose("ends"),
            ("filterClause", new() { ["fieldId"] = "title", ["operator"] = "ne", ["value"] = "Task 1" }));
        var view = await service.ReadExtensionViewAsync("schedule");
        Assert.IsTrue(view.Definition.IsRecordSet);
        Assert.AreEqual(NendoFormat.ExtensionRecordsMinimumHostVersion, (await service.GetDefinitionSnapshotAsync()).Manifest.MinimumHostVersion);
        var projection = view.Projection;
        Assert.IsTrue(projection.IsRecordSet);
        CollectionAssert.AreEqual(new[] { "t0000", "t0002" }, projection.Nodes.Select(n => n.Id).ToArray());
        foreach (var record in projection.Nodes)
            CollectionAssert.AreEquivalent(new[] { "starts", "ends" }, record.Values!.Keys.ToArray());
        Assert.AreEqual("2026-10-03", projection.Nodes[1].Values!["starts"]);
        Assert.IsEmpty(projection.Edges);

        var grant = new NendoExtensionGrant(view.ApplicationId, view.InstanceId, "schedule", view.Definition.PackageDigest,
            view.Definition.ComputeBindingDigest(), 2);
        using var session = new NendoExtensionViewSession(grant, new Authority(grant), projection);
        var sent = Encoding.UTF8.GetString(session.GetInitialization("light", "en"));
        Assert.IsFalse(sent.Contains("never sent", StringComparison.Ordinal), sent);
        using var document = JsonDocument.Parse(sent);
        var shape = document.RootElement.GetProperty("projection");
        // The page reads records, and nothing of a graph's shape.
        CollectionAssert.AreEquivalent(new[] { "sourceChangeSequence", "fields", "records" }, shape.EnumerateObject().Select(p => p.Name).ToArray(), sent);
        Assert.AreEqual(2, shape.GetProperty("records").GetArrayLength());
        Assert.IsTrue(session.Receive(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { version = 2, session = session.SessionId, generation = 1, method = "ready" }))).Accepted);
        Assert.AreEqual("selected", session.Receive(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { version = 2, session = session.SessionId, generation = 1, method = "selectRecord", recordId = "t0002" }))).Code);
    }

    [TestMethod]
    public async Task ARecordSetIsBoundedAtAThousandRecordsAndRefusedWholeAbove()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await Seed(coordinator, NendoExtensionViewDefinition.MaximumRecords);
        await Pin(service, Properties(), Disclose("starts"));
        Assert.HasCount(NendoExtensionViewDefinition.MaximumRecords, (await service.ReadExtensionViewAsync("schedule")).Projection.Nodes);
        await coordinator.ApplyAsync(new("test", "over", "test", "One more", [
            new CreateRecordOperation("over", "tasks", "t9999", new Dictionary<string, object?> { ["title"] = "One too many" })]));
        Assert.AreEqual("graph-projection-too-large",
            (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.ReadExtensionViewAsync("schedule"))).Code);
    }

    [TestMethod]
    public async Task TheCompilerRefusesWhatARecordSetDoesNotTake()
    {
        await using var workspace = new EngineTestWorkspace();
        var service = await Seed(await workspace.CreateAsync());
        async Task Refused(string why, Dictionary<string, object?> properties, params (string, Dictionary<string, object?>)[] children)
        {
            var preview = await service.PrepareProposalAsync(Request(NendoExtensionViewDefinition.RecordsKind, properties, children));
            Assert.AreNotEqual(NendoProposalState.Previewable, preview.State, why);
            Assert.IsNotEmpty(preview.Diagnostics.Where(d => d.Severity == NendoDiagnosticSeverity.Error).ToArray(), why);
        }
        await Refused("protocol 1", Properties(protocol: 1));
        var withEdge = Properties(); withEdge["edgeEntityId"] = "other";
        await Refused("an edge type", withEdge);
        await Refused("a field of another record type", Properties(), Disclose("elsewhere"));
        await Refused("the label disclosed again", Properties(), Disclose("title"));
    }

    [TestMethod]
    public void ARecordSetsDigestIsNotAGraphs()
    {
        static Dictionary<string, JsonElement> Json(Dictionary<string, object?> p) => p.ToDictionary(x => x.Key, x => JsonSerializer.SerializeToElement(x.Value));
        var records = NendoExtensionViewDefinition.Read("v", Json(Properties()), [], NendoExtensionViewDefinition.RecordsKind);
        var graphProperties = Properties(); graphProperties["edgeEntityId"] = "tasks"; graphProperties["sourceFieldId"] = "a"; graphProperties["targetFieldId"] = "b";
        var graph = NendoExtensionViewDefinition.Read("v", Json(graphProperties), []);
        Assert.AreNotEqual(graph.ComputeBindingDigest(), records.ComputeBindingDigest());
        Assert.IsNull(records.Binding.EdgeEntityId);
    }

    [TestMethod]
    public async Task RemovingAViewIsOfferedUndoOnlyWhenTheInverseCanRestoreIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await Seed(coordinator);
        await Pin(service, Properties());
        var removed = await coordinator.ApplyAsync(new("test", "remove", "test", "Remove", [new RemoveUiNodeOperation("remove", "schedule", "schedule")]));
        Assert.IsTrue((await service.QueryHistoryAsync(new(1))).Items[0].CanRequestCompensation, "A childless record-set view could not be restored.");
        await service.CompensateRevisionAsync(removed.RevisionId, "restore");
        Assert.IsTrue((await service.ReadExtensionViewAsync("schedule")).Definition.IsRecordSet);

        // A view with disclosed fields leaves children behind, which the inverse does not
        // restore, so the history must not offer what the inverse would then refuse.
        await PinAs("again", service, Properties(), Disclose("starts"));
        var removedWithChildren = await coordinator.ApplyAsync(new("test", "remove2", "test", "Remove again", [new RemoveUiNodeOperation("remove2", "schedule", "again")]));
        Assert.IsFalse((await service.QueryHistoryAsync(new(1))).Items[0].CanRequestCompensation,
            "The history offered to restore a view whose children the inverse cannot restore.");
        await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(() => service.CompensateRevisionAsync(removedWithChildren.RevisionId, "restore-again"));
    }

    private sealed class Authority(NendoExtensionGrant expected) : INendoExtensionAuthority
    {
        public long RevocationGeneration => 0;
        public bool IsGranted(NendoExtensionGrant grant) => grant == expected;
    }
}
