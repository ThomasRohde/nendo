using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using NCalc;
using NCalc.Handlers;
using NCalc.Helpers;

namespace Nendo.Engine;

/// <summary>
/// The source of one formula, with everything needed to decide what it means.
/// </summary>
internal sealed record BehaviourFormula(
    string FormulaId,
    string Source,
    IReadOnlyList<BehaviourParameter> Parameters,
    IReadOnlyDictionary<string, ValidatedExpression> Calls,
    bool? ResultNullable = null);

/// <summary>
/// A formula that has been parsed, typed and bounded, and may now be evaluated.
/// <para>
/// Immutable, and the only thing that reaches evaluation. Holding the parsed tree
/// rather than the source is what keeps validation and evaluation from disagreeing:
/// there is no second parse that could accept something the first refused.
/// </para>
/// </summary>
internal sealed class ValidatedExpression
{
    internal ValidatedExpression(
        string formulaId,
        LogicalExpression ast,
        IReadOnlyList<BehaviourParameter> parameters,
        IReadOnlyDictionary<string, ValidatedExpression> calls,
        NendoBehaviourScalar resultType,
        bool? resultNullable,
        string cacheKey)
    {
        FormulaId = formulaId;
        Ast = ast;
        Parameters = parameters;
        Calls = calls;
        ResultType = resultType;
        ResultNullable = resultNullable;
        CacheKey = cacheKey;
    }

    internal string FormulaId { get; }

    /// <summary>NCalc's parsed tree. Never leaves the Engine's behaviour internals.</summary>
    internal LogicalExpression Ast { get; }

    internal IReadOnlyList<BehaviourParameter> Parameters { get; }

    internal IReadOnlyDictionary<string, ValidatedExpression> Calls { get; }

    internal NendoBehaviourScalar ResultType { get; }

    /// <summary>
    /// Whether the definition declared that its result may be empty. The declaration
    /// decides what an empty input does to the formula: stop it with an empty result,
    /// or stop it with <c>calculation-missing-input</c> (ADR-0008, 2026-09-20 amendment).
    /// Null where nothing was declared -- a trigger condition, an action's assignment --
    /// and there an empty operand is the error it always was, and an empty ending is
    /// allowed: a condition that ends empty selects nothing, an assignment clears.
    /// </summary>
    internal bool? ResultNullable { get; }

    internal string CacheKey { get; }
}

/// <summary>
/// The only route from an expression's source text to a value.
/// <para>
/// NCalc parses the accepted syntax and supplies the checked arithmetic and the
/// comparison semantics. This adapter decides what syntax is accepted, what may be
/// named or called, how much work an evaluation may do, and what happens when a
/// value is empty — and it intercepts division, which is the one operation whose
/// library behaviour is wrong for this contract.
/// </para>
/// <para>
/// Division is intercepted because the evaluator's integer division converts its
/// operands to Double before dividing. That silently makes <c>1/3</c> a binary
/// approximation and makes two different 17-digit integers compare equal. The
/// interception converts to decimal <em>before</em> dividing; converting the result
/// afterwards would be too late, because the wrong branch has already been taken.
/// </para>
/// </summary>
internal sealed class NendoExpressionAdapter
{
    private static readonly ExpressionOptions Options =
        ExpressionOptions.DecimalAsDefault | ExpressionOptions.LongAsDefault |
        ExpressionOptions.OverflowProtection | ExpressionOptions.NoStringTypeCoercion |
        ExpressionOptions.OrdinalStringComparer | ExpressionOptions.NoCache;

    private static readonly CultureInfo Culture = CultureInfo.InvariantCulture;

    private readonly ExpressionConfiguration _configuration = ExpressionConfiguration.FromOptions(Options);
    private readonly Dictionary<string, ValidatedExpression> _cache = new(StringComparer.Ordinal);

    internal int CachedExpressionCount => _cache.Count;

