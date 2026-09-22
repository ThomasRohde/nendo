using NCalc;

namespace Nendo.Engine;

/// <summary>One name an expression may use, with the type it is guaranteed to have.</summary>
internal readonly record struct BehaviourParameter(string Name, NendoBehaviourScalar Type, bool Nullable);

/// <summary>
/// The typed, depth- and size-bounded walk over a parsed expression.
/// <para>
/// Everything an expression is permitted to do is decided here, before any value
/// exists. The walk is an allow-list at every level — which node kinds may appear,
/// which operators, which functions, and which operand types each accepts — so a
/// construct is refused by not being listed rather than by being recognised as
/// dangerous. Operators NCalc parses happily but this contract does not define
/// (power, shifts, bitwise, <c>in</c>, <c>like</c>, lists) fall out automatically.
/// </para>
/// <para>
/// It also settles the static type of every subexpression, which is what makes a
/// later refusal impossible for reasons of type: <c>'2' + 1</c> and <c>true + 1</c>
/// are rejected here, not left to produce "21" or an exception at evaluation time.
/// </para>
/// </summary>
internal static class NendoBehaviourAnalyzer
{
    /// <summary>Binary operations this contract defines. Everything else refuses.</summary>
    private static readonly HashSet<BinaryExpressionType> Allowed =
    [
        BinaryExpressionType.And, BinaryExpressionType.Or,
        BinaryExpressionType.Equal, BinaryExpressionType.NotEqual,
        BinaryExpressionType.Lesser, BinaryExpressionType.LesserOrEqual,
        BinaryExpressionType.Greater, BinaryExpressionType.GreaterOrEqual,
        BinaryExpressionType.Plus, BinaryExpressionType.Minus,
        BinaryExpressionType.Times, BinaryExpressionType.Div, BinaryExpressionType.Modulo,
    ];

    internal static bool IsAllowed(BinaryExpressionType type) => Allowed.Contains(type);

    /// <summary>
    /// Walks the tree, charging work per node and enforcing node count and depth, and
    /// returns the static result type.
    /// </summary>
    internal static NendoBehaviourScalar Analyze(
        LogicalExpression expression,
        IReadOnlyDictionary<string, BehaviourParameter> parameters,
        IReadOnlyDictionary<string, ValidatedExpression> calls,
        BehaviourBudget budget)
    {
        var nodes = 0;
        return Walk(expression, 1);

        void Charge(int depth)
        {
            budget.SpendWork();
            if (++nodes > budget.Limits.AstNodes)
                throw new NendoValidationException(
                    $"This formula has more than the {budget.Limits.AstNodes} parts a formula may contain.");
            if (depth > budget.Limits.AstDepth)
                throw new NendoValidationException(
                    $"This formula nests more than {budget.Limits.AstDepth} levels deep.");
        }

        // One outcome of a choice: its type, or null when it is a refusal by name. A
        // refusal stands in for a value of the other outcome's kind, so it is typed here,
        // where the other outcome is in view, and not by the catalogue, which cannot see
        // it. An alias that shadows the name is the author's own function and is walked
        // as one.
        NendoBehaviourScalar? Outcome(LogicalExpression node, int depth)
        {
            if (node is not NCalc.Function { Identifier.Name: "Refuse" } refusal || calls.ContainsKey("Refuse"))
                return Walk(node, depth);
            Charge(depth);
            if (refusal.Parameters.Count != 1)
                throw new NendoValidationException("Refuse takes 1 value.");
            if (Walk(refusal.Parameters[0], depth + 1) != NendoBehaviourScalar.Text)
                throw new NendoValidationException("Refuse expects text for argument 1.");
            return null;
        }

        NendoBehaviourScalar Walk(LogicalExpression node, int depth)
        {
            Charge(depth);

            switch (node)
            {
                case ValueExpression value:
                    return LiteralType(value);

                case Identifier identifier:
                    return parameters.TryGetValue(identifier.Name, out var parameter)
                        ? parameter.Type
                        : throw new NendoValidationException(
                            $"'{identifier.Name}' is not one of the values this formula declares.");

                case UnaryExpression unary:
                {
                    var operand = Walk(unary.Expression, depth + 1);
                    return unary.Type switch
                    {
                        UnaryExpressionType.Not when operand == NendoBehaviourScalar.Boolean => NendoBehaviourScalar.Boolean,
                        UnaryExpressionType.Not => throw new NendoValidationException("'not' applies to a true/false value."),
                        UnaryExpressionType.Negate when IsNumeric(operand) => operand,
                        UnaryExpressionType.Negate => throw new NendoValidationException("A minus sign applies to a number."),
                        _ => throw new NendoValidationException("This formula uses an operator the contract does not define."),
                    };
                }

                case BinaryExpression binary:
                {
                    if (!Allowed.Contains(binary.Type))
                        throw new NendoValidationException("This formula uses an operator the contract does not define.");
                    var left = Walk(binary.LeftExpression, depth + 1);
                    var right = Walk(binary.RightExpression, depth + 1);
                    return BinaryType(binary.Type, left, right);
                }

                case TernaryExpression ternary:
                {
                    if (Walk(ternary.LeftExpression, depth + 1) != NendoBehaviourScalar.Boolean)
                        throw new NendoValidationException("A choice needs a true/false test before the question mark.");
                    var whenTrue = Outcome(ternary.MiddleExpression, depth + 1);
                    var whenFalse = Outcome(ternary.RightExpression, depth + 1);
                    if (whenTrue is null && whenFalse is null)
                        throw new NendoValidationException(
                            "A choice cannot refuse in both outcomes: a calculation that can never answer is a definition error.");
                    if (whenTrue is null) return whenFalse!.Value;
                    if (whenFalse is null) return whenTrue.Value;
                    if (whenTrue == whenFalse) return whenTrue.Value;
                    if (IsNumeric(whenTrue.Value) && IsNumeric(whenFalse.Value)) return NendoBehaviourScalar.Decimal;
                    throw new NendoValidationException("Both outcomes of a choice must be the same kind of value.");
                }

                case NCalc.Function function:
                {
                    var name = function.Identifier.Name;
                    var arguments = new List<NendoBehaviourScalar>(function.Parameters.Count);
                    foreach (var argument in function.Parameters) arguments.Add(Walk(argument, depth + 1));
                    if (calls.TryGetValue(name, out var target)) return ApplicationCall(name, target, arguments);
                    if (!NendoBehaviourCatalogue.TryGet(name, out var catalogue))
                        throw new NendoValidationException(
                            $"'{name}' is not a function this formula may call.");
                    if (arguments.Count < catalogue.MinimumArguments || arguments.Count > catalogue.MaximumArguments)
                        throw new NendoValidationException(
                            $"{name} takes {Range(catalogue.MinimumArguments, catalogue.MaximumArguments)}.");
                    return catalogue.ResultFor(arguments);
                }

                // A list is how NCalc represents `(1,2)`. Nothing in this contract
                // consumes one, and letting it through would be the first value that
                // is not a scalar.
                case LogicalExpressionList:
                    throw new NendoValidationException("A formula produces a single value, not a list.");

                default:
                    throw new NendoValidationException("This formula uses a construct the contract does not define.");
            }
        }
    }

