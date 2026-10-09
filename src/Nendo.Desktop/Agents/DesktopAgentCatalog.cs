using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// A program the Agent page can launch: what it is called, and the command that starts it as an
/// ACP agent on stdio (ADR-0030). <c>ResolvedPath</c> is where it was found on this computer, or
/// null when it was not. <c>Package</c> is the npm package that provides it, null for the
/// person's own command; <c>RenamedFrom</c> is the package it was found to come from when that
/// one was renamed to <c>Package</c> and no longer gets updates.
/// </summary>
internal sealed record DesktopAgentCommand(
    string Id,
    string Name,
    string Program,
    IReadOnlyList<string> Arguments,
    string? ResolvedPath,
    string? Package = null,
    string? RenamedFrom = null)
{
    /// <summary>The command as a person would type it.</summary>
    internal string CommandLine =>
        string.Join(' ', new[] { Program }.Concat(Arguments).Select(DesktopAgentCatalog.Quote));

    /// <summary>What installs it, for a person to run in a terminal. Nendo never runs it.</summary>
    internal string? InstallCommand => Package is null ? null : $"npm install -g {Package}";

    /// <summary>
    /// What moves it to the package that is still updated, one command a line. The old package
    /// goes first: npm refuses to put a second package's command where the first one's is.
    /// </summary>
    internal string? UpdateCommand => RenamedFrom is null ? null : $"npm uninstall -g {RenamedFrom}\nnpm install -g {Package}";

    /// <summary>
    /// How Windows starts it. A batch file, which is how npm installs a command, runs under the
    /// command interpreter; anything else runs directly.
    /// </summary>
    internal ProcessStartInfo StartInfo()
    {
        var path = ResolvedPath ?? throw new NendoPreconditionException(
            "agent-not-found", $"{Name} is not installed on this computer: {Program} was not found.");
        var extension = Path.GetExtension(path);
        if (extension.Equals(".cmd", StringComparison.OrdinalIgnoreCase) || extension.Equals(".bat", StringComparison.OrdinalIgnoreCase))
        {
            var shell = Environment.GetEnvironmentVariable("ComSpec") is { Length: > 0 } comSpec
                ? comSpec
                : Path.Combine(Environment.SystemDirectory, "cmd.exe");
            // /s takes the outer quotes off what follows /c, and nothing else, so a path with a
            // space stays one word.
            var line = string.Join(' ', new[] { path }.Concat(Arguments).Select(DesktopAgentCatalog.Quote));
            return new ProcessStartInfo(shell) { Arguments = $"/d /s /c \"{line}\"" };
        }
        var start = new ProcessStartInfo(path);
        foreach (var argument in Arguments) start.ArgumentList.Add(argument);
        return start;
    }
}

/// <summary>
/// The agents Nendo knows how to start, and the one command line a person may add (ADR-0030).
/// <para>
/// Nendo looks for each on this computer's <c>PATH</c>, as a terminal would. It never
/// downloads, installs or updates one, and it reads no registry over the network. It names the
/// npm package that provides each, so the page can say what to install, and it reads the npm
/// shim it found to tell when that came from a package that was renamed and left behind: the
/// old name keeps its last version for good, and an agent that falls behind its own settings
/// refuses to start (2026-10-08: the old Claude adapter did not know <c>defaultMode: auto</c>).
/// </para>
/// </summary>
internal static class DesktopAgentCatalog
{
    internal const string CustomId = "custom";
    internal const int MaximumCommandLineLength = 1000;
    private const int MaximumShimBytes = 16 * 1024;

    private static readonly (string Id, string Name, string Program, string[] Arguments, string Package, string[] Renamed)[] Known =
    [
        ("copilot", "GitHub Copilot CLI", "copilot", ["--acp"], "@github/copilot", []),
        ("gemini", "Gemini CLI", "gemini", ["--experimental-acp"], "@google/gemini-cli", []),
        ("claude", "Claude Code", "claude-agent-acp", [], "@agentclientprotocol/claude-agent-acp", ["@zed-industries/claude-agent-acp"]),
        ("codex", "Codex", "codex-acp", [], "@agentclientprotocol/codex-acp", ["@zed-industries/codex-acp"]),
        ("opencode", "OpenCode", "opencode", ["acp"], "opencode-ai", []),
    ];

