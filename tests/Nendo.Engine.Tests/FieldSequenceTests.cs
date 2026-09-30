namespace Nendo.Engine.Tests;

/// <summary>
/// A numbered field, ADR-0020 stage 2: schema.setFieldSequence on a unique Text field. A create
/// that leaves it empty gets the prefix and the next number inside the same write; the next
/// number is one past the highest ever seen, raised by codes clients write themselves, and never
/// reused. History records the code, so a restore brings the same one back.
/// </summary>
[TestClass]
public sealed class FieldSequenceTests
{
    private const string Entity = "items";

    [TestMethod]
    public async Task ACreateWithoutACodeGetsTheNextOneAfterTheHighestExisting()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        foreach (var (id, code) in new[] { ("a", "W-001"), ("b", "W-003"), ("c", "w-010"), ("d", "X-500"), ("e", "W-12a") })
            await CreateAsync(service, id, code);
        await SequenceAsync(coordinator, service, "W-", 3);

        var created = await CreateAsync(service, "f", null);
        Assert.AreEqual("W-011", Code(await RecordAsync(service, "f")));
        var assigned = created.AssignedValues.Single();
        Assert.AreEqual(("items", "f", "code", "W-011"), (assigned.EntityId, assigned.RecordId, assigned.FieldId, assigned.Value));

