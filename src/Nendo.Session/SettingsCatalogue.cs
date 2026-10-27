namespace Nendo.Session;

/// <summary>One value a choice setting offers, and the words the Settings page shows for it.</summary>
internal sealed record SettingOption(string Value, string Label);

/// <summary>
/// One setting of Nendo (ADR-0038): where the Settings page shows it, the one home it has, the
/// control that changes it and the store that keeps it.
/// <para>
/// <c>Home</c> is <c>device</c> (this computer), <c>here</c> (this file, kept on this computer) or
/// <c>file</c> (in the file's definition). <c>Kind</c> is <c>toggle</c>, <c>choice</c>, <c>number</c>
/// or <c>text</c>, which the page changes in its row, <c>icons</c>, which it draws as one row for each
/// record type and screen, or <c>link</c> and <c>action</c>, which open
/// the page that owns the setting or run its one command. <c>Store</c> names the ADR-0034 document,
/// the page storage key or the definition that keeps the value; the catalogue keeps nothing itself.
/// </para>
/// </summary>
internal sealed record SettingDescriptor(
    string Id,
    string Section,
    string Group,
    string Title,
    string? Help,
    string Home,
    string Kind,
    string Store,
    IReadOnlyList<SettingOption>? Options = null,
    int? Minimum = null,
    int? Maximum = null,
    string? Unit = null,
    bool WindowsOnly = false,
    bool NeedsFile = false);

/// <summary>
/// A setting as this host offers it now. <c>Value</c> is filled only for a setting that has no
/// other read on the bridge (what Close does, Record failures); the page reads the others where
/// it always has. <c>Override</c> names the environment variable that fixes the value, when one
/// does, and the row is then read-only.
/// </summary>
internal sealed record SettingView(SettingDescriptor Setting, object? Value, string? Override);

internal sealed record SettingsView(IReadOnlyList<SettingView> Settings);

/// <summary>
/// Every setting of Nendo, in the order the Settings page shows them (ADR-0038). It names and
/// routes; each value stays in the store ADR-0034 gives it, and the controls that existed before
/// the page change the same value through the same bridge methods.
/// </summary>
internal static class SettingsCatalogue
{
    internal const string Device = "device";
    internal const string Here = "here";
    internal const string InTheFile = "file";

    internal const string CloseToTray = "window.closeToTray";
    internal const string RecordFailures = "diagnostics.recordFailures";

    // The connection store's own bounds; it lives with the agents in the Windows host, so a test there
    // holds these equal to it.
    internal const int MinimumLeaseSeconds = 15;
    internal const int MaximumLeaseSeconds = 86400;