    private static readonly string[] RunnableExtensions = [".exe", ".cmd", ".bat", ".com"];

    /// <summary>Whether a person may hide <paramref name="agentId"/>: a known agent, or their own command.</summary>
    internal static bool CanHide(string agentId) =>
        agentId == CustomId || Known.Any(agent => string.Equals(agent.Id, agentId, StringComparison.Ordinal));

    /// <summary>Every known agent, found or not, and the person's own command when there is one.</summary>
    internal static IReadOnlyList<DesktopAgentCommand> List(string? customCommandLine, string? pathVariable = null)
    {
        var path = pathVariable ?? Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        var agents = Known
            .Select(agent =>
            {
                var resolved = Resolve(agent.Program, path);
                return new DesktopAgentCommand(agent.Id, agent.Name, agent.Program, agent.Arguments, resolved,
                    agent.Package, RenamedFrom(resolved, agent.Renamed));
            })
            .ToList();
        if (Custom(customCommandLine, path) is { } custom) agents.Add(custom);
        return agents;
    }

    /// <summary>
    /// Which of <paramref name="renamed"/> the npm shim at <paramref name="resolvedPath"/> starts,
    /// or null. npm writes each global command as a small batch file that names its package's
    /// script under <c>node_modules</c>; anything else, or a file too large to be one, is not read.
    /// </summary>
    internal static string? RenamedFrom(string? resolvedPath, IReadOnlyList<string> renamed)
    {
        if (resolvedPath is null || renamed.Count == 0 ||
            !Path.GetExtension(resolvedPath).Equals(".cmd", StringComparison.OrdinalIgnoreCase)) return null;
        string shim;
        try
        {
            var file = new FileInfo(resolvedPath);
            if (!file.Exists || file.Length > MaximumShimBytes) return null;
            shim = File.ReadAllText(resolvedPath).Replace('/', '\\');
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return null;
        }
        return renamed.FirstOrDefault(package =>
            shim.Contains($"node_modules\\{package.Replace('/', '\\')}\\", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The person's own command line as a launchable command, or null when there is none.</summary>
    internal static DesktopAgentCommand? Custom(string? commandLine, string? pathVariable = null)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return null;
        var words = Split(commandLine);
        if (words.Count == 0) return null;
        return new DesktopAgentCommand(CustomId, "Your command", words[0], words.Skip(1).ToArray(),
            Resolve(words[0], pathVariable ?? Environment.GetEnvironmentVariable("PATH") ?? string.Empty));
    }

    /// <summary>
    /// Where <paramref name="program"/> is: itself when it names a file, otherwise the first
    /// runnable match on <paramref name="pathVariable"/>. Null when there is none.
    /// </summary>
    internal static string? Resolve(string program, string pathVariable)
    {
        if (string.IsNullOrWhiteSpace(program) || program.IndexOfAny(Path.GetInvalidPathChars()) >= 0) return null;
        if (program.Contains('\\') || program.Contains('/') || Path.IsPathRooted(program))
            return Runnable(Path.GetFullPath(program));
        foreach (var folder in pathVariable.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string candidate;
            try { candidate = Path.Combine(folder.Trim('"'), program); }
            catch (ArgumentException) { continue; }
            if (Runnable(candidate) is { } found) return found;
        }
        return null;
    }

    private static string? Runnable(string candidate)
    {
        if (RunnableExtensions.Any(extension => candidate.EndsWith(extension, StringComparison.OrdinalIgnoreCase)))
            return File.Exists(candidate) ? candidate : null;
        foreach (var extension in RunnableExtensions)
        {
            if (File.Exists(candidate + extension)) return candidate + extension;
        }
        return null;
    }

    /// <summary>A command line split into words: spaces separate, double quotes group.</summary>
    internal static IReadOnlyList<string> Split(string commandLine)
    {
        var words = new List<string>();
        var word = new StringBuilder();
        var quoted = false;
        var any = false;
        foreach (var character in commandLine)
        {
            if (character == '"') { quoted = !quoted; any = true; continue; }
            if (char.IsWhiteSpace(character) && !quoted)
            {
                if (any) words.Add(word.ToString());
                word.Clear();
                any = false;
                continue;
            }
            word.Append(character);
            any = true;
        }
        if (any) words.Add(word.ToString());
        return words;
    }

    internal static string Quote(string word) =>
        word.Length > 0 && !word.Any(character => char.IsWhiteSpace(character) || character is '"' or '&' or '|' or '<' or '>' or '^')
            ? word
            : $"\"{word.Replace("\"", "\\\"", StringComparison.Ordinal)}\"";
}

