using System.Collections;
using System.Security;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Nendo.Desktop;

/// <summary>A variable as the registry keeps it: its text, and whether it names others to expand (REG_EXPAND_SZ).</summary>
internal readonly record struct EnvironmentValue(string Value, bool Expandable = false);

/// <summary>
/// The person's environment as Windows holds it now, for finding and starting a launched agent
/// (ADR-0030). A process's environment is a copy taken when it started, and Nendo stays in the
/// tray across windows, so a program installed since then (Node.js adds its folders to
/// <c>PATH</c>) stayed "not installed" and a variable set since (an API key) never reached the
/// agent (DAE-12).
/// <para>
/// This reads the machine's and the person's variables from the registry each time and lays them
/// over this process's own, much as Windows builds a new sign-in's environment. Two things are
/// not taken from the registry. This process's identity and per-sign-in variables (its user
/// name, domain, profile and home folders, logon server) stay its own: the machine's key names
/// <c>USERNAME=SYSTEM</c>, which every agent was given. And an expandable value is expanded
/// against the environment being built, not this process's old copy, so a variable set since
/// reaches a <c>PATH</c> folder that names it.
/// </para>
/// </summary>
internal static partial class AgentEnvironment
{
    private const string MachineKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
    private const string UserKey = "Environment";
    internal const string PathName = "Path";

    /// <summary>This process's identity and per-sign-in variables, which the registry's keys never replace.</summary>
    internal static readonly string[] OwnIdentity =
        ["USERNAME", "USERDOMAIN", "USERDOMAIN_ROAMINGPROFILE", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "LOGONSERVER"];

    /// <summary>This process's variables, then the machine's and the person's from the registry over them.</summary>
    internal static IReadOnlyDictionary<string, string> Read() =>
        Merge(ProcessVariables(), RegistryVariables(Registry.LocalMachine, MachineKey), RegistryVariables(Registry.CurrentUser, UserKey));

    /// <summary>
    /// <paramref name="process"/> with <paramref name="machine"/> and then <paramref name="user"/>
    /// over it, this process's identity put back, and every expandable value expanded against the
    /// result. <c>PATH</c> is the machine's folders, then the person's, and then any folder only
    /// this process had, each once.
    /// </summary>
    internal static IReadOnlyDictionary<string, string> Merge(
        IReadOnlyDictionary<string, string> process,
        IReadOnlyDictionary<string, EnvironmentValue> machine,
        IReadOnlyDictionary<string, EnvironmentValue> user)
    {
        var merged = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var expandable = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in process) merged[name] = value;
        foreach (var layer in new[] { machine, user })
        {
            foreach (var (name, value) in layer)
            {
                merged[name] = value.Value;
                if (value.Expandable) expandable.Add(name); else expandable.Remove(name);
            }
        }
        foreach (var name in OwnIdentity)
        {
            if (Find(process, name) is { } own) { merged[name] = own; expandable.Remove(name); }
        }
        // Twice, so a value that names another expandable value meets it expanded.
        for (var pass = 0; pass < 2; pass++)
            foreach (var name in expandable) merged[name] = Expand(merged[name], merged);

        var folders = new List<string>();
        void Add(string? path)
        {
            foreach (var folder in (path ?? string.Empty).Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                if (!folders.Contains(folder, StringComparer.OrdinalIgnoreCase)) folders.Add(folder);
        }
        Add(Find(machine, PathName) is { } machinePath ? Expand(machinePath, merged) : null);
        Add(Find(user, PathName) is { } userPath ? Expand(userPath, merged) : null);
        Add(Find(process, PathName));
        merged[PathName] = string.Join(';', folders);
        return merged;
    }

    /// <summary>The <c>PATH</c> of an environment, empty when it has none.</summary>
    internal static string PathOf(IReadOnlyDictionary<string, string> environment) => Find(environment, PathName) ?? string.Empty;

    /// <summary><c>%NAME%</c> replaced by the variable's value where there is one, and left as it is where there is not.</summary>
    internal static string Expand(string text, IReadOnlyDictionary<string, string> variables) =>
        Reference().Replace(text, match => Find(variables, match.Groups[1].Value) ?? match.Value);

    [GeneratedRegex("%([^%;]+)%", RegexOptions.CultureInvariant)]
    private static partial Regex Reference();

    private static string? Find(IReadOnlyDictionary<string, string> from, string name)
    {
        if (from.TryGetValue(name, out var exact)) return exact;
        foreach (var (key, value) in from)
            if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) return value;
        return null;
    }

    private static string? Find(IReadOnlyDictionary<string, EnvironmentValue> from, string name)
    {
        if (from.TryGetValue(name, out var exact)) return exact.Value;
        foreach (var (key, value) in from)
            if (string.Equals(key, name, StringComparison.OrdinalIgnoreCase)) return value.Value;
        return null;
    }

    private static Dictionary<string, string> ProcessVariables()
    {
        var variables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables())
            if (entry.Key is string name && entry.Value is string value) variables[name] = value;
        return variables;
    }

    private static Dictionary<string, EnvironmentValue> RegistryVariables(RegistryKey hive, string path)
    {
        var variables = new Dictionary<string, EnvironmentValue>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var key = hive.OpenSubKey(path);
            if (key is null) return variables;
            foreach (var name in key.GetValueNames())
            {
                // Read as written: expanding here would use this process's old variables.
                if (name.Length > 0 && key.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is string value)
                    variables[name] = new EnvironmentValue(value, key.GetValueKind(name) == RegistryValueKind.ExpandString);
            }
        }
        catch (Exception exception) when (exception is SecurityException or IOException or UnauthorizedAccessException)
        {
            // Unreadable: this process's own variables stand.
        }
        return variables;
    }
}
