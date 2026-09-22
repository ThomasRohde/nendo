using System.Diagnostics;
using static Nendo.Engine.Tests.BehaviourScalarTests;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0008 regression lane D2: limits, allocation and cancellation.
/// <para>
/// Each ceiling is exercised below it, exactly at it and above it, because a limit
/// that only refuses far past its boundary is not the limit the contract publishes.
/// The adversarial cases run under a watchdog: a probe that has to be killed, or a
/// worker still running after its caller returned, is a containment failure and not
/// a flaky test.
/// </para>
/// <para>
/// D2.01 and D2.02 belong to this lane but need a real transaction, so they live
/// with the atomic action tests rather than here.
/// </para>
/// </summary>
[TestClass]
public sealed class BehaviourLimitTests
{
    private const int WatchdogSeconds = 60;

    [TestMethod]
    public void D2_03_SyntaxItemsAreCountedIncludingPunctuation()
    {
        var limits = NendoBehaviourLimits.Default with { SyntaxItems = 3 };
        Passes("-1", limits);
        Passes("1+1", limits);
        Refuses("-1+1", limits);
    }

    [TestMethod]
    public void D2_04_NestedCallsAreBoundedByTreeDepth()
    {
        var limits = NendoBehaviourLimits.Default with { AstDepth = 8 };
        var adapter = new NendoExpressionAdapter();
        var identity = adapter.Validate(new BehaviourFormula("fn.id", "x",
            [new BehaviourParameter("x", NendoBehaviourScalar.Integer, false)],
            new Dictionary<string, ValidatedExpression>()), Budget(limits));
        var calls = new Dictionary<string, ValidatedExpression> { ["Id"] = identity };

        foreach (var (depth, allowed) in new[] { (6, true), (7, true), (8, false) })
        {
            var source = string.Concat(Enumerable.Repeat("Id(", depth)) + "1" + new string(')', depth);
            var formula = new BehaviourFormula($"nested-{depth}", source, [], calls);
            if (allowed) adapter.Validate(formula, Budget(limits));
            else Assert.ThrowsExactly<NendoValidationException>(() => adapter.Validate(formula, Budget(limits)), source);
        }
    }

    [TestMethod]
    public void D2_05_AWarmCacheCannotSmuggleADeepDefinitionGraphPast()
    {
        foreach (var (length, allowed) in new[] { (7, true), (8, true), (9, false) })
        {
            var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
            for (var index = 0; index < length; index++)
            {
                var next = index == length - 1 ? null : $"fn.{index + 1}";
                definitions[$"fn.{index}"] = new NendoFunctionDefinition(
                    $"fn.{index}", $"Step {index}", [], NendoBehaviourScalar.Integer, false,
                    next is null ? "1" : "next(1)",
                    next is null ? [] : [new NendoFunctionCallAlias("next", next)]);
            }
            // Validating the innermost definition first warms whatever cache exists;
            // the graph check must still walk the whole chain afterwards.
            NendoBehaviourGraph.ValidateCandidate(
                new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal)
                { [$"fn.{length - 1}"] = definitions[$"fn.{length - 1}"] });
            if (allowed) NendoBehaviourGraph.ValidateCandidate(definitions);
            else Assert.ThrowsExactly<NendoValidationException>(
                () => NendoBehaviourGraph.ValidateCandidate(definitions), $"chain of {length}");
        }

