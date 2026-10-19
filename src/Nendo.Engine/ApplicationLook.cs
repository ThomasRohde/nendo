using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// The look a file chose for itself: one of the choice tones and one letter, each of which
/// may be left to the default, and a picture drawn in their place. Null parts are not
/// chosen; a file that chose none carries no look at all.
/// </summary>
public sealed record NendoApplicationLook(string? Tone, string? Letter, string? Icon = null);

/// <summary>
/// A file's look as it is drawn: what it chose, and the defaults where it chose nothing. The
/// defaults travel too, so a page offering "use the defaults" can show what that would be
/// without working it out a second time. <see cref="Icon"/> is the picture's <c>media:</c>
/// address when the file has one, drawn instead of the tone and letter.
/// </summary>
public sealed record NendoResolvedLook(
    string Tone, string Letter, bool ToneChosen, bool LetterChosen, string? DefaultTone = null, string? DefaultLetter = null,
    string? Icon = null);

/// <summary>
/// How a file is told apart from the others open beside it: a tone and a letter, drawn as a
/// badge on the Nendo mark wherever the file has an icon.
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
        return new(chosen?.Tone ?? tone, chosen?.Letter ?? letter, chosen?.Tone is not null, chosen?.Letter is not null, tone, letter,
            chosen?.Icon);
    }

    /// <summary>The only picture type an icon may be: one decoder for every place that draws it.</summary>
    public const string IconMediaType = "image/png";

    /// <summary>The smallest side an icon's picture may have: the smallest frame the shell asks for.</summary>
    public const int MinimumIconPixels = 16;

    /// <summary>The largest side an icon's picture may have: four times the largest frame drawn from it.</summary>
    public const int MaximumIconPixels = 1024;

    /// <summary>The most an icon's picture may hold, so drawing it never reads a large picture.</summary>
    public const long MaximumIconBytes = 1024 * 1024;

    /// <summary>
    /// Why an embedded picture cannot be a file's icon, or null when it can: a square PNG, 16 to
    /// 1,024 pixels a side, at most 1 MiB.
    /// </summary>
    public static string? IconRefusal(NendoMediaItem item)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (item.MediaType != IconMediaType)
            return $"A file's icon is a PNG, and this picture is {item.MediaType}. Nendo converts a dropped picture to one.";
        if (item.ByteLength > MaximumIconBytes)
            return $"A file's icon holds at most {MaximumIconBytes / 1024} KiB, and this picture holds {Math.Ceiling(item.ByteLength / 1024.0)} KiB.";
        if (item.Width is not { } width || item.Height is not { } height)
            return "A file's icon must say its size, and this picture does not.";
        if (width != height)
            return $"A file's icon is square, and this picture is {width} by {height} pixels.";
        if (width is < MinimumIconPixels or > MaximumIconPixels)
            return $"A file's icon is {MinimumIconPixels} to {MaximumIconPixels} pixels a side, and this picture is {width}.";
        return null;
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

/// <summary>
/// Gives the file a picture as its icon, drawn instead of the tone and letter, or takes it away
/// (ADR-0004).
/// <para>
/// The picture is embedded content the file already holds (<see cref="PutMediaOperation"/>), a
/// square PNG within <see cref="NendoLook.IconRefusal"/>'s bounds. Null takes the picture away,
/// and the file shows its tone and letter again.
/// </para>
/// </summary>
public sealed record SetApplicationIconOperation : NendoOperation
{
    public SetApplicationIconOperation(string operationId, string? icon, long expectedDefinitionRevision)
        : base(operationId)
    {
        Icon = string.IsNullOrWhiteSpace(icon) ? null : icon.Trim();
        ExpectedDefinitionRevision = expectedDefinitionRevision;
        if (Icon is not null && (!NendoMediaAddress.TryParse(Icon, out var address) || address!.Source != NendoMediaSource.Embedded))
        {
            throw new NendoValidationException(
                $"A file's icon is a picture embedded in the file, named media: and its SHA-256, and '{Icon}' is not.");
        }
    }

    /// <summary>The picture's <c>media:</c> address, or null to take the picture away.</summary>
    public string? Icon { get; }

    /// <summary>The SHA-256 the address names, or null.</summary>
    public string? Sha256 => Icon?[NendoMedia.EmbeddedScheme.Length..];

    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "application.setIcon";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer) => JsonSerializer.Serialize(writer,
        new { icon = Icon, expectedDefinitionRevision = ExpectedDefinitionRevision });
}
