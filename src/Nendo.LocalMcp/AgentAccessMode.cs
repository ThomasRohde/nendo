namespace Nendo.LocalMcp;

/// <summary>
/// The owner-selected capability exposed to local agents for the current file session.
/// </summary>
/// <remarks>
/// The order is load-bearing: authority is checked with <c>&lt;</c>, so each member
/// includes every capability before it. Append a new level; never insert one.
/// </remarks>
public enum AgentAccessMode
{
    Disabled,
    ReadOnly,
    DataMutation,
    ApplicationAuthoring,

    /// <summary>
    /// The agent accepts its own validated proposals, and the host grants the open
    /// file's automatic-action consent on its behalf (ADR-0009, 2026-09-22 amendment).
    /// <para>
    /// This is the level at which a shape change and an action can reach the active file
    /// with nobody having read either. It exists because building a new file to order is
    /// the one situation where the review it removes was not protecting anything. It is
    /// never the default. Like every level it is remembered for the file it was chosen for
    /// (2026-09-29 amendment); another instance and a read-only or recovery open begin Disabled.
    /// </para>
    /// </summary>
    Unattended,
}

/// <summary>
/// The names a person sees for each level, and the refusal an agent gets below one. One
/// table, so the instructions, the tool boundary and the lease service cannot name a level
/// differently from the Agent page that sets it. The Desktop reads it for the tray menu,
/// the tray tooltip and notifications.
/// </summary>
public static class NendoAccessLevels
{
    public static string DisplayName(AgentAccessMode mode) => mode switch
    {
        AgentAccessMode.Disabled => "Off",
        AgentAccessMode.ReadOnly => "Inspect",
        AgentAccessMode.DataMutation => "Edit data",
        AgentAccessMode.ApplicationAuthoring => "Shape app",
        AgentAccessMode.Unattended => "Unattended",
        _ => throw new ArgumentOutOfRangeException(nameof(mode)),
    };

    /// <summary>The code for a request that needs <paramref name="required"/>, without the NENDO_ prefix.</summary>
    internal static string RequiredCode(AgentAccessMode required) => required switch
    {
        AgentAccessMode.Unattended => "UNATTENDED_REQUIRED",
        AgentAccessMode.ApplicationAuthoring => "SHAPE_APP_REQUIRED",
        _ => "EDIT_DATA_REQUIRED",
    };

    /// <summary>What the agent can do about it: the person raises the level, on the Agent page.</summary>
    internal static string RequiredMessage(AgentAccessMode required) =>
        $"{DisplayName(required)} access is required. Ask the person to raise agent access to " +
        $"{DisplayName(required)} on the Agent page in Nendo.";
}
