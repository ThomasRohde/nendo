namespace Nendo.LocalMcp;

/// <summary>
/// The descriptions of the arguments many tools share, written once so every tool says the
/// same thing about the same argument.
/// </summary>
internal static class NendoParameterDescriptions
{
    internal const string ApplicationHandle = "Private application handle returned by nendo.lease.acquire.";

    internal const string LeaseId = "Opaque lease ID returned by nendo.lease.acquire.";

    internal const string ChangeSetId = "Server-minted change-set ID returned by nendo.change_set.begin.";

    internal const string EntityId = "Stable entity ID from nendo://application/entities or nendo://application/describe.";

    internal const string IdempotencyKey = "Stable key used to make exact retries safe.";
}
