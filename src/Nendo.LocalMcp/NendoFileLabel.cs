namespace Nendo.LocalMcp;

/// <summary>
/// The open file's name, as the agent surface says it.
/// <para>
/// With two Nendo windows open, an agent registered with both could not tell from anything
/// it read first which file a server was: the title said "Nendo", the instructions said "a
/// Nendo file", and the grant named no file at all. Only the discovery document carried the
/// name. These are the places a client shows before its first call, so they carry it too.
/// </para>
/// <para>
/// A name and never a location: anything carrying a directory is cut to its last segment,
/// the same rule the discovery entry follows. And a bounded one, because the instructions
/// are held under a client's cut and a file name can be 255 characters long.
/// </para>
/// </summary>
internal static class NendoFileLabel
{
    /// <summary>The longest name the title and the instructions repeat before cutting it short.</summary>
    internal const int MaximumCharacters = 60;

    /// <summary>The file name without its directory, or null when there is none to say.</summary>
    internal static string? FileName(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return null;
        var name = Path.GetFileName(fileName.Trim().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        return string.IsNullOrWhiteSpace(name) ? null : name;
    }

    /// <summary>The file name cut to <see cref="MaximumCharacters"/>, for text a client reads.</summary>
    internal static string? Short(string? fileName) => FileName(fileName) is { } name ? Cut(name) : null;

    /// <summary>
    /// What a client lists this server as: "Nendo · BCM" for BCM.nendo, so two registered
    /// files read as two files in a client's server list rather than as "Nendo" twice.
    /// </summary>
    internal static string Title(string? fileName)
    {
        if (FileName(fileName) is not { } name) return "Nendo";
        var stem = Path.GetFileNameWithoutExtension(name);
        return string.IsNullOrWhiteSpace(stem) ? "Nendo" : $"Nendo · {Cut(stem)}";
    }

    private static string Cut(string text) =>
        text.Length <= MaximumCharacters ? text : string.Concat(text.AsSpan(0, MaximumCharacters - 1), "…");
}
