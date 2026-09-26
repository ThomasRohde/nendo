using System.Globalization;

namespace Nendo.Engine;

/// <summary>
/// One function a formula may call, with the types it accepts and the type it
/// returns. The signature is checked while the expression is validated, so a call
/// with the wrong shape refuses installation instead of failing on some records
/// and not others.
/// </summary>
internal sealed record CatalogueFunction(
    string Name,
    int MinimumArguments,
    int MaximumArguments,
    Func<IReadOnlyList<NendoBehaviourScalar>, NendoBehaviourScalar> ResultFor,
    Func<IReadOnlyList<BehaviourValue>, BehaviourBudget, BehaviourValue> Invoke)
{
    /// <summary>
    /// What each argument accepts, written the way the refusal names it. Published
    /// beside the enforced arity so discovery and validation cannot drift: an agent
    /// reading this is reading the same table the analyzer checks against.
    /// </summary>
    internal required IReadOnlyList<string> ParameterTypes { get; init; }

    internal required string ResultType { get; init; }

    /// <summary>One sentence an editor or an agent can show without reading the code.</summary>
    internal required string Summary { get; init; }

    /// <summary>Whether the last declared argument repeats up to <see cref="MaximumArguments"/>.</summary>
    internal bool Repeating { get; init; }
}

