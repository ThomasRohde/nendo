using System.Globalization;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0008 regression lane D1: runtime and scalar fidelity.
/// <para>
/// Every expected value is computed independently with .NET decimal and checked
/// Int64 arithmetic rather than copied from what the evaluator produced, and every
/// comparison is a typed one. Comparing formatted strings would let a Double that
/// happens to print the same characters pass as a decimal.
/// </para>
/// </summary>
[TestClass]
public sealed class BehaviourScalarTests
{
    [TestMethod]
    public void D1_01_IntegerDivisionStaysInTheDecimalDomain()
    {
        var result = Evaluate("x / y", ("x", Integer(9007199254740993L)), ("y", Integer(1L)));
        Assert.AreEqual(NendoBehaviourScalar.Decimal, result.Type);
        Assert.AreEqual(9007199254740993m, result.Boxed);
        // The failure this guards against prints as a plausible number, so the type
        // is asserted separately from the value.
        Assert.IsInstanceOfType<decimal>(result.Boxed);
        Assert.AreNotEqual(9007199254740992m, result.Boxed);
    }

    [TestMethod]
    public void D1_02_CorruptionHiddenBehindABooleanIsDetected()
    {
        var result = Evaluate("(x / y) = z",
            ("x", Integer(9007199254740993L)), ("y", Integer(1L)), ("z", Integer(9007199254740992L)));
        Assert.AreEqual(NendoBehaviourScalar.Boolean, result.Type);
        Assert.IsFalse((bool)result.Boxed!, "Two different integers compared equal, so a division lost precision.");
    }

    [TestMethod]
    public void D1_03_EveryIntegerDivisionMatchesDecimalDivisionExactly()
    {
        long[] numerators = [long.MinValue, long.MinValue + 1, -9007199254740993L, -1L, 0L, 1L, 9007199254740993L, long.MaxValue];
        long[] denominators = [long.MinValue, -3L, -1L, 1L, 3L, long.MaxValue];
        var checkedPairs = 0;
        foreach (var numerator in numerators)
        {
            foreach (var denominator in denominators)
            {
                var result = Evaluate("x / y", ("x", Integer(numerator)), ("y", Integer(denominator)));
                Assert.AreEqual(NendoBehaviourScalar.Decimal, result.Type, $"{numerator}/{denominator}");
                Assert.AreEqual((decimal)numerator / denominator, result.Boxed, $"{numerator}/{denominator}");
                Assert.IsInstanceOfType<decimal>(result.Boxed, $"{numerator}/{denominator}");
                checkedPairs++;
            }
        }
        Assert.AreEqual(48, checkedPairs);
    }

    [TestMethod]
    public void D1_04_LiteralDivisionIsExactToTheDecimalDomain()
    {
        var result = Evaluate("1 / 3");
        Assert.AreEqual(NendoBehaviourScalar.Decimal, result.Type);
        Assert.AreEqual(0.3333333333333333333333333333m, result.Boxed);
    }

    [TestMethod]
    public void D1_05_DecimalDivisionReducesScaleAsTheDomainDoes()
    {
        var result = Evaluate("x / 2", ("x", Decimal(decimal.MaxValue)));
        Assert.AreEqual(decimal.MaxValue / 2m, result.Boxed);
    }

    [TestMethod]
    public void D1_06_SmallestDecimalKeepsItsScale()
    {
        const decimal smallest = 0.0000000000000000000000000001m;
        var result = Evaluate("x + 0.0", ("x", Decimal(smallest)));
        Assert.AreEqual(smallest + 0.0m, result.Boxed);
    }

    [TestMethod]
    public void D1_07_IntegerBoundariesSurviveIdentity()
    {
        foreach (var boundary in new[] { long.MinValue, long.MaxValue })
        {
            var result = Evaluate("x", ("x", Integer(boundary)));
            Assert.AreEqual(NendoBehaviourScalar.Integer, result.Type);
            Assert.AreEqual(boundary, result.Boxed);
        }
    }

