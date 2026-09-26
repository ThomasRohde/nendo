namespace Nendo.Engine.Tests;

/// <summary>
/// How a formula's call reaches a reusable function: the name it resolves to and
/// the arguments it is given. Review findings R-004 and R-011.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourFunctionCallTests
{
    // R-004. The analyzer types an alias that shares a built-in's name as the
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

    // R-011. A parameter declared nullable takes an empty argument as a typed empty.
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

    private static Dictionary<string, BehaviourValue> Values(params (string Name, BehaviourValue Value)[] values) =>
        values.ToDictionary(value => value.Name, value => value.Value, StringComparer.Ordinal);

    private static BehaviourBudget Budget() => new(NendoBehaviourLimits.Default);

    private static NendoMutation Mutation(string key, params NendoOperation[] operations) => new("test", key, "test", key, operations);

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