/// <summary>
/// What a person chose about Launch on the Agent page, kept for this device only, never in a
/// file (ADR-0030): the one command line they added, and the agents they hid. A computer at
/// work may have only one agent its owner uses; the others' rows are noise there (W-199).
/// </summary>
internal sealed class DesktopAgentLaunchStore(string root)
{
    private const int MaximumBytes = 4096;
    private readonly string _root = Path.GetFullPath(root);
    private string StatePath => Path.Combine(_root, "agent-launch.json");

    internal string? CommandLine => Load().CommandLine;

    /// <summary>The agents this person hid, by ID, in the order they hid them.</summary>
    internal IReadOnlyList<string> Hidden => Load().Hidden;

    /// <summary>Keep <paramref name="commandLine"/>, or forget the command with an empty one.</summary>
    internal void Save(string? commandLine)
    {
        var line = commandLine?.Trim();
        if (line is { Length: > DesktopAgentCatalog.MaximumCommandLineLength })
            throw new NendoValidationException($"A command is at most {DesktopAgentCatalog.MaximumCommandLineLength} characters.");
        Write(Load() with { CommandLine = string.IsNullOrEmpty(line) ? null : line });
    }

    /// <summary>Hide <paramref name="agentId"/> from Launch, or show it again.</summary>
    internal void SetHidden(string agentId, bool hidden)
    {
        if (!DesktopAgentCatalog.CanHide(agentId))
            throw new NendoValidationException("Choose one of the agents the Agent page offers.");
        var current = Load();
        var next = current.Hidden.Where(id => !string.Equals(id, agentId, StringComparison.Ordinal)).ToList();
        if (hidden) next.Add(agentId);
        Write(current with { Hidden = next });
    }

    private Choices Load()
    {
        try
        {
            var document = DesktopStateFile.Read<StoredLaunch>(StatePath, MaximumBytes, 4);
            if (document?.Version != 1) return Choices.None;
            var line = document.CommandLine is { Length: > 0 and <= DesktopAgentCatalog.MaximumCommandLineLength } kept ? kept : null;
            // An ID this build does not know is dropped rather than trusted: the file is this
            // device's, but an older or newer Nendo may have written it.
            var hidden = (document.Hidden ?? []).Where(DesktopAgentCatalog.CanHide).Distinct(StringComparer.Ordinal).ToList();
            return new Choices(line, hidden);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return Choices.None;
        }
    }

    private void Write(Choices choices)
    {
        if (choices.CommandLine is null && choices.Hidden.Count == 0)
        {
            try { File.Delete(StatePath); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            return;
        }
        using var guard = DesktopDeviceStateLock.EnterRequired(StatePath);
        DesktopStateFile.Replace(_root, StatePath, "agent-launch",
            stream => JsonSerializer.Serialize(stream, new StoredLaunch(1, choices.CommandLine, choices.Hidden.Count == 0 ? null : [.. choices.Hidden])));
    }

    private sealed record Choices(string? CommandLine, IReadOnlyList<string> Hidden)
    {
        internal static readonly Choices None = new(null, []);
    }

    private sealed record StoredLaunch(int Version, string? CommandLine, string[]? Hidden = null);
}
