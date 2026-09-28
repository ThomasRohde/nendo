namespace Nendo.LocalMcp;

/// <summary>
/// The view API reference (W-094): <c>window.nendo</c> as an agent reads it before it writes a
/// custom view's code. The Workbench's api build writes it beside api.js, from the tables api.js
/// and the view broker are built from, and this assembly carries it as it was built.
/// <para>
/// It is its own read, and only a pointer names it anywhere else. The instructions, the vocabulary
/// and the custom-view example each say to read it when writing a view's code, and
/// <c>nendo://application/describe</c> lists it among the reads by its first sentence, which says
/// the same. An agent that is not writing a view has no reason to pay for reading it.
/// </para>
/// </summary>
internal static class NendoViewApi
{
    internal const string Uri = "nendo://application/view-api";

    private const string ResourceName = "Nendo.LocalMcp.view-api.json";

    private static readonly Lazy<string> Reference = new(() =>
    {
        using var stream = typeof(NendoViewApi).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"This build carries no {ResourceName}; the Workbench's api build writes it.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });

    /// <summary>The reference as JSON text, exactly as the api build wrote it.</summary>
    internal static string Json => Reference.Value;
}
