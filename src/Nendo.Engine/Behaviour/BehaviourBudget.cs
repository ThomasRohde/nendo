using System.Globalization;

namespace Nendo.Engine;

/// <summary>
/// What a budget pays for, so a ceiling it reaches says which allowance ran out: a save's,
/// one record's read, or one formula's check. Every ceiling once said "for a single save",
/// also on a list read and on an install (EBH-20).
/// </summary>
internal enum BehaviourBudgetUse
{
    /// <summary>One save and every action it runs.</summary>
    Save,

    /// <summary>The calculated fields of one record, on a read.</summary>
    Read,

    /// <summary>Checking one formula when a definition is installed or compiled.</summary>
    Check,
}

/// <summary>
/// The single spend counter for one evaluation or one causal transaction.
/// <para>
/// One instance spans nested function calls, every related-record scan and every
/// generated write in a trigger chain. That is the point: a formula that calls a
/// function that aggregates a collection cannot buy itself a fresh allowance by
/// going one level deeper, and a chain of triggers cannot outrun the ceiling by
/// splitting work across steps. A fresh budget belongs only to an independent
/// evaluation or an independent transaction.
/// </para>
/// <para>
/// Every charge happens <em>before</em> the work it pays for — before a visit, an
/// allocation, a row read or a write — so the ceiling bounds what is attempted, not
/// what already happened.
/// </para>
/// </summary>
internal sealed class BehaviourBudget
{
    private readonly CancellationToken _cancellationToken;
    private int _work;
    private int _calls;
    private int _scans;
    private int _changes;

    internal BehaviourBudget(
        NendoBehaviourLimits limits,
        CancellationToken cancellationToken = default,
        BehaviourBudgetUse use = BehaviourBudgetUse.Save)
    {
        Limits = (limits ?? throw new ArgumentNullException(nameof(limits))).Validate();
        _cancellationToken = cancellationToken;
        Use = use;
    }

    internal BehaviourBudgetUse Use { get; }

    internal NendoBehaviourLimits Limits { get; }

    internal int WorkSpent => _work;

    internal int CallsSpent => _calls;

    internal int ScansSpent => _scans;

    internal int ChangesSpent => _changes;

    internal CancellationToken CancellationToken => _cancellationToken;

    /// <summary>
    /// Charges primitive work. Counters are checked, so an absurd request overflows
    /// into a refusal rather than wrapping around into a fresh allowance.
    /// </summary>
    internal void SpendWork(int units = 1)
    {
        if (units < 0) throw new NendoValidationException("Work units cannot be negative.");
        _cancellationToken.ThrowIfCancellationRequested();
        int total;
        try { total = checked(_work + units); }
        catch (OverflowException) { throw Exhausted("work"); }
        if (total > Limits.WorkUnits) throw Exhausted("work");
        _work = total;
    }

    /// <summary>Charges one function call, nested or not, plus its work.</summary>
    internal void SpendCall()
    {
        SpendWork();
        if (checked(_calls + 1) > Limits.FunctionCalls) throw Exhausted("function call");
        _calls++;
    }

    /// <summary>
    /// Charges related rows about to be read. Rows that turn out not to contribute
    /// to the aggregate are charged too: the cost is the reading, not the answer.
    /// </summary>
    internal void SpendScan(int rows = 1)
    {
        if (rows < 0) throw new NendoValidationException("Scanned rows cannot be negative.");
        SpendWork(rows);
        int total;
        try { total = checked(_scans + rows); }
        catch (OverflowException) { throw Exhausted("related record"); }
        if (total > Limits.RelatedRows) throw Exhausted("related record");
        _scans = total;
    }

    /// <summary>Charges one generated, non-no-op record change.</summary>
    internal void SpendChange()
    {
        SpendWork();
        if (checked(_changes + 1) > Limits.GeneratedChanges) throw Exhausted("automatic change");
        _changes++;
    }

    /// <summary>Rows a related read may still ask SQLite for, so the LIMIT is real.</summary>
    internal int RemainingScanAllowance => Math.Max(0, Limits.RelatedRows - _scans);

    /// <summary>
    /// The refusal for an allowance of this budget that ran out, worded for what the budget pays
    /// for, with what it had spent of every allowance (W-246).
    /// </summary>
    internal NendoCalculationException Exhausted(string what)
    {
        var spend = new NendoBudgetSpend(what, _calls, Limits.FunctionCalls, _scans, Limits.RelatedRows,
            _changes, Limits.GeneratedChanges, _work, Limits.WorkUnits);
        var reason = Use switch
        {
            BehaviourBudgetUse.Read =>
                $"This calculation reached the {what} limit for one record. Simplify the formula or narrow what it reads.",
            BehaviourBudgetUse.Check =>
                $"This formula reached the {what} limit for checking one formula. Shorten or simplify it.",
            _ => what == "automatic change"
                ? "This save reached the automatic change limit: its actions changed more records than one save may. " +
                  "An action that starts itself again, directly or through another trigger, runs until this limit; narrow its trigger or condition."
                : $"This calculation reached the {what} limit for a single save. Simplify the formula or narrow what it reads.",
        } + " " + Spent(spend);
        return new(NendoCalculationCodes.LimitReached, reason) { ExhaustedBudget = true, Spend = spend, Reason = reason };
    }

    private static string Spent(NendoBudgetSpend spend) => string.Create(CultureInfo.InvariantCulture,
        $"It had spent {spend.FunctionCalls:N0} of {spend.FunctionCallLimit:N0} function calls, " +
        $"{spend.RelatedRecords:N0} of {spend.RelatedRecordLimit:N0} related records, " +
        $"{spend.AutomaticChanges:N0} of {spend.AutomaticChangeLimit:N0} automatic changes " +
        $"and {spend.WorkUnits:N0} of {spend.WorkUnitLimit:N0} work units.");

    /// <summary>
    /// A ceiling met inside a related record's calculation, with that step named (W-246). The
    /// calculation the person sees is the outermost one; without the path they could not tell
    /// which member's formula spent the allowance.
    /// </summary>
    internal static NendoCalculationException Inside(NendoCalculationException exception, string calculationId, string recordId)
    {
        var reason = exception.Reason ?? exception.Message;
        IReadOnlyList<string> path = [$"{calculationId} of record {recordId}", .. exception.Path];
        return new(exception.Code, $"{reason} It ran out inside {string.Join(", inside ", path)}.")
        {
            ExhaustedBudget = exception.ExhaustedBudget,
            Spend = exception.Spend,
            Path = path,
            Reason = reason,
        };
    }
}
