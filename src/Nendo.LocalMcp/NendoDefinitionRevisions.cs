using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// Fills the definition revision an operation is checked against when its sender left it out.
/// <para>
/// Every operation that lists <c>expectedDefinitionRevision</c> carries an exact integer into
/// the Engine, which refuses one without it. An agent over MCP and a custom view both send
/// operations without it, and neither can be expected to know the number: a view has no read
/// that states it. The host does know it. The revision advances once per preceding
/// definition-lane mutation, so each operation gets the revision it will meet, and an explicit
/// value is passed through untouched and still conflicts loudly if it is wrong.
/// </para>
/// </summary>
public static class NendoDefinitionRevisions
{
    /// <summary>
    /// The operations whose payload carries <c>expectedDefinitionRevision</c>. A data-lane
    /// conversion is included because it is validated against the same counter even though it
    /// does not advance it.
    /// </summary>
    public static IReadOnlySet<string> RevisionScopedOperations { get; } = new HashSet<string>(
        NendoAuthoringOperations.All
            .Where(operation => operation.OptionalPayload.Contains("expectedDefinitionRevision"))
            .Select(operation => operation.OperationType),
        StringComparer.Ordinal);

    /// <summary>Whether a mutation that starts with this operation advances the definition revision.</summary>
    public static bool IsDefinitionLane(string operationType) =>
        operationType.StartsWith("schema.", StringComparison.Ordinal) ||
        operationType.StartsWith("ui.", StringComparison.Ordinal) ||
        operationType.StartsWith("behaviour.", StringComparison.Ordinal) ||
        operationType.StartsWith("application.", StringComparison.Ordinal) ||
        operationType.StartsWith("extension.", StringComparison.Ordinal);

    /// <summary>The payload with <paramref name="revision"/> filled in, if it takes one and states none.</summary>
    public static JsonElement Resolve(string operationType, JsonElement payload, long revision)
    {
        if (!RevisionScopedOperations.Contains(operationType) ||
            payload.ValueKind != JsonValueKind.Object ||
            (payload.TryGetProperty("expectedDefinitionRevision", out var declared) && declared.ValueKind != JsonValueKind.Null))
        {
            return payload.Clone();
        }
        var buffer = new System.Buffers.ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in payload.EnumerateObject().Where(property => property.Name != "expectedDefinitionRevision"))
            {
                property.WriteTo(writer);
            }
            writer.WriteNumber("expectedDefinitionRevision", revision);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.WrittenMemory);
        return document.RootElement.Clone();
    }

    /// <summary>
    /// The change set with every omitted revision filled in, starting at
    /// <paramref name="capturedRevision"/> and advancing after each definition-lane mutation.
    /// </summary>
    public static NendoCanonicalChangeSetRequest Fill(NendoCanonicalChangeSetRequest changeSet, long capturedRevision)
    {
        ArgumentNullException.ThrowIfNull(changeSet);
        if (changeSet.Mutations is null) return changeSet;
        var revision = capturedRevision;
        var mutations = new List<NendoCanonicalMutationRequest>(changeSet.Mutations.Count);
        foreach (var mutation in changeSet.Mutations)
        {
            if (mutation?.Operations is null)
            {
                mutations.Add(mutation!);
                continue;
            }
            var at = revision;
            mutations.Add(mutation with
            {
                Operations = mutation.Operations
                    .Select(operation => operation is null ? operation! : operation with { Payload = Resolve(operation.OperationType, operation.Payload, at) })
                    .ToArray(),
            });
            if (mutation.Operations.Count > 0 && mutation.Operations[0] is { } first && IsDefinitionLane(first.OperationType))
            {
                revision++;
            }
        }
        return new NendoCanonicalChangeSetRequest(mutations);
    }
}
