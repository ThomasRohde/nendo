namespace Nendo.Engine;

/// <summary>
/// Why a calculation produced no value. Codes are stable identifiers a surface can
/// map to its own words; the message is already owner-facing and carries no stack
/// trace, type name or expression internals.
/// </summary>
public static class NendoCalculationCodes
{
    /// <summary>A value the formula needs is empty.</summary>
    public const string MissingInput = "calculation-missing-input";

    /// <summary>Division by zero.</summary>
    public const string DivideByZero = "calculation-divide-by-zero";

    /// <summary>A whole number or decimal result is out of range.</summary>
    public const string Overflow = "calculation-overflow";

    /// <summary>A date could not be read, or is not a real calendar date.</summary>
    public const string InvalidDate = "calculation-invalid-date";

    /// <summary>A text value or result is longer than the contract allows.</summary>
    public const string TextTooLong = "calculation-text-too-long";

    /// <summary>The work, call, scan or change ceiling was reached.</summary>
    public const string LimitReached = "calculation-limit-reached";

    /// <summary>A dependent value is itself in error.</summary>
    public const string DependencyFailed = "calculation-dependency-failed";

    /// <summary>The formula refused by name, in its author's own words.</summary>
    public const string Refused = "calculation-refused";

    /// <summary>A related record could not be read completely.</summary>
    public const string RelatedUnavailable = "calculation-related-unavailable";

    /// <summary>
    /// A stored value is not of the type its field declares, as a tool outside Nendo can
    /// leave it. The field's value fails; the record and the file stay readable.
    /// </summary>
    public const string StoredValueInvalid = "calculation-stored-value-invalid";
}

/// <summary>
/// One expected failure during evaluation.
/// <para>
/// Expected is the load-bearing word. An empty input, a zero denominator or an
/// exhausted budget are ordinary outcomes of running a formula over real data, and
/// each becomes a visible calculation error beside otherwise valid input. Anything
/// unexpected is left to propagate rather than being turned into a value, because a
/// fabricated result is worse than a failure.
/// </para>
/// </summary>
public sealed class NendoCalculationException(string code, string message) : NendoException(message)
{
    public string Code { get; } = code;

    /// <summary>
    /// True when the save's own budget ran out: its work units, function calls, generated
    /// changes or related-row allowance. Such a ceiling aborts the whole save, a trigger
    /// condition's included. A limit the data itself reaches, such as a subtree past the
    /// hierarchy's descendant bound or a record deeper than its hierarchy allows, keeps the
    /// same code but is not a budget: in a condition it blocks the action and is reported
    /// (ADR-0008 §6, EBH-02).
    /// </summary>
    internal bool ExhaustedBudget { get; init; }

    /// <summary>
    /// The formula and the declared value whose empty input stopped it, so a reader that knows
    /// which field the value comes from can name that field instead of the author's alias
    /// (EBH-20). Null for every other failure.
    /// </summary>
    internal (string FormulaId, string Parameter)? EmptyInput { get; init; }
}
