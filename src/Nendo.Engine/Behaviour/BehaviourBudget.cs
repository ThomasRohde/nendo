using System.Globalization;

namespace Nendo.Engine;

/// <summary>
/// What a budget pays for, so a ceiling it reaches says which allowance ran out: a save's,
/// one record's read, or one formula's check. Every ceiling once said "for a single save",
/// also on a list read and on an install.
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
/// <para>
/// The work units are the one allowance nothing renews (ADR-0008). A related record's calculation runs under that record's own function-call
/// and related-record allowances, as it would on its own read (<see cref="EnterMember"/>); a
/// record the evaluation is about is read for work, not as a related record (<see cref="SpendRead"/>);
/// a result is worked out once per budget (<see cref="TryRecall"/>); and a save's call,
/// related-record and change allowances are those of the records it names, one by one
/// (<see cref="Records"/>).
/// </para>
/// </summary>
internal sealed class BehaviourBudget
{
    private readonly CancellationToken _cancellationToken;
    private int _work;
    private int _calls;
    private int _scans;
    private int _changes;
    private int _memberDepth;
    private HashSet<(string EntityId, string RecordId)> _own = [];
    private readonly Dictionary<(string CalculationId, string RecordId), (BehaviourValue? Value, NendoCalculationException? Failure)> _worked = [];
    private readonly Dictionary<string, int> _stepWork = new(StringComparer.Ordinal);

    internal BehaviourBudget(
        NendoBehaviourLimits limits,
        CancellationToken cancellationToken = default,
        BehaviourBudgetUse use = BehaviourBudgetUse.Save,
        int records = 1)
    {
        Limits = (limits ?? throw new ArgumentNullException(nameof(limits))).Validate();
        _cancellationToken = cancellationToken;
        Use = use;
        if (records < 1) throw new NendoValidationException("A budget pays for at least one record.");
        Records = records;
    }

    internal BehaviourBudgetUse Use { get; }

    internal NendoBehaviourLimits Limits { get; }

    /// <summary>
    /// The records a save names. Its function-call, related-record and automatic-change allowances
    /// are this many times one record's, so a batch is allowed what its records would be allowed
    /// saved one by one; work units are not multiplied, and bound the save whatever its size.
    /// </summary>
    internal int Records { get; }

    internal int WorkSpent => _work;

    internal int CallsSpent => _calls;

    internal int ScansSpent => _scans;

    internal int ChangesSpent => _changes;

    /// <summary>Function calls this budget, or the member scope it is in, allows.</summary>
    internal int FunctionCallLimit => checked(Limits.FunctionCalls * Scale);

    /// <summary>Related records this budget, or the member scope it is in, allows.</summary>
    internal int RelatedRowLimit => checked(Limits.RelatedRows * Scale);

    /// <summary>Automatic changes one save allows.</summary>
    internal int GeneratedChangeLimit => checked(Limits.GeneratedChanges * Records);

    /// <summary>Inside a related record's calculation the allowances are that one record's.</summary>
    private int Scale => _memberDepth > 0 ? 1 : Records;

    internal CancellationToken CancellationToken => _cancellationToken;

    /// <summary>
    /// The step of an action the work now being spent belongs to, so a save that runs out can
    /// say which step spent most. Null outside a step.
    /// </summary>
    internal string? Step { get; set; }

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
        if (Step is { } step) _stepWork[step] = _stepWork.GetValueOrDefault(step) + units;
    }

    /// <summary>Charges one function call, nested or not, plus its work.</summary>
    internal void SpendCall()
    {
        SpendWork();
        if (checked(_calls + 1) > FunctionCallLimit) throw Exhausted("function call");
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
        if (total > RelatedRowLimit) throw Exhausted("related record");
        _scans = total;
    }

    /// <summary>
    /// Charges reading one record: work alone for a record this evaluation is about, the save's
    /// own records and the member whose calculation is being worked out, and a related record
    /// for any other, because re-reading the record being saved as a related record would spend
    /// most of a batch's related records.
    /// </summary>
    internal void SpendRead(string entityId, string recordId)
    {
        if (_own.Contains((entityId, recordId))) SpendWork();
        else SpendScan();
    }

    /// <summary>A record this evaluation is about: reading it is work, not a related record.</summary>
    internal void Own(string entityId, string recordId) => _own.Add((entityId, recordId));

    /// <summary>Charges one generated, non-no-op record change, and forgets results the change may have moved.</summary>
    internal void SpendChange()
    {
        SpendWork();
        if (checked(_changes + 1) > GeneratedChangeLimit) throw Exhausted("automatic change");
        _changes++;
        // A remembered result was worked out against the state this change is about to replace.
        _worked.Clear();
    }

    /// <summary>Rows a related read may still ask SQLite for, so the LIMIT is real.</summary>
    internal int RemainingScanAllowance => Math.Max(0, RelatedRowLimit - _scans);

    /// <summary>
    /// A calculation already worked out for a record under this budget, or its failure. A
    /// client's two sums over the same projects worked every project out twice. A spent
    /// allowance is never remembered: it is this budget's, not the record's.
    /// </summary>
    internal bool TryRecall(string calculationId, string recordId, out (BehaviourValue? Value, NendoCalculationException? Failure) known) =>
        _worked.TryGetValue((calculationId, recordId), out known);

    internal void Remember(string calculationId, string recordId, BehaviourValue? value, NendoCalculationException? failure)
    {
        if (failure is { ExhaustedBudget: true }) return;
        _worked[(calculationId, recordId)] = (value, failure);
    }

    /// <summary>
    /// Works out a related record's calculation under that record's own function-call and
    /// related-record allowances, as its own read would, while every unit of work is still
    /// charged here. A client's total of 33 entries ran out of the client's 64 calls.
    /// The owner still pays one related record for each member it reads.
    /// </summary>
    internal MemberScope EnterMember(string entityId, string recordId)
    {
        var scope = new MemberScope(this, _calls, _scans, _own);
        _memberDepth++;
        _calls = 0;
        _scans = 0;
        _own = [(entityId, recordId)];
        return scope;
    }

    internal readonly struct MemberScope(BehaviourBudget budget, int calls, int scans, HashSet<(string, string)> own) : IDisposable
    {
        public void Dispose()
        {
            budget._memberDepth--;
            budget._calls = calls;
            budget._scans = scans;
            budget._own = own;
        }
    }

    /// <summary>
    /// The refusal for an allowance of this budget that ran out, worded for what the budget pays
    /// for, with what it had spent of every allowance and, on a save, the step that spent
    /// most.
    /// </summary>
    internal NendoCalculationException Exhausted(string what)
    {
        var heaviest = _stepWork.Count == 0 ? (KeyValuePair<string, int>?)null
            : _stepWork.OrderByDescending(entry => entry.Value).ThenBy(entry => entry.Key, StringComparer.Ordinal).First();
        var spend = new NendoBudgetSpend(what, _calls, FunctionCallLimit, _scans, RelatedRowLimit,
            _changes, GeneratedChangeLimit, _work, Limits.WorkUnits, heaviest?.Key, heaviest?.Value);
        var reason = (_memberDepth > 0 && what is "function call" or "related record" ? BehaviourBudgetUse.Read : Use) switch
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
        $"and {spend.WorkUnits:N0} of {spend.WorkUnitLimit:N0} work units.") +
        (spend.HeaviestStep is { } step
            ? string.Create(CultureInfo.InvariantCulture, $" The step that spent most was {step}, with {spend.HeaviestStepWorkUnits:N0} work units.")
            : string.Empty);

    /// <summary>
    /// A ceiling met inside a related record's calculation, with that step named. The
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