    [TestMethod]
    public void D1_08_IntegerAdditionOverflowIsAnError() =>
        AssertCalculationError(NendoCalculationCodes.Overflow, "x + 1", ("x", Integer(long.MaxValue)));

    [TestMethod]
    public void D1_09_BoundaryArithmeticOverflowsRemainderAndMixedComparison()
    {
        AssertCalculationError(NendoCalculationCodes.Overflow, "x - 1", ("x", Integer(long.MinValue)));
        AssertCalculationError(NendoCalculationCodes.Overflow, "x * 2", ("x", Integer(long.MaxValue)));
        Assert.AreEqual(1L, Evaluate("x % 2", ("x", Integer(long.MaxValue))).Boxed);
        // The whole number is widened to decimal for the comparison, so no bit is lost.
        AssertBoolean(true, "(x + 0.0) = x", ("x", Integer(long.MaxValue)));
    }

    [TestMethod]
    public void D1_10_UnaryNegationOverflowIsChecked() =>
        AssertCalculationError(NendoCalculationCodes.Overflow, "-x", ("x", Integer(long.MinValue)));

    [TestMethod]
    public void D1_11_DecimalOverflowIsAnError() =>
        AssertCalculationError(NendoCalculationCodes.Overflow, "x * 2", ("x", Decimal(decimal.MaxValue)));

    [TestMethod]
    public void D1_12_DivisionByZeroIsAnError()
    {
        AssertCalculationError(NendoCalculationCodes.DivideByZero, "1 / 0");
        AssertCalculationError(NendoCalculationCodes.DivideByZero, "x / y", ("x", Integer(1L)), ("y", Integer(0L)));
        AssertCalculationError(NendoCalculationCodes.DivideByZero, "x / y", ("x", Decimal(1m)), ("y", Decimal(0m)));
    }

    [TestMethod]
    public void D1_13_RoundingStatesItsMidpointPolicy()
    {
        Assert.AreEqual(2m, Evaluate("RoundEven(2.5, 0)").Boxed);
        Assert.AreEqual(3m, Evaluate("RoundAway(2.5, 0)").Boxed);
        Assert.AreEqual(-2m, Evaluate("RoundEven(-2.5, 0)").Boxed);
        Assert.AreEqual(-3m, Evaluate("RoundAway(-2.5, 0)").Boxed);
    }

    [TestMethod]
    public void D1_14_EmptyTextAndNoTextAreDifferentStates()
    {
        var empty = Evaluate("x", ("x", Text("")));
        Assert.AreEqual(NendoBehaviourScalar.Text, empty.Type);
        Assert.IsFalse(empty.IsNull);
        Assert.AreEqual("", empty.Boxed);

        var absent = EvaluateOptional("x", ("x", NullText()));
        Assert.AreEqual(NendoBehaviourScalar.Text, absent.Type);
        Assert.IsTrue(absent.IsNull, "An empty value collapsed into empty text.");
    }

    /// <summary>
    /// ADR-0008, 2026-09-20 amendment: the declaration decides. Under a result declared
    /// to allow an empty, an empty operand is an empty result of the declared kind --
    /// never zero, never false. Under a result declared always to answer, D1_15 and
    /// D1_16 stand.
    /// </summary>
    [TestMethod]
    public void D1_18_AnEmptyOperandUnderAnOptionalResultIsAnEmptyResult()
    {
        var number = EvaluateOptional("x + 1", ("x", NullInteger()));
        Assert.AreEqual(NendoBehaviourScalar.Integer, number.Type);
        Assert.IsTrue(number.IsNull, "An empty operand under an optional result was not an empty result.");
        Assert.IsNull(number.Boxed);

        var flag = EvaluateOptional("x and true", ("x", NullBoolean()));
        Assert.AreEqual(NendoBehaviourScalar.Boolean, flag.Type);
        Assert.IsTrue(flag.IsNull, "An empty condition under an optional result was answered rather than left empty.");
    }

