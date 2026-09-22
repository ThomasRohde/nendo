namespace Nendo.Engine;

/// <summary>One calculation, with its definition and its validated expression.</summary>
internal sealed record CompiledCalculation(
    NendoCalculationDefinition Definition,
    ValidatedExpression Expression);

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
        IReadOnlyDictionary<string, IReadOnlyList<CompiledCalculation>> byEntity)
    {
        Definitions = definitions;
        Functions = functions;
        Calculations = calculations;
        CalculationsByEntity = byEntity;
    }

    internal static CompiledBehaviour Empty { get; } = new(
        new Dictionary<string, NendoBehaviourDefinition>(StringComparer.Ordinal),
        new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal),
        new Dictionary<string, CompiledCalculation>(StringComparer.Ordinal),
        new Dictionary<string, IReadOnlyList<CompiledCalculation>>(StringComparer.Ordinal));

    internal IReadOnlyDictionary<string, NendoBehaviourDefinition> Definitions { get; }

    internal IReadOnlyDictionary<string, ValidatedExpression> Functions { get; }

    internal IReadOnlyDictionary<string, CompiledCalculation> Calculations { get; }

    /// <summary>
    /// The calculations of each record type, already in the order they must be
    /// evaluated: a calculation always appears after everything it reads.
    /// </summary>
    internal IReadOnlyDictionary<string, IReadOnlyList<CompiledCalculation>> CalculationsByEntity { get; }

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
        BehaviourBudget FormulaBudget() => new(budget.Limits, budget.CancellationToken);

        var functions = new Dictionary<string, ValidatedExpression>(StringComparer.Ordinal);
        foreach (var definitionId in TopologicalOrder(definitions))
        {
            if (definitions[definitionId] is not NendoFunctionDefinition function) continue;
            functions[definitionId] = adapter.Validate(
                new BehaviourFormula(
                    function.DefinitionId,
                    function.Expression,
                    function.Parameters
                        .Select(parameter => new BehaviourParameter(parameter.ParameterId, parameter.ParameterType, parameter.Nullable))
                        .ToArray(),
                    Resolve(function.CallAliases, functions, function.DefinitionId),
                    function.ResultNullable),
                FormulaBudget());
        }

        var calculations = new Dictionary<string, CompiledCalculation>(StringComparer.Ordinal);
        foreach (var definitionId in TopologicalOrder(definitions))
        {
            if (definitions[definitionId] is not NendoCalculationDefinition calculation) continue;
            var expression = adapter.Validate(
                new BehaviourFormula(
                    calculation.DefinitionId,
                    calculation.Expression,
                    calculation.Bindings
                        .Select(binding => new BehaviourParameter(binding.BindingId, binding.ResultType, binding.Nullable))
                        .ToArray(),
                    Resolve(calculation.CallAliases, functions, calculation.DefinitionId),
                    calculation.ResultNullable),
                FormulaBudget());
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
                    break;
                }
                case NendoActionDefinition action:
                {
                    foreach (var step in action.Steps)
                    {
                        foreach (var assignment in step.Assignments)
                        {
                            adapter.Validate(new BehaviourFormula(
                                $"{action.DefinitionId}:{step.StepId}:{assignment.FieldId}", assignment.Expression,
                                assignment.Bindings
                                    .Select(binding => new BehaviourParameter(binding.BindingId, binding.ResultType, binding.Nullable))
                                    .ToArray(),
                                Resolve(assignment.CallAliases, functions, action.DefinitionId)), FormulaBudget());
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
                group => (IReadOnlyList<CompiledCalculation>)Ordered(group, definitions).ToArray(),
                StringComparer.Ordinal);

        return new CompiledBehaviour(definitions, functions, calculations, byEntity);
    }

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
    private static IEnumerable<CompiledCalculation> Ordered(
        IEnumerable<CompiledCalculation> group,
        IReadOnlyDictionary<string, NendoBehaviourDefinition> definitions)
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
