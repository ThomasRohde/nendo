using Nendo.Engine;

namespace Nendo.Desktop;

internal enum DesktopStartupMode
{
    Create,

    /// <summary>
    /// Explorer's <em>New</em> menu chose the name. Separate from <see cref="Create"/>
    /// because the shell may already have left an empty file at that path, and refusing
    /// it would mean the menu entry never worked; a lane that asked for a create still
    /// wants an existing file to be an error.
    /// </summary>
    CreateFromShell,

    Open,
}

internal sealed record DesktopStartupRequest(DesktopStartupMode Mode, string Path)
{
    /// <summary>
    /// What this launch was asked to open: an environment variable, or a file the
    /// person double-clicked.
    /// </summary>
    /// <remarks>
    /// The environment wins. It is how the test lanes drive a specific file, and a
    /// lane that also happened to be handed an argument would otherwise open
    /// whichever the order of these two calls decided.
    /// </remarks>
    internal static DesktopStartupRequest? FromStartup()
    {
        return FromEnvironment() ?? FromCommandLine();
    }

    /// <summary>
    /// What Windows Explorer passed: a file to open, or a file to make.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A double-click or Open with hands the path as the first argument, so there is
    /// no switch to parse; anything that looks like one is skipped rather than opened,
    /// because a path is what this accepts and a flag is not a file.
    /// </para>
    /// <para>
    /// The one exception is <c>-new</c>, which is what the Explorer <em>New</em> menu
    /// sends. A ShellNew entry can copy a template file or run a command, and this is
    /// the command: Explorer picks the name, Nendo makes the file. Shipping a template
    /// would mean shipping a second answer to what an empty file is, which would then
    /// have to be kept in step with the one <em>New file</em> already produces.
    /// </para>
    /// <para>
    /// A path the framework cannot resolve opens no file rather than failing the
    /// launch: a window with no file is recoverable and a process that exits before
    /// drawing one is not.
    /// </para>
    /// </remarks>
    internal static DesktopStartupRequest? FromCommandLine() =>
        FromArguments(Environment.GetCommandLineArgs());

    internal static DesktopStartupRequest? FromArguments(IReadOnlyList<string> arguments)
    {
        var mode = DesktopStartupMode.Open;
        for (var index = 1; index < arguments.Count; index++)
        {
            var candidate = arguments[index];
            if (string.IsNullOrWhiteSpace(candidate))
            {
                continue;
            }
            if (candidate[0] == '-' || candidate[0] == '/')
            {
                // Only the last switch before the path counts, so "-new -new x" and a
                // stray flag after one both behave the way the text reads.
                mode = string.Equals(candidate[1..], "new", StringComparison.OrdinalIgnoreCase)
                    ? DesktopStartupMode.CreateFromShell
                    : DesktopStartupMode.Open;
                continue;
            }
            try
            {
                return new DesktopStartupRequest(mode, System.IO.Path.GetFullPath(candidate));
            }
            catch (ArgumentException)
            {
                return null;
            }
            catch (System.IO.PathTooLongException)
            {
                return null;
            }
            catch (NotSupportedException)
            {
                return null;
            }
        }
        return null;
    }

    internal static DesktopStartupRequest? FromEnvironment()
    {
        var create = Environment.GetEnvironmentVariable("NENDO_STARTUP_CREATE");
        var open = Environment.GetEnvironmentVariable("NENDO_STARTUP_OPEN");
        if (!string.IsNullOrWhiteSpace(create) && !string.IsNullOrWhiteSpace(open))
        {
            throw new NendoValidationException(
                "NENDO_STARTUP_CREATE and NENDO_STARTUP_OPEN cannot be used together.");
        }
        if (!string.IsNullOrWhiteSpace(create))
        {
            return new DesktopStartupRequest(DesktopStartupMode.Create, System.IO.Path.GetFullPath(create));
        }
        return string.IsNullOrWhiteSpace(open)
            ? null
            : new DesktopStartupRequest(DesktopStartupMode.Open, System.IO.Path.GetFullPath(open));
    }
}