    internal static readonly IReadOnlyList<SettingDescriptor> All =
    [
        new("appearance.theme", "general", "Appearance", "Theme", "System follows Windows.", Device, "choice",
            @"window\appearance.json", [new("system", "System"), new("light", "Light"), new("dark", "Dark")]),
        new("appearance.shortcutHints", "general", "Appearance", "Show shortcut hints",
            "Key names beside the commands that have them. Ctrl / switches them too.", Device, "toggle", "page storage: nendo.shortcuts"),
        new(CloseToTray, "general", "Window", "Close keeps Nendo in the notification area",
            "Agents stay connected while the window is closed. Off: Close ends Nendo.", Device, "toggle",
            @"window\tray.json", WindowsOnly: true),
        new("media.webPictures", "general", "Pictures", "Load pictures from the web",
            "A picture field that links to an address shows the picture from there.", Device, "toggle", "page storage: nendo.media.webPictures"),
        new(RecordFailures, "general", "Diagnostics", "Record failures",
            "Keeps the last 50 times a view stopped or an agent request failed inside Nendo, on this computer.", Device, "toggle",
            @"window\tray.json", WindowsOnly: true),

        new("agents.access", "agents", "This file", "Agent access", "What an agent connected to this file may do.", Here, "choice",
            @"agents\access.json",
            [new("off", "Off"), new("inspect", "Inspect"), new("editData", "Edit data"), new("shapeApp", "Shape app"), new("unattended", "Unattended")],
            WindowsOnly: true, NeedsFile: true),
        new("agents.port", "agents", "This file", "Port for this file", "Used while each file keeps its port.", Here, "number",
            @"agents\ports.json", Minimum: 1024, Maximum: 65535, WindowsOnly: true, NeedsFile: true),
        new("agents.startInRepository", "agents", "This file", "Start agents in the file's repository",
            "Off: a launched agent starts in an empty folder of its own.", Here, "toggle", @"agents\launch.json", WindowsOnly: true, NeedsFile: true),
        new("agents.fixedPort", "agents", "Connection", "Each file keeps its port",
            "Off: a free port each time agent access starts.", Device, "toggle", @"agents\connection.json", WindowsOnly: true),
        new("agents.leaseExpiry", "agents", "Connection", "End an idle edit lease",
            "An agent that stops writing gives up editing after the time below.", Device, "toggle", @"agents\connection.json", WindowsOnly: true),
        new("agents.leaseExpirySeconds", "agents", "Connection", "Idle time before a lease ends", null, Device, "number",
            @"agents\connection.json", Minimum: MinimumLeaseSeconds, Maximum: MaximumLeaseSeconds,
            Unit: "seconds", WindowsOnly: true),
        new("agents.viewMessages", "agents", "Launching", "Views may message the agent",
            "Ask shows a card the first time a view sends a message in a conversation.", Device, "choice", @"agents\launch.json",
            [new("never", "Never"), new("ask", "Ask"), new("always", "Always")], WindowsOnly: true),
        new("agents.options", "agents", "Launching", "Each agent's settings",
            "Model, mode and the other options an agent offers, kept from its last launch. Set them on the Agent page while it runs.",
            Device, "link", @"agents\settings.json", WindowsOnly: true),

        new("views.run", "views", "Run", "Run custom views",
            "Off: every file opens without its views. Studio and your data stay.", Device, "toggle", @"views\settings.json"),
        new("views.runThisFile", "views", "Run", "Run this file's views", null, Here, "toggle", @"views\settings.json", NeedsFile: true),
        new("views.developmentLinks", "views", "Development", "Development links",
            "Run a package from a folder instead of the copy in the file. Set in Studio, on Custom views.", Here, "link",
            @"views\settings.json", WindowsOnly: true, NeedsFile: true),

        new("file.look", "file", "Identity", "Look",
            "The icon on the taskbar, in Alt+Tab and on notifications.", InTheFile, "link", "definition: application.setLook", NeedsFile: true),
        new("file.purpose", "file", "Identity", "Purpose", "What the file is for, in a sentence agents and Help read first.",
            InTheFile, "text", "definition: application.setPurpose", Maximum: 4000, NeedsFile: true),
        new("file.newFileLabel", "file", "Identity", "Name for a new file", "What File → New calls one more file of this application.",
            InTheFile, "text", "definition: application.setNewFileLabel", Maximum: 40, NeedsFile: true),
        new("file.icons", "file", "Icons", "Icons",
            "The icon of each record type and screen in the navigation. Right-click one there to change it too.",
            InTheFile, "icons", "definition: schema.setEntityIcon and a screen's icon", NeedsFile: true),
        new("file.automaticActions", "file", "Automatic actions", "Automatic actions",
            "Whether this file's automatic actions may run on this computer. A copy you send asks again.", Here, "action",
            @"actions\consent.json", NeedsFile: true),
    ];

    /// <summary>The environment variable that fixes a setting for this process, when one does.</summary>
    internal static string? Override(string id, Func<string, string?> read) => id switch
    {
        CloseToTray when !string.IsNullOrWhiteSpace(read("NENDO_DESKTOP_CLOSE_ACTION")) => "NENDO_DESKTOP_CLOSE_ACTION",
        _ => null,
    };

    /// <summary>The settings a host offers, each with the value only the host can read.</summary>
    internal static SettingsView Describe(bool windows, Func<string, object?> hostValue, Func<string, string?> read) =>
        new(All.Where(setting => windows || !setting.WindowsOnly)
            .Select(setting => new SettingView(setting, hostValue(setting.Id), Override(setting.Id, read)))
            .ToList());
}
