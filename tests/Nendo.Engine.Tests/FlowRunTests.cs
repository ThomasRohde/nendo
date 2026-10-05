namespace Nendo.Engine.Tests;

/// <summary>
/// A repeatable procedure held as records: steps, the edges between them, and a run
/// that sits on one step at a time. The run moves only when the edge it is given leaves
/// the step it is on, and the host refuses any other move with nothing changed.
/// <para>
/// This is the spike behind the flow-editor app: it shows that ordinary actions, with
/// no host change, can hold the routing of a procedure an agent walks through MCP. An
/// assignment's inputs resolve against the record it writes, so the run carries the
/// chosen edge itself; a separate move record could not reach the run's step.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class FlowRunTests
{
    private const string WrongEdge = "That edge does not leave the step this run is on.";

    [TestMethod]
    public async Task ARunMovesOnlyAlongAnEdgeThatLeavesItsStep()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        // The edges carry their endpoints' keys, copied by an action, because a formula
        // compares text and never a reference.
        var edges = (await service.GetSnapshotAsync()).Records.Where(record => record.EntityId == "edges")
            .ToDictionary(record => record.RecordId);
        Assert.AreEqual(("check", "fix"),
            (edges["check-no"].Values["fromKey"].GetString(), edges["check-no"].Values["toKey"].GetString()),
            "The edge's keys were not copied from the steps it joins.");

        await service.CreateRecordAsync(new("runs", "r1",
            new Dictionary<string, object?> { ["currentKey"] = "start" }, Context("r1")));
        await MoveAsync(service, "start-next");
        Assert.AreEqual("check", await CurrentAsync(service));

        // An edge that leaves another step is refused by name, and the run is untouched:
        // same step, same chosen edge, same version, no new revision.
        var before = await RunAsync(service);
        var history = (await service.GetHistoryAsync()).Count;
        var refused = await Assert.ThrowsExactlyAsync<NendoCalculationException>(() => MoveAsync(service, "fix-next"));
        Assert.AreEqual(NendoCalculationCodes.Refused, refused.Code);
        StringAssert.Contains(refused.Message, WrongEdge);
        var after = await RunAsync(service);
        Assert.AreEqual(before.RecordVersion, after.RecordVersion, "A refused move changed the run.");
        Assert.AreEqual("check", after.Values["currentKey"].GetString());
        Assert.AreEqual("start-next", after.Values["choice"].GetString());
        Assert.HasCount(history, await service.GetHistoryAsync(), "A refused move left a revision.");

        // The branch and the loop back: check → fix → check → done.
        var applied = await MoveAsync(service, "check-no");
        Assert.AreEqual("fix", await CurrentAsync(service));
        await MoveAsync(service, "fix-next");
        await MoveAsync(service, "check-yes");
        Assert.AreEqual("done", await CurrentAsync(service));

        // One move is one revision: the chosen edge and the step it led to.
        var revision = (await service.GetHistoryAsync()).Single(entry => entry.RevisionId == applied.RevisionId);
        Assert.HasCount(2, revision.Operations);
    }

    [TestMethod]
    public async Task TheSameMovesFromTheSameStepAlwaysEndOnTheSameStep()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(coordinator, service);

        // Two runs, the same outcomes, the same path. A second run does not inherit
        // anything from the first.
        string[] path = ["start-next", "check-no", "fix-next", "check-yes"];
        var ends = new List<string?>();
        foreach (var runId in new[] { "r1", "r2" })
        {
            await service.CreateRecordAsync(new("runs", runId,
                new Dictionary<string, object?> { ["currentKey"] = "start" }, Context(runId)));
            foreach (var edge in path) await MoveAsync(service, edge, runId);
            ends.Add(await CurrentAsync(service, runId));
        }
        CollectionAssert.AreEqual(new[] { "done", "done" }, ends);
    }

    private static async Task<NendoApplyResult> MoveAsync(NendoApplicationService service, string edgeId, string runId = "r1")
    {
        var snapshot = await service.GetSnapshotAsync();
        var run = snapshot.Records.Single(record => record.EntityId == "runs" && record.RecordId == runId);
        var edge = snapshot.Records.Single(record => record.EntityId == "edges" && record.RecordId == edgeId);
        return await service.SetFieldAsync(new("runs", runId, "choice", run.RecordVersion, edgeId,
            Context($"{runId}-{run.RecordVersion}-{edgeId}"), edge.RecordVersion));
    }

    private static async Task<NendoRecordSnapshot> RunAsync(NendoApplicationService service, string runId = "r1") =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == "runs" && record.RecordId == runId);

    private static async Task<string?> CurrentAsync(NendoApplicationService service, string runId = "r1") =>
        (await RunAsync(service, runId)).Values["currentKey"].GetString();

    /// <summary>start → check; check → done on yes, → fix on no; fix → check.</summary>
    private static async Task SeedAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Steps, edges and runs", [
            new CreateEntityOperation("steps", "steps", "Steps", "steps"),
            new AddFieldOperation("s-key", "steps", "key", "Key", "key", NendoStorageKind.Text, true),
            new CreateEntityOperation("edges", "edges", "Edges", "edges"),
            new AddFieldOperation("e-outcome", "edges", "outcome", "Outcome", "outcome", NendoStorageKind.Text, true),
            new AddFieldOperation("e-from", "edges", "from", "From", "from_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("e-to", "edges", "to", "To", "to_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("e-from-key", "edges", "fromKey", "From key", "from_key", NendoStorageKind.Text, false),
            new AddFieldOperation("e-to-key", "edges", "toKey", "To key", "to_key", NendoStorageKind.Text, false),
            new ConfigureReferenceOperation("bind-from", "edges", "from", "steps", "key", 0),
            new ConfigureReferenceOperation("bind-to", "edges", "to", "steps", "key", 0),
            new CreateEntityOperation("runs", "runs", "Runs", "runs"),
            new AddFieldOperation("r-current", "runs", "currentKey", "Current step", "current_key", NendoStorageKind.Text, true),
            new AddFieldOperation("r-choice", "runs", "choice", "Chosen edge", "choice_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind-choice", "runs", "choice", "edges", "outcome", 0),
        ]));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Route the runs", [
            new SetBehaviourDefinitionOperation("a-keys", new NendoActionDefinition(
                "edge.keys", "Copy the keys of the steps an edge joins",
                [NendoActionStep.SetFields("10-keys", NendoActionTarget.EventRecord, [
                    new NendoActionAssignment("fromKey", "key",
                        [NendoBehaviourBinding.ReferenceTraversal("key", "edges", "from", "steps", "key", NendoBehaviourScalar.Text, false)], []),
                    new NendoActionAssignment("toKey", "key",
                        [NendoBehaviourBinding.ReferenceTraversal("key", "edges", "to", "steps", "key", NendoBehaviourScalar.Text, false)], [])])]), revision),
            new SetBehaviourDefinitionOperation("t-keys", new NendoTriggerDefinition(
                "10-keys", "edges", "Copy the keys when an edge is drawn or redrawn",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated, "edge.keys", ["from", "to"]), revision),
            new SetBehaviourDefinitionOperation("a-advance", new NendoActionDefinition(
                "run.advance", "Move the run along the chosen edge",
                [NendoActionStep.SetField("20-advance", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("currentKey", $"edgeFrom = current ? edgeTo : Refuse('{WrongEdge}')",
                        [
                            NendoBehaviourBinding.SameRecordField("current", "runs", "currentKey", NendoBehaviourScalar.Text, false),
                            NendoBehaviourBinding.ReferenceTraversal("edgeFrom", "runs", "choice", "edges", "fromKey", NendoBehaviourScalar.Text, true),
                            NendoBehaviourBinding.ReferenceTraversal("edgeTo", "runs", "choice", "edges", "toKey", NendoBehaviourScalar.Text, true),
                        ], []))]), revision),
            new SetBehaviourDefinitionOperation("t-advance", new NendoTriggerDefinition(
                "20-advance", "runs", "Move the run when an edge is chosen",
                NendoTriggerEvents.Updated, "run.advance", ["choice"]), revision),
        ]));
        TestBehaviourAuthority.Approving(coordinator);

        foreach (var key in new[] { "start", "check", "fix", "done" })
        {
            await service.CreateRecordAsync(new("steps", key,
                new Dictionary<string, object?> { ["key"] = key }, Context($"step-{key}")));
        }
        foreach (var (id, outcome, from, to) in new[]
        {
            ("start-next", "next", "start", "check"),
            ("check-yes", "yes", "check", "done"),
            ("check-no", "no", "check", "fix"),
            ("fix-next", "next", "fix", "check"),
        })
        {
            await service.CreateRecordAsync(new("edges", id,
                new Dictionary<string, object?> { ["outcome"] = outcome, ["from"] = from, ["to"] = to }, Context(id),
                new Dictionary<string, long> { ["from"] = 1, ["to"] = 1 }));
        }
    }
}
