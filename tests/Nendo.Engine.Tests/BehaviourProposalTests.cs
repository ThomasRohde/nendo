using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0008 regression lane D4, stage S5: a reviewed proposal promotes exactly what
/// was reviewed.
/// <para>
/// A proposal is judged against a clone and applied to the live file some time
/// later. What makes that safe is that the second step replays the first step's
/// output — not that it recomputes the same thing and trusts it to agree. These
/// cases are about the difference.
/// </para>
/// </summary>
/// <remarks>
/// Not parallelized: each case clones a real file into a proposal workspace and
/// promotes it, which is disk-heavy enough to starve the timing-sensitive lanes in
/// the other assemblies if dozens run at once.
/// </remarks>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourProposalTests
{
    [TestMethod]
    public async Task ReviewExpandsTheActionsAndPromotionAppliesExactlyThoseOperationsOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var authority = TestBehaviourAuthority.Approving(coordinator);
        var beforeRecords = JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records);

        var proposalId = ProposalId();
        var preview = await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);

        // Reviewing changes nothing in the active file.
        Assert.AreEqual(beforeRecords, JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records),
            "Previewing a proposal changed the active file.");

        var outcome = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsTrue(outcome.Applied, outcome.Message);

        // The trigger's effect is present exactly once, not twice.
        var project = await Project(service);
        Assert.AreEqual(2L, project.Values["total"].GetInt64(),
            "The reviewed effect was applied a different number of times than once.");
        Assert.AreEqual(2L, project.RecordVersion,
            "The parent was written more than once, so the triggers ran again during replay.");

        // One revision carrying the initiating operation and the reviewed generated one.
        var revision = (await service.GetHistoryAsync()).Single(entry => entry.ProposalId == proposalId);
        Assert.HasCount(2, revision.Operations);
        Assert.AreEqual(1, revision.Operations.Count(
            operation => operation.OperationId.StartsWith("generated-", StringComparison.Ordinal)));

        // The generated write keeps its attribution through promotion, and the outcome
        // names the record the trigger moved. Both were empty before the fix, because the
        // reviewed effects were folded in as author operations with no attribution.
        var attribution = await AttributionAsync(workspace.FilePath);
        Assert.HasCount(1, attribution);
        Assert.AreEqual("10-total", attribution.Single());
        var alsoChanged = outcome.Result!.Revisions.SelectMany(item => item.GeneratedChanges).ToArray();
        Assert.HasCount(1, alsoChanged);
        Assert.AreEqual(("projects", "p1"), (alsoChanged[0].EntityId, alsoChanged[0].RecordId));
    }

    private static async Task<IReadOnlyList<string>> AttributionAsync(string path)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Mode=ReadOnly;Pooling=False");
        await connection.OpenAsync();
        await using var exists = connection.CreateCommand();
        exists.CommandText = "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = '__nendo_attribution';";
        if (Convert.ToInt64(await exists.ExecuteScalarAsync()) == 0) return [];
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT trigger_id FROM __nendo_attribution ORDER BY revision_id, ordinal;";
        var rows = new List<string>();
        await using var reader = await command.ExecuteReaderAsync();
        while (await reader.ReadAsync()) rows.Add(reader.GetString(0));
        return rows;
    }

    [TestMethod]
    public async Task ARecordTheConditionOnlyReadMakesTheReviewedPlanStale()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);

        var proposalId = ProposalId();
        await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());

        // t1 is not touched by the proposal at all — but the total counted it, so what
        // was reviewed is no longer what would happen.
        await service.SetFieldAsync(new("tasks", "t1", "title", 1, "Renamed", Context("unrelated")));

        var outcome = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsFalse(outcome.Applied, "A plan whose read records moved was promoted anyway.");
        Assert.AreEqual(NendoProposalState.Stale, outcome.State);
        Assert.AreEqual(1L, (await Project(service)).Values["total"].GetInt64(),
            "A refused promotion still changed the file.");
    }

    [TestMethod]
    public async Task ARecordCreatedAfterReviewMakesTheReviewedPlanStale()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);

        var proposalId = ProposalId();
        await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());

        // Nothing the review looked at has changed; a new record simply appeared. It
        // would change the count, and no per-record version can notice that.
        await service.CreateRecordAsync(new("tasks", "t3",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "Third" },
            Context("t3"), new Dictionary<string, long> { ["project"] = 1 }));

        var outcome = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsFalse(outcome.Applied, "A plan whose collection membership changed was promoted anyway.");
        Assert.AreEqual(NendoProposalState.Stale, outcome.State);
    }

    [TestMethod]
    public async Task AReviewedProposalSurvivesClosingAndReopeningTheFile()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);

        var proposalId = ProposalId();
        var preview = await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());
        var reviewedDigest = preview.OperationDigest;
        var workspacePath = Path.Combine(coordinator.ProposalRoot, proposalId);

        // The reviewed plan is on disk, not only in the session that made it.
        var planPath = Path.Combine(workspacePath, "behaviour-plan.json");
        Assert.IsTrue(File.Exists(planPath), "The reviewed plan was not persisted with the proposal.");
        var stored = PreparedBehaviourPlan.Deserialize(await File.ReadAllTextAsync(planPath));
        Assert.HasCount(1, stored.Generated);
        Assert.AreEqual("10-total", stored.Generated.Single().Attribution.TriggerId);
        Assert.IsNotEmpty(stored.ReadSet);
        Assert.IsGreaterThan(0, stored.DataRevision);
        Assert.AreEqual(64, reviewedDigest.Length);
    }

    [TestMethod]
    public async Task ATamperedPlanIsRefusedRatherThanPromoted()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);

        var proposalId = ProposalId();
        await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());

        // Edit the workspace behind the review: change the effect the owner approved
        // into a different one.
        var planPath = Path.Combine(coordinator.ProposalRoot, proposalId, "behaviour-plan.json");
        var tampered = (await File.ReadAllTextAsync(planPath)).Replace("\"20-complete\"", "\"20-complete\"");
        tampered = tampered.Replace("\"total\"", "\"total\"").Replace("\"10-total\"", "\"99-tampered\"");
        await File.WriteAllTextAsync(planPath, tampered);

        var outcome = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsFalse(outcome.Applied, "A plan edited behind the review was promoted.");
        Assert.AreEqual(NendoProposalState.Failed, outcome.State);
        Assert.AreEqual(1L, (await Project(service)).Values["total"].GetInt64());
    }

    [TestMethod]
    public async Task PromotionIsNotAWayAroundApproval()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);

        // No approval anywhere. A proposal is reviewed against a clone, and the clone
        // is allowed to simulate — but promoting what it produced writes to the real
        // file, and that is a different question.
        var proposalId = ProposalId();
        var preview = await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());
        Assert.AreEqual(NendoProposalState.Previewable, preview.State,
            "Reviewing should still work: seeing what a file would do needs no permission.");

        var refused = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsFalse(refused.Applied, "An unapproved proposal applied its automatic effects.");
        Assert.AreEqual(1L, (await Project(service)).Values["total"].GetInt64());
        Assert.HasCount(0, (await service.GetHistoryAsync()).Where(entry => entry.ProposalId == proposalId));

        // Approving the behaviour the proposal will leave behind lets it through, and
        // the proposal is still promotable rather than having been burned.
        var authority = new TestBehaviourAuthority();
        coordinator.BehaviourAuthority = authority;
        authority.Approve(await ReviewedGrantAsync(coordinator, proposalId));
        var accepted = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsTrue(accepted.Applied, accepted.Message);
        Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64());
    }

    [TestMethod]
    public async Task ApprovingTodaysBehaviourDoesNotApproveWhatAProposalChangesItInto()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);

        // A proposal that rewrites the action and edits data in the same review. The
        // owner approved the old action; this is not that action.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposalId = ProposalId();
        var preview = await coordinator.BeginProposalAsync(proposalId, "Change the rule and edit", "test",
            new NendoChangeSet([
                new NendoMutation("test", "redefine", "test", "Change what the action writes", [
                    new SetBehaviourDefinitionOperation("redefine-action", new NendoActionDefinition(
                        "project.setTotal", "Set the project total",
                        [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                            new NendoActionAssignment("total", "doneCount + 100",
                                [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done")], []))]),
                        revision),
                ]),
                new NendoMutation("test", "proposal-edit", "test", "Finish the second task", [
                    new SetFieldOperation("edit-done", "tasks", "t2", "done", 1, true),
                ]),
            ]));
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);

        var refused = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsFalse(refused.Applied,
            "Approval of the existing behaviour carried over to a proposal that replaced it.");
        Assert.AreEqual(1L, (await Project(service)).Values["total"].GetInt64());
    }

    [TestMethod]
    public async Task ADefinitionOnlyProposalInstallsWithoutRunningAnything()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);
        var before = await Project(service);

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposalId = ProposalId();
        await coordinator.BeginProposalAsync(proposalId, "Rename a record type", "test",
            new NendoChangeSet([new NendoMutation("test", "rename", "test", "Rename", [
                new RenameEntityOperation("rename", "tasks", "Work items", revision),
            ])]));
        var outcome = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsTrue(outcome.Applied, outcome.Message);

        // Installing or renaming definitions is a reviewed change to the file, never an
        // occasion to run the actions over the records already in it.
        var after = await Project(service);
        Assert.AreEqual(before.RecordVersion, after.RecordVersion, "A definition-only promotion wrote to a record.");
        Assert.AreEqual(before.Values["total"].GetInt64(), after.Values["total"].GetInt64());
    }

    [TestMethod]
    public async Task PromotingTwiceUnderTheSameIdentityAppliesTheEffectsOnlyOnce()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        TestBehaviourAuthority.Approving(coordinator);

        var proposalId = ProposalId();
        var preview = await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());
        // Both promotes carry the digest the reviewer was shown. Because that digest
        // covers the reviewed generated effects, it matches the committed receipt, so the
        // retry is recognised as the same change rather than refused as a digest mismatch.
        var first = await coordinator.PromoteProposalAsync(proposalId, expectedOperationDigest: preview.OperationDigest);
        Assert.IsTrue(first.Applied);
        var afterFirst = JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records);
        var history = await service.GetHistoryAsync();

        // The caller never saw the answer and asks again, with the same reviewed digest.
        var second = await coordinator.PromoteProposalAsync(proposalId, expectedOperationDigest: preview.OperationDigest);
        Assert.IsTrue(second.Applied);
        Assert.AreEqual(preview.OperationDigest, second.Result!.ChangeSetDigest,
            "The reviewed digest a client sends must match the committed receipt's digest.");
        Assert.AreEqual(afterFirst, JsonSerializer.Serialize((await service.GetSnapshotAsync()).Records),
            "A repeated promotion applied the reviewed effects a second time.");
        Assert.HasCount(history.Count, await service.GetHistoryAsync());
    }

    [TestMethod]
    public async Task ConsentWithdrawnDuringPromotionAbortsAndLeavesTheFileUnchanged()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var authority = TestBehaviourAuthority.Approving(coordinator);

        var proposalId = ProposalId();
        await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());

        // Approval is withdrawn inside the promotion transaction, after review's up-front
        // consent gate passed. Promotion replays the reviewed effects instead of running
        // the chain, so only a commit-boundary recheck can catch this.
        coordinator.BeforeProposalCommit = () => authority.RevokeAll();
        var outcome = await coordinator.PromoteProposalAsync(proposalId);
        coordinator.BeforeProposalCommit = null;

        Assert.IsFalse(outcome.Applied, "A promotion whose consent was withdrawn mid-transaction still committed.");
        Assert.AreEqual(1L, (await Project(service)).Values["total"].GetInt64(),
            "The withdrawn promotion still wrote the reviewed effect.");

        // Withdrawn at the commit boundary is the same refusal as withdrawn before it:
        // nothing was written and the proposal is still exactly what was reviewed, so
        // it stays previewable and accepts once the actions are approved again. It
        // used to end as Failed, and the retry after re-approving was refused.
        Assert.AreEqual(NendoProposalState.Previewable, outcome.State,
            "A promotion refused for withdrawn consent ended in a terminal state.");
        authority.ApproveCurrent(coordinator);
        var retried = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsTrue(retried.Applied, retried.Message);
        Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64());
    }

    [TestMethod]
    public async Task ConsentRevokedAndRegrantedRightAfterThePromotionGrantCheckIsStillRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);
        var authority = TestBehaviourAuthority.Approving(coordinator);

        var proposalId = ProposalId();
        await coordinator.BeginProposalAsync(proposalId, "Finish a task", "test", Edit());

        // Consent moves the instant promotion's own grant check has answered: withdrawn
        // and given again before the store begins its transaction. The grant is in place
        // at the commit boundary, so only the revocation generation can tell that the
        // approval the check saw is not the one the file commits under. Reading that
        // generation inside the store, after this window, let the promotion through.
        authority.OnGrantChecked = () =>
        {
            authority.OnGrantChecked = null;
            authority.RevokeAll();
            authority.ApproveCurrent(coordinator);
        };
        var outcome = await coordinator.PromoteProposalAsync(proposalId);

        Assert.IsFalse(outcome.Applied, "A promotion whose consent changed after its grant check still committed.");
        Assert.AreEqual(NendoProposalState.Previewable, outcome.State);
        Assert.AreEqual(1L, (await Project(service)).Values["total"].GetInt64(),
            "The promotion wrote the reviewed effect under a consent it never checked.");
    }

    [TestMethod]
    public async Task AProposalThatBackfillsARetiredFieldAndFiresATriggerCanBeAccepted()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Fixture(coordinator, service);

        // Retire a tasks field on the active file so it can be backfilled.
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "retire", "test", "Retire the title",
            [new SetRetiredOperation("retire", "tasks", "title", true, revision)]));
        TestBehaviourAuthority.Approving(coordinator);

        // A two-mutation proposal: backfill t1's retired title, then finish t2, which fires
        // 10-total whose count reads t1 and t2. The backfilled record's post-write clone
        // version used to survive into the plan's read set, making the proposal refuse as
        // stale every time it was prepared — a proposal that could never be accepted.
        var proposalId = ProposalId();
        await coordinator.BeginProposalAsync(proposalId, "Backfill and finish", "test", new NendoChangeSet([
            new NendoMutation("test", "backfill", "test", "Backfill t1 title",
                [new BackfillRetiredFieldOperation("backfill", "tasks", "t1", "title", 1, "Recovered")]),
            new NendoMutation("test", "finish", "test", "Finish the second task",
                [new SetFieldOperation("edit-done", "tasks", "t2", "done", 1, true)]),
        ]));

        var outcome = await coordinator.PromoteProposalAsync(proposalId);
        Assert.IsTrue(outcome.Applied, outcome.Message);
        Assert.AreEqual(2L, (await Project(service)).Values["total"].GetInt64());
    }

    /// <summary>The consent the reviewed plan says promoting it will need.</summary>
    private static async Task<NendoBehaviourGrant> ReviewedGrantAsync(NendoWriteCoordinator coordinator, string proposalId)
    {
        var plan = PreparedBehaviourPlan.Deserialize(await File.ReadAllTextAsync(
            Path.Combine(coordinator.ProposalRoot, proposalId, "behaviour-plan.json")));
        return plan.RequiredGrant ?? throw new AssertFailedException("The reviewed plan names no required approval.");
    }

    private static string ProposalId() => "proposal-" + Guid.NewGuid().ToString("N");

    private static NendoChangeSet Edit() => new([
        new NendoMutation("test", "proposal-edit", "test", "Finish the second task", [
            new SetFieldOperation("edit-done", "tasks", "t2", "done", 1, true),
        ]),
    ]);

    private static async Task<NendoRecordSnapshot> Project(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1");

    private static NendoRequestContext Context(string key) => new("test", key, "test");

    /// <summary>Two tasks under one project, and a trigger that keeps the project's total.</summary>
    private static async Task Fixture(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 1L }, Context("p1")));
        await service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = true, ["title"] = "First" },
            Context("t1"), new Dictionary<string, long> { ["project"] = 1 }));
        await service.CreateRecordAsync(new("tasks", "t2",
            new Dictionary<string, object?> { ["project"] = "p1", ["done"] = false, ["title"] = "Second" },
            Context("t2"), new Dictionary<string, long> { ["project"] = 1 }));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "behaviour", "test", "Totals", [
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "project.setTotal", "Set the project total",
                [NendoActionStep.SetField("10-total", NendoActionTarget.Referenced("project"),
                    new NendoActionAssignment("total", "doneCount",
                        [NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done")], []))]),
                revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "10-total", "tasks", "Keep the project total current",
                NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted,
                "project.setTotal", ["done", "project"]), revision),
        ]));
    }
}
