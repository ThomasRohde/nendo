using System.Security.Cryptography;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>The small text rules the MCP host applies in more than one place.</summary>
internal static class NendoText
{
    /// <summary>
    /// Text that arrived from outside, fit to be kept or echoed back: control characters
    /// dropped and at most <paramref name="maximum"/> characters, so a caller sees its typo
    /// and nothing it sent can break a line or grow without limit.
    /// </summary>
    internal static string Bounded(string value, int maximum) =>
        new(value.Where(character => !char.IsControl(character)).Take(maximum).ToArray());

    /// <summary>Names as a sentence lists them: "a", "a and b", "a, b and c".</summary>
    internal static string JoinNames(IReadOnlyList<string> names) => names.Count switch
    {
        1 => names[0],
        _ => $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}",
    };

    /// <summary>Lowercase hexadecimal of <paramref name="byteCount"/> random bytes.</summary>
    internal static string RandomHex(int byteCount) =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(byteCount)).ToLowerInvariant();

    /// <summary>Refuses text that is blank or longer than <paramref name="maximumLength"/>, naming it.</summary>
    internal static void RequireText(string value, string name, int maximumLength)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maximumLength)
        {
            throw new NendoValidationException(
                $"The {name} must contain 1-{maximumLength} characters.");
        }
    }

    /// <summary>An Engine code as an MCP error code: ASCII letters and digits upper-cased, everything else an underscore.</summary>
    internal static string ErrorCode(string value) => new(
        value.Select(character => char.IsAsciiLetterOrDigit(character)
            ? char.ToUpperInvariant(character)
            : '_').ToArray());
}
