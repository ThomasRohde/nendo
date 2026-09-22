using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

/// <summary>
/// The one tool that exists only at <see cref="AgentAccessMode.Unattended"/>.
/// <para>
/// It is a class of its own rather than a sixth method on the authoring tools so that
/// the level it belongs to is visible where the listener is composed: one registration
/// block, one mode, one tool. A method hidden among five that are registered a rung
/// lower would be one edit away from being served at Shape app.
/// </para>
/// </summary>
[McpServerToolType]
internal sealed class NendoUnattendedTools(
    NendoAgentAuthoringService authoring,
    NendoActivityLog activity)
{
    [McpServerTool(
        Name = "nendo.change_set.accept",
        Destructive = true,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = false,
        UseStructuredContent = true)]
    [Description("""
        Accept a proposal this session validated, applying it to the open file without asking anyone.
        Available only at the Unattended access level, which the person chooses per file session and which
        is never remembered; below it this tool is not served and acceptance is theirs.
        It replays the validated operations against the active file through the same service the person's own
        Accept button calls, pinned to the proposal's reviewed operation digest, so every staleness and
        digest check still applies. applied=false is an ordinary answer, not a failure: state says whether the
        file moved under the proposal (stale), the reviewed plan no longer matches (failed), or it is still
        waiting (previewable). The proposal stays where it is so the next step is visible, and the change is an
        ordinary History revision either way.
        When the accepted change installs automatic actions, this level also records this device's consent to
        run them, and behaviourApproved says so. That consent is the person's to withdraw, under Agent and
        under Health, exactly as if they had given it.
        Validate first: a change set that is still a draft is NENDO_CHANGE_SET_NOT_VALIDATED.
        """)]
    public async Task<NendoChangeSetAcceptResult> AcceptAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("Private application handle returned by nendo.lease.acquire.")] string applicationHandle,
        [Description("Opaque lease ID returned by nendo.lease.acquire.")] string leaseId,
        [Description("Server-minted change-set ID returned by nendo.change_set.begin, already validated.")] string changeSetId,
        [Description("Stable key used to make an exact retry safe.")] string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var result = await authoring.AcceptAsync(
                applicationHandle,
                leaseId,
                changeSetId,
                idempotencyKey,
                cancellationToken);
            activity.Record(
                "authoring",
                "nendo.change_set.accept",
                context.Server,
                result.Applied ? "completed" : "rejected",
                proposalId: result.ProposalId);
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            activity.Record("authoring", "nendo.change_set.accept", context.Server, "rejected");
            throw NendoToolErrors.Translate(exception);
        }
    }
}
