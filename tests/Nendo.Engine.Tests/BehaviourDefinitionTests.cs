using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// Stage S1 of ADR-0008: the protected definition store and its canonical shape.
/// These cover what a definition means and how it survives storage — not yet how it
/// evaluates, which arrives with the adapter in S2.
/// </summary>
/// <remarks>
/// Not parallelized. Each case here creates a real <c>.nendo</c> file and drives it
/// through the ordinary coordinator, which is the point — but running dozens of them
/// at once saturates the disk and starves the timing-sensitive process lanes in the
/// other test assemblies. Running them one at a time costs a few seconds and keeps
/// the rest of the suite honest.
/// </remarks>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourDefinitionTests
{
    [TestMethod]
    public async Task DefinitionsRoundTripThroughStorageAndReopenWithoutRewritingTheFile()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "install", "test", "Install behaviour", [
            new SetBehaviourDefinitionOperation("f", Rate(), revision),
            new SetBehaviourDefinitionOperation("c", CompletedTasks(), revision),
            new SetBehaviourDefinitionOperation("a", MarkComplete(), revision),
            new SetBehaviourDefinitionOperation("t", CompletionTrigger(), revision),
        ]));

        var installed = await ReadDefinitionsAsync(workspace.FilePath);
        Assert.HasCount(4, installed);
        Assert.AreEqual(CompletedTasks().CanonicalBody(), installed["project.completedTasks"].CanonicalBody());
        Assert.AreEqual(CompletionTrigger().CanonicalBody(), installed["project.completion"].CanonicalBody());
        Assert.AreEqual(NendoFormat.BehaviourMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var reopened = await workspace.OpenAsync();
        var afterReopen = await ReadDefinitionsAsync(workspace.FilePath);
        Assert.AreEqual(
            JsonSerializer.Serialize(installed.Select(pair => pair.Value.CanonicalBody())),
            JsonSerializer.Serialize(afterReopen.Select(pair => pair.Value.CanonicalBody())));
        await reopened.DisposeAsync();
        workspace.Forget(reopened);
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath),
            "Reopening a file that holds definitions rewrote its bytes.");
    }

    [TestMethod]
    public void CanonicalBodyAndOperationDigestAreDeterministicAndSensitiveToMeaning()
    {
        // Two independently constructed copies of the same definition must digest
        // identically, or a reviewed proposal could not be matched to what it promised.
        Assert.AreEqual(CompletedTasks().CanonicalBody(), CompletedTasks().CanonicalBody());
        Assert.AreEqual(
            Mutation(new SetBehaviourDefinitionOperation("op", CompletedTasks(), 3)).OperationDigest,
            Mutation(new SetBehaviourDefinitionOperation("op", CompletedTasks(), 3)).OperationDigest);

        // Order of declared bindings is part of the definition, not an incidental
        // detail of whichever collection built it.
        var swapped = new NendoCalculationDefinition(
            "project.completedTasks", "projects", "completedTasks", "Completed tasks",
            NendoBehaviourScalar.Integer, false, "doneCount + 0",
            [DoneCount(), TaskCount()]);
        Assert.AreNotEqual(CompletedTasks().CanonicalBody(), swapped.CanonicalBody());

        // A changed expression, result type or expected revision each moves the digest.
        Assert.AreNotEqual(
            Mutation(new SetBehaviourDefinitionOperation("op", CompletedTasks(), 3)).OperationDigest,
            Mutation(new SetBehaviourDefinitionOperation("op", CompletedTasks() with { }, 4)).OperationDigest);
        var retyped = new NendoCalculationDefinition(
            "project.completedTasks", "projects", "completedTasks", "Completed tasks",
            NendoBehaviourScalar.Decimal, false, "doneCount + 0", [TaskCount(), DoneCount()]);
        Assert.AreNotEqual(CompletedTasks().CanonicalBody(), retyped.CanonicalBody());
    }

    [TestMethod]
    public async Task RenamingLabelsLeavesBindingsAndStoredBodiesUntouched()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation(new SetBehaviourDefinitionOperation("c", CompletedTasks(), revision)));
        var before = await ReadDefinitionsAsync(workspace.FilePath);

        var current = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation(new RenameEntityOperation("re", "tasks", "Work items", current)));
        current = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation(new RenameFieldOperation("rf", "tasks", "done", "Finished", current)));

        var after = await ReadDefinitionsAsync(workspace.FilePath);
        Assert.AreEqual(
            before["project.completedTasks"].CanonicalBody(),
            after["project.completedTasks"].CanonicalBody(),
            "A display rename changed a stored definition, so bindings were not held by stable ID.");
    }

    [TestMethod]
    public async Task InvalidAndRecursiveDefinitionsRefuseBeforeAnythingIsInstalled()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var before = await service.GetSnapshotAsync();
        var revision = before.Manifest.DefinitionRevision;

        // A pair that only closes the loop once both are present.
        await Refuse(() => coordinator.ApplyAsync(new("test", "cycle", "test", "Recursive pair", [
            new SetBehaviourDefinitionOperation("a", Function("fn.a", "fn.b"), revision),
            new SetBehaviourDefinitionOperation("b", Function("fn.b", "fn.a"), revision),
        ])));

        // A call with nothing behind it.
        await Refuse(() => coordinator.ApplyAsync(Mutation(
            new SetBehaviourDefinitionOperation("dangling", Function("fn.a", "fn.missing"), revision))));

        // A binding whose declared type does not match the stored field.
        await Refuse(() => coordinator.ApplyAsync(Mutation(new SetBehaviourDefinitionOperation("mistyped",
            new NendoCalculationDefinition("project.bad", "projects", "bad", "Bad", NendoBehaviourScalar.Integer, false,
                "name", [NendoBehaviourBinding.SameRecordField("name", "projects", "projectName", NendoBehaviourScalar.Integer, false)]),
            revision))));

        // A binding naming a field that does not exist.
        Assert.AreEqual("field-not-found", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(Mutation(new SetBehaviourDefinitionOperation("absent",
                new NendoCalculationDefinition("project.bad", "projects", "bad", "Bad", NendoBehaviourScalar.Integer, false,
                    "ghost", [NendoBehaviourBinding.SameRecordField("ghost", "projects", "ghost", NendoBehaviourScalar.Integer, false)]),
                revision))))).Code);

        // A calculated field cannot shadow a stored one.
        await Refuse(() => coordinator.ApplyAsync(Mutation(new SetBehaviourDefinitionOperation("shadow",
            new NendoCalculationDefinition("project.shadow", "projects", "total", "Shadow", NendoBehaviourScalar.Integer, false,
                "1", []),
            revision))));

        // A trigger whose action is missing.
        await Refuse(() => coordinator.ApplyAsync(Mutation(
            new SetBehaviourDefinitionOperation("orphan", CompletionTrigger(), revision))));

        Assert.AreEqual(JsonSerializer.Serialize(before), JsonSerializer.Serialize(await service.GetSnapshotAsync()));
        Assert.IsFalse(await TableExistsAsync(workspace.FilePath, "__nendo_behaviour"),
            "A refused definition created the protected table anyway.");
    }

    [TestMethod]
    public async Task RemovingAReferencedDefinitionRefusesUnlessTheSameReviewRewiresIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "install", "test", "Install", [
            new SetBehaviourDefinitionOperation("a", MarkComplete(), revision),
            new SetBehaviourDefinitionOperation("t", CompletionTrigger(), revision),
        ]));

        var current = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        Assert.AreEqual("definition-referenced", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(Mutation(new RemoveBehaviourDefinitionOperation(
                "rm", "project.markComplete", NendoBehaviourKind.Action, current))))).Code);

        // Removing the trigger first, in the same ordered change set, is accepted.
        await coordinator.ApplyAsync(new("test", "remove-both", "test", "Remove both", [
            new RemoveBehaviourDefinitionOperation("rt", "project.completion", NendoBehaviourKind.Trigger, current),
            new RemoveBehaviourDefinitionOperation("ra", "project.markComplete", NendoBehaviourKind.Action, current),
        ]));
        Assert.IsEmpty(await ReadDefinitionsAsync(workspace.FilePath));

        // Removing something absent, or naming the wrong kind, is refused.
        current = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        Assert.AreEqual("definition-not-found", (await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => coordinator.ApplyAsync(Mutation(new RemoveBehaviourDefinitionOperation(
                "gone", "project.markComplete", NendoBehaviourKind.Action, current))))).Code);
    }

    [TestMethod]
    public async Task AFileWithoutBehaviourNeverGrowsTheProtectedTableOrRaisesItsMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        await Seed(coordinator);
        var snapshot = await new NendoApplicationService(coordinator).GetSnapshotAsync();
        Assert.AreNotEqual(NendoFormat.BehaviourMinimumHostVersion, snapshot.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        var bytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.NormalReadOnly, inspection.Classification);
        await using (var reopened = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath)) { }
        Assert.IsFalse(await TableExistsAsync(workspace.FilePath, "__nendo_behaviour"));
        CollectionAssert.AreEqual(bytes, await File.ReadAllBytesAsync(workspace.FilePath),
            "Opening a file without behaviour wrote to it.");
    }

    [TestMethod]
    public async Task ADefinitionFromANewerContractBlocksEditingAndStaysInspectable()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation(new SetBehaviourDefinitionOperation("c", CompletedTasks(), revision)));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // Stand in for a file written by a later Nendo: the stored contract is one this
        // host does not implement, so it cannot know what the formula means.
        await ExecuteAsync(workspace.FilePath,
            "UPDATE __nendo_behaviour SET contract_version = 'behaviour-99';");

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, inspection.Classification);
        Assert.Contains("behaviour-contract-mismatch", inspection.Findings.Select(finding => finding.Code).ToArray());
        Assert.IsTrue(inspection.Capabilities.ReadData, "An unreadable contract also hid the owner's data.");
        Assert.IsFalse(inspection.Capabilities.Mutate);
    }

    [TestMethod]
    public async Task ADamagedDefinitionBodyIsRefusedRatherThanPartiallyInterpreted()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation(new SetBehaviourDefinitionOperation("c", CompletedTasks(), revision)));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        await ExecuteAsync(workspace.FilePath,
            "UPDATE __nendo_behaviour SET body_json = '{\"displayName\":\"Half a definition\"}';");

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.Contains("behaviour-unreadable", inspection.Findings.Select(finding => finding.Code).ToArray());
        Assert.IsTrue(inspection.Capabilities.ReadData);
        Assert.IsFalse(inspection.Capabilities.Mutate);
    }

    [TestMethod]
    public async Task ACalculatedFieldIsDescribedBesideStoredFieldsWithoutBecomingOne()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await Seed(coordinator);
        Assert.IsEmpty((await service.GetSnapshotAsync()).Entities.Single(e => e.EntityId == "projects").DerivedFields);

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation(new SetBehaviourDefinitionOperation("c", CompletedTasks(), revision)));

        var projects = (await service.GetSnapshotAsync()).Entities.Single(e => e.EntityId == "projects");
        var calculated = projects.DerivedFields.Single();
        Assert.AreEqual("completedTasks", calculated.FieldId);
        Assert.AreEqual("Completed tasks", calculated.DisplayName);
        Assert.AreEqual("project.completedTasks", calculated.CalculationId);
        Assert.AreEqual(NendoBehaviourScalar.Integer, calculated.ResultType);
        Assert.IsFalse(calculated.ResultNullable);

        // It is not a stored field, has no column, and no record carries a value for it.
        Assert.IsFalse(projects.Fields.Any(field => field.FieldId == "completedTasks"),
            "A calculated field appeared as an editable stored field.");
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["projectName"] = "Project", ["total"] = 0L, ["complete"] = false },
            new NendoRequestContext("test", "p1", "test")));
        var record = (await service.GetSnapshotAsync()).Records.Single(r => r.EntityId == "projects");
        Assert.IsFalse(record.Values.ContainsKey("completedTasks"));
    }

    [TestMethod]
    public void TheCodecRefusesAnUnsupportedContractAndAMisshapenBody()
    {
        var body = CompletedTasks().CanonicalBody();
        Assert.ThrowsExactly<NendoValidationException>(() =>
            NendoBehaviourCodec.Read("x", NendoBehaviourKind.Calculation, "behaviour-99", body));
        Assert.ThrowsExactly<NendoValidationException>(() =>
            NendoBehaviourCodec.Read("x", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version, "not json"));
        Assert.ThrowsExactly<NendoValidationException>(() =>
            NendoBehaviourCodec.Read("x", NendoBehaviourKind.Function, NendoBehaviourContract.Version, body));

        // Every shipped definition shape survives the round trip it will take through
        // the protected table.
        foreach (var definition in new NendoBehaviourDefinition[] { Rate(), CompletedTasks(), MarkComplete(), CompletionTrigger() })
        {
            var read = NendoBehaviourCodec.Read(
                definition.DefinitionId, definition.Kind, definition.ContractVersion, definition.CanonicalBody());
            Assert.AreEqual(definition.CanonicalBody(), read.CanonicalBody(), definition.DefinitionId);
        }
    }

    /// <summary>
    /// The refusal is the only way an author learns the shape. A reviewer who sent a
    /// sum three ways — an invented key, no key, the wrong key — was told nothing each
    /// time, and dropped the calculation rather than read this source.
    /// </summary>
    [TestMethod]
    public void AnAuthoredBodyIsRefusedByNamingTheBindingTheKeyAndWhatTheKeyIsFor()
    {
        static string Sum(string fieldKey) => $$"""
            {"entityId":"projects","fieldId":"totalHours","displayName":"Hours","resultType":"Integer","resultNullable":false,
             "expression":"hours","callAliases":[],
             "bindings":[{"bindingId":"hours","kind":"RelatedAggregate","aggregate":"Sum","entityId":"projects",
                          "relatedEntityId":"tasks","relatedReferenceFieldId":"project","resultType":"Integer","nullable":false{{fieldKey}}}]}
            """;
        static string Refusal(string body) => Assert.ThrowsExactly<NendoValidationException>(() =>
            NendoBehaviourCodec.Read("projects.totalHours", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version, body,
                NendoBehaviourBodySource.Authored)).Message;

        var missing = Refusal(Sum(""));
        StringAssert.Contains(missing, "Binding 'hours'");
        StringAssert.Contains(missing, "RelatedAggregate Sum");
        StringAssert.Contains(missing, "needs valueFieldId");
        StringAssert.Contains(missing, "the Integer or Decimal field it totals");

        var invented = Refusal(Sum(",\"aggregateFieldId\":\"hours\""));
        StringAssert.Contains(invented, "does not define: aggregateFieldId");
        StringAssert.Contains(invented, "valueFieldId", "The refusal of a wrong key lists the right ones.");

        var wrongKind = Refusal(Sum(",\"valueFieldId\":\"hours\"").Replace("\"Sum\"", "\"Total\""));
        StringAssert.Contains(wrongKind, "'Total'");
        StringAssert.Contains(wrongKind, "Count, FilteredCount, Sum");

        var stray = Refusal(Sum(",\"valueFieldId\":\"hours\"").Replace("\"callAliases\":[],", "\"callAliases\":[],\"aggregateFieldId\":\"x\","));
        StringAssert.Contains(stray, "does not define in its Calculation body: aggregateFieldId");

        // The right key reads. And the same body, read back as a stored one, gets the
        // stored remedy instead — a damaged file is inspected, not corrected.
        NendoBehaviourCodec.Read("projects.totalHours", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version,
            Sum(",\"valueFieldId\":\"hours\""), NendoBehaviourBodySource.Authored);
        var stored = Assert.ThrowsExactly<NendoValidationException>(() =>
            NendoBehaviourCodec.Read("projects.totalHours", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version, Sum("")));
        StringAssert.Contains(stored.Message, "inspect the file before editing it");
    }

    [TestMethod]
    public void GraphValidationRejectsDepthAndSelfReferenceWithoutTouchingStorage()
    {
        var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
        for (var index = 0; index < 10; index++)
        {
            var next = index == 9 ? null : $"fn.{index + 1}";
            definitions[$"fn.{index}"] = Function($"fn.{index}", next);
        }
        Assert.ThrowsExactly<NendoValidationException>(() => NendoBehaviourGraph.ValidateCandidate(definitions));

        var shallow = definitions.Where(pair => int.Parse(pair.Key[3..]) >= 4)
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        NendoBehaviourGraph.ValidateCandidate(shallow);

        Assert.ThrowsExactly<NendoValidationException>(() => Function("fn.self", "fn.self").Validate());
    }

    private static NendoFunctionDefinition Rate() => new(
        "fn.rate", "Rate",
        [new NendoFunctionParameter("a", "Numerator", NendoBehaviourScalar.Decimal, false),
         new NendoFunctionParameter("b", "Denominator", NendoBehaviourScalar.Decimal, false)],
        NendoBehaviourScalar.Decimal, false, "a / b");

    private static NendoFunctionDefinition Function(string id, string? calls) => new(
        id, id, [], NendoBehaviourScalar.Integer, false, calls is null ? "1" : "next(1)",
        calls is null ? [] : [new NendoFunctionCallAlias("next", calls)]);

    private static NendoBehaviourBinding TaskCount() =>
        NendoBehaviourBinding.RelatedCount("taskCount", "projects", "tasks", "project");

    private static NendoBehaviourBinding DoneCount() =>
        NendoBehaviourBinding.RelatedFilteredCount("doneCount", "projects", "tasks", "project", "done");

    private static NendoCalculationDefinition CompletedTasks() => new(
        "project.completedTasks", "projects", "completedTasks", "Completed tasks",
        NendoBehaviourScalar.Integer, false, "doneCount + 0", [TaskCount(), DoneCount()]);

    private static NendoActionDefinition MarkComplete() => new(
        "project.markComplete", "Mark the project complete",
        [NendoActionStep.SetField("20-complete", NendoActionTarget.Referenced("project"),
            new NendoActionAssignment("complete", "true"))]);

    private static NendoTriggerDefinition CompletionTrigger() => new(
        "project.completion", "tasks", "Update completion when a task changes",
        NendoTriggerEvents.Created | NendoTriggerEvents.Updated | NendoTriggerEvents.Deleted,
        "project.markComplete", ["done"]);

    private static async Task Seed(NendoWriteCoordinator coordinator)
    {
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects and tasks", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "projectName", "Name", "project_name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-total", "projects", "total", "Total", "total", NendoStorageKind.Integer, true),
            new AddFieldOperation("p-complete", "projects", "complete", "Complete", "complete", NendoStorageKind.Boolean, true),
            new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
            new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
            new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, true),
            new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
            new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "projectName", 0),
        ]));
    }

    private static NendoMutation Mutation(NendoOperation operation) =>
        new("test", operation.OperationId, "test", operation.OperationType, [operation]);

    private static async Task Refuse(Func<Task> action) =>
        await Assert.ThrowsExactlyAsync<NendoValidationException>(action);

    private static async Task<Dictionary<string, NendoBehaviourDefinition>> ReadDefinitionsAsync(string path)
    {
        var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
        if (!await TableExistsAsync(path, "__nendo_behaviour")) return definitions;
        await using var connection = new SqliteConnection($"Data Source={path};Mode=ReadOnly;Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT definition_id, definition_kind, contract_version, body_json FROM __nendo_behaviour ORDER BY definition_id;";
        await using var rows = await command.ExecuteReaderAsync();
        while (await rows.ReadAsync())
        {
            definitions.Add(rows.GetString(0), NendoBehaviourCodec.Read(
                rows.GetString(0), Enum.Parse<NendoBehaviourKind>(rows.GetString(1)), rows.GetString(2), rows.GetString(3)));
        }
        return definitions;
    }

    private static async Task<bool> TableExistsAsync(string path, string table)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Mode=ReadOnly;Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = @name;";
        command.Parameters.AddWithValue("@name", table);
        return Convert.ToInt64(await command.ExecuteScalarAsync()) > 0;
    }

    private static async Task ExecuteAsync(string path, string sql)
    {
        await using var connection = new SqliteConnection($"Data Source={path};Pooling=False");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync();
    }
}