/// <summary>
/// The closed set of pure functions an expression may call.
/// <para>
/// Closed is the security property, not a simplification. Everything reachable from
/// an expression is listed here by name, so nothing arrives by being a method on a
/// value, a built-in of the evaluator or a member of a transitively referenced
/// library. A function that is merely harmless-looking is still absent.
/// </para>
/// <para>
/// Every entry is a total function of its arguments: no clock, no file, no network,
/// no host service, and no state that differs between two evaluations of the same
/// inputs. That is what makes a cached result and a replayed result the same thing.
/// </para>
/// </summary>
internal static class NendoBehaviourCatalogue
{
    private static readonly IReadOnlyDictionary<string, CatalogueFunction> Functions =
        new Dictionary<string, CatalogueFunction>(StringComparer.Ordinal)
        {
            ["RoundEven"] = Rounding("RoundEven", MidpointRounding.ToEven),
            ["RoundAway"] = Rounding("RoundAway", MidpointRounding.AwayFromZero),
            ["Date"] = new("Date", 1, 1,
                types =>
                {
                    Expect(types, "Date", NendoBehaviourScalar.Text);
                    return NendoBehaviourScalar.Date;
                },
                (args, budget) =>
                {
                    budget.SpendWork();
                    var text = args[0].AsText();
                    return DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                        DateTimeStyles.None, out var date)
                        ? BehaviourValue.Date(date)
                        : throw new NendoCalculationException(NendoCalculationCodes.InvalidDate,
                            "A date must be written as yyyy-MM-dd and be a real calendar date.");
                })
            {
                ParameterTypes = ["text"],
                ResultType = "date",
                Summary = "Reads a calendar date written as yyyy-MM-dd. Anything else is refused rather than guessed at.",
            },
            ["DaysBetween"] = new("DaysBetween", 2, 2,
                types =>
                {
                    Expect(types, "DaysBetween", NendoBehaviourScalar.Date, NendoBehaviourScalar.Date);
                    return NendoBehaviourScalar.Integer;
                },
                (args, budget) =>
                {
                    budget.SpendWork();
                    return BehaviourValue.Integer(args[1].AsDate().DayNumber - args[0].AsDate().DayNumber);
                })
            {
                ParameterTypes = ["date", "date"],
                ResultType = "integer",
                Summary = "Whole days from the first date to the second. Negative when the second is earlier.",
            },
            // ADR-0008 P8: a function added after the fact, through the ordinary
            // catalogue, with nothing else to change. It is total, bounded by the
            // same text ceiling every other text value is, and has no clock, file or
            // network behind it — which is what makes it cacheable and replayable.
            ["TextLength"] = new("TextLength", 1, 1,
                types =>
                {
                    Expect(types, "TextLength", NendoBehaviourScalar.Text);
                    return NendoBehaviourScalar.Integer;
                },
                (args, budget) =>
                {
                    budget.SpendWork();
                    return BehaviourValue.Integer(args[0].AsText().Length);
                })
            {
                ParameterTypes = ["text"],
                ResultType = "integer",
                Summary = "How many characters a text value holds. Empty text is zero, which is an answer rather than a missing one.",
            },
            // ADR-0008, 2026-09-20 amendment: a formula can refuse by name. The entry
            // produces no value. The analyzer types it from the other outcome of the
            // choice it sits in, which is why its own typing refuses: a refusal reached
            // any other way is a formula that can never answer.
            ["Refuse"] = new("Refuse", 1, 1,
                types => throw new NendoValidationException(
                    "Refuse stands in for a value: put it in one outcome of a choice, and let the other outcome say what kind of value it stands for."),
                (args, budget) =>
                {
                    budget.SpendWork();
                    var reason = args[0].AsText();
                    throw new NendoCalculationException(NendoCalculationCodes.Refused,
                        string.IsNullOrWhiteSpace(reason) ? "This calculation refused, and its formula gave no reason." : reason);
                })
            {
                ParameterTypes = ["text"],
                ResultType = "the kind of the other outcome of the choice it sits in",
                Summary = "Produces no value and reports the sentence given as the calculation's own refusal. It sits in one outcome of a choice; the other outcome says what kind of value it stands for.",
            },
            ["Concat"] = new("Concat", 2, 8,
                types =>
                {
                    for (var index = 0; index < types.Count; index++)
                    {
                        if (types[index] != NendoBehaviourScalar.Text)
                            throw new NendoValidationException("Concat joins text values; convert other values first.");
                    }
                    return NendoBehaviourScalar.Text;
                },
                (args, budget) =>
                {
                    // Size is checked against the ceiling before a single character is
                    // allocated, so a formula cannot build a large string and be refused
                    // only once the memory is already committed.
                    budget.SpendWork(args.Count);
                    long length = 0;
                    foreach (var argument in args) length += argument.AsText().Length;
                    if (length > budget.Limits.TextLength)
                        throw new NendoCalculationException(NendoCalculationCodes.TextTooLong,
                            $"Joining these values would exceed the {budget.Limits.TextLength} characters a formula may handle.");
                    budget.SpendWork((int)Math.Min(length, int.MaxValue));
                    return BehaviourValue.Text(string.Concat(args.Select(argument => argument.AsText())), budget.Limits);
                })
            {
                ParameterTypes = ["text"],
                Repeating = true,
                ResultType = "text",
                Summary = "Joins two to eight text values. It does not convert numbers or dates; convert those first.",
            },
        };

    internal static bool TryGet(string name, out CatalogueFunction function) =>
        Functions.TryGetValue(name, out function!);

    /// <summary>The published names, for discovery, editor help and contract tests.</summary>
    internal static IReadOnlyList<string> Names { get; } =
        Functions.Keys.OrderBy(name => name, StringComparer.Ordinal).ToArray();

    /// <summary>
    /// The same table, as description. Generated rather than written out again: a
    /// second hand-maintained catalogue is a catalogue that will disagree with the
    /// one that decides.
    /// </summary>
    internal static IReadOnlyList<NendoBehaviourFunctionDescription> Describe() =>
        Functions.Values
            .OrderBy(function => function.Name, StringComparer.Ordinal)
            .Select(function => new NendoBehaviourFunctionDescription(
                function.Name,
                function.MinimumArguments,
                function.MaximumArguments,
                function.ParameterTypes,
                function.Repeating,
                function.ResultType,
                function.Summary))
            .ToArray();

    private static CatalogueFunction Rounding(string name, MidpointRounding midpoint) => new(
        name, 2, 2,
        types =>
        {
            if (types[0] is not (NendoBehaviourScalar.Decimal or NendoBehaviourScalar.Integer))
                throw new NendoValidationException($"{name} rounds a number.");
            if (types[1] != NendoBehaviourScalar.Integer)
                throw new NendoValidationException($"{name} takes a whole number of digits.");
            return NendoBehaviourScalar.Decimal;
        },
        (args, budget) =>
        {
            budget.SpendWork();
            var digits = args[1].AsInteger();
            // The digits are data here -- a stored field, another calculation -- so a
            // count outside what a decimal holds is this record's calculation error,
            // shown on the one field, not a definition error that fails the whole read.
            // The definition's shape was checked when it was validated.
            if (digits is < 0 or > 28)
                throw new NendoCalculationException(NendoCalculationCodes.Overflow,
                    $"Rounding takes between 0 and 28 digits, and this value asks for {digits.ToString(CultureInfo.InvariantCulture)}.");
            try
            {
                return BehaviourValue.Decimal(Math.Round(args[0].AsDecimal(), (int)digits, midpoint));
            }
            catch (OverflowException)
            {
                throw new NendoCalculationException(NendoCalculationCodes.Overflow,
                    "The rounded value is outside the range this calculation can hold.");
            }
        })
    {
        ParameterTypes = ["decimal|integer", "integer"],
        ResultType = "decimal",
        Summary = midpoint == MidpointRounding.ToEven
            ? "Rounds to a number of digits, sending an exact half to the nearer even digit."
            : "Rounds to a number of digits, sending an exact half away from zero.",
    };

    private static void Expect(IReadOnlyList<NendoBehaviourScalar> actual, string name, params NendoBehaviourScalar[] expected)
    {
        for (var index = 0; index < expected.Length; index++)
        {
            if (actual[index] != expected[index])
                throw new NendoValidationException(
                    $"{name} expects {expected[index].ToString().ToLowerInvariant()} for argument {index + 1}.");
        }
    }
}
