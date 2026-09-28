using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// The look a file chose for itself: one of the choice tones and one letter, each of which
/// may be left to the default. Null parts are not chosen; a file that chose neither carries
/// no look at all.
/// </summary>
public sealed record NendoApplicationLook(string? Tone, string? Letter);

/// <summary>
/// A file's look as it is drawn: what it chose, and the defaults where it chose nothing. The
/// defaults travel too, so a page offering "use the defaults" can show what that would be
/// without working it out a second time.
/// </summary>
public sealed record NendoResolvedLook(
    string Tone, string Letter, bool ToneChosen, bool LetterChosen, string? DefaultTone = null, string? DefaultLetter = null);

/// <summary>
/// How a file is told apart from the others open beside it: a tone and a letter, drawn as a
/// badge on the Nendo mark wherever the file has an icon (W-089).
/// <para>
/// Every file has one without anybody choosing it. The tone comes from the application ID,
/// so a copy keeps its original's and a Fork, which is a new application, gets its own; the
/// letter is the first letter or digit of the file's name. A file may choose either or both
/// through <see cref="SetApplicationLookOperation"/>, and the choice travels with the file.
/// </para>
/// </summary>
public static class NendoLook
{
    /// <summary>Every tone a file may choose: the choice tones, in their published order.</summary>
    public static IReadOnlyList<string> Tones => NendoSemanticVocabulary.ChoiceToneOrder;

    /// <summary>
    /// The tones a default is drawn from. Red is left out because a red dot on an icon reads
    /// as something wrong, and grey because it reads as something switched off; either may
    /// still be chosen.
    /// </summary>
    public static IReadOnlyList<string> DefaultTones { get; } = ["orange", "amber", "green", "teal", "blue", "violet"];

    /// <summary>The tone a file has when it has chosen none: stable for an application ID, on every device.</summary>
    public static string DefaultTone(string applicationId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(applicationId);
        // FNV-1a over the UTF-8 bytes: string.GetHashCode is randomised per process, and a
        // file that changed colour between runs would be telling nobody anything.
        var hash = 2166136261u;
        foreach (var value in Encoding.UTF8.GetBytes(applicationId))
        {
            hash = unchecked((hash ^ value) * 16777619u);
        }
        return DefaultTones[(int)(hash % (uint)DefaultTones.Count)];
    }

    /// <summary>The letter a file has when it has chosen none: the first letter or digit of its name.</summary>
    public static string DefaultLetter(string? fileName)
    {
        var stem = string.IsNullOrWhiteSpace(fileName) ? string.Empty : Path.GetFileNameWithoutExtension(fileName.Trim());
        foreach (var character in stem)
        {
            if (char.IsLetterOrDigit(character)) return char.ToUpperInvariant(character).ToString();
        }
        return "N";
    }

    /// <summary>The look as it is drawn: the chosen parts, and the defaults for the rest.</summary>
    public static NendoResolvedLook Resolve(string applicationId, string? fileName, NendoApplicationLook? chosen)
    {
        var tone = DefaultTone(applicationId);
        var letter = DefaultLetter(fileName);
        return new(chosen?.Tone ?? tone, chosen?.Letter ?? letter, chosen?.Tone is not null, chosen?.Letter is not null, tone, letter);
    }

    /// <summary>Whether this is a tone a file may choose.</summary>
    public static bool IsTone(string? tone) => tone is not null && NendoSemanticVocabulary.ChoiceTones.Contains(tone);

    /// <summary>Whether this is a letter a file may choose: exactly one letter or digit, as the file stores it.</summary>
    public static bool IsLetter(string? letter) =>
        letter is { Length: 1 } && char.IsLetterOrDigit(letter[0]) && string.Equals(letter, letter.ToUpperInvariant(), StringComparison.Ordinal);
}

/// <summary>
/// Gives the file its own look, or returns either part to its default.
/// <para>
/// The file's own, like its purpose: it has no record type and no node, and it is drawn
/// outside the window as much as in it — on the window, the taskbar, the notification area and
/// a notification. A null part returns to the default; both null clears the look, and a file
/// with no chosen look carries nothing for it.
/// </para>
/// </summary>
public sealed record SetApplicationLookOperation : NendoOperation
{
    public SetApplicationLookOperation(string operationId, string? tone, string? letter, long expectedDefinitionRevision)
        : base(operationId)
    {
        Tone = string.IsNullOrWhiteSpace(tone) ? null : tone.Trim();
        Letter = string.IsNullOrWhiteSpace(letter) ? null : letter.Trim().ToUpperInvariant();
        ExpectedDefinitionRevision = expectedDefinitionRevision;
        if (Tone is not null && !NendoLook.IsTone(Tone))
        {
            throw new NendoValidationException(
                $"A file's tone is one of {string.Join(", ", NendoLook.Tones)}, and '{Tone}' is not.");
        }
        if (Letter is not null && !NendoLook.IsLetter(Letter))
        {
            throw new NendoValidationException(
                $"A file's letter is one letter or digit, and '{Letter}' is not.");
        }
    }

    /// <summary>One of the choice tones, or null for the default.</summary>
    public string? Tone { get; }

    /// <summary>One letter or digit, upper case where the script has one, or null for the default.</summary>
    public string? Letter { get; }

    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "application.setLook";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { tone = Tone, letter = Letter, expectedDefinitionRevision = ExpectedDefinitionRevision });
}
