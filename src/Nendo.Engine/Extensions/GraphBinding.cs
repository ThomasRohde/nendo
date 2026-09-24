using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nendo.Engine;

/// <summary>
/// Only stored fields; definition names and arbitrary query text are never bindings.
/// Protocol 2 adds the disclosed fields and the filters, both in authored order and each
/// resolved to the node or the edge type by the field's own record type. Both stay null
/// on a protocol-1 view, and are left out of the serialized form then, so a protocol-1
/// view keeps the exact binding digest its device permission was granted against.
/// </summary>
public sealed record NendoGraphBinding(string NodeEntityId, string LabelFieldId, string EdgeEntityId,
    string SourceFieldId, string TargetFieldId, string? StatusFieldId = null)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? FieldIds { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<NendoGraphFilter>? Filters { get; init; }

    public string ComputeDigest() => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(this))).ToLowerInvariant();

    /// <summary>Records compare list members by reference; bindings are compared by what they say.</summary>
    public bool Equals(NendoGraphBinding? other) => other is not null && ComputeDigest() == other.ComputeDigest();
    public override int GetHashCode() => ComputeDigest().GetHashCode(StringComparison.Ordinal);
}

/// <summary>
/// One authored narrowing of a projected record type. <paramref name="Value"/> is the
/// literal's exact JSON text, or null for a presence test; relative values are refused
/// at compile time because a running view's projection is replaced, and a filter whose
/// meaning drifts with the clock would change what was allowed without any definition change.
/// </summary>
public sealed record NendoGraphFilter(string FieldId, string Operator, string? Value);
