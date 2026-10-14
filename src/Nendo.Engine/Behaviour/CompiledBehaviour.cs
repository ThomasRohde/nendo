namespace Nendo.Engine;

/// <summary>One calculation, with its definition and its validated expression.</summary>
internal sealed record CompiledCalculation(
    NendoCalculationDefinition Definition,
    ValidatedExpression Expression);

/// <summary>
/// An action assignment's validated formula, kept so the install check can compare what it
/// produces with the field it writes (EBH-04) and so a save evaluates it without validating it
/// again (EBH-22). <paramref name="Whole"/> is true when the formula is a rounding to 0 digits,
/// the one decimal result that always fits a whole-number field.
/// </summary>
internal sealed record CompiledAssignment(NendoBehaviourScalar ResultType, bool Whole)
{
    internal ValidatedExpression? Expression { get; init; }
}

/// <summary>
/// Every definition in a file, validated once and held immutably.
/// <para>
/// Compiled as a set rather than one formula at a time, and in dependency order, so
/// a calculation that reads another is validated against what that other one
/// actually produces. The order the calculations must run in is settled here too:
/// discovering it during evaluation would mean discovering a cycle halfway through
/// computing a value.
/// </para>
/// </summary>
internal sealed class CompiledBehaviour
{
    private CompiledBehaviour(
        IReadOnlyDictionary<string, NendoBehaviourDefinition> definitions,
        IReadOnlyDictionary<string, ValidatedExpression> functions,
        IReadOnlyDictionary<string, CompiledCalculation> calculations,
        IReadOnlyDictionary<string, IReadOnlyList<CompiledCalculation>> byEntity,
        IReadOnlyDictionary<string, CompiledAssignment>? assignments = null,
        IReadOnlyDictionary<string, ValidatedExpression>? conditions = null)
    {
        Definitions = definitions;
        Functions = functions;
        Calculations = calculations;
        CalculationsByEntity = byEntity;
        Assignments = assignments ?? new Dictionary<string, CompiledAssignment>(StringComparer.Ordinal);
        Conditions = conditions ?? new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal);
    }

    internal static CompiledBehaviour Empty { get; } = new(
        new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal),
        new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal),
        new Dictionary<string, CompiledCalculation>(StringComparer.Ordinal),
        new Dictionary<string, IReadOnlyList<CompiledCalculation>>(StringComparer.Ordinal));

    internal IReadOnlyDictionary<string, NendoBehaviourDefinition> Definitions { get; }

    internal IReadOnlyDictionary<string, ValidatedExpression> Functions { get; }

    /// <summary>
    /// Each function whose formula produces another kind than it declares, with the kind it
    /// produces: a file a host wrote before installation checked it (R2AAV-01). It compiles, typed
    /// by its formula as before; installation refuses it, and any definition that calls it.
    /// </summary>
    internal IReadOnlyDictionary<string, NendoBehaviourScalar> MismatchedFunctions { get; private init; } =
        new Dictionary<string, NendoBehaviourScalar>(StringComparer.Ordinal);

    internal IReadOnlyDictionary<string, CompiledCalculation> Calculations { get; }

    /// <summary>
    /// The calculations of each record type, already in the order they must be
    /// evaluated: a calculation always appears after everything it reads.
    /// </summary>
    internal IReadOnlyDictionary<string, IReadOnlyList<CompiledCalculation>> CalculationsByEntity { get; }

    /// <summary>
    /// Each action assignment's result, keyed <c>action:step:field</c> as its formula ID is.
    /// </summary>
    internal IReadOnlyDictionary<string, CompiledAssignment> Assignments { get; }

    /// <summary>
    /// Each trigger condition, validated, keyed by the trigger's ID. A save evaluates these and
    /// assignments as compiled rather than validating them again on its own budget: a revalidation
    /// was charged only when the expression cache had lost the formula, so whether a save near
    /// the work ceiling was refused depended on how warm the cache happened to be (EBH-22).
    /// </summary>
    internal IReadOnlyDictionary<string, ValidatedExpression> Conditions { get; }

    internal bool IsEmpty => Definitions.Count == 0;

    /// <summary>
    /// Validates and compiles a complete set. Refuses the whole set if any part of it
    /// is wrong, because a file is never left holding half a behaviour.
    /// </summary>
    internal static CompiledBehaviour Compile(
        IReadOnlyDictionary<string, NendoBehaviourDefinition> definitions,
        NendoExpressionAdapter adapter,
        BehaviourBudget budget)
    {
        ArgumentNullException.ThrowIfNull(definitions);
        ArgumentNullException.ThrowIfNull(adapter);
        if (definitions.Count == 0) return Empty;
        NendoBehaviourGraph.ValidateCandidate(definitions, budget.Limits);

        // Each formula validates against its own allowance, not one budget shared across
        // the whole file. Sharing it silently capped the total formula source a file may
        // hold at roughly the work ceiling, so a file within every published per-formula
        // and per-count limit still failed to compile from a cold adapter — and whether
        // it failed depended on how warm the expression cache happened to be, because a
        // cache hit skips the charge. A single formula stays bounded by its own limits;
        // the set is bounded by the Definitions ceiling the graph check above enforces —
        // CatalogueSize counts functions only, so it never bounded the whole compile.
        BehaviourBudget FormulaBudget() => new(budget.Limits, budget.CancellationToken, BehaviourBudgetUse.Check);

        // Each reusable function in two typings (R2AAV-01). As its formula produces it, with its
        // own calls read the same way, is how every caller read a function before declarations
        // were checked, and how a caller that is not itself declared decimal still reads one: an
        // integer calculation, an action's assignment, a trigger's condition. As declared is a
        // function declared decimal read as a decimal, with its own calls read the same way, for
        // a calculation declared decimal, which computes in decimal from then on rather than in
        // Int64. A caller reads the declared typing only where its formula still validates that
        // way, so a file a host wrote before keeps compiling to the same answers, an Int64
        // overflow apart. Nothing is refused here, on every open and save: installation refuses
        // a function whose formula is not of its declared kind, and a definition that calls one.
        var functions = new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal);
        var declaredFunctions = new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal);
        var mismatched = new Dictionary<string, NendoBehaviourScalar>(StringComparer.Ordinal);
        foreach (var definitionId in TopologicalOrder(definitions))
        {
            if (definitions[definitionId] is not NendoFunctionDefinition function) continue;
            ValidatedExpression Body(IReadOnlyDictionary<string, ValidatedExpression> callees) => adapter.Validate(
                new BehaviourFormula(
                    function.DefinitionId,
                    function.Expression,
                    function.Parameters
                        .Select(parameter => new BehaviourParameter(parameter.ParameterId, parameter.ParameterType, parameter.Nullable))
                        .ToArray(),
                    Resolve(function.CallAliases, callees, function.DefinitionId),
                    function.ResultNullable),
                FormulaBudget());
            var body = Body(functions);
            functions[definitionId] = body;
            if (body.ResultType != function.ResultType && !Widens(function.ResultType, body.ResultType))
                mismatched[definitionId] = body.ResultType;
            declaredFunctions[definitionId] = function.ResultType == NendoBehaviourScalar.Decimal
                ? AsDeclaredDecimal(ReadAsDecimal(() => Body(declaredFunctions)) ?? body)
                : body;
        }

        var calculations = new Dictionary<string, CompiledCalculation>(StringComparer.Ordinal);
        foreach (var definitionId in TopologicalOrder(definitions))
        {
            if (definitions[definitionId] is not NendoCalculationDefinition calculation) continue;
            ValidatedExpression Formula(IReadOnlyDictionary<string, ValidatedExpression> callees) => adapter.Validate(
                new BehaviourFormula(
                    calculation.DefinitionId,
                    calculation.Expression,
                    calculation.Bindings
                        .Select(binding => new BehaviourParameter(binding.BindingId, binding.ResultType, binding.Nullable))
                        .ToArray(),
                    Resolve(calculation.CallAliases, callees, calculation.DefinitionId),
                    calculation.ResultNullable),
                FormulaBudget());
            var expression = calculation.ResultType == NendoBehaviourScalar.Decimal
                ? ReadAsDecimal(() => Formula(declaredFunctions)) ?? Formula(functions)
                : Formula(functions);
            if (expression.ResultType != calculation.ResultType &&
                !(calculation.ResultType == NendoBehaviourScalar.Decimal && expression.ResultType == NendoBehaviourScalar.Integer))
            {
                throw new NendoValidationException(
                    $"'{calculation.DefinitionId}' declares {calculation.ResultType.ToString().ToLowerInvariant()} but its formula produces {expression.ResultType.ToString().ToLowerInvariant()}.");
            }
            calculations[definitionId] = new CompiledCalculation(calculation, expression);
        }

        // Also compile the formulas that are not calculations, so an action input or a
        // trigger condition that cannot be validated refuses at installation rather
        // than in the middle of somebody's save.
        var assignments = new Dictionary<string, CompiledAssignment>(StringComparer.Ordinal);
        var conditions = new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal);
        foreach (var definition in definitions.Values)
        {
            switch (definition)
            {
                case NendoTriggerDefinition { ConditionExpression: { } condition } trigger:
                {
                    var validated = adapter.Validate(new BehaviourFormula(
                        $"{trigger.DefinitionId}:condition", condition,
                        trigger.ConditionBindings
                            .Select(binding => new BehaviourParameter(binding.BindingId, binding.ResultType, binding.Nullable))
                            .ToArray(),
                        Resolve(trigger.CallAliases, functions, trigger.DefinitionId)), FormulaBudget());
                    if (validated.ResultType != NendoBehaviourScalar.Boolean)
                        throw new NendoValidationException(
                            $"The condition of '{trigger.DefinitionId}' must produce a true/false value.");
                    conditions[trigger.DefinitionId] = validated;
                    break;
                }
                case NendoActionDefinition action:
                {
                    foreach (var step in action.Steps)
                    {
                        foreach (var assignment in step.Assignments)
                        {
                            var formulaId = $"{action.DefinitionId}:{step.StepId}:{assignment.FieldId}";
                            var validated = adapter.Validate(new BehaviourFormula(
                                formulaId, assignment.Expression,
                                assignment.Bindings
                                    .Select(binding => new BehaviourParameter(binding.BindingId, binding.ResultType, binding.Nullable))
                                    .ToArray(),
                                Resolve(assignment.CallAliases, functions, action.DefinitionId)), FormulaBudget());
                            assignments[formulaId] = new CompiledAssignment(
                                validated.ResultType, NendoBehaviourAnalyzer.IsWholeRounding(validated.Ast, assignment.CallAliases))
                            { Expression = validated };
                        }
                    }
                    break;
                }
            }
        }

        var byEntity = calculations.Values
            .GroupBy(calculation => calculation.Definition.EntityId, StringComparer.Ordinal)
            .ToDictionary(
                group => group.Key,
                group => (IReadOnlyList<CompiledCalculation>)Ordered(group).ToArray(),
                StringComparer.Ordinal);

        return new CompiledBehaviour(definitions, functions, calculations, byEntity, assignments, conditions)
        {
            MismatchedFunctions = mismatched,
        };
    }

    /// <summary>A whole number where a decimal is declared: the one widening a declaration allows.</summary>
    private static bool Widens(NendoBehaviourScalar declared, NendoBehaviourScalar produced) =>
        declared == NendoBehaviourScalar.Decimal && produced == NendoBehaviourScalar.Integer;

    /// <summary>
    /// A formula read with the decimal typing of the functions it calls, or null when it does not
    /// validate that way or produces something other than a number, so the caller falls back to
    /// the typing every file was compiled with before (R2AAV-01).
    /// </summary>
    private static ValidatedExpression? ReadAsDecimal(Func<ValidatedExpression> validate)
    {
        try
        {
            var validated = validate();
            return validated.ResultType is NendoBehaviourScalar.Integer or NendoBehaviourScalar.Decimal ? validated : null;
        }
        catch (NendoValidationException)
        {
            return null;
        }
    }

    private static ValidatedExpression AsDeclaredDecimal(ValidatedExpression expression) =>
        expression.ResultType == NendoBehaviourScalar.Integer ? expression.Declared(NendoBehaviourScalar.Decimal) : expression;

    private static IReadOnlyDictionary<string, ValidatedExpression> Resolve(
        IReadOnlyList<NendoFunctionCallAlias> aliases,
        IReadOnlyDictionary<string, ValidatedExpression> functions,
        string owner)
    {
        var resolved = new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal);
        foreach (var alias in aliases)
        {
            resolved[alias.Alias] = functions.TryGetValue(alias.FunctionId, out var function)
                ? function
                : throw new NendoValidationException(
                    $"'{owner}' calls '{alias.FunctionId}', which this file does not define.");
        }
        return resolved;
    }

    /// <summary>
    /// The calculations of one record type, each after everything it reads. The graph
    /// check has already refused cycles, so this walk always terminates.
    /// </summary>
    private static IEnumerable<CompiledCalculation> Ordered(IEnumerable<CompiledCalculation> group)
    {
        var members = group.ToDictionary(calculation => calculation.Definition.DefinitionId, StringComparer.Ordinal);
        var emitted = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<CompiledCalculation>();
        foreach (var id in members.Keys.OrderBy(id => id, StringComparer.Ordinal)) Emit(id);
        return ordered;

        void Emit(string id)
        {
            if (!members.TryGetValue(id, out var calculation) || !emitted.Add(id)) return;
            foreach (var dependency in calculation.Definition.Bindings
                         .Where(binding => binding.CalculationId is not null)
                         .Select(binding => binding.CalculationId!)
                         .OrderBy(dependency => dependency, StringComparer.Ordinal))
            {
                Emit(dependency);
            }
            ordered.Add(calculation);
        }
    }

    private static IEnumerable<string> TopologicalOrder(
        IReadOnlyDictionary<string, NendoBehaviourDefinition> definitions)
    {
        var emitted = new HashSet<string>(StringComparer.Ordinal);
        var ordered = new List<string>();
        foreach (var id in definitions.Keys.OrderBy(id => id, StringComparer.Ordinal)) Emit(id);
        return ordered;

        void Emit(string id)
        {
            if (!definitions.TryGetValue(id, out var definition) || !emitted.Add(id)) return;
            foreach (var dependency in definition.ReferencedDefinitionIds
                         .Distinct(StringComparer.Ordinal)
                         .OrderBy(dependency => dependency, StringComparer.Ordinal))
            {
                Emit(dependency);
            }
            ordered.Add(id);
        }
    }
}
