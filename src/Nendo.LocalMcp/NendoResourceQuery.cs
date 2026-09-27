using System.Reflection;
using System.Text.RegularExpressions;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

/// <summary>
/// A read path's query, put in the order its template declares before the SDK matches it.
/// <para>
/// The SDK matches a URI against each template's expansion, which fixes the order of the
/// query parameters and reads an empty value as a value. <c>?limit=2&amp;cursor=</c> was
/// refused as an unknown resource URI and <c>?cursor=&amp;limit=2</c> as an invalid cursor,
/// although both ask for the first page (F-178). A query is now read as a set, in any
/// order, and an empty cursor is no cursor: the first page. Every other empty value stays
/// a value, for the read to refuse by name as it did. A name the template does not
/// declare, or one given twice, is refused naming the ones it does, where the SDK said
/// only that the URI was unknown.
/// </para>
/// </summary>
internal sealed partial class NendoResourceQuery
{
    private readonly IReadOnlyList<Template> _templates;

    internal NendoResourceQuery(IEnumerable<string> uriTemplates) =>
        _templates = [.. uriTemplates.Select(Parse)];

    /// <summary>The read paths <see cref="NendoMcpResources"/> declares.</summary>
    internal static NendoResourceQuery ForDeclaredResources() => new(
        typeof(NendoMcpResources)
            .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
            .Select(method => method.GetCustomAttribute<McpServerResourceAttribute>()?.UriTemplate)
            .OfType<string>());

    /// <summary>
    /// The URI with its query in template order and an empty cursor dropped. A URI without a
    /// query, or one no template's path matches, is returned as it came, for the SDK to answer.
    /// </summary>
    internal string Canonicalize(string uri)
    {
        ArgumentNullException.ThrowIfNull(uri);
        var mark = uri.IndexOf('?', StringComparison.Ordinal);
        if (mark < 0) return uri;
        var path = uri[..mark];
        var template = _templates.FirstOrDefault(candidate => candidate.Path.IsMatch(path));
        if (template is null) return uri;
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in uri[(mark + 1)..].Split('&'))
        {
            if (part.Length == 0) continue;
            var equals = part.IndexOf('=', StringComparison.Ordinal);
            var name = equals < 0 ? part : part[..equals];
            if (!template.Parameters.Contains(name, StringComparer.Ordinal))
            {
                throw Refuse(template, Bounded(name), twice: false);
            }
            if (!values.TryAdd(name, equals < 0 ? string.Empty : part[(equals + 1)..]))
            {
                throw Refuse(template, name, twice: true);
            }
        }
        var query = string.Join('&', template.Parameters
            .Where(name => values.TryGetValue(name, out var value) && (value.Length > 0 || name != "cursor"))
            .Select(name => $"{name}={values[name]}"));
        return query.Length == 0 ? path : $"{path}?{query}";
    }

    private static McpProtocolException Refuse(Template template, string name, bool twice) => new(
        $"NENDO_INVALID_REQUEST: {template.Text} " + (template.Parameters.Count == 0
            ? $"takes no query parameters; remove '{name}'."
            : $"takes {Join(template.Parameters)}; '{name}' " + (twice ? "is given twice." : "is not one of them.")),
        McpErrorCode.InvalidParams);

    private static string Join(IReadOnlyList<string> names) => names.Count switch
    {
        1 => names[0],
        _ => $"{string.Join(", ", names.Take(names.Count - 1))} and {names[^1]}",
    };

    // A name is echoed back so the caller can see its typo, bounded and without control
    // characters, because it arrived from outside.
    private static string Bounded(string value) =>
        new([.. value.Where(character => !char.IsControl(character)).Take(40)]);

    private static Template Parse(string uriTemplate)
    {
        var query = uriTemplate.IndexOf("{?", StringComparison.Ordinal);
        var path = query < 0 ? uriTemplate : uriTemplate[..query];
        var parameters = query < 0
            ? []
            : uriTemplate[(query + 2)..^1].Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        var pattern = "^" + string.Concat(Variable().Split(path)
            .Select((piece, index) => index % 2 == 0 ? Regex.Escape(piece) : "[^/?#]+")) + "$";
        return new Template(
            path,
            new Regex(pattern, RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)),
            parameters);
    }

    // Split keeps the captured variable names at the odd positions.
    [GeneratedRegex(@"\{([^}?]+)\}", RegexOptions.CultureInvariant)]
    private static partial Regex Variable();

    private sealed record Template(string Text, Regex Path, IReadOnlyList<string> Parameters);
}