        // The same graph named the other way round — fn.k reads fn.{k-1}, so every edge
        // points from a higher-sorting ID to a lower-sorting one — must be refused at the
        // same length. Memoising reachedness rather than height let this direction install
        // any depth, because every root after the first settled at height 1.
        foreach (var (length, allowed) in new[] { (8, true), (9, false) })
        {
            var descending = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
            for (var index = 0; index < length; index++)
            {
                var previous = index == 0 ? null : $"fn.{index - 1}";
                descending[$"fn.{index}"] = new NendoFunctionDefinition(
                    $"fn.{index}", $"Down {index}", [], NendoBehaviourScalar.Integer, false,
                    previous is null ? "1" : "prev(1)",
                    previous is null ? [] : [new NendoFunctionCallAlias("prev", previous)]);
            }
            if (allowed) NendoBehaviourGraph.ValidateCandidate(descending);
            else Assert.ThrowsExactly<NendoValidationException>(
                () => NendoBehaviourGraph.ValidateCandidate(descending), $"descending chain of {length}");
        }
    }

    [TestMethod]
    public void D2_26_AColdCompileOfManyFormulasWithinEveryPerFormulaLimitStillSucceeds()
    {
        // Seventeen calculations, each a ~1,000-character text literal: one syntax item,
        // well under SourceLength, and far fewer than the Definitions ceiling in all. The
        // set is legal by every published ceiling. A cold compile against a fresh adapter must therefore
        // succeed; it threw NendoCalculationException(LimitReached) when one 16,384-unit
        // budget was shared across the whole file's preflight charge, so whether a legal
        // file compiled depended on how warm the expression cache happened to be.
        var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
        for (var index = 0; index < 17; index++)
        {
            var literal = "'" + new string('a', 1000) + "'";
            definitions[$"calc.{index}"] = new NendoCalculationDefinition(
                $"calc.{index}", "entity", $"field{index}", $"Field {index}",
                NendoBehaviourScalar.Text, false, literal, []);
        }
        CompiledBehaviour.Compile(definitions, new NendoExpressionAdapter(), Budget());
    }

    [TestMethod]
    public void D2_27_TheDefinitionsCeilingCountsEveryKindNotOnlyFunctions()
    {
        // CatalogueSize bounds reusable functions alone. With each formula compiling
        // under its own work allowance, nothing bounded how many calculations, actions
        // and triggers a file could accumulate across proposals — and so how much
        // compile work every open of it cost. The set ceiling is exact at its boundary.
        var limits = NendoBehaviourLimits.Default with { Definitions = 4 };
        foreach (var (count, allowed) in new[] { (3, true), (4, true), (5, false) })
        {
            var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
            for (var index = 0; index < count; index++)
            {
                definitions[$"calc.{index}"] = new NendoCalculationDefinition(
                    $"calc.{index}", "entity", $"field{index}", $"Field {index}",
                    NendoBehaviourScalar.Integer, false, "1", []);
            }
            if (allowed) NendoBehaviourGraph.ValidateCandidate(definitions, limits);
            else
            {
                var refused = Assert.ThrowsExactly<NendoValidationException>(
                    () => NendoBehaviourGraph.ValidateCandidate(definitions, limits), $"{count} definitions");
                Assert.Contains("the limit is 4", refused.Message);
            }
        }
    }

    [TestMethod]
    public void D2_06_SourceLengthIsCheckedBeforeTheParserAllocates()
    {
        foreach (var (length, allowed) in new[] { (2047, true), (2048, true), (2049, false) })
        {
            var source = "1".PadLeft(length);
            Assert.AreEqual(length, source.Length);
            if (allowed) Passes(source); else Refuses(source);
        }
    }

    [TestMethod]
    public void D2_07_ParenthesisNestingIsRefusedBeforeARecursiveParse()
    {
        foreach (var (depth, allowed) in new[] { (23, true), (24, true), (25, false) })
        {
            var source = new string('(', depth) + "1" + new string(')', depth);
            if (allowed) Passes(source); else Refuses(source);
        }
    }

    [TestMethod]
    public void D2_08_ALongUnaryChainIsRefusedWithoutRunningOutOfStack() =>
        RunUnderWatchdog("128 unary minus signs", () => Refuses(new string('-', 128) + "1"));

    [TestMethod]
    public void D2_09_ManyTokensAreRefusedOnCountBeforeParsing() =>
        RunUnderWatchdog("300 not tokens", () => Refuses(string.Concat(Enumerable.Repeat("not ", 300)) + "true"));

    [TestMethod]
    public void D2_10_UnaryDepthIsExactAtItsBoundary()
    {
        Assert.AreEqual(1L, Evaluate(new string('-', 22) + "1").Boxed);
        Assert.AreEqual(-1L, Evaluate(new string('-', 23) + "1").Boxed);
        Refuses(new string('-', 24) + "1");
    }

    [TestMethod]
    public void D2_11_AStricterLimitCannotReuseAResultValidatedUnderALooserOne()
    {
        var adapter = new NendoExpressionAdapter();
        adapter.Validate(new BehaviourFormula("cached", "12345", [], new Dictionary<string, ValidatedExpression>()),
            Budget());
        Assert.AreEqual(1, adapter.CachedExpressionCount);

        var strict = NendoBehaviourLimits.Default with { SourceLength = 4 };
        Assert.ThrowsExactly<NendoValidationException>(() => adapter.Validate(
            new BehaviourFormula("cached", "12345", [], new Dictionary<string, ValidatedExpression>()),
            Budget(strict)),
            "A warm cache entry answered a request made under a stricter limit.");
    }

    [TestMethod]
    public void D2_12_TextLengthIsCheckedOnInputAndBeforeJoining()
    {
        Assert.AreEqual(4095, ((string)Evaluate("x", ("x", Text(new string('a', 4095)))).Boxed!).Length);
        Assert.AreEqual(4096, ((string)Evaluate("x", ("x", Text(new string('a', 4096)))).Boxed!).Length);
        Assert.AreEqual(NendoCalculationCodes.TextTooLong,
            Assert.ThrowsExactly<NendoCalculationException>(() => Text(new string('a', 4097))).Code);

        // The joined size is refused before the result is allocated, not after.
        var half = new string('b', 2049);
        Assert.AreEqual(NendoCalculationCodes.TextTooLong,
            Assert.ThrowsExactly<NendoCalculationException>(
                () => Evaluate("Concat(x, y)", ("x", Text(half)), ("y", Text(half)))).Code);
    }

    [TestMethod]
    public void D2_13_TheWorkCounterIsCheckedAndNeverWraps()
    {
        var budget = Budget();
        budget.SpendWork(16_383);
        Assert.AreEqual(16_383, budget.WorkSpent);
        budget.SpendWork();
        Assert.AreEqual(16_384, budget.WorkSpent);
        Assert.AreEqual(NendoCalculationCodes.LimitReached,
            Assert.ThrowsExactly<NendoCalculationException>(() => budget.SpendWork()).Code);
        Assert.AreEqual(16_384, budget.WorkSpent, "A refused charge still moved the counter.");

        var overflowing = Budget();
        Assert.AreEqual(NendoCalculationCodes.LimitReached,
            Assert.ThrowsExactly<NendoCalculationException>(() => overflowing.SpendWork(int.MaxValue)).Code);
        overflowing.SpendWork(1);
        Assert.AreEqual(NendoCalculationCodes.LimitReached,
            Assert.ThrowsExactly<NendoCalculationException>(() => overflowing.SpendWork(int.MaxValue)).Code);
    }

    [TestMethod]
    public void D2_14_RelatedRowScansAreSharedAndAlsoChargeWork()
    {
        var budget = Budget();
        budget.SpendScan(255);
        Assert.AreEqual(255, budget.ScansSpent);
        budget.SpendScan();
        Assert.AreEqual(256, budget.ScansSpent);
        var workBefore = budget.WorkSpent;
        Assert.AreEqual(NendoCalculationCodes.LimitReached,
            Assert.ThrowsExactly<NendoCalculationException>(() => budget.SpendScan()).Code);
        Assert.AreEqual(256, budget.ScansSpent);
        Assert.IsGreaterThan(workBefore, budget.WorkSpent, "A refused scan did not charge for the attempt.");
        Assert.AreEqual(0, budget.RemainingScanAllowance);
    }

    [TestMethod]
    public void D2_15_GeneratedChangesAreSharedAndAlsoChargeWork()
    {
        var budget = Budget();
        for (var index = 0; index < 63; index++) budget.SpendChange();
        Assert.AreEqual(63, budget.ChangesSpent);
        budget.SpendChange();
        Assert.AreEqual(64, budget.ChangesSpent);
        var workBefore = budget.WorkSpent;
        Assert.AreEqual(NendoCalculationCodes.LimitReached,
            Assert.ThrowsExactly<NendoCalculationException>(() => budget.SpendChange()).Code);
        Assert.AreEqual(64, budget.ChangesSpent);
        Assert.IsGreaterThan(workBefore, budget.WorkSpent);
    }

    [TestMethod]
    public void D2_16_FunctionCallsAreCountedAcrossOneSharedBudget()
    {
        var adapter = new NendoExpressionAdapter();
        var budget = Budget();
        var one = adapter.Validate(new BehaviourFormula("fn.one", "1", [], new Dictionary<string, ValidatedExpression>()),
            budget);
        var caller = adapter.Validate(new BehaviourFormula("caller", "One()", [],
            new Dictionary<string, ValidatedExpression> { ["One"] = one }), budget);
        var values = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal);

        for (var call = 1; call <= 64; call++)
        {
            Assert.AreEqual(1L, adapter.Calculate(caller, values, budget).Boxed, $"call {call}");
        }
        Assert.AreEqual(64, budget.CallsSpent);
        Assert.AreEqual(NendoCalculationCodes.LimitReached,
            Assert.ThrowsExactly<NendoCalculationException>(() => adapter.Calculate(caller, values, budget)).Code);
    }

    [TestMethod]
    public void D2_17_TheValidatedExpressionCacheNeverExceedsItsCap()
    {
        var adapter = new NendoExpressionAdapter();
        for (var index = 0; index < 50; index++)
        {
            adapter.Validate(
                new BehaviourFormula($"formula-{index}", $"{index} + 1", [], new Dictionary<string, ValidatedExpression>()),
                Budget());
            Assert.AreEqual((index % 16) + 1, adapter.CachedExpressionCount, $"after {index + 1} formulas");
            Assert.IsLessThanOrEqualTo(16, adapter.CachedExpressionCount);
        }
    }

    [TestMethod]
    public void D2_18_CatalogueParameterAndIdentifierCeilingsAreExact()
    {
        foreach (var (count, allowed) in new[] { (31, true), (32, true), (33, false) })
        {
            var definitions = new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal);
            for (var index = 0; index < count; index++)
            {
                definitions[$"fn.{index}"] = new NendoFunctionDefinition(
                    $"fn.{index}", $"Function {index}", [], NendoBehaviourScalar.Integer, false, "1");
            }
            if (allowed) NendoBehaviourGraph.ValidateCandidate(definitions);
            else Assert.ThrowsExactly<NendoValidationException>(
                () => NendoBehaviourGraph.ValidateCandidate(definitions), $"{count} functions");
        }

        foreach (var (count, allowed) in new[] { (15, true), (16, true), (17, false) })
        {
            var parameters = Enumerable.Range(0, count)
                .Select(index => new BehaviourParameter($"p{index}", NendoBehaviourScalar.Integer, false))
                .ToArray();
            var formula = new BehaviourFormula($"params-{count}", "1", parameters,
                new Dictionary<string, ValidatedExpression>());
            if (allowed) new NendoExpressionAdapter().Validate(formula, Budget());
            else Assert.ThrowsExactly<NendoValidationException>(
                () => new NendoExpressionAdapter().Validate(formula, Budget()), $"{count} parameters");
        }

        foreach (var (length, allowed) in new[] { (127, true), (128, true), (129, false) })
        {
            var name = new string('n', length);
            var formula = new BehaviourFormula("identifier", name,
                [new BehaviourParameter(name, NendoBehaviourScalar.Integer, false)],
                new Dictionary<string, ValidatedExpression>());
            if (allowed) new NendoExpressionAdapter().Validate(formula, Budget());
            else Assert.ThrowsExactly<NendoValidationException>(
                () => new NendoExpressionAdapter().Validate(formula, Budget()), $"identifier of {length}");
        }
    }

    [TestMethod]
    public void D2_19_CancellationReachesTheWorkerAndTheWorkerFinishes()
    {
        using var source = new CancellationTokenSource();
        using var started = new ManualResetEventSlim(false);
        var observed = false;
        var completed = false;
        var iterations = 0;

        var worker = Task.Run(() =>
        {
            var adapter = new NendoExpressionAdapter();
            try
            {
                while (true)
                {
                    // A fresh budget each time: this is a loop of independent
                    // evaluations, not one evaluation buying a larger allowance.
                    var budget = Budget(NendoBehaviourLimits.Default, source.Token);
                    Evaluate(adapter, budget, "1 + 2");
                    iterations++;
                    started.Set();
                    // Paced, not spinning. What is under test is that cancellation is
                    // seen inside an evaluation and that the caller can join the worker
                    // — neither of which needs a saturated core, and a test that pins
                    // one starves the timing-sensitive lanes running beside it.
                    Thread.Sleep(1);
                }
            }
            catch (OperationCanceledException) { observed = true; }
            finally { completed = true; }
        });

        Assert.IsTrue(started.Wait(TimeSpan.FromSeconds(WatchdogSeconds)), "The worker never started.");
        source.Cancel();
        // Awaiting the worker is the assertion: a caller that merely stops waiting
        // would leave evaluation running and call it cancelled.
        Assert.IsTrue(worker.Wait(TimeSpan.FromSeconds(WatchdogSeconds)),
            "The worker was still running after cancellation; it was not contained.");
        Assert.IsTrue(observed, "Cancellation was not observed inside the worker.");
        Assert.IsTrue(completed);
        Assert.IsGreaterThan(0, iterations);
    }

    [TestMethod]
    public void D2_20_To_22_RepeatedEvaluationStaysExactAndIsMeasured()
    {
        // Computed here rather than written as a literal, so the oracle is .NET's
        // decimal arithmetic and not a transcription of what the evaluator produced.
        var one = decimal.Parse("1", System.Globalization.CultureInfo.InvariantCulture);
        var three = decimal.Parse("3", System.Globalization.CultureInfo.InvariantCulture);
        var two = decimal.Parse("2.0", System.Globalization.CultureInfo.InvariantCulture);
        var expected = one / three + two;

        foreach (var count in new[] { 1, 100, 1000 })
        {
            var adapter = new NendoExpressionAdapter();
            var before = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();
            for (var index = 0; index < count; index++)
            {
                Assert.AreEqual(expected, Evaluate(adapter, Budget(), "1 / 3 + 2.0").Boxed, $"evaluation {index}");
            }
            stopwatch.Stop();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
            // Recorded rather than asserted: a machine-speed threshold would be a
            // flaky test, and the published budgets belong in the contract.
            Console.WriteLine(
                $"{count,5} evaluations: {stopwatch.Elapsed.TotalMilliseconds,9:F2} ms, {allocated,12:N0} bytes allocated");
        }
    }

    [TestMethod]
    public void D2_23_To_25_CancellationJoinsAWarmWorkerAtEveryDepth()
    {
        foreach (var warmup in new[] { 1, 100, 1000 })
        {
            using var source = new CancellationTokenSource();
            using var ready = new ManualResetEventSlim(false);
            var completed = false;
            var observed = false;

            var worker = Task.Run(() =>
            {
                var adapter = new NendoExpressionAdapter();
                try
                {
                    for (var index = 0; index < warmup; index++)
                    {
                        Evaluate(adapter, Budget(NendoBehaviourLimits.Default, source.Token), "1 / 3 + 2.0");
                    }
                    ready.Set();
                    while (true)
                    {
                        Evaluate(adapter, Budget(NendoBehaviourLimits.Default, source.Token), "1 / 3 + 2.0");
                        Thread.Sleep(1);
                    }
                }
                catch (OperationCanceledException) { observed = true; }
                finally { completed = true; }
            });

            Assert.IsTrue(ready.Wait(TimeSpan.FromSeconds(WatchdogSeconds)), $"warm-up of {warmup} never finished.");
            var stopwatch = Stopwatch.StartNew();
            source.Cancel();
            Assert.IsTrue(worker.Wait(TimeSpan.FromSeconds(WatchdogSeconds)),
                $"The worker warmed with {warmup} evaluations did not stop.");
            stopwatch.Stop();
            Assert.IsTrue(observed);
            Assert.IsTrue(completed);
            Console.WriteLine($"warm-up {warmup,5}: cancel to join {stopwatch.Elapsed.TotalMilliseconds:F3} ms");
        }
    }

    private static void Passes(string source, NendoBehaviourLimits? limits = null) =>
        new NendoExpressionAdapter().Validate(
            new BehaviourFormula("probe", source, [], new Dictionary<string, ValidatedExpression>()),
            Budget(limits));

    private static void Refuses(string source, NendoBehaviourLimits? limits = null) =>
        Assert.ThrowsExactly<NendoValidationException>(() => Passes(source, limits), source);

    /// <summary>
    /// Runs an adversarial probe on its own thread and fails if it does not finish.
    /// A probe that has to be abandoned has already demonstrated the failure this
    /// lane exists to catch, so it is never reported as inconclusive.
    /// </summary>
    private static void RunUnderWatchdog(string what, Action probe)
    {
        Exception? failure = null;
        var thread = new Thread(() => { try { probe(); } catch (Exception exception) { failure = exception; } })
        {
            IsBackground = true,
            Name = $"behaviour-probe:{what}",
        };
        thread.Start();
        Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(WatchdogSeconds)),
            $"The probe '{what}' was still running after {WatchdogSeconds} seconds; it was not contained.");
        if (failure is not null) throw failure;
    }
}
