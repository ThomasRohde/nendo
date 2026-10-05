using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The Flow app's own record types and actions, installed from the very operations its build
/// sends (<c>tools/flow/flow-app.operations.json</c>), walked the way an agent walks a run.
/// <para>
/// FlowRunTests showed the idea with a hand-made schema. This pins the shipped one: a run
/// begins only on its flow's Start edge, moves only along an edge that leaves its step,
/// refuses a step written by hand even when the edge is written beside it, and finishes on
/// an End. A drawn step keeps its key, and an edge redrawn in the editor re-reads its ends.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class FlowAppTests
{
    private const string Start = "fl_edge_defect_reported_locate";

    [TestMethod]
    public async Task ARunWalksTheSampleFlowOnlyAlongItsEdges()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await InstallAsync(coordinator);

        // A run that begins anywhere but the Start edge is refused, and nothing is created.
        var wrongStart = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => BeginAsync(service, "r0", "fl_edge_defect_locate_fix"));
        StringAssert.Contains(wrongStart.Message, "A run begins on the edge that leaves the Start of its own flow.");
        Assert.IsFalse((await service.GetSnapshotAsync()).Records.Any(record => record.EntityId == "fl.run"));

        await BeginAsync(service, "r1", Start);
        var run = await RunAsync(service);
        Assert.AreEqual(("defect.locate", "defect.locate", "Running"), (Text(run, "currentKey"), Text(run, "path"), Text(run, "status")));

        await ChooseAsync(service, "fl_edge_defect_locate_fix");
        Assert.AreEqual("defect.fix", Text(await RunAsync(service), "currentKey"));

        // An edge from elsewhere in the flow: refused, the run untouched.
        var before = await RunAsync(service);
        var wrongEdge = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => ChooseAsync(service, "fl_edge_defect_record_done"));
        StringAssert.Contains(wrongEdge.Message, "That edge does not leave the step this run is on.");
        Assert.AreEqual(before.RecordVersion, (await RunAsync(service)).RecordVersion);

        // The step written by hand: refused.
        var direct = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() =>
            service.SetFieldAsync(new("fl.run", "r1", "fl.run.currentKey", before.RecordVersion, "defect.done", Context("direct"))));
        StringAssert.Contains(direct.Message, "Nendo moves a run.");

        // The step and an edge leaving it, written together to jump ahead: the guard meets
        // the write first and refuses it, because the step is not where that edge leads.
        var recordDone = await VersionAsync(service, "fl.edge", "fl_edge_defect_record_done");
        var forged = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() =>
            service.SetFieldsAsync(new("fl.run", "r1", before.RecordVersion,
                new Dictionary<string, object?> { ["fl.run.currentKey"] = "defect.record", ["fl.run.choice"] = "fl_edge_defect_record_done" },
                Context("forged"), new Dictionary<string, long> { ["fl.run.choice"] = recordDone })));
        StringAssert.Contains(forged.Message, "Nendo moves a run.");
        Assert.AreEqual(before.RecordVersion, (await RunAsync(service)).RecordVersion);

        // Through the loop back (the guard missed), then out to the End.
        foreach (var edge in new[] { "fix_guard", "guard_falsify", "falsify_guard", "guard_falsify", "falsify_restore", "restore_record", "record_done" })
            await ChooseAsync(service, $"fl_edge_defect_{edge}");
        run = await RunAsync(service);
        Assert.AreEqual(("defect.done", "Finished"), (Text(run, "currentKey"), Text(run, "status")));
        Assert.AreEqual(
            "defect.locate › defect.fix › defect.guard › defect.falsify › defect.guard › defect.falsify › defect.restore › defect.record › defect.done",
            Text(run, "path"));

        // Nothing leaves an End.
        await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => ChooseAsync(service, "fl_edge_defect_locate_fix"));
    }

    [TestMethod]
    public async Task AStepKeepsItsKeyAndARedrawnEdgeReadsItsNewEnd()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await InstallAsync(coordinator);

        var fix = await VersionAsync(service, "fl.step", "fl_step_defect_fix");
        var rekeyed = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() =>
            service.SetFieldAsync(new("fl.step", "fl_step_defect_fix", "fl.step.key", fix, "defect.repair", Context("rekey"))));
        StringAssert.Contains(rekeyed.Message, "A step keeps its key and kind once it is drawn");
        // Its name is the person's to change.
        await service.SetFieldAsync(new("fl.step", "fl_step_defect_fix", "fl.step.name", fix, "Repair it", Context("rename")));

        // An edge drawn by the editor carries no keys; the action copies them.
        await service.CreateRecordAsync(new("fl.edge", "fl_edge_new", new Dictionary<string, object?>
        {
            ["fl.edge.outcome"] = "skip", ["fl.edge.flow"] = "fl_flow_defect",
            ["fl.edge.from"] = "fl_step_defect_locate", ["fl.edge.to"] = "fl_step_defect_fix",
        }, Context("draw"), new Dictionary<string, long>
        {
            ["fl.edge.flow"] = 1, ["fl.edge.from"] = await VersionAsync(service, "fl.step", "fl_step_defect_locate"),
            ["fl.edge.to"] = await VersionAsync(service, "fl.step", "fl_step_defect_fix"),
        }));
        var edge = await RecordAsync(service, "fl.edge", "fl_edge_new");
        Assert.AreEqual(("defect.locate", "Step", "defect.fix", "Step", "defect"),
            (Text(edge, "fromKey"), Text(edge, "fromKind"), Text(edge, "toKey"), Text(edge, "toKind"), Text(edge, "flowKey")));

        // Redrawn to the End, it reads its new end.
        await service.SetFieldAsync(new("fl.edge", "fl_edge_new", "fl.edge.to", edge.RecordVersion, "fl_step_defect_done", Context("redraw"),
            await VersionAsync(service, "fl.step", "fl_step_defect_done")));
        edge = await RecordAsync(service, "fl.edge", "fl_edge_new");
        Assert.AreEqual(("defect.done", "End"), (Text(edge, "toKey"), Text(edge, "toKind")));
    }

    /// <summary>The build's operations, in the build's mutations: one per record type, then each lane.</summary>
    private static async Task InstallAsync(NendoWriteCoordinator coordinator)
    {
        using var fixture = JsonDocument.Parse(await File.ReadAllTextAsync(
            Path.Combine(TestRepository.Root(), "tools", "flow", "flow-app.operations.json")));
        var groups = new List<List<JsonElement>>();
        string? lane = null;
        foreach (var element in fixture.RootElement.GetProperty("definition").EnumerateArray())
        {
            var type = element.GetProperty("operationType").GetString()!;
            var next = type.Split('.')[0] is "schema" or "application" ? "schema" : type.Split('.')[0];
            if (groups.Count == 0 || type == "schema.createEntity" || next != lane) groups.Add([]);
            lane = next;
            groups[^1].Add(element);
        }
        groups.Add([.. fixture.RootElement.GetProperty("seed").EnumerateArray()]);

        var serial = 0;
        foreach (var group in groups)
        {
            if (ReferenceEquals(group, groups[^1])) TestBehaviourAuthority.Approving(coordinator);
            // MCP fills in an omitted definition revision; the build omits it, so do the same.
            var revision = (await new NendoApplicationService(coordinator).GetSnapshotAsync()).Manifest.DefinitionRevision;
            await coordinator.ApplyAsync(new("test", $"flow-{++serial}", "test", "Flow app",
                group.Select(element => Compile(element, ++serial, revision)).ToList()));
        }
    }

    private static NendoOperation Compile(JsonElement element, int serial, long revision)
    {
        var type = element.GetProperty("operationType").GetString()!;
        var payload = element.GetProperty("payload");
        try
        {
            return CanonicalChangeSetRequestCompiler.CompileOperation(new NendoCanonicalOperationRequest($"op-{serial}", type, payload));
        }
        catch (NendoValidationException exception) when (exception.Message.Contains("expectedDefinitionRevision"))
        {
            var filled = JsonSerializer.SerializeToNode(payload)!.AsObject();
            filled["expectedDefinitionRevision"] = revision;
            return CanonicalChangeSetRequestCompiler.CompileOperation(
                new NendoCanonicalOperationRequest($"op-{serial}", type, JsonSerializer.SerializeToElement(filled)));
        }
    }

    private static async Task<NendoApplyResult> BeginAsync(NendoApplicationService service, string runId, string edgeId) =>
        await service.CreateRecordAsync(new("fl.run", runId, new Dictionary<string, object?>
        {
            ["fl.run.title"] = "Walk", ["fl.run.flow"] = "fl_flow_defect", ["fl.run.choice"] = edgeId,
        }, Context(runId), new Dictionary<string, long> { ["fl.run.flow"] = 1, ["fl.run.choice"] = await VersionAsync(service, "fl.edge", edgeId) }));

    private static async Task<NendoApplyResult> ChooseAsync(NendoApplicationService service, string edgeId)
    {
        var run = await RunAsync(service);
        return await service.SetFieldAsync(new("fl.run", "r1", "fl.run.choice", run.RecordVersion, edgeId,
            Context($"r1-{run.RecordVersion}-{edgeId}"), await VersionAsync(service, "fl.edge", edgeId)));
    }

    private static Task<NendoRecordSnapshot> RunAsync(NendoApplicationService service) => RecordAsync(service, "fl.run", "r1");

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string entityId, string recordId) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == entityId && record.RecordId == recordId);

    private static async Task<long> VersionAsync(NendoApplicationService service, string entityId, string recordId) =>
        (await RecordAsync(service, entityId, recordId)).RecordVersion;

    private static string? Text(NendoRecordSnapshot record, string field) =>
        record.Values[$"{record.EntityId}.{field}"].GetString();
}