        var batch = await service.CreateRecordsAsync(new(Entity,
        [
            new("g", new Dictionary<string, object?> { ["title"] = "G" }, null),
            new("h", new Dictionary<string, object?> { ["title"] = "H", ["code"] = "" }, null),
        ], Context("batch")));
        CollectionAssert.AreEqual(new[] { "W-012", "W-013" }, batch.AssignedValues.Select(value => value.Value).ToArray());
        Assert.AreEqual(new NendoFieldSequence("W-", 3), Field(await service.GetSnapshotAsync()).Sequence);
    }

    [TestMethod]
    public async Task ANumberIsNeverReusedAndAnExplicitCodeRaisesTheCounter()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "F-", 3);
        await CreateAsync(service, "a", null);
        var b = await CreateAsync(service, "b", null);
        Assert.AreEqual("F-002", b.AssignedValues.Single().Value);

        await service.DeleteRecordAsync(new(Entity, "b", 1, Context("delete-b")));
        Assert.AreEqual("F-003", (await CreateAsync(service, "c", null)).AssignedValues.Single().Value, "A deleted record's number stays spent.");

        await CreateAsync(service, "d", "F-050");
        Assert.AreEqual("F-051", (await CreateAsync(service, "e", null)).AssignedValues.Single().Value);
        await service.SetFieldAsync(new(Entity, "a", "code", 1, "f-0100", Context("raise")));
        Assert.AreEqual("F-101", (await CreateAsync(service, "f", null)).AssignedValues.Single().Value, "Case and padding do not hide a number.");

        // The counter is stored, so a reopen carries on from it.
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        coordinator = await workspace.OpenAsync();
        service = new NendoApplicationService(coordinator);
        Assert.AreEqual("F-102", (await CreateAsync(service, "g", null)).AssignedValues.Single().Value);
    }

    [TestMethod]
    public async Task HistoryRecordsTheCodeSoARestoreBringsTheSameOneBack()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "C-", 3);
        await CreateAsync(service, "a", null);
        var deleted = await service.DeleteRecordAsync(new(Entity, "a", 1, Context("delete")));
        await service.CompensateRevisionAsync(deleted.RevisionId, "restore");
        Assert.AreEqual("C-001", Code(await RecordAsync(service, "a")));
        Assert.AreEqual("C-002", (await CreateAsync(service, "b", null)).AssignedValues.Single().Value);
    }

    [TestMethod]
    public async Task ANumberedFieldMayBeRequiredAndTheCreateStillSucceeds()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "W-", 3);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "require", "test", "Require", [new SetFieldRequiredOperation("req", Entity, "code", true, revision)]));
        await CreateAsync(service, "a", null);
        Assert.AreEqual("W-001", Code(await RecordAsync(service, "a")));
    }

    [TestMethod]
    public async Task ASequenceNeedsAUniqueTextFieldAndHoldsItUnique()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service, declareUnique: false);
        Assert.AreEqual("field-sequence-invalid", (await Refused(() => SequenceAsync(coordinator, service, "W-", 3))).Code);
        await UniqueAsync(coordinator, service, "number");
        Assert.AreEqual("field-sequence-invalid", (await Refused(() => SequenceAsync(coordinator, service, "N-", 3, "number"))).Code);
        Assert.ThrowsExactly<NendoValidationException>(() => new SetFieldSequenceOperation("x", Entity, "code", "V2", 3, 0));
        Assert.ThrowsExactly<NendoValidationException>(() => new SetFieldSequenceOperation("x", Entity, "code", "W-", 10, 0));

        await UniqueAsync(coordinator, service, "code");
        await SequenceAsync(coordinator, service, "W-", 3);
        Assert.AreEqual("field-sequence-in-use", (await Refused(() => UniqueAsync(coordinator, service, "code", unique: false))).Code);
        Assert.AreEqual("field-sequence-unchanged", (await Refused(() => SequenceAsync(coordinator, service, "W-", 3))).Code);
    }

    [TestMethod]
    public async Task RemovingASequenceLeavesTheCodesAndUndoingItDoesNotGoBackwards()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "W-", 3);
        await CreateAsync(service, "a", null);
        await CreateAsync(service, "b", null);
        await service.DeleteRecordAsync(new(Entity, "b", 1, Context("delete-b")));

        var removed = await SequenceAsync(coordinator, service, null, null);
        Assert.IsNull(Field(await service.GetSnapshotAsync()).Sequence);
        Assert.AreEqual("W-001", Code(await RecordAsync(service, "a")));
        Assert.IsEmpty((await CreateAsync(service, "c", null)).AssignedValues);

        await service.CompensateRevisionAsync(removed.RevisionId, "undo-remove");
        Assert.AreEqual("W-003", (await CreateAsync(service, "d", null)).AssignedValues.Single().Value,
            "W-002 was handed out before the sequence was removed, and stays spent after it comes back.");
    }

    [TestMethod]
    public async Task AReviewedGeneratedCodeIsStaleIfTheActiveSequenceAdvances()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "W-", 3);
        var preview = await NumberedProposalAsync(service);
        Assert.AreEqual("W-001", await PreviewCodeAsync(coordinator, preview));
        await CreateAsync(service, "active", null);
        var before = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;

        var outcome = await service.PromoteProposalAsync(preview.ProposalId);

        Assert.AreEqual(NendoProposalState.Stale, outcome.State,
            "Acceptance silently replaced the reviewed generated code after its sequence advanced.");
        Assert.IsFalse(outcome.Applied);
        Assert.AreEqual(before, (await service.GetSnapshotAsync()).Manifest.ChangeSequence);
        Assert.IsEmpty((await service.QueryRecordsAsync(new(Entity, 1) { RecordId = "proposed" })).Items);
        Assert.AreEqual("W-001", Code(await RecordAsync(service, "active")));
        Assert.AreEqual("NPROP011", (await service.GetProposalAsync(preview.ProposalId)).Diagnostics.Single().Code);
    }

    [TestMethod]
    public async Task UnrelatedDataWithoutSequenceAllocationKeepsTheReviewedCode()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "W-", 3);
        var preview = await NumberedProposalAsync(service);
        var reviewed = await PreviewCodeAsync(coordinator, preview);
        await CreateAsync(service, "unrelated", "Manual");

        var outcome = await service.PromoteProposalAsync(preview.ProposalId);

        Assert.IsTrue(outcome.Applied, outcome.Message);
        Assert.AreEqual(reviewed, Code(await RecordAsync(service, "proposed")));
        Assert.AreEqual("W-002", (await CreateAsync(service, "next", null)).AssignedValues.Single().Value);
    }

    [TestMethod]
    public async Task ANewSequenceSeedIsStaleWhenItsSourceDataChanges()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var proposalId = $"proposal-{Guid.NewGuid():N}";
        var preview = await service.PrepareProposalAsync(new NendoProposalRequest(proposalId, "Number an item", "test", new([
            new NendoMutation("sequence-proposal", proposalId + "-schema", "test", "Number automatically",
                [new SetFieldSequenceOperation("sequence", Entity, "code", "W-", 3, revision)]),
            new NendoMutation("sequence-proposal", proposalId + "-create", "test", "Create item",
                [new CreateRecordOperation("create", Entity, "proposed", new Dictionary<string, object?> { ["title"] = "Proposed" })]),
        ])));
        Assert.AreEqual("W-001", await PreviewCodeAsync(coordinator, preview));
        await CreateAsync(service, "active", "W-010");

        Assert.AreEqual(NendoProposalState.Stale, (await service.PromoteProposalAsync(preview.ProposalId)).State,
            "A newly installed sequence silently changed its reviewed seed.");
    }

    [TestMethod]
    public async Task ChangingAnExistingSequencePrefixGuardsItsDataDerivedSeed()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "W-", 3);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var id = $"proposal-{Guid.NewGuid():N}";
        var preview = await service.PrepareProposalAsync(new NendoProposalRequest(id, "Change prefix", "test", new([
            new NendoMutation("sequence-proposal", id + "-prefix", "test", "Change prefix",
                [new SetFieldSequenceOperation("prefix", Entity, "code", "X-", 3, revision)]),
            new NendoMutation("sequence-proposal", id + "-create", "test", "Create item",
                [new CreateRecordOperation("create", Entity, "proposed", new Dictionary<string, object?> { ["title"] = "Proposed" })]),
        ])));
        Assert.AreEqual("X-001", await PreviewCodeAsync(coordinator, preview));
        await CreateAsync(service, "active", "X-010");
        Assert.AreEqual(NendoProposalState.Stale, (await service.PromoteProposalAsync(id)).State,
            "Changing a sequence prefix silently reseeded its reviewed code.");
    }

    [TestMethod]
    public async Task RemovingASequenceAfterAllocatingStillGuardsTheReviewedAllocation()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SchemaAsync(coordinator, service);
        await SequenceAsync(coordinator, service, "W-", 3);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var id = $"proposal-{Guid.NewGuid():N}";
        var preview = await service.PrepareProposalAsync(new NendoProposalRequest(id, "Create then stop numbering", "test", new([
            new NendoMutation("sequence-proposal", id + "-create", "test", "Create item",
                [new CreateRecordOperation("create", Entity, "proposed", new Dictionary<string, object?> { ["title"] = "Proposed" })]),
            new NendoMutation("sequence-proposal", id + "-remove", "test", "Stop numbering",
                [new SetFieldSequenceOperation("remove", Entity, "code", null, null, revision)]),
        ])));
        Assert.AreEqual("W-001", await PreviewCodeAsync(coordinator, preview));
        await CreateAsync(service, "active", null);
        Assert.AreEqual(NendoProposalState.Stale, (await service.PromoteProposalAsync(id)).State,
            "Removing a sequence erased its earlier allocation dependency.");
    }

    private static Task<NendoProposalPreview> NumberedProposalAsync(NendoApplicationService service)
    {
        var id = $"proposal-{Guid.NewGuid():N}";
        return service.PrepareProposalAsync(new NendoProposalRequest(id, "Create numbered item", "test", new([
            new NendoMutation("sequence-proposal", id, "test", "Create item",
                [new CreateRecordOperation("create", Entity, "proposed", new Dictionary<string, object?> { ["title"] = "Proposed" })]),
        ])));
    }

    private static async Task<string?> PreviewCodeAsync(NendoWriteCoordinator coordinator, NendoProposalPreview preview)
    {
        Assert.AreEqual(NendoProposalState.Previewable, preview.State);
        await using var clone = await NendoWriteCoordinator.OpenReadOnlyAsync(
            Path.Combine(coordinator.ProposalRoot, preview.ProposalId, "proposal.nendo"));
        return Code(await RecordAsync(new NendoApplicationService(clone), "proposed"));
    }

    private static async Task SchemaAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, bool declareUnique = true)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Items", [
            new CreateEntityOperation("e", Entity, "Items", "items"),
            new AddFieldOperation("f-title", Entity, "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("f-code", Entity, "code", "Code", "code", NendoStorageKind.Text, false),
            new AddFieldOperation("f-number", Entity, "number", "Number", "number", NendoStorageKind.Integer, false),
        ]));
        if (declareUnique) await UniqueAsync(coordinator, service, "code");
    }

    private static async Task<NendoApplyResult> UniqueAsync(NendoWriteCoordinator coordinator, NendoApplicationService service, string field, bool unique = true)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", $"unique-{Guid.NewGuid():N}", "test", "Unique",
            [new SetFieldUniqueOperation($"u-{Guid.NewGuid():N}", Entity, field, unique, revision)]));
    }

    private static async Task<NendoApplyResult> SequenceAsync(NendoWriteCoordinator coordinator, NendoApplicationService service,
        string? prefix, int? width, string field = "code")
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        return await coordinator.ApplyAsync(new("test", $"sequence-{Guid.NewGuid():N}", "test", "Sequence",
            [new SetFieldSequenceOperation($"s-{Guid.NewGuid():N}", Entity, field, prefix, width, revision)]));
    }

    private static Task<NendoApplyResult> CreateAsync(NendoApplicationService service, string id, string? code) =>
        service.CreateRecordAsync(new(Entity, id,
            code is null ? new Dictionary<string, object?> { ["title"] = id.ToUpperInvariant() }
                : new Dictionary<string, object?> { ["title"] = id.ToUpperInvariant(), ["code"] = code },
            Context($"create-{id}-{Guid.NewGuid():N}")));

    private static NendoFieldSnapshot Field(NendoSessionSnapshot snapshot) =>
        snapshot.Entities.Single().Fields.Single(field => field.FieldId == "code");

    private static string? Code(NendoRecordSnapshot record) =>
        record.Values["code"].ValueKind == System.Text.Json.JsonValueKind.String ? record.Values["code"].GetString() : null;

    private static async Task<NendoRecordSnapshot> RecordAsync(NendoApplicationService service, string id) =>
        (await service.QueryRecordsAsync(new(Entity, 1) { RecordId = id })).Items.Single();

    private static Task<NendoPreconditionException> Refused(Func<Task> action) => Assert.ThrowsExactlyAsync<NendoPreconditionException>(action);

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
