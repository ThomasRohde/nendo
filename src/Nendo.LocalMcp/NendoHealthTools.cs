using System.ComponentModel;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

/// <summary>
/// The one thing an agent could not do about health: ask for a measurement. The
/// health resource reports the last integrity result and never rescans, so a
/// long-lived session could only read a verdict that aged with every write.
/// </summary>
[McpServerToolType]
internal sealed class NendoHealthTools(
    NendoResourceProjection projection,
    NendoActivityLog activity)
{
    [McpServerTool(
        Name = "nendo.health.verify_integrity",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = true,
        UseStructuredContent = true)]
    [Description("Request an integrity scan of the open file and read the result measured now. Needs no lease and changes nothing. A file that has not changed since the last scan is not rescanned: rescanned is false and the recorded result already describes it, so calling this in a loop costs nothing. A scan that fails puts the host into recovery, which is the file being protected, not this call failing.")]
    public async Task<NendoMcpIntegrityCheck> VerifyIntegrityAsync(
        RequestContext<CallToolRequestParams> context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var result = await projection.VerifyIntegrityAsync(cancellationToken);
            activity.Record(
                "health",
                "nendo.health.verify_integrity",
                context.Server,
                result.Rescanned ? "scanned" : "current");
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            throw NendoToolErrors.Translate(exception);
        }
    }
}
