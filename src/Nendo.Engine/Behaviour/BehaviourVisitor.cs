using System.Globalization;
using NCalc;
using NCalc.Factories;
using NCalc.Helpers;
using NCalc.Visitors;

namespace Nendo.Engine;

/// <summary>
/// Counts every node the evaluator visits and enforces the rules that cannot be
/// settled statically.
/// <para>
/// Charging per visit rather than per expression is what bounds evaluation rather
/// than source size: a small formula that calls a function that calls a function
/// visits many nodes, and every one of them is paid for out of the same budget.
/// </para>
/// <para>
/// The typed walk already refused everything this contract does not define, so the
/// guards here are the ones that depend on values: an empty operand, a condition
/// that is not actually true or false, and the branch of a choice that must not be
/// evaluated at all.
/// </para>
/// </summary>
internal sealed class BehaviourEvaluationVisitor : EvaluationVisitor
{
    private readonly ExpressionEvaluationOptions _options;
    private readonly CultureInfo _culture;
    private readonly BehaviourBudget _budget;

    internal BehaviourEvaluationVisitor(
        ExpressionContext context,
        ExpressionEvaluationOptions options,
        CultureInfo cultureInfo,
        IEvaluationVisitorFactory factory,
        CancellationToken cancellationToken,
        BehaviourBudget budget)
        : base(context, options, cultureInfo, factory, cancellationToken)
    {
        _options = options;
        _culture = cultureInfo;
        _budget = budget;
    }

    public override object? Visit(ValueExpression expression)
    {
        _budget.SpendWork();
        return base.Visit(expression);
    }

    public override object? Visit(Identifier identifier)
    {
        _budget.SpendWork();
        return base.Visit(identifier);
    }

    public override object? Visit(NCalc.Function function)
    {
        _budget.SpendWork();
        return base.Visit(function);
    }

    public override object? Visit(BinaryExpression expression)
    {
        _budget.SpendWork();
        if (!NendoBehaviourAnalyzer.IsAllowed(expression.Type))
            throw new NendoValidationException("This formula uses an operator the contract does not define.");
        return base.Visit(expression);
    }

    /// <summary>
    /// Evaluates the operand exactly once and checks it before the library can turn
    /// an empty value into zero or false.
    /// </summary>
    public override object? Visit(UnaryExpression expression)
    {
        _budget.SpendWork();
        if (expression.Type is not (UnaryExpressionType.Not or UnaryExpressionType.Negate))
            throw new NendoValidationException("This formula uses an operator the contract does not define.");
        var operand = expression.Expression.Accept(this)
            ?? throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
                "A value this calculation needs is empty.");
        if (expression.Type == UnaryExpressionType.Not && operand is not bool)
            throw new NendoValidationException("'not' applies to a true/false value.");
        try
        {
            return EvaluationHelper.Unary(expression, operand, _options, _culture);
        }
        catch (OverflowException)
        {
            throw NendoExpressionAdapter.Overflow();
        }
    }

    /// <summary>
    /// Visits the selected branch only. The branch not taken is not merely discarded;
    /// it is never evaluated, so <c>true ? 7 : 1/0</c> is seven rather than an error.
    /// </summary>
    public override object? Visit(TernaryExpression expression)
    {
        _budget.SpendWork();
        var condition = expression.LeftExpression.Accept(this);
        return condition switch
        {
            true => expression.MiddleExpression.Accept(this),
            false => expression.RightExpression.Accept(this),
            null => throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
                "The true/false test in this calculation is empty."),
            _ => throw new NendoValidationException("A choice needs a true/false test before the question mark."),
        };
    }

    public override object? Visit(LogicalExpressionList list)
    {
        _budget.SpendWork();
        throw new NendoValidationException("A formula produces a single value, not a list.");
    }
}

/// <summary>
/// Supplies the counting visitors.
/// <para>
/// The asynchronous visitor is built even on the synchronous path, because the
/// evaluator constructs one to hand to binary-operation handlers. It is created
/// counting rather than throwing or unbounded, so there is no evaluation entry point
/// that does work without paying for it.
/// </para>
/// </summary>
internal sealed class BehaviourVisitorFactory(BehaviourBudget budget) : IEvaluationVisitorFactory
{
    public EvaluationVisitor CreateEvaluationVisitor(
        ExpressionContext context,
        ExpressionEvaluationOptions options,
        CultureInfo cultureInfo,
        CancellationToken cancellationToken) =>
        new BehaviourEvaluationVisitor(context, options, cultureInfo, this, cancellationToken, budget);

    public AsyncEvaluationVisitor CreateAsyncEvaluationVisitor(
        ExpressionContext context,
        ExpressionEvaluationOptions options,
        CultureInfo cultureInfo,
        CancellationToken cancellationToken) =>
        new BehaviourAsyncEvaluationVisitor(context, options, cultureInfo, this, cancellationToken, budget);
}

/// <summary>
/// The asynchronous visitor the evaluator requires to exist. Nothing in this Engine
/// reaches it — every evaluation runs through the synchronous path — but it charges
/// the same budget so that remains true by construction rather than by convention.
/// </summary>
internal sealed class BehaviourAsyncEvaluationVisitor(
    ExpressionContext context,
    ExpressionEvaluationOptions options,
    CultureInfo cultureInfo,
    IEvaluationVisitorFactory factory,
    CancellationToken cancellationToken,
    BehaviourBudget budget)
    : AsyncEvaluationVisitor(context, options, cultureInfo, factory, cancellationToken)
{
    public override Task<object?> Visit(ValueExpression expression)
    {
        budget.SpendWork();
        return base.Visit(expression);
    }

    public override Task<object?> Visit(Identifier identifier)
    {
        budget.SpendWork();
        return base.Visit(identifier);
    }

    public override Task<object?> Visit(NCalc.Function function)
    {
        budget.SpendWork();
        return base.Visit(function);
    }

    public override Task<object?> Visit(BinaryExpression expression)
    {
        budget.SpendWork();
        if (!NendoBehaviourAnalyzer.IsAllowed(expression.Type))
            throw new NendoValidationException("This formula uses an operator the contract does not define.");
        return base.Visit(expression);
    }

    public override Task<object?> Visit(UnaryExpression expression)
    {
        budget.SpendWork();
        return base.Visit(expression);
    }

    public override Task<object?> Visit(TernaryExpression expression)
    {
        budget.SpendWork();
        return base.Visit(expression);
    }

    public override Task<object?> Visit(LogicalExpressionList list)
    {
        budget.SpendWork();
        throw new NendoValidationException("A formula produces a single value, not a list.");
    }
}
