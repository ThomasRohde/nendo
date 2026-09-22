using System.Globalization;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>What a calculated field currently is.</summary>
public enum NendoCalculationState
{
    /// <summary>A typed value the formula produced.</summary>
    Value,

    /// <summary>The formula produced nothing. Different from empty text and from zero.</summary>
    Empty,

    /// <summary>The formula could not produce a value; <see cref="NendoCalculationResult.ErrorCode"/> says why.</summary>
    Error,

    /// <summary>Not computed yet. Never yesterday's value shown as though it were current.</summary>
    Pending,
}

/// <summary>
/// One calculated field's current result for one record.
/// <para>
/// The four states are distinct on purpose. Collapsing empty into zero, or an error
/// into a blank, would put a number on screen that no formula produced — and the
/// same number into a total, an export or an agent's answer.
/// </para>
/// <para>
/// The value travels as a <see cref="JsonElement"/>, exactly as stored record values
/// do, so the same exact-number transport carries it to Studio, custom surfaces and
/// MCP without passing through a floating-point double anywhere.
/// </para>
/// </summary>
public sealed record NendoCalculationResult(
    string CalculationId,
    string FieldId,
    NendoCalculationState State,
    NendoBehaviourScalar ResultType,
    JsonElement Value,
    string? ErrorCode = null,
    string? ErrorMessage = null)
{
    /// <summary>The record version the inputs were read at, for cache and staleness checks.</summary>
    public long SourceRecordVersion { get; init; }

    /// <summary>The file's data revision when related records were counted.</summary>
    public long SourceDataRevision { get; init; }
}

/// <summary>
/// Reads the values a binding names. Implemented by storage, which is the only layer
/// that knows about SQL, physical tables and columns; everything above it describes
/// what it wants in stable semantic IDs.
/// </summary>
internal interface IBehaviourRecordSource
{
    /// <summary>
    /// Resolves one binding for one record. Same-record calculation bindings never
    /// arrive here: the service has already computed those, in dependency order.
    /// </summary>
    Task<BehaviourValue> ResolveAsync(
        NendoBehaviourBinding binding,
        string recordId,
        BehaviourBudget budget,
        CancellationToken cancellationToken);
}

