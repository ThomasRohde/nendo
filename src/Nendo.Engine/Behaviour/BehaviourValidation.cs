using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// Shape checks shared by the definition records, the canonical operations and the
/// store. One implementation so a definition cannot pass validation on the way in
/// through one route and fail on the way out through another.
/// </summary>
internal static class NendoBehaviourValidation
{
    private static readonly NendoBehaviourLimits Limits = NendoBehaviourLimits.Default;

    /// <summary>
    /// Stable IDs are machine identity, so they are held to an ASCII shape rather than
    /// to whatever a display label allows. Rejecting the rest here keeps them safe to
    /// embed in an expression, a digest and a diagnostic without escaping rules.
    /// </summary>
    internal static void RequireIdentifier(string value, string what)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new NendoValidationException($"A {what} needs a stable ID.");
        if (value.Length > Limits.IdentifierLength)
            throw new NendoValidationException($"A {what} ID is limited to {Limits.IdentifierLength} characters.");
        foreach (var character in value)
        {
            var allowed = character is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9'
                or '-' or '_' or '.';
            if (!allowed)
                throw new NendoValidationException(
                    $"A {what} ID uses letters, digits, hyphen, underscore and dot only.");
        }
    }

    internal static void RequireLabel(string value, string what)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new NendoValidationException($"A {what} needs a name.");
        if (value.Length > 200)
            throw new NendoValidationException($"A {what} is limited to 200 characters.");
    }

    internal static void RequireExpression(string expression)
    {
        if (string.IsNullOrWhiteSpace(expression))
            throw new NendoValidationException("A formula needs an expression.");
        if (expression.Length > Limits.SourceLength)
            throw new NendoValidationException($"A formula is limited to {Limits.SourceLength} characters.");
    }

    internal static void RequireDistinctBindings(IReadOnlyList<NendoBehaviourBinding> bindings)
    {
        ArgumentNullException.ThrowIfNull(bindings);
        if (bindings.Count > Limits.Parameters)
            throw new NendoValidationException($"A formula reads at most {Limits.Parameters} values.");
        if (bindings.Select(binding => binding.BindingId).Distinct(StringComparer.Ordinal).Count() != bindings.Count)
            throw new NendoValidationException("Binding aliases must be unique within a formula.");
        foreach (var binding in bindings) binding.Validate();
    }

    internal static void RequireDistinctAliases(IReadOnlyList<NendoFunctionCallAlias> aliases)
    {
        ArgumentNullException.ThrowIfNull(aliases);
        if (aliases.Count > Limits.CatalogueSize)
            throw new NendoValidationException($"A formula calls at most {Limits.CatalogueSize} functions.");
        if (aliases.Select(alias => alias.Alias).Distinct(StringComparer.Ordinal).Count() != aliases.Count)
            throw new NendoValidationException("Function aliases must be unique within a formula.");
        foreach (var alias in aliases) alias.Validate();
    }

    internal static void WriteBindings(
        Utf8JsonWriter writer,
        IReadOnlyList<NendoBehaviourBinding> bindings,
        string property = "bindings")
    {
        writer.WriteStartArray(property);
        foreach (var binding in bindings) binding.WriteCanonical(writer);
        writer.WriteEndArray();
    }

    internal static void WriteAliases(Utf8JsonWriter writer, IReadOnlyList<NendoFunctionCallAlias> aliases)
    {
        writer.WriteStartArray("callAliases");
        foreach (var alias in aliases) alias.WriteCanonical(writer);
        writer.WriteEndArray();
    }
}

/// <summary>
/// Checks a complete candidate set of definitions against each other: that every
/// stable reference resolves, that no function calls itself around a loop, and that
/// the call graph stays inside its depth ceiling.
/// <para>
/// This runs over the whole candidate set rather than one definition at a time.
/// A cycle is a property of the graph, so installing definitions individually and
/// validating each in isolation would admit the pair that only closes the loop once
/// both are present.
/// </para>
/// </summary>
internal static class NendoBehaviourGraph
{
    /// <summary>Every binding a definition declares, whichever part of it they belong to.</summary>
    internal static IEnumerable<NendoBehaviourBinding> BindingsOf(NendoBehaviourDefinition definition) => definition switch
    {
        NendoCalculationDefinition calculation => calculation.Bindings,
        NendoTriggerDefinition trigger => trigger.ConditionBindings,
        NendoActionDefinition action => action.Steps
            .SelectMany(step => step.Assignments).SelectMany(assignment => assignment.Bindings),
        _ => [],
    };

