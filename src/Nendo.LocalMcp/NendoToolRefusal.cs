using System.ComponentModel;

namespace Nendo.LocalMcp;

/// <summary>
/// A tool refusal as a client reads it, beside the text the model reads (W-149). Every
/// in-house client used to scrape the <c>NENDO_</c> code out of the text with a regular
/// expression; the object travels in the result's <c>_meta</c> under
/// <see cref="MetaKey"/>, a reverse-DNS key from the project's own domain, as the
/// <c>_meta</c> rules require. Protocol errors keep their <c>-32602</c> and their text.
/// </summary>
public sealed record NendoToolRefusal(
    [property: Description("The refusal's code, NENDO_ and a stable name.")]
    string Code,
    [property: Description("The sentence the text carries after the code: what was refused and what to do.")]
    string Message)
{
    /// <summary>The validated proposal a pending-cause advisory named, when the refusal is explained by one.</summary>
    [Description("The validated proposal whose acceptance the refused write depends on, when the refusal is explained by one.")]
    public string? PendingProposalId { get; init; }

    /// <summary>What a calculation's budget had spent when an allowance ran out (W-246).</summary>
    [Description("When a calculation limit was reached: the allowance that ran out, what was spent of each allowance, and the related records' calculations it ran out inside.")]
    public NendoToolLimit? Limit { get; init; }

    /// <summary>The <c>_meta</c> key the object travels under: the project's website domain, reversed, and the field.</summary>
    public const string MetaKey = "io.github.thomasrohde.nendo/refusal";

    private static readonly AsyncLocal<Holder?> Current = new();

    /// <summary>
    /// Opens the scope one tool call runs in. The translation that turns an exception into
    /// the refusal text records the structured form into the same holder, which the host's
    /// filter reads after the call: a value set inside the awaited call does not flow back
    /// to the filter, but a reference it shares does.
    /// </summary>
    internal static Scope Begin() => new();

    internal static void Record(string code, string message, string? pendingProposalId = null, NendoToolLimit? limit = null)
    {
        if (Current.Value is { } holder)
        {
            holder.Refusal = new NendoToolRefusal(code, message) { PendingProposalId = pendingProposalId, Limit = limit };
        }
    }

    private sealed class Holder
    {
        internal NendoToolRefusal? Refusal { get; set; }
    }

    internal sealed class Scope : IDisposable
    {
        private readonly Holder _holder = new();
        private readonly Holder? _previous;

        internal Scope()
        {
            _previous = Current.Value;
            Current.Value = _holder;
        }

        /// <summary>The refusal the call recorded, or null when it completed or refused outside the translation.</summary>
        internal NendoToolRefusal? Refusal => _holder.Refusal;

        public void Dispose() => Current.Value = _previous;
    }
}

/// <summary>A calculation limit as a client reads it: the allowance, each counter against its limit, and where (W-246).</summary>
public sealed record NendoToolLimit(
    [property: Description("The allowance that ran out: function call, related record, automatic change or work.")]
    string Allowance,
    [property: Description("Function calls spent.")] int FunctionCalls,
    [property: Description("Function calls one budget allows.")] int FunctionCallLimit,
    [property: Description("Related records read.")] int RelatedRecords,
    [property: Description("Related records one budget allows.")] int RelatedRecordLimit,
    [property: Description("Automatic changes made.")] int AutomaticChanges,
    [property: Description("Automatic changes one save allows.")] int AutomaticChangeLimit,
    [property: Description("Work units spent.")] int WorkUnits,
    [property: Description("Work units one budget allows.")] int WorkUnitLimit,
    [property: Description("The related records' calculations it ran out inside, outermost first, each 'calculationId of record recordId'.")]
    IReadOnlyList<string> Path,
    [property: Description("On a save that ran actions, the step that spent most, as \"step S of action 'A'\"; null otherwise.")]
    string? HeaviestStep = null,
    [property: Description("Work units that step spent; null with no step.")]
    int? HeaviestStepWorkUnits = null)
{
    internal static NendoToolLimit? From(Nendo.Engine.NendoCalculationException exception) =>
        exception.Spend is not { } spend ? null : new(spend.Allowance, spend.FunctionCalls, spend.FunctionCallLimit,
            spend.RelatedRecords, spend.RelatedRecordLimit, spend.AutomaticChanges, spend.AutomaticChangeLimit,
            spend.WorkUnits, spend.WorkUnitLimit, exception.Path, spend.HeaviestStep, spend.HeaviestStepWorkUnits);
}

/// <summary>What an outstanding proposal has to do with a refused write: the sentence, and the proposal it names.</summary>
internal sealed record NendoPendingCause(string Text, string? ProposalId);
