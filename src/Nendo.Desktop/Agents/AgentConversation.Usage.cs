using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nendo.Desktop;

/// <summary>
/// How full the agent's context is, as the agent last said it: tokens in use of the context's
/// size, and, when the agent reports one, what the session has cost so far in an ISO 4217
/// currency.
/// </summary>
internal sealed record AgentUsageView(long Used, long Size, decimal? CostAmount, string? CostCurrency);

/// <summary>
/// The agent's context use (ACP <c>usage_update</c>). The agent states it whole whenever it changes;
/// the conversation keeps the last one it could show, for the tab's context chip. It is the
/// agent's own count, never Nendo's.
/// </summary>
internal sealed partial class AgentConversation
{
    private static readonly Regex Currency = new("^[A-Z]{3}$", RegexOptions.CultureInvariant);

    private AgentUsageView? _usage;

    /// <summary>
    /// The agent said how full its context is. Called under the lock; false, keeping the last one,
    /// when the update has no whole, non-negative count of tokens used of a size above zero. A cost
    /// that is not a non-negative amount in a three-letter currency is left out, and the use kept.
    /// </summary>
    private bool ApplyUsage(JsonElement update)
    {
        if (Count(update, "used") is not { } used || Count(update, "size") is not { } size || size == 0) return false;
        decimal? amount = null;
        string? currency = null;
        if (update.TryGetProperty("cost", out var cost) && cost.ValueKind == JsonValueKind.Object
            && cost.TryGetProperty("amount", out var stated) && stated.ValueKind == JsonValueKind.Number
            && stated.TryGetDecimal(out var value) && value >= 0
            && Text(cost, "currency", 3) is { } code && Currency.IsMatch(code))
        {
            amount = value;
            currency = code;
        }
        _usage = new AgentUsageView(used, size, amount, currency);
        return true;
    }

    private static long? Count(JsonElement update, string name) =>
        update.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var count) && count >= 0
            ? count : null;
}
