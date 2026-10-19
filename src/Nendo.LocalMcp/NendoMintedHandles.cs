using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace Nendo.LocalMcp;

/// <summary>
/// The application handles this process's hosts have granted, so a surface that draws an
/// agent's own text can hide a handle by its value wherever it appears: in prose, a table or on
/// its own, not only after a key it recognises. A handle is a capability (ADR-0009);
/// whoever reads it may write as the agent.
/// </summary>
public static class NendoMintedHandles
{
    /// <summary>
    /// A bound, so a long-running process cannot grow the set without end. Past it the oldest
    /// handle is forgotten, never the newest: a handle in use now is always hidden.
    /// </summary>
    internal const int Capacity = 4096;

    private static readonly ConcurrentDictionary<string, byte> Handles = new(StringComparer.Ordinal);
    private static readonly ConcurrentQueue<string> Order = new();

    // A handle is 32 random bytes as 64 lowercase hex digits; a run of exactly that length.
    private static readonly Regex Candidate = new(
        "(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    internal static void Remember(string handle)
    {
        var key = handle.ToLowerInvariant();
        if (!Handles.TryAdd(key, 0)) return;
        Order.Enqueue(key);
        while (Handles.Count > Capacity && Order.TryDequeue(out var oldest)) Handles.TryRemove(oldest, out _);
    }

    /// <summary>Replaces every handle this process granted with <paramref name="replacement"/>.</summary>
    public static string Hide(string text, string replacement) =>
        Handles.IsEmpty
            ? text
            : Candidate.Replace(text, match => Handles.ContainsKey(match.Value.ToLowerInvariant()) ? replacement : match.Value);
}
