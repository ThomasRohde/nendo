using System.Security.Cryptography;
using System.Text.Json;

namespace Nendo.Engine;

public enum NendoIdentityCopyKind { Duplicate, Fork }

public sealed record NendoIdentitySourcePoint(
    string ApplicationId, string InstanceId, long DefinitionRevision, long DataRevision, long ChangeSequence)
{
    internal static NendoIdentitySourcePoint From(NendoManifestSnapshot manifest) =>
        new(manifest.ApplicationId, manifest.InstanceId, manifest.DefinitionRevision, manifest.DataRevision, manifest.ChangeSequence);
}

public sealed record NendoIdentityCopyPlan(
    string PlanId, NendoIdentityCopyKind Kind, string DestinationFileName,
    NendoManifestSnapshot Source, string ResultApplicationId, string ResultInstanceId);

public sealed record NendoIdentityCopyResult(
    string PlanId, NendoIdentityCopyKind Kind, string DestinationFileName,
    NendoManifestSnapshot Manifest, string TransitionRevisionId, bool IsIdempotentReplay);

/// <summary>Only the dedicated lifecycle constructs this operation; generic mutation rejects it.</summary>
public sealed record IdentityTransitionOperation : NendoOperation
{
    internal IdentityTransitionOperation(
        string operationId, NendoIdentityCopyKind kind, NendoIdentitySourcePoint source,
        string resultApplicationId, string resultInstanceId, string requestDigest) : base(operationId)
    {
        if (!Enum.IsDefined(kind)) throw new NendoValidationException("Unknown identity-copy kind.");
        ArgumentNullException.ThrowIfNull(source);
        Require(source.ApplicationId, nameof(source.ApplicationId));
        Require(source.InstanceId, nameof(source.InstanceId));
        Require(resultApplicationId, nameof(resultApplicationId));
        Require(resultInstanceId, nameof(resultInstanceId));
        ArgumentNullException.ThrowIfNull(requestDigest);
        if (source.DefinitionRevision < 0 || source.DataRevision < 0 || source.ChangeSequence < 0 ||
            source.ChangeSequence != checked(source.DefinitionRevision + source.DataRevision) ||
            resultInstanceId == source.InstanceId ||
            (kind == NendoIdentityCopyKind.Duplicate) != (resultApplicationId == source.ApplicationId) ||
            requestDigest.Length != 64 || requestDigest.Any(character => !Uri.IsHexDigit(character)))
        {
            throw new NendoValidationException("The identity transition does not satisfy the copy contract.");
        }
        Kind = kind;
        Source = source;
        ResultApplicationId = resultApplicationId;
        ResultInstanceId = resultInstanceId;
        RequestDigest = requestDigest;
    }

    public NendoIdentityCopyKind Kind { get; }
    public NendoIdentitySourcePoint Source { get; }
    public string ResultApplicationId { get; }
    public string ResultInstanceId { get; }
    public string RequestDigest { get; }
    public override string OperationType => "identity.transition";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.IrreversibleDeclared;

    internal static IdentityTransitionOperation ParseCanonical(string canonical)
    {
        using var document = JsonDocument.Parse(canonical);
        var root = document.RootElement;
        var payload = root.GetProperty("payload");
        var source = payload.GetProperty("source");
        var result = new IdentityTransitionOperation(root.GetProperty("operationId").GetString()!,
            Enum.Parse<NendoIdentityCopyKind>(payload.GetProperty("kind").GetString()!, ignoreCase: false),
            new(source.GetProperty("applicationId").GetString()!, source.GetProperty("instanceId").GetString()!,
                source.GetProperty("definitionRevision").GetInt64(), source.GetProperty("dataRevision").GetInt64(),
                source.GetProperty("changeSequence").GetInt64()),
            payload.GetProperty("resultApplicationId").GetString()!, payload.GetProperty("resultInstanceId").GetString()!,
            payload.GetProperty("requestDigest").GetString()!);
        if (result.CanonicalJson() != canonical) throw new NendoValidationException("Identity provenance is not canonical.");
        return result;
    }

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteString("kind", Kind.ToString());
        writer.WriteString("requestDigest", RequestDigest);
        writer.WriteString("resultApplicationId", ResultApplicationId);
        writer.WriteString("resultInstanceId", ResultInstanceId);
        writer.WriteStartObject("source");
        writer.WriteString("applicationId", Source.ApplicationId);
        writer.WriteNumber("changeSequence", Source.ChangeSequence);
        writer.WriteNumber("dataRevision", Source.DataRevision);
        writer.WriteNumber("definitionRevision", Source.DefinitionRevision);
        writer.WriteString("instanceId", Source.InstanceId);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }
}

internal sealed record IdentityCopyIntent(
    NendoIdentityCopyKind Kind, string RequestId, NendoManifestSnapshot Source, string ContentDigest, string RequestDigest)
{
    internal string Scope => $"host.identity/{Source.InstanceId}";

    internal static IdentityCopyIntent Create(NendoIdentityCopyKind kind, string requestId, NendoManifestSnapshot source, string contentDigest, string destination) =>
        new(kind, requestId, source, contentDigest, Convert.ToHexString(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(
            new { version = 1, kind = kind.ToString(), requestId, contentDigest, destination = destination.ToUpperInvariant() }))));

    internal IdentityTransitionOperation Operation(string applicationId, string instanceId) =>
        new(NendoCanonical.DeterministicId("operation", Scope, RequestId, 0), Kind,
            NendoIdentitySourcePoint.From(Source), applicationId, instanceId, RequestDigest);

    internal NendoMutation Mutation(IdentityTransitionOperation operation) =>
        new(Scope, RequestId, "host.file-lifecycle", Kind == NendoIdentityCopyKind.Duplicate ? "Duplicate application" : "Fork application (history retained)", [operation]);
}