    /// <summary>
    /// Parses, types and bounds one formula. A definition error — unknown name,
    /// wrong type, forbidden operator, oversized source — refuses here, so it is
    /// never installed and never becomes an error on every record.
    /// </summary>
    internal ValidatedExpression Validate(BehaviourFormula formula, BehaviourBudget budget)
    {
        ArgumentNullException.ThrowIfNull(formula);
        ArgumentNullException.ThrowIfNull(budget);

        var key = CacheKey(formula, budget.Limits);
        if (_cache.TryGetValue(key, out var cached)) return cached;

        NendoBehaviourPreflight.Check(formula.Source, budget);

        var expression = new Expression(formula.Source, _configuration, new ExpressionContext(), Culture, null);
        LogicalExpression? ast;
        try
        {
            ast = expression.GetLogicalExpression(budget.CancellationToken);
        }
        catch (Exception exception) when (exception is NCalc.Exceptions.NCalcParserException or FormatException)
        {
            // A cancelled parse can surface as a parse error, so cancellation is
            // rechecked before this is reported as the author's mistake.
            budget.CancellationToken.ThrowIfCancellationRequested();
            throw new NendoValidationException("This formula could not be read. Check its syntax.");
        }
        budget.CancellationToken.ThrowIfCancellationRequested();
        if (ast is null || expression.Error is not null)
            throw new NendoValidationException("This formula could not be read. Check its syntax.");

        var parameters = new Dictionary<string, BehaviourParameter>(StringComparer.Ordinal);
        if (formula.Parameters.Count > budget.Limits.Parameters)
            throw new NendoValidationException(
                $"A formula reads at most {budget.Limits.Parameters} values.");
        foreach (var parameter in formula.Parameters)
        {
            NendoBehaviourValidation.RequireIdentifier(parameter.Name, "value");
            if (!parameters.TryAdd(parameter.Name, parameter))
                throw new NendoValidationException($"'{parameter.Name}' is declared twice.");
        }
        foreach (var alias in formula.Calls.Keys) NendoBehaviourValidation.RequireIdentifier(alias, "function alias");

        var resultType = NendoBehaviourAnalyzer.Analyze(ast, parameters, formula.Calls, budget);
        var validated = new ValidatedExpression(
            formula.FormulaId, ast, formula.Parameters, formula.Calls, resultType, formula.ResultNullable, key);

        // Clearing on reaching the cap keeps a bounded, predictable footprint without
        // a recency structure whose cost would itself need bounding.
        if (_cache.Count >= budget.Limits.CacheEntries) _cache.Clear();
        _cache[key] = validated;
        return validated;
    }

