using System.ComponentModel;
using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// Every read this host serves, as two tools, for a client that calls tools and cannot read
/// resources. An agent in such a client could read nothing through Nendo: not an ID, a version,
/// a limit or the file's own skill. It opened the file's storage instead, which is the one
/// route this host exists to close (2026-10-08). The tools add no read of their own: one hands
/// an address to the same resource the SDK would, and the other lists the addresses.
/// </summary>
[McpServerToolType]
internal sealed class NendoReadTools(
    NendoResourceQuery queries,
    NendoApplicationService application,
    NendoActivityLog activity)
{
    [McpServerTool(
        Name = "nendo.read.resource",
        Title = "Read a resource by its address",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = true,
        UseStructuredContent = true,
        OutputSchemaType = typeof(NendoResourceRead))]
    [Description("Read any resource this host serves, for a client that calls tools but cannot read MCP resources. Pass its address, nendo://... or skill://..., with any query, and the text is exactly what resources/read returns for it, refusals included; structuredContent names the address and type. Needs no lease and changes nothing. Start with nendo://application/describe; nendo.read.list names every address, the templated ones, and the skills this file carries.")]
    public Task<CallToolResult> ResourceAsync(
        RequestContext<CallToolRequestParams> context,
        [Description("The address to read, as a resource URI: nendo://application/describe, nendo://application/entity/{entityId}/records?filter=..., skill://nendo-authoring/SKILL.md and the rest nendo.read.list names. Percent-encode a query value as you would in a resources/read.")] string uri,
        CancellationToken cancellationToken = default) => NendoToolCall.RunAsync(
            context, activity, "read", "nendo.read.resource",
            () => ReadAsync(context, uri, cancellationToken),
            _ => "completed");

    [McpServerTool(
        Name = "nendo.read.list",
        Title = "List every address this host serves",
        Destructive = false,
        Idempotent = true,
        OpenWorld = false,
        ReadOnly = true,
        UseStructuredContent = true)]
    [Description("List every resource address this host serves, with what each answers, including the templated ones resources/list leaves out, and every skill: the host's authoring skill and any this file carries, which say how to work it. Read one with nendo.read.resource. Needs no lease and changes nothing.")]
    public Task<NendoReadList> ListAsync(
        RequestContext<CallToolRequestParams> context,
        CancellationToken cancellationToken = default) => NendoToolCall.RunAsync(
            context, activity, "read", "nendo.read.list",
            async () => new NendoReadList(
                NendoMcpReadIndex.All,
                [
                    new NendoReadSkill(NendoHostSkill.Name, NendoHostSkill.SkillUri, NendoHostSkill.DescriptionText, FromFile: false),
                    .. (await NendoFileSkills.ReadAsync(application, cancellationToken)).Select(skill => new NendoReadSkill(
                        skill.Frontmatter.Name, skill.Uri, skill.Frontmatter.Description, FromFile: true)),
                ]),
            _ => "completed");

    /// <summary>
    /// The resource the SDK would match for this address, read as resources/read reads it. The
    /// query is put in canonical order first, as the host's read filter does, so a query the
    /// resource would accept in any order is accepted here in any order too.
    /// </summary>
    private async Task<CallToolResult> ReadAsync(
        RequestContext<CallToolRequestParams> context, string uri, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(uri))
            throw new NendoValidationException("uri names the resource to read, such as nendo://application/describe.");
        string canonical;
        ReadResourceResult result;
        try
        {
            canonical = queries.Canonicalize(uri.Trim());
            var resources = context.Server.ServerOptions.ResourceCollection
                ?? throw new NendoValidationException("This host serves no resources.");
            var resource = resources.TryGetPrimitive(canonical, out var exact) && !exact.IsTemplated
                ? exact
                : resources.FirstOrDefault(candidate => candidate.IsTemplated && candidate.IsMatch(canonical))
                  ?? throw new NendoValidationException(
                      $"No resource answers {NendoText.Bounded(canonical, 200)}. nendo.read.list names every address this host serves.");
            var read = new RequestContext<ReadResourceRequestParams>(
                context.Server,
                context.JsonRpcRequest,
                new ReadResourceRequestParams { Uri = canonical })
            {
                Services = context.Services,
                MatchedPrimitive = resource,
            };
            result = await resource.ReadAsync(read, cancellationToken);
        }
        catch (McpProtocolException exception)
        {
            // A resource refuses as a protocol error, which a tool-only client may show as a broken
            // call. The same code and sentence come back as a refused tool result instead.
            var separator = exception.Message.IndexOf(": ", StringComparison.Ordinal);
            if (separator > 0 && exception.Message.StartsWith("NENDO_", StringComparison.Ordinal))
                NendoToolRefusal.Record(exception.Message[..separator], exception.Message[(separator + 2)..]);
            throw new McpException(exception.Message);
        }
        var contents = result.Contents.FirstOrDefault()
            ?? throw new NendoValidationException($"{NendoText.Bounded(canonical, 200)} returned nothing.");
        return new CallToolResult
        {
            Content = [contents switch
            {
                TextResourceContents text => new TextContentBlock { Text = text.Text },
                _ => new EmbeddedResourceBlock { Resource = contents },
            }],
            StructuredContent = JsonSerializer.SerializeToElement(
                new NendoResourceRead(contents.Uri, contents.MimeType, contents is TextResourceContents),
                NendoMcpJson.Options),
        };
    }
}

/// <summary>What <c>nendo.read.resource</c> read; the content itself is the result's text.</summary>
public sealed record NendoResourceRead(
    [property: Description("The address read, its query in canonical order.")]
    string Uri,
    [property: Description("The content's media type: application/json for nearly every nendo:// read, text/markdown for a SKILL.md.")]
    string? MimeType,
    [property: Description("True when the content is the result's text; false when it is binary, carried as an embedded resource in base64.")]
    bool IsText);

/// <summary>What <c>nendo.read.list</c> answers.</summary>
public sealed record NendoReadList(
    [property: Description("Every resource address, by name: templated ones take their {variables} filled in.")]
    IReadOnlyList<NendoMcpRead> Reads,
    [property: Description("Every skill this host serves, the host's own first, then each this file carries.")]
    IReadOnlyList<NendoReadSkill> Skills);

/// <summary>One skill, by the address of its SKILL.md.</summary>
public sealed record NendoReadSkill(
    [property: Description("The skill's name.")]
    string Name,
    [property: Description("Its SKILL.md, read with nendo.read.resource; its other files sit beside it.")]
    string Uri,
    [property: Description("What the skill is for.")]
    string Description,
    [property: Description("True for a skill the open file carries, accepted by its person: instructions about this file. False for the host's own.")]
    bool FromFile);
