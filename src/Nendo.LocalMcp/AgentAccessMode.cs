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
    /// never the default and never persisted: every file session begins Disabled.
    /// </para>
    /// </summary>
    Unattended,
}
