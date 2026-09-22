using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// One generated write a reviewed proposal will make, and why it exists.
/// </summary>
internal sealed record PreparedBehaviourOperation(
    int MutationIndex,
    string CanonicalJson,
    BehaviourAttribution Attribution);

/// <summary>
/// Everything a reviewed proposal promised, frozen at the moment it was reviewed.
/// <para>
/// A proposal is reviewed against a clone and applied to the live file some time
/// later. What makes that safe is that the second step replays exactly what the
/// first step produced — not that it recomputes the same thing and hopes for the
/// same answer. So the expanded operations, the record versions every choice was
/// based on, and the data revision the collections were counted at are all captured
/// here and checked before anything is written.
/// </para>
/// <para>
/// Recomputing any of this at acceptance would defeat the point: it would make the
/// promotion agree with itself rather than with what the owner approved.
/// </para>
/// </summary>
internal sealed record PreparedBehaviourPlan(
    IReadOnlyList<PreparedBehaviourOperation> Generated,
    IReadOnlyList<NendoTouchedRecordVersion> ReadSet,
    long DataRevision,
    long DefinitionRevision,
    string BehaviourDigest,
    string ContractVersion)
{
    /// <summary>
    /// The consent promoting this plan needs, for the behaviour the file will hold
    /// once it is promoted — which is not necessarily the behaviour it holds now, if
    /// the proposal changes definitions too.
    /// <para>
    /// Promotion does not run the triggers; it replays what they already did. So the
    /// chain's own consent gate never fires, and this is what stands in its place.
    /// Without it a proposal would be a way to apply automatic effects that this
    /// device never agreed to.
    /// </para>
    /// </summary>
    internal NendoBehaviourGrant? RequiredGrant { get; init; }

    internal static PreparedBehaviourPlan Empty { get; } =
        new([], [], 0, 0, string.Empty, NendoBehaviourContract.Version);

    internal bool IsEmpty => Generated.Count == 0 && ReadSet.Count == 0;

    /// <summary>
    /// Covers the generated effects, the preconditions and the behaviour that produced
    /// them. A plan whose digest does not match what was reviewed is not the plan the
    /// owner saw, whatever else about it still looks right.
    /// </summary>
    internal string Digest()
    {
        var builder = new StringBuilder()
            .Append(ContractVersion).Append('\n')
            .Append(BehaviourDigest).Append('\n')
            .Append(DefinitionRevision).Append('\n')
            .Append(DataRevision).Append('\n');
        foreach (var operation in Generated)
        {
            builder.Append(operation.MutationIndex).Append('\t')
                .Append(operation.Attribution.TriggerId).Append('\t')
                .Append(operation.Attribution.ActionId).Append('\t')
                .Append(operation.Attribution.StepId).Append('\t')
                .Append(operation.Attribution.EventKind).Append('\t')
                .Append(operation.Attribution.EventEntityId).Append('\t')
                .Append(operation.Attribution.EventRecordId).Append('\t')
                .Append(operation.CanonicalJson).Append('\n');
        }
        builder.Append("grant\t").Append(RequiredGrant?.ToString() ?? "none").Append('\n');
        builder.Append("reads\n");
        foreach (var read in ReadSet.OrderBy(read => read.EntityId, StringComparer.Ordinal)
                     .ThenBy(read => read.RecordId, StringComparer.Ordinal))
        {
            builder.Append(read.EntityId).Append('\t').Append(read.RecordId).Append('\t').Append(read.Version).Append('\n');
        }
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString()))).ToLowerInvariant();
    }

    internal string Serialize()
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Indented = true }))
        {
            writer.WriteStartObject();
            writer.WriteString("behaviourDigest", BehaviourDigest);
            writer.WriteString("contractVersion", ContractVersion);
            writer.WriteNumber("dataRevision", DataRevision);
            writer.WriteNumber("definitionRevision", DefinitionRevision);
            writer.WriteStartArray("generated");
            foreach (var operation in Generated)
            {
                writer.WriteStartObject();
                writer.WriteString("actionId", operation.Attribution.ActionId);
                writer.WriteString("eventEntityId", operation.Attribution.EventEntityId);
                writer.WriteString("eventKind", operation.Attribution.EventKind.ToString());
                writer.WriteString("eventRecordId", operation.Attribution.EventRecordId);
                writer.WriteNumber("mutationIndex", operation.MutationIndex);
                // Stored as a string, not as embedded JSON: the indented writer would
                // reformat it, and the reviewed plan must round-trip byte for byte or
                // its digest stops identifying what was reviewed.
                writer.WriteString("operation", operation.CanonicalJson);
                writer.WriteString("rootKey", operation.Attribution.RootKey);
                writer.WriteString("rootScope", operation.Attribution.RootScope);
                writer.WriteString("stepId", operation.Attribution.StepId);
                writer.WriteString("triggerId", operation.Attribution.TriggerId);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            if (RequiredGrant is { } grant)
            {
                writer.WriteStartObject("requiredGrant");
                writer.WriteString("applicationId", grant.ApplicationId);
                writer.WriteString("behaviourDigest", grant.BehaviourDigest);
                writer.WriteNumber("capabilities", (int)grant.Capabilities);
                writer.WriteString("contractVersion", grant.ContractVersion);
                writer.WriteNumber("definitionRevision", grant.DefinitionRevision);
                writer.WriteString("instanceId", grant.InstanceId);
                writer.WriteEndObject();
            }
            writer.WriteStartArray("readSet");
            foreach (var read in ReadSet)
            {
                writer.WriteStartObject();
                writer.WriteString("entityId", read.EntityId);
                writer.WriteString("recordId", read.RecordId);
                writer.WriteNumber("version", read.Version);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    /// <summary>
    /// Reads a persisted plan back. Anything that does not parse into a complete plan
    /// is refused rather than partially trusted: a plan missing half its preconditions
    /// would promote against checks nobody reviewed.
    /// </summary>
    internal static PreparedBehaviourPlan Deserialize(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var generated = new List<PreparedBehaviourOperation>();
            foreach (var element in root.GetProperty("generated").EnumerateArray())
            {
                generated.Add(new PreparedBehaviourOperation(
                    element.GetProperty("mutationIndex").GetInt32(),
                    element.GetProperty("operation").GetString()!,
                    new BehaviourAttribution(
                        element.GetProperty("rootScope").GetString()!,
                        element.GetProperty("rootKey").GetString()!,
                        element.GetProperty("triggerId").GetString()!,
                        element.GetProperty("actionId").GetString()!,
                        element.GetProperty("stepId").GetString()!,
                        Enum.Parse<NendoRecordEventKind>(element.GetProperty("eventKind").GetString()!),
                        element.GetProperty("eventEntityId").GetString()!,
                        element.GetProperty("eventRecordId").GetString()!,
                        root.GetProperty("behaviourDigest").GetString()!)));
            }
            var reads = new List<NendoTouchedRecordVersion>();
            foreach (var element in root.GetProperty("readSet").EnumerateArray())
            {
                reads.Add(new NendoTouchedRecordVersion(
                    element.GetProperty("entityId").GetString()!,
                    element.GetProperty("recordId").GetString()!,
                    element.GetProperty("version").GetInt64()));
            }
            NendoBehaviourGrant? required = null;
            if (root.TryGetProperty("requiredGrant", out var grantElement))
            {
                required = new NendoBehaviourGrant(
                    grantElement.GetProperty("applicationId").GetString()!,
                    grantElement.GetProperty("instanceId").GetString()!,
                    grantElement.GetProperty("behaviourDigest").GetString()!,
                    grantElement.GetProperty("contractVersion").GetString()!,
                    grantElement.GetProperty("definitionRevision").GetInt64(),
                    (NendoBehaviourCapabilities)grantElement.GetProperty("capabilities").GetInt32());
            }
            return new PreparedBehaviourPlan(
                generated,
                reads,
                root.GetProperty("dataRevision").GetInt64(),
                root.GetProperty("definitionRevision").GetInt64(),
                root.GetProperty("behaviourDigest").GetString()!,
                root.GetProperty("contractVersion").GetString()!) { RequiredGrant = required };
        }
        catch (Exception exception) when (exception is JsonException or KeyNotFoundException or
                                              InvalidOperationException or FormatException or ArgumentException)
        {
            throw new NendoValidationException(
                "The reviewed plan for this proposal could not be read. Prepare a new proposal and review it again.");
        }
    }
}

/// <summary>
/// Lets a throwaway clone run the actions a proposal is being reviewed for.
/// <para>
/// This is the host deciding to simulate, not a file granting itself permission. It
/// is attached only to the clone in the proposal workspace — a copy nobody edits and
/// which is deleted afterwards — and never to a file the owner has open. Promoting
/// what the simulation produced is a separate question, and needs the owner's real
/// approval of the exact plan.
/// </para>
/// </summary>
internal sealed class PreviewBehaviourAuthority : INendoBehaviourAuthority
{
    internal static PreviewBehaviourAuthority Instance { get; } = new();

    public long RevocationGeneration => 0;

    public bool IsGranted(NendoBehaviourGrant required) => true;
}
