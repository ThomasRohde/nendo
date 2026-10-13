using System.Security.Cryptography;
using System.Text;

namespace Nendo.Desktop;

/// <summary>
/// Where a custom view's code runs: one web origin for each package in each file instance.
/// <para>
/// Each origin is a site of its own, so the browser gives every package its own renderer
/// process and its own storage. None shares an origin, or a site, with the Workbench at
/// app.nendo.local. The key ties the origin to the file instance, so two files carrying the same
/// package keep separate storage, a Duplicate (which keeps its original's application ID) starts
/// with storage of its own rather than the original's drafts, and a view left over from a closed
/// file reaches nothing (ADR-0013, 2026-10-13).
/// </para>
/// <para>
/// <c>.example</c> is reserved and never resolves, so a request that the host does not
/// answer fails rather than leaving the machine.
/// </para>
/// </summary>
internal static class ExtensionOrigins
{
    internal const string Suffix = ".example";

    /// <summary>The API script every view origin serves, from the installed Workbench rather than the file.</summary>
    internal const string ApiPath = "_nendo/api.js";

    private const int SlugCharacters = 40;
    private const int KeyCharacters = 10;

    /// <param name="carriedOver">
    /// This instance keeps the origin its application had before the instance ID was in the key
    /// (<see cref="ExtensionOriginCarry"/>): the key is then of the application and package alone.
    /// </param>
    internal static string Host(string applicationId, string instanceId, string packageId, bool carriedOver = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        ArgumentException.ThrowIfNullOrWhiteSpace(packageId);
        var slug = new StringBuilder(packageId.Length);
        foreach (var character in packageId.ToLowerInvariant())
        {
            var next = character is >= 'a' and <= 'z' or >= '0' and <= '9' ? character : '-';
            if (next == '-' && (slug.Length == 0 || slug[^1] == '-')) continue;
            slug.Append(next);
        }
        var text = slug.ToString();
        if (text.Length > SlugCharacters) text = text[..SlugCharacters];
        text = text.Trim('-');
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(carriedOver ? applicationId + "\n" + packageId : applicationId + "\n" + instanceId + "\n" + packageId)))[..KeyCharacters]
            .ToLowerInvariant();
        return (text.Length == 0 ? "view" : text) + "-" + key + Suffix;
    }

    internal static string Origin(string applicationId, string instanceId, string packageId) => "https://" + Host(applicationId, instanceId, packageId);

    /// <summary>A single label under the reserved suffix, which is every host a view can have.</summary>
    internal static bool IsViewHost(string? host) =>
        host is { Length: > 0 } &&
        host.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase) &&
        host.Length > Suffix.Length &&
        !host[..^Suffix.Length].Contains('.');
}
