using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Tests;

/// <summary>
/// How a formula's call reaches a reusable function: the name it resolves to and
/// the arguments it is given. Review findings R-004 and R-011.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourFunctionCallTests
{
    // The analyzer types an alias that shares a built-in's name as the
    // author's function; the evaluator must then run that function, not the built-in.
    [TestMethod]
    public void AnAliasNamedLikeABuiltInRunsTheAuthorsFunctionWithTheSameSignature()
    {
        var adapter = new NendoExpressionAdapter();
        var custom = Function(adapter, "custom.length", "99", false, new BehaviourParameter("value", NendoBehaviourScalar.Text, false));
        var caller = Caller(adapter, "TextLength('abc')", ("TextLength", custom));

        var result = adapter.Calculate(caller, new Dictionary<string, BehaviourValue>(), Budget());
        Assert.AreEqual(NendoBehaviourScalar.Integer, result.Type);
        Assert.AreEqual(99L, result.Boxed, "The built-in TextLength ran in place of the function validation selected.");
    }

    [TestMethod]
    public void AnAliasNamedLikeABuiltInRunsTheAuthorsFunctionWithADifferentSignature()
    {
        var adapter = new NendoExpressionAdapter();
        // Two numbers in, a number out: a shape the built-in TextLength would refuse.
        var product = Function(adapter, "custom.product", "a * b", false,
            new BehaviourParameter("a", NendoBehaviourScalar.Integer, false),
            new BehaviourParameter("b", NendoBehaviourScalar.Integer, false));
        var caller = Caller(adapter, "TextLength(6, 7)", ("TextLength", product));
        Assert.AreEqual(NendoBehaviourScalar.Integer, caller.ResultType);
        Assert.AreEqual(42L, adapter.Calculate(caller, new Dictionary<string, BehaviourValue>(), Budget()).Boxed);

        // A different result kind too: the analyzer typed this as text, so text it is.
        var label = Function(adapter, "custom.label", "'custom'", false, new BehaviourParameter("value", NendoBehaviourScalar.Text, false));
        var labelled = Caller(adapter, "Concat(TextLength('abc'), '!')", ("TextLength", label));
        Assert.AreEqual(NendoBehaviourScalar.Text, labelled.ResultType);
        Assert.AreEqual("custom!", adapter.Calculate(labelled, new Dictionary<string, BehaviourValue>(), Budget()).Boxed);

        // Without the alias the built-in is what the name means.
        var builtIn = Caller(adapter, "TextLength('abc')");
        Assert.AreEqual(3L, adapter.Calculate(builtIn, new Dictionary<string, BehaviourValue>(), Budget()).Boxed);
    }

    [TestMethod]
    public async Task AnActionRunsTheAliasedFunctionValidationSelected()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("schema",
            new CreateEntityOperation("entity", "items", "Items", "items"),
            new AddFieldOperation("title", "items", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("size", "items", "size", "Size", "size", NendoStorageKind.Integer, false)));
        await service.CreateRecordAsync(new("items", "r1", new Dictionary<string, object?> { ["title"] = "Before" }, Context("r1")));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("behaviour",
            new SetBehaviourDefinitionOperation("f", new NendoFunctionDefinition(
                "fn.size", "Size",
                [new NendoFunctionParameter("value", "Value", NendoBehaviourScalar.Text, false)],
                NendoBehaviourScalar.Integer, false, "99"), revision),
            new SetBehaviourDefinitionOperation("a", new NendoActionDefinition(
                "items.size", "Record the size",
                [NendoActionStep.SetField("write-size", NendoActionTarget.EventRecord,
                    new NendoActionAssignment("size", "TextLength(title)",
                        [NendoBehaviourBinding.SameRecordField("title", "items", "title", NendoBehaviourScalar.Text, false)],
                        [new NendoFunctionCallAlias("TextLength", "fn.size")]))]), revision),
            new SetBehaviourDefinitionOperation("t", new NendoTriggerDefinition(
                "items.size.trigger", "items", "Keep the size current",
                NendoTriggerEvents.Updated, "items.size", ["title"]), revision)));
        TestBehaviourAuthority.Approving(coordinator);

        var version = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "r1").RecordVersion;
        await service.SetFieldAsync(new("items", "r1", "title", version, "After", Context("edit")));

        var record = (await service.GetSnapshotAsync()).Records.Single(candidate => candidate.RecordId == "r1");
        Assert.AreEqual(99L, record.Values["size"].GetInt64(),
            "The action stored the built-in's answer (5) rather than the aliased function's.");
    }

    // A parameter declared nullable takes an empty argument as a typed empty.
    [TestMethod]
    public void ANullableParameterTakesAnEmptyArgumentTheFunctionNeverReads()
    {
        var adapter = new NendoExpressionAdapter();
        var constant = Function(adapter, "nullable.constant", "7", false, new BehaviourParameter("x", NendoBehaviourScalar.Integer, true));
        var caller = Caller(adapter, "F(x)", [new BehaviourParameter("x", NendoBehaviourScalar.Integer, true)], ("F", constant));

        var result = adapter.Calculate(caller, Values(("x", BehaviourValue.Empty(NendoBehaviourScalar.Integer))), Budget());
        Assert.AreEqual(7L, result.Boxed);
    }

    [TestMethod]
    public void ANullableParameterOnABranchNotTakenDoesNotStopTheFunction()
    {
        var adapter = new NendoExpressionAdapter();
        var choose = Function(adapter, "nullable.choose", "flag ? 7 : x + 1", false,
            new BehaviourParameter("flag", NendoBehaviourScalar.Boolean, false),
            new BehaviourParameter("x", NendoBehaviourScalar.Integer, true));
        var caller = Caller(adapter, "F(flag, x)",
            [new BehaviourParameter("flag", NendoBehaviourScalar.Boolean, false), new BehaviourParameter("x", NendoBehaviourScalar.Integer, true)],
            ("F", choose));

        var empty = BehaviourValue.Empty(NendoBehaviourScalar.Integer);
        Assert.AreEqual(7L, adapter.Calculate(caller, Values(("flag", BehaviourValue.Boolean(true)), ("x", empty)), Budget()).Boxed);
        Assert.AreEqual(5L, adapter.Calculate(caller, Values(("flag", BehaviourValue.Boolean(false)), ("x", BehaviourValue.Integer(4))), Budget()).Boxed);

        // Short-circuited Boolean control: the empty is never read.
        var either = Function(adapter, "nullable.either", "flag or x > 0", false,
            new BehaviourParameter("flag", NendoBehaviourScalar.Boolean, false),
            new BehaviourParameter("x", NendoBehaviourScalar.Integer, true));
        var eitherCaller = Caller(adapter, "F(flag, x)",
            [new BehaviourParameter("flag", NendoBehaviourScalar.Boolean, false), new BehaviourParameter("x", NendoBehaviourScalar.Integer, true)],
            ("F", either));
        Assert.IsTrue((bool)adapter.Calculate(eitherCaller, Values(("flag", BehaviourValue.Boolean(true)), ("x", empty)), Budget()).Boxed!);
    }

    [TestMethod]
    public void ANullableParameterUsedInArithmeticStopsTheFunctionAsAnEmptyOperand()
    {
        var adapter = new NendoExpressionAdapter();
        var empty = BehaviourValue.Empty(NendoBehaviourScalar.Integer);
        var callerParameters = new[] { new BehaviourParameter("x", NendoBehaviourScalar.Integer, true) };

        // Declared always to answer: the empty operand is the missing-input error.
        var strict = Function(adapter, "nullable.strict", "x + 1", false, new BehaviourParameter("x", NendoBehaviourScalar.Integer, true));
        var strictCaller = Caller(adapter, "F(x)", callerParameters, ("F", strict));
        var failure = Assert.ThrowsExactly<NendoCalculationException>(
            () => adapter.Calculate(strictCaller, Values(("x", empty)), Budget()));
        Assert.AreEqual(NendoCalculationCodes.MissingInput, failure.Code);

        // Declared to allow an empty result: the function answers a typed empty, and
        // the caller reads it as an empty argument of that type.
        var optional = Function(adapter, "nullable.optional", "x + 1", true, new BehaviourParameter("x", NendoBehaviourScalar.Integer, true));
        var optionalCaller = Caller(adapter, "F(x)", callerParameters, true, ("F", optional));
        var result = adapter.Calculate(optionalCaller, Values(("x", empty)), Budget());
        Assert.IsTrue(result.IsNull);
        Assert.AreEqual(NendoBehaviourScalar.Integer, result.Type);
        Assert.AreEqual(3L, adapter.Calculate(optionalCaller, Values(("x", BehaviourValue.Integer(2))), Budget()).Boxed);
    }

    [TestMethod]
    public void ANonNullableParameterStillRefusesAnEmptyArgument()
    {
        var adapter = new NendoExpressionAdapter();
        var constant = Function(adapter, "strict.constant", "7", false, new BehaviourParameter("x", NendoBehaviourScalar.Integer, false));
        var caller = Caller(adapter, "F(x)", [new BehaviourParameter("x", NendoBehaviourScalar.Integer, true)], ("F", constant));

        var failure = Assert.ThrowsExactly<NendoCalculationException>(
            () => adapter.Calculate(caller, Values(("x", BehaviourValue.Empty(NendoBehaviourScalar.Integer))), Budget()));
        Assert.AreEqual(NendoCalculationCodes.MissingInput, failure.Code);
        StringAssert.Contains(failure.Message, "'x' is empty");
    }

    private static ValidatedExpression Function(
        NendoExpressionAdapter adapter, string id, string source, bool resultNullable, params BehaviourParameter[] parameters) =>
        adapter.Validate(new BehaviourFormula(id, source, parameters, new Dictionary<string, ValidatedExpression>(), resultNullable), Budget());

    private static ValidatedExpression Caller(
        NendoExpressionAdapter adapter, string source, params (string Alias, ValidatedExpression Target)[] calls) =>
        Caller(adapter, source, [], false, calls);

    private static ValidatedExpression Caller(
        NendoExpressionAdapter adapter, string source, BehaviourParameter[] parameters,
        params (string Alias, ValidatedExpression Target)[] calls) =>
        Caller(adapter, source, parameters, false, calls);

    private static ValidatedExpression Caller(
        NendoExpressionAdapter adapter, string source, BehaviourParameter[] parameters, bool resultNullable,
        params (string Alias, ValidatedExpression Target)[] calls) =>
        adapter.Validate(new BehaviourFormula("caller", source, parameters,
            calls.ToDictionary(call => call.Alias, call => call.Target, StringComparer.Ordinal), resultNullable), Budget());

    // A function's declared result is its published signature, so installing a formula
    // of another kind is refused naming the function, and so is a definition that calls one,
    // rather than typing its callers by the formula and blaming a calculation that trusted it.
    [TestMethod]
    public async Task InstallingAFunctionWhoseFormulaIsNotItsDeclaredKindIsRefusedNamingTheFunction()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SizedItemsAsync(coordinator, service);

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(Mutation("label",
            new SetBehaviourDefinitionOperation("f", new NendoFunctionDefinition("fn.label", "Label",
                [new NendoFunctionParameter("x", "X", NendoBehaviourScalar.Integer, false)], NendoBehaviourScalar.Integer, false, "Concat('n', 'o')"), revision),
            new SetBehaviourDefinitionOperation("c", SizeCalculation("calc.t", "t", NendoBehaviourScalar.Text, "label(size)", "label", "fn.label"), revision))),
            "A function declared integer with a text formula installed, and its callers were typed by the formula.");
        StringAssert.Contains(refused.Message, "Function 'fn.label' declares integer but its formula produces text.");
    }

    // A file a host wrote before installation checked declarations keeps working: the
    // check runs where a definition is installed, never on the open and save every file compiles.
    // A stored function whose formula is not its declared kind is read by its formula, as it was,
    // and its callers and every other calculation still compute; only a new caller is refused.
    [TestMethod]
    public async Task AStoredFunctionOfTheWrongKindStillComputesAndADataWriteStillCommits()
    {
        await using var workspace = new EngineTestWorkspace();
        var (coordinator, service) = await StoredTwiceAsync(workspace, "Text");

        var item = await Item(service);
        Assert.AreEqual(8L, Calculated(item, "twice"), "The caller of a stored function of the wrong kind stopped computing.");
        Assert.AreEqual(5L, Calculated(item, "next"), "A calculation that calls no function stopped computing.");
        await service.SetFieldAsync(new("items", "r1", "size", item.RecordVersion, 5L, Context("edit")));
        item = await Item(service);
        Assert.AreEqual(10L, Calculated(item, "twice"));
        Assert.AreEqual(6L, Calculated(item, "next"));

        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() => coordinator.ApplyAsync(Mutation("caller",
            new SetBehaviourDefinitionOperation("thrice", SizeCalculation("calc.thrice", "thrice", NendoBehaviourScalar.Integer, "twice(size) + size", "twice", "fn.twice"), revision))));
        StringAssert.Contains(refused.Message, "'calc.thrice' calls 'fn.twice', which declares text but whose formula produces integer.");
    }

    // A function declared decimal over a
    // whole-number formula, called by a calculation declared integer. Reading every caller as the
    // declaration made that calculation a decimal one, so after a reopen every calculation
    // vanished and every data write failed with "'calc.twice' declares integer but its formula
    // produces decimal". An integer caller reads the whole number the formula produces.
    [TestMethod]
    public async Task AStoredDecimalFunctionOverAWholeNumberStillServesAnIntegerCaller()
    {
        await using var workspace = new EngineTestWorkspace();
        var (_, service) = await StoredTwiceAsync(workspace, "Decimal");

        var item = await Item(service);
        Assert.AreEqual(8L, Calculated(item, "twice"), "An integer caller of a decimal-declared function stopped computing after a reopen.");
        Assert.AreEqual(5L, Calculated(item, "next"));
        await service.SetFieldAsync(new("items", "r1", "size", item.RecordVersion, 5L, Context("edit")));
        item = await Item(service);
        Assert.AreEqual(10L, Calculated(item, "twice"));
        Assert.AreEqual(6L, Calculated(item, "next"));
    }

    // A whole-number body under a decimal declaration loses nothing, and its callers
    // compute in decimal as the signature says, so a total past Int64 is answered, not an overflow.
    [TestMethod]
    public void AWholeNumberBodyDeclaredDecimalIsCalledAsADecimal()
    {
        var definitions = Definitions(
            new NendoFunctionDefinition("fn.same", "Same", [new NendoFunctionParameter("x", "X", NendoBehaviourScalar.Integer, false)],
                NendoBehaviourScalar.Decimal, false, "x"),
            Calculation("calc.d", NendoBehaviourScalar.Decimal, "same(x) * 2", "same", "fn.same"));
        var adapter = new NendoExpressionAdapter();
        var compiled = CompiledBehaviour.Compile(definitions, adapter, Budget());
        var calculation = compiled.CalculationsByEntity["entity"].Single();

        Assert.AreEqual(NendoBehaviourScalar.Decimal, calculation.Expression.Calls["same"].ResultType,
            "The callers of a function declared decimal were typed by its whole-number body.");
        var result = adapter.Calculate(calculation.Expression, Values(("x", BehaviourValue.Integer(long.MaxValue))), Budget());
        Assert.AreEqual(NendoBehaviourScalar.Decimal, result.Type);
        Assert.AreEqual(18446744073709551614m, result.AsDecimal());
    }

    // A caller declared integer reads the whole number the formula produces, as every
    // caller did before declarations were checked, so a file holding one keeps compiling.
    [TestMethod]
    public void AnIntegerCallerReadsTheWholeNumberADecimalDeclaredFunctionProduces()
    {
        var definitions = Definitions(
            new NendoFunctionDefinition("fn.same", "Same", [new NendoFunctionParameter("x", "X", NendoBehaviourScalar.Integer, false)],
                NendoBehaviourScalar.Decimal, false, "x"),
            Calculation("calc.i", NendoBehaviourScalar.Integer, "same(x) + 1", "same", "fn.same"));
        var compiled = CompiledBehaviour.Compile(definitions, new NendoExpressionAdapter(), Budget());
        Assert.AreEqual(NendoBehaviourScalar.Integer, compiled.CalculationsByEntity["entity"].Single().Expression.ResultType);
    }

    /// <summary>
    /// Items with a whole-number size, one item of size 4, a function fn.twice declared integer
    /// over size * 2, an integer calculation that calls it and one that calls nothing. Then, as a
    /// host before the install check could leave it, the stored function's declared result is
    /// rewritten to <paramref name="storedResultType"/> and the file opened again.
    /// </summary>
    private static async Task<(NendoWriteCoordinator Coordinator, NendoApplicationService Service)> StoredTwiceAsync(
        EngineTestWorkspace workspace, string storedResultType)
    {
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await SizedItemsAsync(coordinator, service);
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(Mutation("twice",
            new SetBehaviourDefinitionOperation("f", new NendoFunctionDefinition("fn.twice", "Twice",
                [new NendoFunctionParameter("x", "X", NendoBehaviourScalar.Integer, false)], NendoBehaviourScalar.Integer, false, "x * 2"), revision),
            new SetBehaviourDefinitionOperation("c", SizeCalculation("calc.twice", "twice", NendoBehaviourScalar.Integer, "twice(size)", "twice", "fn.twice"), revision),
            new SetBehaviourDefinitionOperation("n", SizeCalculation("calc.next", "next", NendoBehaviourScalar.Integer, "size + 1"), revision)));
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        await using (var connection = new SqliteConnection($"Data Source={workspace.FilePath};Pooling=False"))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = "UPDATE __nendo_behaviour SET body_json = json_set(body_json, '$.resultType', @type) WHERE definition_id = 'fn.twice';";
            command.Parameters.AddWithValue("@type", storedResultType);
            Assert.AreEqual(1, await command.ExecuteNonQueryAsync(), "The stored function was not found to rewrite.");
        }
        var reopened = await workspace.OpenAsync();
        return (reopened, new NendoApplicationService(reopened));
    }

    private static async Task SizedItemsAsync(NendoWriteCoordinator coordinator, NendoApplicationService service)
    {
        await coordinator.ApplyAsync(Mutation("schema",
            new CreateEntityOperation("entity", "items", "Items", "items"),
            new AddFieldOperation("title", "items", "title", "Title", "title", NendoStorageKind.Text, true),
            new AddFieldOperation("size", "items", "size", "Size", "size", NendoStorageKind.Integer, true)));
        await service.CreateRecordAsync(new("items", "r1", new Dictionary<string, object?> { ["title"] = "One", ["size"] = 4L }, Context("r1")));
    }

    private static NendoCalculationDefinition SizeCalculation(
        string id, string fieldId, NendoBehaviourScalar type, string formula, string? alias = null, string? functionId = null) =>
        new(id, "items", fieldId, fieldId, type, false, formula,
            [NendoBehaviourBinding.SameRecordField("size", "items", "size", NendoBehaviourScalar.Integer, false)],
            alias is null ? null : [new NendoFunctionCallAlias(alias, functionId!)]);

    private static async Task<NendoRecordSnapshot> Item(NendoApplicationService service) =>
        (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "r1");

    private static long Calculated(NendoRecordSnapshot record, string fieldId)
    {
        var result = record.Calculations.SingleOrDefault(calculation => calculation.FieldId == fieldId);
        Assert.IsNotNull(result, $"The calculated field {fieldId} is gone: the file's calculations no longer compile.");
        Assert.AreEqual(NendoCalculationState.Value, result.State, $"{fieldId}: {result.ErrorCode} {result.ErrorMessage}");
        return result.Value.GetInt64();
    }

    private static Dictionary<string, NendoBehaviourDefinition> Definitions(params NendoBehaviourDefinition[] definitions) =>
        definitions.ToDictionary(definition => definition.DefinitionId, StringComparer.Ordinal);

    private static NendoCalculationDefinition Calculation(string id, NendoBehaviourScalar type, string formula, string alias, string functionId) =>
        new(id, "entity", id.Replace("calc.", "", StringComparison.Ordinal), id, type, false, formula,
            [NendoBehaviourBinding.SameRecordField("x", "entity", "x", NendoBehaviourScalar.Integer, false)],
            [new NendoFunctionCallAlias(alias, functionId)]);

    private static Dictionary<string, BehaviourValue> Values(params (string Name, BehaviourValue Value)[] values) =>
        values.ToDictionary(value => value.Name, value => value.Value, StringComparer.Ordinal);

    private static BehaviourBudget Budget() => new(NendoBehaviourLimits.Default);

    private static NendoMutation Mutation(string key, params NendoOperation[] operations) => new("test", key, "test", key, operations);
}
