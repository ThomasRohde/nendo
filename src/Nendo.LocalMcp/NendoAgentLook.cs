using System.ComponentModel;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>A look a file chose: each part, or null where it keeps the default.</summary>
public sealed record NendoAgentLook(
    [property: Description("One of the choice tones, or null when the file keeps the default tone.")]
    string? Tone,
    [property: Description("One letter or digit, or null when the file keeps the default letter.")]
    string? Letter)
{
    internal static NendoAgentLook? From(NendoApplicationLook? look) =>
        look is null ? null : new NendoAgentLook(look.Tone, look.Letter);
}
