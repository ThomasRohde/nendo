using System.Security.Cryptography;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>Only stored fields; definition names and arbitrary query text are never bindings.</summary>
public sealed record NendoGraphBinding(string NodeEntityId, string LabelFieldId, string EdgeEntityId,
    string SourceFieldId, string TargetFieldId, string? StatusFieldId = null)
{
    public string ComputeDigest() => Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(this))).ToLowerInvariant();
}
