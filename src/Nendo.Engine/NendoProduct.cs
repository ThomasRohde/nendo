using System.Reflection;

namespace Nendo.Engine;

/// <summary>
/// The product version of this build, read back from the assembly rather than
/// repeated as a literal. The number is declared once in
/// <c>Directory.Build.props</c>; everything that shows it — the Workbench status
/// bar, the MCP server handshake, the installer's uninstall registration — reads
/// it from here, so a bump cannot land in one place and not another.
/// <para>
/// This is the application's version. It is unrelated to
/// <see cref="NendoFormat.CurrentHostVersion"/>, which states the file-format
/// capability a <c>.nendo</c> file needs from whatever host opens it.
/// </para>
/// </summary>
public static class NendoProduct
{
    /// <summary>The version as a person reads it, for example <c>0.4.0</c>.</summary>
    public static string Version { get; } = Read();

    private static string Read()
    {
        var informational = typeof(NendoProduct).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrWhiteSpace(informational))
        {
            return typeof(NendoProduct).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
        }
        // A source-control build appends +<commit>; the version is the part before it.
        var plus = informational.IndexOf('+', StringComparison.Ordinal);
        return plus < 0 ? informational : informational[..plus];
    }
}
