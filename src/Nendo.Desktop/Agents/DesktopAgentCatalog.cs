using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// A program the Agent page can launch: what it is called, and the command that starts it as an
/// ACP agent on stdio (ADR-0030). <c>ResolvedPath</c> is where it was found on this computer, or
/// null when it was not.
/// </summary>
internal sealed record DesktopAgentCommand(
    string Id,
    string Name,
    string Program,
    IReadOnlyList<string> Arguments,
    string? ResolvedPath)
{
    /// <summary>The command as a person would type it.</summary>
    internal string CommandLine =>
        string.Join(' ', new[] { Program }.Concat(Arguments).Select(DesktopAgentCatalog.Quote));

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
/// downloads, installs or updates one, and it reads no registry over the network.
/// </para>
/// </summary>
internal static class DesktopAgentCatalog
{
    internal const string CustomId = "custom";
    internal const int MaximumCommandLineLength = 1000;

    private static readonly (string Id, string Name, string Program, string[] Arguments)[] Known =
    [
        ("copilot", "GitHub Copilot CLI", "copilot", ["--acp"]),
        ("gemini", "Gemini CLI", "gemini", ["--experimental-acp"]),
        ("claude", "Claude Code", "claude-agent-acp", []),
        ("codex", "Codex", "codex-acp", []),
        ("opencode", "OpenCode", "opencode", ["acp"]),
    ];

    private static readonly string[] RunnableExtensions = [".exe", ".cmd", ".bat", ".com"];

    /// <summary>Every known agent, found or not, and the person's own command when there is one.</summary>
    internal static IReadOnlyList<DesktopAgentCommand> List(string? customCommandLine, string? pathVariable = null)
    {
        var path = pathVariable ?? Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        var agents = Known
            .Select(agent => new DesktopAgentCommand(agent.Id, agent.Name, agent.Program, agent.Arguments, Resolve(agent.Program, path)))
            .ToList();
        if (Custom(customCommandLine, path) is { } custom) agents.Add(custom);
        return agents;
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
/// The one command line a person added on the Agent page, kept for this device only, never in
/// a file (ADR-0030).
/// </summary>
internal sealed class DesktopAgentLaunchStore(string root)
{
    private const int MaximumBytes = 4096;
    private readonly string _root = Path.GetFullPath(root);
    private string StatePath => Path.Combine(_root, "agent-launch.json");

    internal string? CommandLine
    {
        get
        {
            try
            {
                var document = DesktopStateFile.Read<StoredLaunch>(StatePath, MaximumBytes, 4);
                return document?.Version == 1 && document.CommandLine is { Length: > 0 and <= DesktopAgentCatalog.MaximumCommandLineLength } line
                    ? line : null;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                return null;
            }
        }
    }

    /// <summary>Keep <paramref name="commandLine"/>, or forget the command with an empty one.</summary>
    internal void Save(string? commandLine)
    {
        var line = commandLine?.Trim();
        if (line is { Length: > DesktopAgentCatalog.MaximumCommandLineLength })
            throw new NendoValidationException($"A command is at most {DesktopAgentCatalog.MaximumCommandLineLength} characters.");
        if (string.IsNullOrEmpty(line))
        {
            try { File.Delete(StatePath); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            return;
        }
        using var guard = DesktopDeviceStateLock.EnterRequired(StatePath);
        DesktopStateFile.Replace(_root, StatePath, "agent-launch",
            stream => JsonSerializer.Serialize(stream, new StoredLaunch(1, line)));
    }

    private sealed record StoredLaunch(int Version, string? CommandLine);
}
