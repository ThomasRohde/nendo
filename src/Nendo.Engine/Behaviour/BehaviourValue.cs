using System.Globalization;

namespace Nendo.Engine;

/// <summary>
/// One typed scalar flowing through an expression, or a typed empty.
/// <para>
/// The boxed payload is always exactly one of <see cref="long"/>,
/// <see cref="decimal"/>, <see cref="bool"/>, <see cref="string"/> or
/// <see cref="DateOnly"/> — never Double, never BigDecimal, never an arbitrary
/// object. NCalc's transitive dependencies make other numeric types reachable in
/// principle; nothing may construct one of these around them.
/// </para>
/// <para>
/// Empty carries its type. A calculation that yields nothing still knows it was a
/// whole number, so a dependant reads a typed empty rather than an untyped hole.
/// </para>
/// </summary>
internal readonly record struct BehaviourValue
{
    private BehaviourValue(NendoBehaviourScalar type, object? boxed)
    {
        Type = type;
        Boxed = boxed;
    }

    internal NendoBehaviourScalar Type { get; }

    internal object? Boxed { get; }

    internal bool IsNull => Boxed is null;

    internal static BehaviourValue Integer(long value) => new(NendoBehaviourScalar.Integer, value);

    internal static BehaviourValue Decimal(decimal value) => new(NendoBehaviourScalar.Decimal, value);

    internal static BehaviourValue Boolean(bool value) => new(NendoBehaviourScalar.Boolean, value);

    internal static BehaviourValue Date(DateOnly value) => new(NendoBehaviourScalar.Date, value);

    internal static BehaviourValue Empty(NendoBehaviourScalar type) => new(type, null);

    internal static BehaviourValue Text(string value, NendoBehaviourLimits limits)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Length > limits.TextLength)
            throw new NendoCalculationException(NendoCalculationCodes.TextTooLong,
                $"A text value is longer than the {limits.TextLength} characters a formula may handle.");
        return new(NendoBehaviourScalar.Text, value);
    }

    /// <summary>
    /// Wraps a value produced by NCalc, refusing anything outside the contract's
    /// scalar domain. A Double reaching here means an operation slipped past the
    /// typed walk, so it is a failure rather than something to convert.
    /// </summary>
    internal static BehaviourValue FromEvaluated(object? value, NendoBehaviourLimits limits) => value switch
    {
        null => throw new NendoCalculationException(NendoCalculationCodes.MissingInput,
            "A value this formula needs is empty."),
        long number => Integer(number),
        decimal number => Decimal(number),
        bool flag => Boolean(flag),
        string text => Text(text, limits),
        DateOnly date => Date(date),
        _ => throw new NendoValidationException(
            "The formula produced a kind of value this contract does not define."),
    };

    internal long AsInteger() => (long)Require();

    internal decimal AsDecimal() => Type == NendoBehaviourScalar.Integer ? (long)Require() : (decimal)Require();

    internal bool AsBoolean() => (bool)Require();

    internal string AsText() => (string)Require();

    internal DateOnly AsDate() => (DateOnly)Require();

    private object Require() => Boxed ?? throw new NendoCalculationException(
        NendoCalculationCodes.MissingInput, "A value this formula needs is empty.");

    /// <summary>Invariant text for diagnostics and tests; never a display format.</summary>
    public override string ToString() => Boxed switch
    {
        null => $"empty {Type.ToString().ToLowerInvariant()}",
        long number => number.ToString(CultureInfo.InvariantCulture),
        decimal number => number.ToString(CultureInfo.InvariantCulture),
        bool flag => flag ? "true" : "false",
        DateOnly date => date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        _ => (string)Boxed,
    };
}
