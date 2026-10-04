using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

/// <summary>
/// What every tool method does around its service call (W-159): run it, fill the activity
/// slot with the kind of call and what it touched, and turn a refusal into the text and
/// structured form a client reads. The three tool classes carried a copy each.
/// </summary>
internal static class NendoToolCall
{
    internal static async Task<T> RunAsync<T>(
        RequestContext<CallToolRequestParams> context,
        NendoActivityLog activity,
        string category,
        string name,
        Func<Task<T>> action,
        Func<T, string> outcome,
        Func<T, string?>? revisionId = null,
        Func<T, string?>? proposalId = null,
        Func<NendoPendingCause?>? cause = null)
    {
        try
        {
            var result = await action();
            activity.Record(context, category, name, outcome(result), revisionId?.Invoke(result), proposalId?.Invoke(result));
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            activity.Record(context, category, name, "rejected");
            throw NendoToolErrors.Translate(exception, cause);
        }
    }
}