    [TestMethod]
    public void D1_19_AFormulaThatEndsEmptyUnderARequiredResultIsAMissingInput() =>
        AssertCalculationError(NendoCalculationCodes.MissingInput, "x", ("x", NullText()));

    /// <summary>
    /// A function declared to allow an empty result returns empty to its caller when an
    /// empty argument stops it, and the caller's own declaration then decides.
    /// </summary>
    [TestMethod]
    public void D1_20_AnOptionalFunctionReturnsEmptyAndItsCallerDecides()
    {
        var adapter = new NendoExpressionAdapter();
        var budget = Budget();
        var score = adapter.Validate(new BehaviourFormula("score", "value / effort",
            [new BehaviourParameter("value", NendoBehaviourScalar.Integer, true), new BehaviourParameter("effort", NendoBehaviourScalar.Integer, true)],
            new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal), ResultNullable: true), budget);
        var calls = new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal) { ["Score"] = score };
        BehaviourParameter[] parameters =
            [new("v", NendoBehaviourScalar.Integer, true), new("e", NendoBehaviourScalar.Integer, true)];
        var unrated = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal) { ["v"] = Integer(4), ["e"] = NullInteger() };
        var rated = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal) { ["v"] = Integer(4), ["e"] = Integer(2) };

        var quiet = adapter.Validate(new BehaviourFormula("quiet", "Score(v, e)", parameters, calls, ResultNullable: true), budget);
        var empty = adapter.Calculate(quiet, unrated, budget);
        Assert.AreEqual(NendoBehaviourScalar.Decimal, empty.Type);
        Assert.IsTrue(empty.IsNull, "An optional caller of an optional function did not read empty.");
        Assert.AreEqual(2m, adapter.Calculate(quiet, rated, budget).Boxed);

        var loud = adapter.Validate(new BehaviourFormula("loud", "Score(v, e) + 1", parameters, calls), budget);
        var exception = Assert.ThrowsExactly<NendoCalculationException>(() => adapter.Calculate(loud, unrated, budget));
        Assert.AreEqual(NendoCalculationCodes.MissingInput, exception.Code);
        Assert.AreEqual(3m, adapter.Calculate(loud, rated, budget).Boxed);
    }

    /// <summary>
    /// A formula can refuse by name. The refusal stands in for a value of the other
    /// outcome's kind, whichever side of the choice it is on, and it is not quietened
    /// by an optional result: it is the author's sentence, not an empty input.
    /// </summary>
    [TestMethod]
    public void D1_21_AFormulaCanRefuseByNameInOneOutcomeOfAChoice()
    {
        const string guard = "x > 5 ? Refuse('Ratings are 1 to 5.') : x";
        Assert.AreEqual(3L, Evaluate(guard, ("x", Integer(3))).Boxed);
        var refused = Assert.ThrowsExactly<NendoCalculationException>(() => Evaluate(guard, ("x", Integer(7))));
        Assert.AreEqual(NendoCalculationCodes.Refused, refused.Code);
        Assert.AreEqual("Ratings are 1 to 5.", refused.Message);

        Assert.AreEqual(NendoBehaviourScalar.Integer, Evaluate("x > 5 ? x : Refuse('No.')", ("x", Integer(7))).Type);
        Assert.AreEqual(NendoBehaviourScalar.Text, Evaluate("x > 5 ? Refuse('No.') : 'fine'", ("x", Integer(3))).Type);

        var optional = Assert.ThrowsExactly<NendoCalculationException>(() => EvaluateOptional(guard, ("x", Integer(7))));
        Assert.AreEqual(NendoCalculationCodes.Refused, optional.Code);
    }

    [TestMethod]
    public void D1_22_ARefusalOutsideAChoiceIsADefinitionError()
    {
        AssertRefused("Refuse('Never answers.')");
        AssertRefused("1 + Refuse('Inside arithmetic.')");
        AssertRefused("x ? Refuse('a') : Refuse('b')", ("x", Boolean(true)));
        AssertRefused("x ? Refuse(1) : 2", ("x", Boolean(true)));
        AssertRefused("x ? Refuse('a', 'b') : 2", ("x", Boolean(true)));
    }

    [TestMethod]
    public void D1_15_AnEmptyNumberIsAMissingInputNotZero() =>
        AssertCalculationError(NendoCalculationCodes.MissingInput, "x + 1", ("x", NullInteger()));

    [TestMethod]
    public void D1_16_AnEmptyConditionIsAMissingInputNotFalse() =>
        AssertCalculationError(NendoCalculationCodes.MissingInput, "x and true", ("x", NullBoolean()));

    [TestMethod]
    public void D1_17_TextAndBooleanNeverBecomeNumbers()
    {
        AssertRefused("true + 1");
        AssertRefused("'2' + 1");
        AssertRefused("x + 1", ("x", Text("2")));
        AssertRefused("x + 1", ("x", Boolean(true)));
    }

    [TestMethod]
    public void D1_18_TheBranchNotTakenIsNeverEvaluated()
    {
        Assert.AreEqual(7.0m, Evaluate("true ? 7.0 : 1/0").Boxed);
        AssertBoolean(false, "false and (1/0 = 0.0)");
        AssertBoolean(true, "true or (1/0 = 0.0)");
        Assert.AreEqual(0m, Evaluate("false ? 1/0 : 0.0").Boxed);
    }

    [TestMethod]
    public void D1_19_DaysBetweenIsASignedCalendarDifference()
    {
        Assert.AreEqual(2L, Evaluate("DaysBetween(Date('2024-02-28'), Date('2024-03-01'))").Boxed);
        Assert.AreEqual(-2L, Evaluate("DaysBetween(Date('2024-03-01'), Date('2024-02-28'))").Boxed);
        Assert.AreEqual(0L, Evaluate("DaysBetween(Date('2024-02-29'), Date('2024-02-29'))").Boxed);
    }

    [TestMethod]
    public void D1_20_AnImpossibleDateIsACalculationError()
    {
        AssertCalculationError(NendoCalculationCodes.InvalidDate, "Date('2024-02-30')");
        AssertCalculationError(NendoCalculationCodes.InvalidDate, "Date('01/02/2024')");
        AssertCalculationError(NendoCalculationCodes.InvalidDate, "Date('2024-2-3')");
    }

    [TestMethod]
    public void D1_21_ArithmeticIsIdenticalUnderEveryCulture()
    {
        var original = CultureInfo.CurrentCulture;
        try
        {
            foreach (var name in new[] { "en-US", "da-DK", "tr-TR" })
            {
                CultureInfo.CurrentCulture = new CultureInfo(name);
                Assert.AreEqual(3.75m, Evaluate("1.5 + 2.25").Boxed, name);
                Assert.AreEqual(0.3333333333333333333333333333m, Evaluate("1 / 3").Boxed, name);
                Assert.AreEqual(2L, Evaluate("DaysBetween(Date('2024-02-28'), Date('2024-03-01'))").Boxed, name);
            }
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
        }
    }

    [TestMethod]
    public void D1_22_NestedReusableFunctionsPreserveSemanticBindings()
    {
        var adapter = new NendoExpressionAdapter();
        var budget = Budget();
        var rate = adapter.Validate(new BehaviourFormula("fn.rate", "a / b",
            [new BehaviourParameter("a", NendoBehaviourScalar.Decimal, false),
             new BehaviourParameter("b", NendoBehaviourScalar.Decimal, false)],
            new Dictionary<string, ValidatedExpression>()), budget);
        var twice = adapter.Validate(new BehaviourFormula("fn.twice", "Rate(x, 1) * 2",
            [new BehaviourParameter("x", NendoBehaviourScalar.Decimal, false)],
            new Dictionary<string, ValidatedExpression> { ["Rate"] = rate }), budget);

        // The formula names its input by a display alias; the value arrives from a
        // stable field ID that the alias is bound to, not from the label.
        var caller = adapter.Validate(new BehaviourFormula("project.doubled", "Twice(displayAlias)",
            [new BehaviourParameter("displayAlias", NendoBehaviourScalar.Integer, false)],
            new Dictionary<string, ValidatedExpression> { ["Twice"] = twice }), budget);

        var result = adapter.Calculate(caller,
            new Dictionary<string, BehaviourValue> { ["displayAlias"] = Integer(9007199254740993L) }, budget);
        Assert.AreEqual(NendoBehaviourScalar.Decimal, result.Type);
        Assert.AreEqual(18014398509481986m, result.Boxed);
    }

    [TestMethod]
    public void D1_23_RecursiveDefinitionsRefuse()
    {
        var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal)
        {
            ["fn.a"] = Calls("fn.a", "fn.b"),
            ["fn.b"] = Calls("fn.b", "fn.a"),
        };
        Assert.ThrowsExactly<NendoValidationException>(() => NendoBehaviourGraph.ValidateCandidate(definitions));
    }

    [TestMethod]
    public void D1_24_EverythingOutsideTheClosedVocabularyRefusesBeforeEvaluation()
    {
        foreach (var source in new[]
        {
            "Pow(2, 100)",                    // a built-in of the library, not of this contract
            "ReadFile('x')",                  // no file access exists to reach
            "Network('https://example.org')", // nor any network access
            "2 ** 3",                         // power
            "1 << 2",                         // shift
            "(1, 2)",                         // a list is not a scalar
            "unknownBinding + 1",             // a name nothing declares
            "'x'.Length",                     // no member access on a value
            "[x].GetType()",                  // no reflection
            "Abs(-1)",                        // a plausible built-in that is still absent
            "1 in (1, 2)",
            "'a' like 'a%'",
            "1 & 2",
            "true ? 1 : 'text'",              // branches of different kinds
        })
        {
            AssertRefused(source);
        }
    }

    [TestMethod]
    public void D1_25_ValueEmptyAndErrorAreThreeDistinctOutcomes()
    {
        var value = Evaluate("1");
        Assert.IsFalse(value.IsNull);
        Assert.AreEqual(1L, value.Boxed);

        // Under a result declared to allow it; under one declared always to answer, an
        // empty ending is the missing input D1_19 asserts (ADR-0008, 2026-09-20 amendment).
        var empty = EvaluateOptional("x", ("x", NullInteger()));
        Assert.IsTrue(empty.IsNull);
        Assert.AreEqual(NendoBehaviourScalar.Integer, empty.Type);

        AssertCalculationError(NendoCalculationCodes.DivideByZero, "1 / 0");
    }

    [TestMethod]
    public void TheLibraryOnlyControlStillProducesTheWrongAnswer()
    {
        // The documented failure oracle. If this ever stops returning Double, the
        // interception is no longer what is protecting the contract and the reason
        // for every case above has changed — which is worth failing over.
        var configuration = NCalc.ExpressionConfiguration.FromOptions(
            NCalc.ExpressionOptions.DecimalAsDefault | NCalc.ExpressionOptions.LongAsDefault |
            NCalc.ExpressionOptions.OverflowProtection | NCalc.ExpressionOptions.NoStringTypeCoercion |
            NCalc.ExpressionOptions.OrdinalStringComparer | NCalc.ExpressionOptions.NoCache);
        var uninterceptedLiteral = new NCalc.Expression("1 / 3", configuration,
            new NCalc.ExpressionContext(), CultureInfo.InvariantCulture, null).Evaluate(default);
        Assert.IsInstanceOfType<double>(uninterceptedLiteral,
            "The library no longer divides into Double; revisit why division is intercepted.");
        Assert.AreEqual(0.3333333333333333d, uninterceptedLiteral);

        var uninterceptedPrecision = new NCalc.Expression("9007199254740993 / 1", configuration,
            new NCalc.ExpressionContext(), CultureInfo.InvariantCulture, null).Evaluate(default);
        Assert.AreEqual(9007199254740992d, uninterceptedPrecision);
    }

    private static NendoFunctionDefinition Calls(string id, string callee) => new(
        id, id, [], NendoBehaviourScalar.Integer, false, "next(1)",
        [new NendoFunctionCallAlias("next", callee)]);

    internal static BehaviourBudget Budget(NendoBehaviourLimits? limits = null, CancellationToken token = default) =>
        new(limits ?? NendoBehaviourLimits.Default, token);

    internal static BehaviourValue Integer(long value) => BehaviourValue.Integer(value);
    internal static BehaviourValue Decimal(decimal value) => BehaviourValue.Decimal(value);
    internal static BehaviourValue Boolean(bool value) => BehaviourValue.Boolean(value);
    internal static BehaviourValue Text(string value) => BehaviourValue.Text(value, NendoBehaviourLimits.Default);
    internal static BehaviourValue NullInteger() => BehaviourValue.Empty(NendoBehaviourScalar.Integer);
    internal static BehaviourValue NullBoolean() => BehaviourValue.Empty(NendoBehaviourScalar.Boolean);
    internal static BehaviourValue NullText() => BehaviourValue.Empty(NendoBehaviourScalar.Text);

    internal static BehaviourValue Evaluate(string source, params (string Name, BehaviourValue Value)[] bindings) =>
        Evaluate(new NendoExpressionAdapter(), Budget(), source, bindings);

    /// <summary>The same formula under a result declared to allow an empty.</summary>
    internal static BehaviourValue EvaluateOptional(string source, params (string Name, BehaviourValue Value)[] bindings) =>
        Evaluate(new NendoExpressionAdapter(), Budget(), source, true, bindings);

    internal static BehaviourValue Evaluate(
        NendoExpressionAdapter adapter,
        BehaviourBudget budget,
        string source,
        params (string Name, BehaviourValue Value)[] bindings) =>
        Evaluate(adapter, budget, source, false, bindings);

    internal static BehaviourValue Evaluate(
        NendoExpressionAdapter adapter,
        BehaviourBudget budget,
        string source,
        bool resultNullable,
        params (string Name, BehaviourValue Value)[] bindings)
    {
        var parameters = bindings
            .Select(binding => new BehaviourParameter(binding.Name, binding.Value.Type, binding.Value.IsNull))
            .ToArray();
        var validated = adapter.Validate(
            new BehaviourFormula("test", source, parameters, new Dictionary<string, ValidatedExpression>(), resultNullable), budget);
        return adapter.Calculate(validated,
            bindings.ToDictionary(binding => binding.Name, binding => binding.Value, StringComparer.Ordinal), budget);
    }

    private static void AssertCalculationError(
        string code,
        string source,
        params (string Name, BehaviourValue Value)[] bindings)
    {
        var exception = Assert.ThrowsExactly<NendoCalculationException>(() => Evaluate(source, bindings), source);
        Assert.AreEqual(code, exception.Code, source);
        Assert.DoesNotContain("NCalc", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    private static void AssertBoolean(bool expected, string source, params (string Name, BehaviourValue Value)[] bindings)
    {
        var result = Evaluate(source, bindings);
        Assert.AreEqual(NendoBehaviourScalar.Boolean, result.Type, source);
        Assert.IsInstanceOfType<bool>(result.Boxed, source);
        if (expected) Assert.IsTrue((bool)result.Boxed!, source); else Assert.IsFalse((bool)result.Boxed!, source);
    }

    private static void AssertRefused(string source, params (string Name, BehaviourValue Value)[] bindings) =>
        Assert.ThrowsExactly<NendoValidationException>(() => Evaluate(source, bindings), source);
}
