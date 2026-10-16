using System.ComponentModel;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>What a put did: a chunk staged, or the picture embedded with its address and the write.</summary>
public sealed record NendoMediaPutResult(
    [property: Description("true when this call embedded the picture; false when it staged a chunk.")] bool Committed,
    [property: Description("How many bytes of the picture are staged or were embedded.")] long Bytes,
    [property: Description("The picture's address, media: and its SHA-256, once embedded.")] string? Address,
    [property: Description("The revision that embedded it, and set the field when one was named.")] NendoDataApplyResult? Write);
