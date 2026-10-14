using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// schema.setReferenceLabel (ADR-0003, 2026-10-14 note, W-232): a bound reference shows its
/// records by another active Text field of its target. Since ESS-09 the label field cannot be
/// retired, and before this operation nothing could move a bound reference off it.
/// </summary>
[TestClass]
public sealed class ReferenceLabelTests
{
    [TestMethod]
    public async Task AChangedLabelShowsTheRecordsByTheNewFieldMovesNoValueAndFreesTheOldOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);
        var before = (await service.GetSnapshotAsync()).Records.OrderBy(record => record.RecordId, StringComparer.Ordinal).ToArray();
        Assert.AreEqual("Apollo", Task(before).ReferenceLabels["project"]);

        await Relabel(coordinator, service, "code");

        var snapshot = await service.GetSnapshotAsync();
        var after = snapshot.Records.OrderBy(record => record.RecordId, StringComparer.Ordinal).ToArray();
        Assert.AreEqual("APL", Task(after).ReferenceLabels["project"], "A record read still shows the project by its old label.");
        var queried = (await service.QueryRecordsAsync(new("tasks"))).Items.Single();
        Assert.AreEqual("APL", queried.ReferenceLabels["project"], "A reference column still shows the project by its old label.");
        Assert.AreEqual("code", snapshot.Entities.Single(entity => entity.EntityId == "tasks").Fields
            .Single(field => field.FieldId == "project").Reference?.LabelFieldId, "A picker reads the label field from the definition, which did not move.");
        // No stored value moves: every record keeps its version and its values.
        Assert.HasCount(before.Length, after);
        for (var index = 0; index < before.Length; index++)
        {
            Assert.AreEqual(before[index].RecordVersion, after[index].RecordVersion, $"{before[index].RecordId} changed version.");
            CollectionAssert.AreEquivalent(before[index].Values.Keys.ToArray(), after[index].Values.Keys.ToArray());
            foreach (var (key, value) in before[index].Values)
                Assert.IsTrue(JsonElement.DeepEquals(value, after[index].Values[key]), $"{before[index].RecordId}.{key} changed.");
        }
        Assert.AreEqual(NendoFormat.ReferenceLabelMinimumHostVersion, snapshot.Manifest.MinimumHostVersion);

        // The old label is no longer held by reference-label-in-use.
        await Retire(coordinator, service, "name");
        Assert.IsTrue((await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "projects").Fields
            .Single(field => field.FieldId == "name").Retired);
    }

    [TestMethod]
    public async Task AnUnboundOrRetiredReferenceIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);

        var unbound = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Relabel(coordinator, service, "code", fieldId: "loose"),
            "An unbound reference was given a label without a target.");
        Assert.AreEqual("reference-unbound", unbound.Code);
        StringAssert.Contains(unbound.Message, "schema.configureReference", StringComparison.Ordinal);

        await coordinator.ApplyAsync(new("test", "retire-project", "test", "Retire",
            [new SetRetiredOperation("retire-project", "tasks", "project", true, await RevisionAsync(service))]));
        var retired = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Relabel(coordinator, service, "code"),
            "A retired reference was relabelled.");
        Assert.AreEqual("field-retired", retired.Code);
        await AssertLabelAsync(service, "name");
    }

    [TestMethod]
    [DataRow("budget", DisplayName = "a number on the target")]
    [DataRow("archived", DisplayName = "a retired text field on the target")]
    [DataRow("title", DisplayName = "a text field of another record type")]
    [DataRow("missing", DisplayName = "no field at all")]
    public async Task ALabelThatIsNotAnActiveTextFieldOnTheTargetIsRefused(string labelFieldId)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);

        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => Relabel(coordinator, service, labelFieldId),
            $"{labelFieldId} was accepted as the label of Tasks.Project.");
        StringAssert.Contains(refused.Message, "A reference label must be an active text field on its target record type", StringComparison.Ordinal);
        await AssertLabelAsync(service, "name");
    }

    [TestMethod]
    public async Task AnUnchangedLabelAndAStaleRevisionAreRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);
        var revision = await RevisionAsync(service);

        var unchanged = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Relabel(coordinator, service, "name"),
            "Setting the label a reference already has recorded a change that changed nothing.");
        Assert.AreEqual("reference-label-unchanged", unchanged.Code);
        StringAssert.Contains(unchanged.Message, "Tasks.Project already shows Projects by Name", StringComparison.Ordinal);

        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Relabel(coordinator, service, "code", revision: revision - 1),
            "A label change written against an older definition was applied.");
        Assert.AreEqual("definition-version-conflict", stale.Code);
        await AssertLabelAsync(service, "name");
        Assert.AreEqual(revision, await RevisionAsync(service), "A refused label change moved the definition.");
    }

    [TestMethod]
    public async Task HistoryOffersUndoAndTheUndoPutsTheOldLabelBack()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);

        var changed = await Relabel(coordinator, service, "code");
        var offered = (await service.QueryHistoryAsync(new(1))).Items[0];
        Assert.AreEqual(changed.RevisionId, offered.RevisionId);
        Assert.IsTrue(offered.CanRequestCompensation, "History offers no Undo for a changed reference label.");

        await service.CompensateRevisionAsync(changed.RevisionId, "undo-relabel");
        await AssertLabelAsync(service, "name");
        Assert.AreEqual("Apollo", (await service.GetSnapshotAsync()).Records.Single(record => record.EntityId == "tasks").ReferenceLabels["project"]);
        // The undo is a label change again, so Name is held once more.
        var held = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Retire(coordinator, service, "name"));
        Assert.AreEqual("reference-label-in-use", held.Code);
    }

    [TestMethod]
    public async Task TheDeadEndsNameTheOperation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);

        var held = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Retire(coordinator, service, "name"));
        Assert.AreEqual("reference-label-in-use", held.Code);
        StringAssert.Contains(held.Message, "with schema.setReferenceLabel first", StringComparison.Ordinal);

        var compiled = new NendoSemanticCompiler().Compile(BoardSource(retireLabel: true));
        var diagnostic = compiled.Diagnostics.Single(value => value.Code == "NUI239");
        StringAssert.Contains(diagnostic.Hint, "schema.setReferenceLabel", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AProposalSaysWhatTheLabelChangesFromAndTo()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);

        using var payload = JsonDocument.Parse($$"""{"entityId":"tasks","fieldId":"project","labelFieldId":"code","expectedDefinitionRevision":{{await RevisionAsync(service)}}}""");
        var preview = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Show projects by code", "test", new NendoCanonicalChangeSetRequest([
                new NendoCanonicalMutationRequest("label-test", "proposal-label", "test", "Show projects by code", [
                    new NendoCanonicalOperationRequest("op-label", "schema.setReferenceLabel", payload.RootElement.Clone()),
                ]),
            ])));
        var line = preview.SemanticDiff.Single(entry => entry.Kind == "setReferenceLabel");
        Assert.AreEqual("Show Tasks.Project's records by Code instead of Name. Every stored value stays as it is.", line.Summary);
        Assert.AreEqual(NendoReversibilityClass.ReversibleWithRetainedState, line.Reversibility);
        Assert.IsTrue((await service.PromoteProposalAsync(preview.ProposalId)).Applied);
        await AssertLabelAsync(service, "code");
    }

    /// <summary>
    /// A retired reference, or one on a retired record type, draws and groups nothing and cannot be
    /// relabelled (field-retired, entity-retired), so it does not hold its label: the refusal's own
    /// advice would be refused, and the way out was three proposals (P8, P9).
    /// </summary>
    [TestMethod]
    [DataRow(false, DisplayName = "the reference is retired")]
    [DataRow(true, DisplayName = "its record type is retired")]
    public async Task ARetiredReferenceDoesNotHoldItsLabel(bool retireType)
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);
        var key = $"retire-holder-{Guid.NewGuid():N}";
        await coordinator.ApplyAsync(new("test", key, "test", "Retire the holder",
            [new SetRetiredOperation(key, "tasks", retireType ? null : "project", true, await RevisionAsync(service))]));
        var relabel = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => Relabel(coordinator, service, "code"));
        Assert.AreEqual(retireType ? "entity-retired" : "field-retired", relabel.Code);

        await Retire(coordinator, service, "name");
        Assert.IsTrue((await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "projects").Fields
            .Single(field => field.FieldId == "name").Retired, "A retired reference kept its label from retirement, though nothing could move it.");
    }

    /// <summary>A definition change after the label change leaves its undo unoffered and refused (P4).</summary>
    [TestMethod]
    public async Task ALaterDefinitionChangeEndsTheUndo()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);
        var changed = await Relabel(coordinator, service, "code");
        var rename = $"rename-{Guid.NewGuid():N}";
        await coordinator.ApplyAsync(new("test", rename, "test", "Rename",
            [new RenameFieldOperation(rename, "projects", "budget", "Funding", await RevisionAsync(service))]));

        var history = (await service.QueryHistoryAsync(new(5))).Items;
        Assert.IsFalse(history.Single(item => item.RevisionId == changed.RevisionId).CanRequestCompensation,
            "History offers to undo a label change the definition has moved past.");
        var refused = await Assert.ThrowsExactlyAsync<NendoCompensationNotSupportedException>(
            () => service.CompensateRevisionAsync(changed.RevisionId, "undo-late"));
        StringAssert.Contains(refused.Message, "Only the latest change to the file's structure can be undone", StringComparison.Ordinal);
        await AssertLabelAsync(service, "code");
    }

    /// <summary>
    /// Relabel and retire the old label in one mutation applies, as one revision History does not
    /// offer to undo (P2); the other order is refused, since the label is still held when the
    /// retirement runs (P3).
    /// </summary>
    [TestMethod]
    public async Task RelabelThenRetireInOneMutationAppliesAndTheOtherOrderIsRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);
        var revision = await RevisionAsync(service);

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(new("test", "retire-first", "test", "Retire then relabel", [
            new SetRetiredOperation("retire-first-a", "projects", "name", true, revision),
            new SetReferenceLabelOperation("retire-first-b", "tasks", "project", "code", revision),
        ])), "Name was retired while Tasks.Project still showed Projects by it.");
        Assert.AreEqual("reference-label-in-use", refused.Code);
        await AssertLabelAsync(service, "name");

        var applied = await coordinator.ApplyAsync(new("test", "relabel-first", "test", "Relabel then retire", [
            new SetReferenceLabelOperation("relabel-first-a", "tasks", "project", "code", revision),
            new SetRetiredOperation("relabel-first-b", "projects", "name", true, revision),
        ]));
        await AssertLabelAsync(service, "code");
        Assert.IsTrue((await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "projects").Fields
            .Single(field => field.FieldId == "name").Retired);
        Assert.IsFalse((await service.QueryHistoryAsync(new(1))).Items.Single(item => item.RevisionId == applied.RevisionId).CanRequestCompensation,
            "History offers to undo two definition changes in one revision, which no inverse reverses.");
    }

    /// <summary>A file that never changes a label keeps the rung it had (P1).</summary>
    [TestMethod]
    public async Task AFileThatNeverRelabelsStaysBelowTheRung()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SeedAsync(service, coordinator);
        await Retire(coordinator, service, "code");
        var stated = Version.Parse((await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
        Assert.IsLessThan(Version.Parse(NendoFormat.ReferenceLabelMinimumHostVersion), stated,
            $"A file that never changed a label states host {stated}.");
    }

    private static NendoRecordSnapshot Task(IEnumerable<NendoRecordSnapshot> records) => records.Single(record => record.EntityId == "tasks");

    private static async Task<long> RevisionAsync(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;

    private static async Task<NendoApplyResult> Relabel(NendoWriteCoordinator coordinator, NendoApplicationService service, string labelFieldId,
        string fieldId = "project", long? revision = null)
    {
        var key = $"relabel-{Guid.NewGuid():N}";
        return await coordinator.ApplyAsync(new("test", key, "test", "Change the label",
            [new SetReferenceLabelOperation(key, "tasks", fieldId, labelFieldId, revision ?? await RevisionAsync(service))]));
    }

    private static async Task<NendoApplyResult> Retire(NendoWriteCoordinator coordinator, NendoApplicationService service, string fieldId)
    {
        var key = $"retire-{Guid.NewGuid():N}";
        return await coordinator.ApplyAsync(new("test", key, "test", "Retire",
            [new SetRetiredOperation(key, "projects", fieldId, true, await RevisionAsync(service))]));
    }

    private static async Task AssertLabelAsync(NendoApplicationService service, string expected) =>
        Assert.AreEqual(expected, (await service.GetSnapshotAsync()).Entities.Single(entity => entity.EntityId == "tasks").Fields
            .Single(field => field.FieldId == "project").Reference?.LabelFieldId);

    private static async Task SeedAsync(NendoApplicationService service, NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-code", "projects", "code", "Code", "code", NendoStorageKind.Text, false),
            new AddFieldOperation("p-budget", "projects", "budget", "Budget", "budget", NendoStorageKind.Integer, false),
            new AddFieldOperation("p-archived", "projects", "archived", "Archived note", "archived", NendoStorageKind.Text, false),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, false),
            new AddFieldOperation("t-loose", "tasks", "loose", "Loose", "loose_id", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
        ]));
        await coordinator.ApplyAsync(new("test", "retire-archived", "test", "Retire",
            [new SetRetiredOperation("retire-archived", "projects", "archived", true, await RevisionAsync(service))]));
        await service.CreateRecordAsync(new("projects", "apollo",
            new Dictionary<string, object?> { ["name"] = "Apollo", ["code"] = "APL", ["budget"] = 12L }, new("test", "create-apollo", "test")));
        await service.CreateRecordAsync(new("tasks", "launch",
            new Dictionary<string, object?> { ["title"] = "Launch", ["project"] = "apollo" }, new("test", "create-launch", "test"),
            new Dictionary<string, long> { ["project"] = 1 }));
    }

    private static NendoSessionSnapshot BoardSource(bool retireLabel)
    {
        var now = new DateTimeOffset(2026, 10, 14, 8, 0, 0, TimeSpan.Zero);
        var nodes = new NendoUiNodeSnapshot[]
        {
            new("task-surface", "board", null, "boardSurface", 0, new Dictionary<string, JsonElement>(StringComparer.Ordinal)
            {
                ["definitionVersion"] = JsonSerializer.SerializeToElement(NendoSemanticVocabulary.ContractVersion),
                ["entityId"] = JsonSerializer.SerializeToElement("task"),
                ["groupByFieldId"] = JsonSerializer.SerializeToElement("t-client"),
            }),
            new("task-surface", "b1", "board", "fieldBinding", 0, new Dictionary<string, JsonElement>(StringComparer.Ordinal)
            {
                ["fieldId"] = JsonSerializer.SerializeToElement("t-title"),
            }),
        };
        return new NendoSessionSnapshot(
            "boards.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ReferenceBoardMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [
                new NendoEntitySnapshot("client", "Client",
                [
                    new("c-name", "Name", NendoStorageKind.Text, true, "singleLine", []) { Retired = retireLabel },
                ]),
                new NendoEntitySnapshot("task", "Task",
                [
                    new("t-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
                    new("t-client", "Client", NendoStorageKind.Reference, false, null, [])
                    {
                        Reference = new NendoReferenceDefinition("client", "c-name"),
                    },
                ]),
            ],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }
}
