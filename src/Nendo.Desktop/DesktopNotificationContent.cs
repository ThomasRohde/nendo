using System.Text;

namespace Nendo.Desktop;

/// <summary>
/// One notification, built but not yet shown.
/// <para>
/// <paramref name="Route"/> is the whole of what a click carries back. It is a
/// closed set of view names and nothing else — no file path, no proposal
/// identifier, no digest, no session ID. Two reasons: Windows keeps notification
/// arguments in its own store, outside anything this application controls, and a
/// proposal named in a toast may be gone by the time somebody clicks it, so
/// landing on the list that shows what is actually pending is both safer and more
/// honest than landing on a missing item.
/// </para>
/// </summary>
internal sealed record DesktopNotification(
    string Tag,
    string Title,
    string Body,
    string? ButtonLabel,
    string Route);

/// <summary>
/// The wording of every notification Nendo raises, as pure functions over the
/// state that justifies them.
/// <para>
/// Separated from the manager that shows them so the text, the routing and the
/// absence of anything privileged are all under test without a desktop session —
/// the same reason the Workbench keeps its markup builders pure.
/// </para>
/// <para>
/// No factory here produces an approve or accept button. Approving is host-owned
/// and rests on having seen what is being approved: promotion verifies the digest
/// that was reviewed, and a behaviour grant binds an exact digest, contract
/// version, revision and capability set. A notification can say a person is
/// needed; it cannot be the place they answer.
/// </para>
/// </summary>
internal static class DesktopNotificationContent
{
    internal const string RouteOpen = "open";
    internal const string RouteAgent = "agent";
    internal const string RouteHealth = "health";

    internal const string TagTrayIntro = "tray-intro";
    internal const string TagProposal = "proposal-waiting";
    internal const string TagApproval = "approval-needed";
    internal const string TagUnwritable = "file-unwritable";
    internal const string TagRenderer = "renderer-failed";

    /// <summary>The group every Nendo notification joins, so restoring the window can clear them all.</summary>
    internal const string Group = "nendo";

    /// <summary>Shown once per device, the first time the close button hides the window.</summary>
    internal static DesktopNotification TrayIntro(string? fileName) => new(
        TagTrayIntro,
        "Nendo is still running",
        Subject(fileName, "is still open") +
            " Nendo is in the notification area, so an agent can keep working. Use its menu to exit.",
        null,
        RouteOpen);

    internal static DesktopNotification ProposalWaiting(string? fileName, int pending) => new(
        TagProposal,
        pending > 1 ? $"{pending} changes are waiting for you" : "A change is waiting for you",
        Subject(fileName, "has") +
            (pending > 1
                ? $" {pending} proposed changes. Nothing is applied until you review and accept them."
                : " a proposed change. Nothing is applied until you review and accept it."),
        "Review changes",
        RouteAgent);

    internal static DesktopNotification ApprovalNeeded(
        string? fileName,
        bool createsRecords,
        bool updatesRecords,
        bool deletesRecords) => new(
        TagApproval,
        "Nendo needs your approval",
        Subject(fileName, "has automatic actions that can") + $" {Capabilities(createsRecords, updatesRecords, deletesRecords)}. " +
            "Editing stays off until you approve them on this device.",
        "Open approval",
        RouteHealth);

    internal static DesktopNotification FileUnwritable(string? fileName, string health) => new(
        TagUnwritable,
        "This file can no longer be edited",
        Subject(fileName, "is now") + $" {HealthPhrase(health)}. Your data is still there and still readable.",
        "Open file health",
        RouteHealth);

    internal static DesktopNotification RendererFailed(string? fileName) => new(
        TagRenderer,
        "Nendo needs attention",
        Subject(fileName, "is open, but its workspace stopped responding") +
            ". Recovery is waiting in the window; your data is unaffected.",
        "Open Nendo",
        RouteOpen);

    /// <summary>
    /// The toast payload. Built here rather than through the notification builder so
    /// the exact document is assertable, and so the routing argument is the only
    /// thing that ever leaves this file.
    /// </summary>
    internal static string ToXml(DesktopNotification notification)
    {
        var launch = $"route={notification.Route}";
        var builder = new StringBuilder();
        builder.Append("<toast launch=\"").Append(Escape(launch)).Append("\" activationType=\"foreground\">");
        builder.Append("<visual><binding template=\"ToastGeneric\">");
        builder.Append("<text>").Append(Escape(notification.Title)).Append("</text>");
        builder.Append("<text>").Append(Escape(notification.Body)).Append("</text>");
        builder.Append("</binding></visual>");
        if (notification.ButtonLabel is { } label)
        {
            builder.Append("<actions><action content=\"").Append(Escape(label))
                .Append("\" arguments=\"").Append(Escape(launch))
                .Append("\" activationType=\"foreground\"/></actions>");
        }
        builder.Append("</toast>");
        return builder.ToString();
    }

    /// <summary>The view a click should land on, or null when the argument is not one of ours.</summary>
    internal static string? RouteFrom(string? arguments)
    {
        if (string.IsNullOrEmpty(arguments)) return null;
        foreach (var part in arguments.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            if (!part.StartsWith("route=", StringComparison.Ordinal)) continue;
            var route = part["route=".Length..];
            if (route is RouteOpen or RouteAgent or RouteHealth) return route;
        }
        return null;
    }

    /// <summary>
    /// Names the file where there is one. A notification about "the open file" when
    /// two windows are open answers nothing, and the name is already on the taskbar
    /// and in the window title — this adds no reach it did not have.
    /// </summary>
    private static string Subject(string? fileName, string predicate) =>
        fileName is null ? $"Your file {predicate}" : $"{fileName} {predicate}";

    private static string Capabilities(bool createsRecords, bool updatesRecords, bool deletesRecords)
    {
        var parts = new List<string>(3);
        if (createsRecords) parts.Add("create");
        if (updatesRecords) parts.Add("update");
        if (deletesRecords) parts.Add("delete");
        if (parts.Count == 0) return "change records";
        var verbs = parts.Count == 1
            ? parts[0]
            : $"{string.Join(", ", parts.Take(parts.Count - 1))} and {parts[^1]}";
        return $"{verbs} records";
    }

    private static string HealthPhrase(string health) => health switch
    {
        "readOnly" => "read-only",
        "recoveryRequired" => "in recovery",
        "rejected" => "refused by this host",
        _ => "no longer writable",
    };

    private static string Escape(string value) => value
        .Replace("&", "&amp;", StringComparison.Ordinal)
        .Replace("<", "&lt;", StringComparison.Ordinal)
        .Replace(">", "&gt;", StringComparison.Ordinal)
        .Replace("\"", "&quot;", StringComparison.Ordinal)
        .Replace("'", "&apos;", StringComparison.Ordinal);
}