/// <summary>
/// Computes calculated fields for a record.
/// <para>
/// Evaluation is on demand and reads whatever state its source shows it — committed
/// data for an ordinary read, or a transaction's staged data mid-save. That is why
/// the source is an interface and not the coordinator: calling the public coordinator
/// from inside a write transaction would re-enter its gate and read the state the
/// transaction is in the middle of replacing.
/// </para>
/// <para>
/// Computing a calculation is a read. It writes nothing, raises no revision, records
/// no record event and starts no action, so opening a file, rendering a list or
/// rebuilding a cache can never change it.
/// </para>
/// </summary>
internal sealed class NendoCalculationService(NendoExpressionAdapter adapter)
{
    /// <summary>
    /// Every calculated field of one record, in dependency order.
    /// <para>
    /// A calculation whose input is itself in error reports a dependency failure
    /// rather than a value: showing the last good number beside a broken input is
    /// how a wrong figure ends up being trusted.
    /// </para>
    /// </summary>
    internal async Task<IReadOnlyList<NendoCalculationResult>> EvaluateRecordAsync(
        CompiledBehaviour behaviour,
        string entityId,
        string recordId,
        IBehaviourRecordSource source,
        BehaviourBudget budget,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(behaviour);
        ArgumentNullException.ThrowIfNull(source);
        if (!behaviour.CalculationsByEntity.TryGetValue(entityId, out var calculations)) return [];

        var results = new List<NendoCalculationResult>(calculations.Count);
        var computed = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal);
        var failed = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var calculation in calculations)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var definition = calculation.Definition;
            var dependency = definition.Bindings
                .Where(binding => binding.CalculationId is not null)
                .Select(binding => binding.CalculationId!)
                .FirstOrDefault(failed.ContainsKey);
            if (dependency is not null)
            {
                results.Add(Failure(definition, NendoCalculationCodes.DependencyFailed,
                    $"This depends on {dependency}, which could not be calculated."));
                failed[definition.DefinitionId] = NendoCalculationCodes.DependencyFailed;
                continue;
            }

            try
            {
                var values = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal);
                foreach (var binding in definition.Bindings)
                {
                    values[binding.BindingId] = binding.CalculationId is { } read
                        ? computed[read]
                        : await source.ResolveAsync(binding, recordId, budget, cancellationToken);
                }
                var value = adapter.Calculate(calculation.Expression, values, budget);
                computed[definition.DefinitionId] = value;
                results.Add(Success(definition, value));
            }
            catch (NendoCalculationException exception)
            {
                // The declaration decides (ADR-0008, 2026-09-20 amendment): an empty
                // input that stopped a calculation declared to allow an empty result --
                // in its formula, or in a related total it reads -- is that empty
                // result, and a dependant reads a typed empty.
                if (exception.Code == NendoCalculationCodes.MissingInput && definition.ResultNullable)
                {
                    var empty = BehaviourValue.Empty(definition.ResultType);
                    computed[definition.DefinitionId] = empty;
                    results.Add(Success(definition, empty));
                    continue;
                }
                // An expected failure: a visible error on this field, while every other
                // field of the record — and the record itself — stays exactly as valid
                // as it was.
                failed[definition.DefinitionId] = exception.Code;
                results.Add(Failure(definition, exception.Code, exception.Message));
            }
        }
        return results;
    }

    /// <summary>
    /// One calculation for one record, used where a trigger condition or an action
    /// input needs a single derived value rather than the whole set.
    /// </summary>
    internal async Task<BehaviourValue> EvaluateAsync(
        CompiledBehaviour behaviour,
        string calculationId,
        string recordId,
        IBehaviourRecordSource source,
        BehaviourBudget budget,
        CancellationToken cancellationToken)
    {
        if (!behaviour.Calculations.TryGetValue(calculationId, out var calculation))
            throw new NendoValidationException($"'{calculationId}' is not a calculated field in this file.");
        var values = new Dictionary<string, BehaviourValue>(StringComparer.Ordinal);
        try
        {
            foreach (var binding in calculation.Definition.Bindings)
            {
                values[binding.BindingId] = binding.CalculationId is { } read
                    ? await EvaluateAsync(behaviour, read, recordId, source, budget, cancellationToken)
                    : await source.ResolveAsync(binding, recordId, budget, cancellationToken);
            }
        }
        catch (NendoCalculationException exception)
            when (exception.Code == NendoCalculationCodes.MissingInput && calculation.Definition.ResultNullable)
        {
            // The same rule the record-wide read applies: a related total that cannot
            // be read is an empty input, and the declaration decides what that means.
            return BehaviourValue.Empty(calculation.Definition.ResultType);
        }
        return adapter.Calculate(calculation.Expression, values, budget);
    }

    private static NendoCalculationResult Success(NendoCalculationDefinition definition, BehaviourValue value) =>
        new(definition.DefinitionId, definition.FieldId,
            value.IsNull ? NendoCalculationState.Empty : NendoCalculationState.Value,
            definition.ResultType, ToJson(value));

    private static NendoCalculationResult Failure(NendoCalculationDefinition definition, string code, string message) =>
        new(definition.DefinitionId, definition.FieldId, NendoCalculationState.Error,
            definition.ResultType, NoValue, code, message);

    /// <summary>
    /// The absence of a value, as JSON null.
    /// <para>
    /// Deliberately not <c>default(JsonElement)</c>. That is an <c>Undefined</c>
    /// element, and writing one throws rather than producing anything — so a single
    /// failed calculation would take down every serialization the record appears in,
    /// including the render plan's digest. "No value" is a value JSON can carry.
    /// </para>
    /// </summary>
    private static readonly JsonElement NoValue = JsonSerializer.SerializeToElement<object?>(null);

    /// <summary>
    /// Carries the value in the same shape a stored value of that kind takes, so a
    /// consumer does not need a second decoder for calculated fields — and so a
    /// decimal never becomes a double on the way out.
    /// </summary>
    private static JsonElement ToJson(BehaviourValue value) => value.Boxed switch
    {
        null => NoValue,
        long number => JsonSerializer.SerializeToElement(number),
        decimal number => JsonSerializer.SerializeToElement(number),
        bool flag => JsonSerializer.SerializeToElement(flag),
        DateOnly date => JsonSerializer.SerializeToElement(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)),
        _ => JsonSerializer.SerializeToElement((string)value.Boxed),
    };
}
