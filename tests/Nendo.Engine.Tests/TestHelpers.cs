namespace Nendo.Engine.Tests;

/// <summary>
/// Small helpers many Engine test classes share, reached through the project's global
/// <c>using static</c>. A class that needs a different one declares its own, which wins.
/// </summary>
internal static class TestHelpers
{
    /// <summary>The request context of a test write, under the given idempotency key.</summary>
    internal static NendoRequestContext Context(string key) => new("test", key, "test");

    /// <summary>A compile result's diagnostics on one line, for an assertion's message.</summary>
    internal static string Messages(NendoCompileResult compiled) =>
        string.Join("; ", compiled.Diagnostics.Select(d => $"{d.Code}: {d.Message}"));
}