    /// <summary>
    /// Validates the set that would exist after a change set is applied. Throws on the
    /// first problem, naming the definition, because a partially valid behaviour set is
    /// never installed.
    /// </summary>
    internal static void ValidateCandidate(
        IReadOnlyDictionary<string, NendoBehaviourDefinition> definitions,
        NendoBehaviourLimits? limits = null)
    {
        ArgumentNullException.ThrowIfNull(definitions);
        var ceiling = (limits ?? NendoBehaviourLimits.Default).Validate();
        // The catalogue ceiling counts functions only. Every formula compiles under its
        // own work allowance, so without a ceiling on the set itself nothing bounded how
        // much compile work a file could ask for on every open.
        if (definitions.Count > ceiling.Definitions)
            throw new NendoValidationException(
                $"This file defines {definitions.Count} calculations, functions, actions and triggers, and the limit is {ceiling.Definitions}.");
        var functions = definitions.Values.OfType<NendoFunctionDefinition>().ToArray();
        if (functions.Length > ceiling.CatalogueSize)
            throw new NendoValidationException(
                $"This file defines {functions.Length} reusable functions, and the limit is {ceiling.CatalogueSize}.");

        foreach (var definition in definitions.Values)
        {
            definition.Validate();
            foreach (var alias in definition.ReferencedAliases)
            {
                if (!definitions.TryGetValue(alias.FunctionId, out var target))
                    throw new NendoValidationException(
                        $"'{definition.DefinitionId}' calls '{alias.FunctionId}', which this file does not define.");
                if (target is not NendoFunctionDefinition)
                    throw new NendoValidationException(
                        $"'{definition.DefinitionId}' calls '{alias.FunctionId}', which is not a reusable function.");
            }
            if (definition is NendoTriggerDefinition trigger)
            {
                if (!definitions.TryGetValue(trigger.ActionId, out var action))
                    throw new NendoValidationException(
                        $"Trigger '{trigger.DefinitionId}' runs '{trigger.ActionId}', which this file does not define.");
                if (action is not NendoActionDefinition)
                    throw new NendoValidationException(
                        $"Trigger '{trigger.DefinitionId}' runs '{trigger.ActionId}', which is not an action.");
            }
            foreach (var binding in BindingsOf(definition).Where(candidate => candidate.CalculationId is not null))
            {
                if (!definitions.TryGetValue(binding.CalculationId!, out var read))
                    throw new NendoValidationException(
                        $"'{definition.DefinitionId}' reads '{binding.CalculationId}', which this file does not define.");
                if (read is not NendoCalculationDefinition calculation)
                    throw new NendoValidationException(
                        $"'{definition.DefinitionId}' reads '{binding.CalculationId}', which is not a calculated field.");
                if (!string.Equals(calculation.EntityId, binding.EntityId, StringComparison.Ordinal))
                    throw new NendoValidationException(
                        $"'{definition.DefinitionId}' reads '{binding.CalculationId}', which belongs to a different record type.");
                if (calculation.ResultType != binding.ResultType)
                    throw new NendoValidationException(
                        $"'{binding.CalculationId}' produces {calculation.ResultType.ToString().ToLowerInvariant()}, and '{definition.DefinitionId}' declares {binding.ResultType.ToString().ToLowerInvariant()}.");
            }
        }

        // One recursion stack for the complete graph: a definition reached twice on the
        // same path is a cycle no matter which entry point started the walk. The memo
        // holds each node's *height* — the longest chain that hangs below it — not merely
        // that the node was reached. Memoising reachedness made the ceiling depend on the
        // order roots were walked in: a chain whose edges point from a higher-sorting ID
        // to a lower-sorting one settled every node at height 1 as its own root, so a
        // chain far deeper than the ceiling installed. Height is order-independent.
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var height = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var definitionId in definitions.Keys.OrderBy(id => id, StringComparer.Ordinal))
        {
            Height(definitionId);
        }

        int Height(string definitionId)
        {
            if (height.TryGetValue(definitionId, out var known)) return known;
            if (!visiting.Add(definitionId))
                throw new NendoValidationException(
                    $"'{definitionId}' calls itself through a loop of definitions. Break the loop before installing it.");
            var definition = definitions[definitionId];
            var deepestBelow = 0;
            foreach (var referenced in definition.ReferencedDefinitionIds.Distinct(StringComparer.Ordinal)
                         .OrderBy(id => id, StringComparer.Ordinal))
            {
                deepestBelow = Math.Max(deepestBelow, Height(referenced));
            }
            visiting.Remove(definitionId);
            var depth = deepestBelow + 1;
            if (depth > ceiling.GraphDepth)
                throw new NendoValidationException(
                    $"The definitions nest more than {ceiling.GraphDepth} deep at '{definitionId}'.");
            height[definitionId] = depth;
            return depth;
        }
    }

    /// <summary>
    /// Every definition that would break if the named one were removed. Deleting a
    /// referenced definition is refused unless the same change set also rewires or
    /// removes whatever points at it.
    /// </summary>
    internal static IReadOnlyList<string> DependantsOf(
        IReadOnlyDictionary<string, NendoBehaviourDefinition> definitions,
        string definitionId) =>
        definitions.Values
            .Where(definition => !string.Equals(definition.DefinitionId, definitionId, StringComparison.Ordinal))
            .Where(definition => definition.ReferencedDefinitionIds
                .Any(referenced => string.Equals(referenced, definitionId, StringComparison.Ordinal)))
            .Select(definition => definition.DefinitionId)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();
}