    private static NendoBehaviourScalar ApplicationCall(
        string name,
        ValidatedExpression target,
        IReadOnlyList<NendoBehaviourScalar> arguments)
    {
        if (arguments.Count != target.Parameters.Count)
            throw new NendoValidationException(
                $"{name} takes {target.Parameters.Count} value{(target.Parameters.Count == 1 ? "" : "s")}.");
        for (var index = 0; index < arguments.Count; index++)
        {
            var expected = target.Parameters[index].Type;
            if (arguments[index] == expected) continue;
            // A whole number where a decimal is wanted is the one widening this
            // contract allows, because it loses nothing. The reverse does.
            if (expected == NendoBehaviourScalar.Decimal && arguments[index] == NendoBehaviourScalar.Integer) continue;
            throw new NendoValidationException(
                $"{name} expects {expected.ToString().ToLowerInvariant()} for argument {index + 1}.");
        }
        return target.ResultType;
    }

    private static NendoBehaviourScalar BinaryType(
        BinaryExpressionType type,
        NendoBehaviourScalar left,
        NendoBehaviourScalar right) => type switch
        {
            BinaryExpressionType.And or BinaryExpressionType.Or =>
                left == NendoBehaviourScalar.Boolean && right == NendoBehaviourScalar.Boolean
                    ? NendoBehaviourScalar.Boolean
                    : throw new NendoValidationException("'and' and 'or' join true/false values."),

            // Division always answers in the decimal domain, including whole number
            // over whole number. That is the whole point: 1/3 is a third, not zero and
            // not a binary approximation of a third.
            BinaryExpressionType.Div =>
                IsNumeric(left) && IsNumeric(right)
                    ? NendoBehaviourScalar.Decimal
                    : throw new NendoValidationException("Division needs numbers on both sides."),

            BinaryExpressionType.Plus or BinaryExpressionType.Minus or
            BinaryExpressionType.Times or BinaryExpressionType.Modulo =>
                IsNumeric(left) && IsNumeric(right)
                    ? Promote(left, right)
                    : throw new NendoValidationException(
                        "Arithmetic needs numbers on both sides; text and true/false values do not become numbers."),

            BinaryExpressionType.Equal or BinaryExpressionType.NotEqual =>
                Comparable(left, right, ordered: false),

            _ => Comparable(left, right, ordered: true),
        };

    private static NendoBehaviourScalar Comparable(NendoBehaviourScalar left, NendoBehaviourScalar right, bool ordered)
    {
        if (IsNumeric(left) && IsNumeric(right)) return NendoBehaviourScalar.Boolean;
        if (left == right && (!ordered || left != NendoBehaviourScalar.Boolean)) return NendoBehaviourScalar.Boolean;
        throw new NendoValidationException(
            ordered
                ? "A comparison needs two numbers, two dates or two pieces of text."
                : "A comparison needs two values of the same kind.");
    }

    private static NendoBehaviourScalar Promote(NendoBehaviourScalar left, NendoBehaviourScalar right) =>
        left == NendoBehaviourScalar.Decimal || right == NendoBehaviourScalar.Decimal
            ? NendoBehaviourScalar.Decimal
            : NendoBehaviourScalar.Integer;

    internal static bool IsNumeric(NendoBehaviourScalar type) =>
        type is NendoBehaviourScalar.Integer or NendoBehaviourScalar.Decimal;

    private static NendoBehaviourScalar LiteralType(ValueExpression value) => value.Value switch
    {
        long => NendoBehaviourScalar.Integer,
        decimal => NendoBehaviourScalar.Decimal,
        bool => NendoBehaviourScalar.Boolean,
        string => NendoBehaviourScalar.Text,
        // Double, char, Guid, DateTime and TimeSpan literals are all reachable in
        // NCalc's grammar and none of them is a value this contract defines.
        _ => throw new NendoValidationException(
            "This formula contains a kind of literal value the contract does not define."),
    };

    private static string Range(int minimum, int maximum) =>
        minimum == maximum
            ? $"{minimum} value{(minimum == 1 ? "" : "s")}"
            : $"between {minimum} and {maximum} values";
}