    /// <summary>
    /// Evaluates a validated formula against typed values, spending the caller's
    /// budget. The same budget covers every nested call, so depth buys no extra
    /// allowance.
    /// </summary>
    internal BehaviourValue Calculate(
        ValidatedExpression expression,
        IReadOnlyDictionary<string, BehaviourValue> values,
        BehaviourBudget budget)
    {
        ArgumentNullException.ThrowIfNull(expression);
        ArgumentNullException.ThrowIfNull(values);
        ArgumentNullException.ThrowIfNull(budget);
        budget.CancellationToken.ThrowIfCancellationRequested();

        var context = new ExpressionContext();
        object? result;
        try
        {
            foreach (var parameter in expression.Parameters)
            {
                if (!values.TryGetValue(parameter.Name, out var value))
                    throw new NendoValidationException($"No value was supplied for '{parameter.Name}'.");
                if (value.Type != parameter.Type && !(parameter.Type == NendoBehaviourScalar.Decimal &&
                                                      value.Type == NendoBehaviourScalar.Integer))
                {
                    throw new NendoValidationException(
                        $"'{parameter.Name}' was given a {value.Type.ToString().ToLowerInvariant()} value where the formula declares {parameter.Type.ToString().ToLowerInvariant()}.");
                }
                // An empty where the formula declared a value is an empty input stopping
                // the formula: a calculation outcome, not a definition error. The
                // definition was fine; this record's data is not.
                if (value.IsNull && !parameter.Nullable)
                    throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
                        $"'{parameter.Name}' is empty, and this formula needs a value for it.");
                context.Parameters[parameter.Name] = value.Boxed;
            }

            foreach (var (alias, target) in expression.Calls)
            {
                var callee = target;
                context.Functions[alias] = data => InvokeApplicationFunction(callee, data, budget);
            }
            foreach (var name in NendoBehaviourCatalogue.Names)
            {
                if (!NendoBehaviourCatalogue.TryGet(name, out var function)) continue;
                var entry = function;
                context.Functions[name] = data => InvokeCatalogueFunction(entry, data, budget);
            }

            var factory = new BehaviourVisitorFactory(budget);
            var runner = new Expression(expression.Ast, _configuration, context, Culture, factory);
            runner.EvaluateBinary += args => EvaluateBinary(args, budget);

            result = runner.Evaluate(budget.CancellationToken);
        }
        catch (NendoCalculationException exception)
            when (exception.Code == NendoCalculationCodes.MissingInput && expression.ResultNullable == true)
        {
            // The declaration decides (ADR-0008, 2026-09-20 amendment): an empty input
            // that stops a formula declared to allow an empty result is that empty
            // result, not an error. A formula declared always to answer keeps the error,
            // and every other code -- a refusal by name, a zero divisor -- is what it is.
            return BehaviourValue.Empty(expression.ResultType);
        }
        budget.CancellationToken.ThrowIfCancellationRequested();
        if (result is null)
        {
            // Honoured both ways: a formula that ends empty under a declaration that it
            // always answers is reporting a value it does not have.
            if (expression.ResultNullable == false)
                throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
                    "This formula ended empty, and it was declared always to produce a value.");
            return BehaviourValue.Empty(expression.ResultType);
        }
        var evaluated = BehaviourValue.FromEvaluated(result, budget.Limits);
        // A whole number answering a decimal formula is widened here rather than
        // being reported as a different kind of result than the definition promised.
        return evaluated.Type == NendoBehaviourScalar.Integer && expression.ResultType == NendoBehaviourScalar.Decimal
            ? BehaviourValue.Decimal(evaluated.AsDecimal())
            : evaluated;
    }

    private object? InvokeCatalogueFunction(CatalogueFunction function, FunctionData data, BehaviourBudget budget)
    {
        budget.SpendCall();
        var arguments = new List<BehaviourValue>(data.Count);
        for (var index = 0; index < data.Count; index++)
        {
            arguments.Add(BehaviourValue.FromEvaluated(data.Evaluate(index), budget.Limits));
        }
        return function.Invoke(arguments, budget).Boxed;
    }

    private object? InvokeApplicationFunction(ValidatedExpression callee, FunctionData data, BehaviourBudget budget)
    {
        budget.SpendCall();
        if (data.Count != callee.Parameters.Count)
            throw new NendoValidationException($"'{callee.FormulaId}' takes {callee.Parameters.Count} values.");
        var arguments = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal);
        for (var index = 0; index < callee.Parameters.Count; index++)
        {
            var parameter = callee.Parameters[index];
            var value = BehaviourValue.FromEvaluated(data.Evaluate(index), budget.Limits);
            if (parameter.Type == NendoBehaviourScalar.Decimal && value.Type == NendoBehaviourScalar.Integer)
                value = BehaviourValue.Decimal(value.AsDecimal());
            arguments[parameter.Name] = value;
        }
        // The same budget, deliberately: a chain of calls spends one allowance.
        return Calculate(callee, arguments, budget).Boxed;
    }

    /// <summary>
    /// Computes every binary operation this contract defines.
    /// <para>
    /// The handler always sets a result. NCalc does not memoise
    /// <c>LeftValue()</c>/<c>RightValue()</c>, so inspecting the operands and then
    /// letting the library compute would evaluate both sides a second time — double
    /// the work, double the charge, and a second read of every value.
    /// </para>
    /// </summary>
    private static void EvaluateBinary(BinaryEventArgs args, BehaviourBudget budget)
    {
        budget.SpendWork();
        var type = args.BinaryExpression.Type;
        var options = ExpressionConfigurationEvaluation;

        // Boolean control is lazy, and stays lazy: the right side of a settled `and`
        // or `or` is never evaluated, so an error there is never raised.
        if (type is BinaryExpressionType.And or BinaryExpressionType.Or)
        {
            var left = RequireBoolean(args.LeftValue());
            if (type == BinaryExpressionType.And && !left) { args.Result = false; return; }
            if (type == BinaryExpressionType.Or && left) { args.Result = true; return; }
            args.Result = RequireBoolean(args.RightValue());
            return;
        }

        var leftValue = Require(args.LeftValue());
        var rightValue = Require(args.RightValue());

        if (type == BinaryExpressionType.Div)
        {
            var divisor = ToDecimal(rightValue);
            if (divisor == 0m)
                throw new NendoCalculationException(NendoCalculationCodes.DivideByZero,
                    "This calculation divides by zero.");
            try { args.Result = ToDecimal(leftValue) / divisor; }
            catch (OverflowException) { throw Overflow(); }
            return;
        }

        try
        {
            args.Result = type switch
            {
                BinaryExpressionType.Plus => EvaluationHelper.Plus(leftValue, rightValue, options, Culture),
                BinaryExpressionType.Minus => EvaluationHelper.Minus(leftValue, rightValue, options, Culture),
                BinaryExpressionType.Times => EvaluationHelper.Times(leftValue, rightValue, options, Culture),
                BinaryExpressionType.Modulo => EvaluationHelper.Modulo(leftValue, rightValue, options, Culture),
                _ => Compare(type, leftValue, rightValue, options),
            };
        }
        catch (OverflowException) { throw Overflow(); }
        catch (DivideByZeroException)
        {
            throw new NendoCalculationException(NendoCalculationCodes.DivideByZero,
                "This calculation divides by zero.");
        }
    }

    private static object Compare(
        BinaryExpressionType type,
        object left,
        object right,
        ExpressionEvaluationOptions options)
    {
        var comparison = TypeHelper.CompareUsingMostPreciseType(left, right, options.StringComparer, Culture);
        return type switch
        {
            BinaryExpressionType.Equal => comparison == ComparisonResult.Equal,
            BinaryExpressionType.NotEqual => comparison != ComparisonResult.Equal,
            BinaryExpressionType.Lesser => comparison == ComparisonResult.Less,
            BinaryExpressionType.LesserOrEqual => comparison != ComparisonResult.Greater,
            BinaryExpressionType.Greater => comparison == ComparisonResult.Greater,
            BinaryExpressionType.GreaterOrEqual => comparison != ComparisonResult.Less,
            _ => throw new NendoValidationException("This formula uses an operator the contract does not define."),
        };
    }

    /// <summary>Only long and decimal convert. A Double here would mean the typed walk was bypassed.</summary>
    private static decimal ToDecimal(object value) => value switch
    {
        long number => number,
        decimal number => number,
        _ => throw new NendoValidationException("Division needs numbers on both sides."),
    };

    private static object Require(object? value) => value ?? throw new NendoCalculationException(
        NendoCalculationCodes.MissingInput, "A value this calculation needs is empty.");

    private static bool RequireBoolean(object? value) => value switch
    {
        bool flag => flag,
        null => throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
            "A true/false value this calculation needs is empty."),
        _ => throw new NendoValidationException("'and' and 'or' join true/false values."),
    };

    internal static NendoCalculationException Overflow() => new(NendoCalculationCodes.Overflow,
        "This calculation produced a number outside the range it can hold.");

    private static ExpressionEvaluationOptions ExpressionConfigurationEvaluation { get; } =
        ExpressionConfiguration.FromOptions(Options).Evaluation;

    private static string CacheKey(BehaviourFormula formula, NendoBehaviourLimits limits)
    {
        // The key covers the contract, the formula's identity and source, the declared
        // types of everything it reads, the exact callees it resolved to, and the limit
        // policy. A stricter run therefore cannot reuse a result validated under a more
        // permissive one, and a changed dependency cannot hide behind a warm entry.
        var builder = new StringBuilder()
            .Append(NendoBehaviourContract.Version).Append('\n')
            .Append(limits.PolicyKey()).Append('\n')
            .Append(formula.FormulaId).Append('\n')
            .Append(formula.Source).Append('\n')
            .Append(formula.ResultNullable switch { true => "optional", false => "required", null => "undeclared" }).Append('\n');
        foreach (var parameter in formula.Parameters)
        {
            builder.Append(parameter.Name).Append(':').Append(parameter.Type).Append(':').Append(parameter.Nullable).Append(';');
        }
        builder.Append('\n');
        foreach (var (alias, target) in formula.Calls.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            builder.Append(alias).Append("=>").Append(target.CacheKey).Append(';');
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString()))).ToLowerInvariant();
    }
}
