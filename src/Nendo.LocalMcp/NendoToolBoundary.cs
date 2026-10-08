using System.Globalization;
using System.Reflection;
using System.Text.Json;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Nendo.LocalMcp;

/// <summary>
/// Which tools exist at which access level, and what each takes, checked before the SDK
/// binds a call.
/// <para>
/// The argument contract is read from the tool methods themselves: each parameter's name,
/// whether it has a default, and its type, down through the closed records a list of
/// them carries. A hand-kept table of argument names stood here until 2026-09-27, and the
/// binder behind it answered every call it could not bind with "An error occurred
/// invoking" and nothing else: a missing <c>idempotencyKey</c> had no sentence, an unknown
/// key inside a record was dropped without a word, and a tool served one level up was
/// "Unknown tool", so the level codes Help documents could not occur (F-171 to F-174).
/// Every refusal here names the argument or the nested key and what is accepted, or the
/// level to ask the person for.
/// </para>
/// </summary>
internal static class NendoToolBoundary
{
    /// <summary>
    /// Each tool class and the lowest level that serves it. The listener registers from this
    /// table and the boundary refuses from it, so the two cannot disagree. The one tool that
    /// exists only at Unattended is a class and a row of its own (ADR-0009, 2026-09-22). The two
    /// read tools are served from Inspect, since they read what the resources already serve
    /// there (ADR-0009, 2026-10-08).
    /// </summary>
    internal static readonly IReadOnlyList<(Type Tools, AgentAccessMode Minimum)> ToolClasses =
    [
        (typeof(NendoReadTools), AgentAccessMode.ReadOnly),
        (typeof(NendoLeaseTools), AgentAccessMode.DataMutation),
        (typeof(NendoDataTools), AgentAccessMode.DataMutation),
        (typeof(NendoHealthTools), AgentAccessMode.DataMutation),
        (typeof(NendoAuthoringTools), AgentAccessMode.ApplicationAuthoring),
        (typeof(NendoUnattendedTools), AgentAccessMode.Unattended),
    ];

    // What the refusal calls one of each closed record. Declared before Tools, whose
    // initializer reads it.
    private static readonly IReadOnlyDictionary<Type, string> Nouns = new Dictionary<Type, string>
    {
        [typeof(NendoRecordInput)] = "A record",
        [typeof(NendoReferenceInput)] = "A reference target",
        [typeof(NendoRecordWriteInput)] = "A record write",
        [typeof(NendoRecordKeyInput)] = "A record key",
        [typeof(NendoCsvColumnMapping)] = "A column mapping",
        [typeof(NendoAgentMutationInput)] = "A mutation",
        [typeof(NendoAgentOperationInput)] = "An operation",
    };

    /// <summary>Every tool by name: its level, its method and the arguments it takes.</summary>
    internal static readonly IReadOnlyDictionary<string, ToolContract> Tools = ToolClasses
        .SelectMany(entry => ToolMethods(entry.Tools).Select(method => Contract(method, entry.Minimum)))
        .ToDictionary(tool => tool.Name, StringComparer.Ordinal);

    internal static IEnumerable<MethodInfo> ToolMethods(Type tools) => tools
        .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
        .Where(method => method.GetCustomAttribute<McpServerToolAttribute>() is not null);

    /// <summary>
    /// Refuse a call this level does not serve, or whose arguments do not fit the tool, with
    /// a sentence that names the cause. A tool that does not exist here is a protocol error,
    /// as the specification asks; arguments that do not fit are a tool error the agent reads.
    /// </summary>
    internal static void Validate(CallToolRequestParams request, AgentAccessMode mode)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!Tools.TryGetValue(request.Name, out var tool))
        {
            throw new McpProtocolException(
                $"NENDO_TOOL_UNAVAILABLE: No tool is named '{NendoText.Bounded(request.Name, 60)}'. tools/list names every tool " +
                $"this access level serves; this file session is at {NendoAccessLevels.DisplayName(mode)}.",
                McpErrorCode.InvalidParams);
        }
        if (mode < tool.Minimum)
        {
            throw new McpProtocolException(
                $"NENDO_{NendoAccessLevels.RequiredCode(tool.Minimum)}: {tool.Name} is served from " +
                $"{NendoAccessLevels.DisplayName(tool.Minimum)}, and this file session is at " +
                $"{NendoAccessLevels.DisplayName(mode)}. Ask the person to raise agent access to " +
                $"{NendoAccessLevels.DisplayName(tool.Minimum)} on the Agent page in Nendo.",
                McpErrorCode.InvalidParams);
        }
        var problems = new List<string>();
        var arguments = request.Arguments ?? new Dictionary<string, JsonElement>();
        CheckMembers(tool.Name, tool.Arguments, arguments.Select(pair => (pair.Key, pair.Value)), path: null, problems);
        if (problems.Count > 0)
        {
            var shown = string.Join(" ", problems.Take(MaximumProblems).Select(problem => problem + "."));
            throw new McpException(
                $"NENDO_INVALID_REQUEST: {tool.Name} was not called. {shown}" +
                (problems.Count > MaximumProblems ? $" {problems.Count - MaximumProblems} more not shown." : string.Empty));
        }
    }

    private const int MaximumProblems = 5;

    internal sealed record ToolContract(string Name, AgentAccessMode Minimum, IReadOnlyList<Member> Arguments);

    /// <summary>One argument, or one key of a closed record.</summary>
    internal sealed record Member(string Name, Shape Shape, bool Required);

    /// <summary>What one value may be.</summary>
    internal abstract record Shape(bool Nullable);

    /// <summary><c>string</c>, <c>integer</c> (64-bit), <c>int32</c> or <c>boolean</c>.</summary>
    internal sealed record Scalar(string Kind, bool Nullable) : Shape(Nullable);

    /// <summary>
    /// An operation payload, a value map or a field value. Nendo reads these itself and
    /// refuses a wrong one naming the operation or the field, which says more than a shape can.
    /// </summary>
    internal sealed record Open() : Shape(true);

    internal sealed record ListOf(Shape Item, bool Nullable) : Shape(Nullable);

    internal sealed record MapOf(Shape Value, bool Nullable) : Shape(Nullable);

    /// <summary>A record with a closed set of keys; <paramref name="Noun"/> says what one is.</summary>
    internal sealed record Closed(string Noun, IReadOnlyList<Member> Members, bool Nullable) : Shape(Nullable);

    private static ToolContract Contract(MethodInfo method, AgentAccessMode minimum)
    {
        var name = method.GetCustomAttribute<McpServerToolAttribute>()!.Name
            ?? throw new InvalidOperationException($"{method.Name} declares no tool name.");
        var nullability = new NullabilityInfoContext();
        var arguments = method.GetParameters()
            .Where(parameter => !IsInjected(parameter.ParameterType))
            .Select(parameter => new Member(
                parameter.Name!,
                ShapeOf(parameter.ParameterType, nullability.Create(parameter)),
                Required: !parameter.HasDefaultValue))
            .ToArray();
        return new ToolContract(name, minimum, arguments);
    }

    // The parameters the SDK supplies itself rather than binding from the arguments.
    private static bool IsInjected(Type type) =>
        type == typeof(CancellationToken) ||
        type == typeof(McpServer) ||
        type == typeof(IServiceProvider) ||
        type.IsGenericType && type.GetGenericTypeDefinition() == typeof(RequestContext<>) ||
        type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IProgress<>);

    private static Shape ShapeOf(Type type, NullabilityInfo nullability)
    {
        if (Nullable.GetUnderlyingType(type) is { } underlying) return ShapeOf(underlying, nullability, nullable: true);
        return ShapeOf(type, nullability, nullable: !type.IsValueType && nullability.ReadState != NullabilityState.NotNull);
    }

    private static Shape ShapeOf(Type type, NullabilityInfo nullability, bool nullable)
    {
        if (type == typeof(string)) return new Scalar("string", nullable);
        if (type == typeof(long)) return new Scalar("integer", nullable);
        if (type == typeof(int)) return new Scalar("int32", nullable);
        if (type == typeof(bool)) return new Scalar("boolean", nullable);
        if (type == typeof(NendoObjectInput) || type == typeof(NendoScalarInput)) return new Open();
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>) &&
            type.GetGenericArguments()[0] == typeof(string))
        {
            return new MapOf(ShapeOf(type.GetGenericArguments()[1], nullability.GenericTypeArguments[1]), nullable);
        }
        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IReadOnlyList<>))
        {
            return new ListOf(ShapeOf(type.GetGenericArguments()[0], nullability.GenericTypeArguments[0]), nullable);
        }
        if (NendoJsonInputs.ClosedInputs.Contains(type))
        {
            // The names the binder reads, from the options it reads them with, so a
            // naming policy or a renamed member cannot open a gap between the two.
            var context = new NullabilityInfoContext();
            var members = NendoMcpJson.ToolOptions.GetTypeInfo(type).Properties
                .Select(property =>
                {
                    var member = (PropertyInfo)property.AttributeProvider!;
                    return new Member(
                        property.Name,
                        ShapeOf(property.PropertyType, context.Create(member)),
                        Required: property.AssociatedParameter is { HasDefaultValue: false });
                })
                .ToArray();
            return new Closed(Nouns[type], members, nullable);
        }
        throw new InvalidOperationException(
            $"A tool takes a {type.Name}, which the argument contract cannot describe. Give it a shape here.");
    }

    /// <summary>
    /// The keys a custom view's <c>records.batch</c> uses for what a record write here calls
    /// otherwise. An agent that learned the write shape from a view's code sent <c>op</c> and
    /// was told only what is taken; the refusal now names the key it meant (2026-10-08).
    /// </summary>
    private static readonly IReadOnlyDictionary<(string Owner, string Key), string> ViewApiNames =
        new Dictionary<(string, string), string>
        {
            [("A record write", "op")] = "kind",
            [("A record write", "version")] = "expectedRecordVersion",
            [("A record write", "targetVersions")] = "expectedTargetVersions",
        };

    private static void CheckMembers(
        string owner,
        IReadOnlyList<Member> members,
        IEnumerable<(string Key, JsonElement Value)> present,
        string? path,
        List<string> problems)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (key, value) in present)
        {
            seen.Add(key);
            var member = members.FirstOrDefault(candidate => string.Equals(candidate.Name, key, StringComparison.Ordinal));
            if (member is null)
            {
                var named = ViewApiNames.TryGetValue((owner, key), out var here) ? $", the view API's name for {here}" : string.Empty;
                problems.Add($"{path ?? "It"} does not take '{NendoText.Bounded(key, 60)}'{named}; {Takes(owner, members)}");
                continue;
            }
            Check(value, member.Shape, path is null ? member.Name : $"{path}.{member.Name}", problems);
        }
        foreach (var member in members.Where(member => member.Required && !seen.Contains(member.Name)))
        {
            problems.Add($"{path ?? "It"} requires {member.Name}");
        }
    }

    private static void Check(JsonElement value, Shape shape, string path, List<string> problems)
    {
        if (value.ValueKind == JsonValueKind.Null)
        {
            if (!shape.Nullable) problems.Add($"{path} must be {Expected(shape)}; it was null");
            return;
        }
        switch (shape)
        {
            case Open:
                return;
            case Scalar { Kind: "string" } when value.ValueKind == JsonValueKind.String:
            case Scalar { Kind: "boolean" } when value.ValueKind is JsonValueKind.True or JsonValueKind.False:
                return;
            // The binder reads a whole number sent as a string, as JSON's web defaults do,
            // so this does too: a refusal here must never be stricter than the call would be.
            case Scalar { Kind: "integer" } when
                value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _) ||
                value.ValueKind == JsonValueKind.String &&
                long.TryParse(value.GetString(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _):
            case Scalar { Kind: "int32" } when
                value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out _) ||
                value.ValueKind == JsonValueKind.String &&
                int.TryParse(value.GetString(), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _):
                return;
            case ListOf list when value.ValueKind == JsonValueKind.Array:
                var index = 0;
                foreach (var item in value.EnumerateArray()) Check(item, list.Item, $"{path}[{index++}]", problems);
                return;
            case MapOf map when value.ValueKind == JsonValueKind.Object:
                foreach (var entry in value.EnumerateObject()) Check(entry.Value, map.Value, $"{path}.{NendoText.Bounded(entry.Name, 60)}", problems);
                return;
            case Closed closed when value.ValueKind == JsonValueKind.Object:
                CheckMembers(closed.Noun, closed.Members, value.EnumerateObject().Select(entry => (entry.Name, entry.Value)), path, problems);
                return;
        }
        problems.Add($"{path} must be {Expected(shape)}; it was {Actual(value)}");
    }

    private static string Takes(string owner, IReadOnlyList<Member> members)
    {
        var required = members.Where(member => member.Required).Select(member => member.Name).ToArray();
        var optional = members.Where(member => !member.Required).Select(member => member.Name).ToArray();
        var subject = owner.StartsWith("nendo.", StringComparison.Ordinal) ? "it" : owner.ToLowerInvariant();
        var sentence = required.Length == 0 ? $"{subject} takes only" : $"{subject} takes {NendoText.JoinNames(required)}";
        if (optional.Length > 0) sentence += required.Length == 0 ? $" {NendoText.JoinNames(optional)}, each optional" : $", and optionally {NendoText.JoinNames(optional)}";
        return required.Length == 0 && optional.Length == 0 ? $"{subject} takes no arguments" : sentence;
    }

    private static string Expected(Shape shape) => shape switch
    {
        Scalar { Kind: "integer" or "int32" } => "a whole number",
        Scalar { Kind: "boolean" } => "true or false",
        Scalar => "a string",
        ListOf => "an array",
        MapOf or Closed => "an object",
        _ => "a value",
    };

    private static string Actual(JsonElement value) => value.ValueKind switch
    {
        JsonValueKind.String => "a string",
        JsonValueKind.Number => value.TryGetInt64(out _)
            ? "a number"
            : value.TryGetDecimal(out var number) && number != decimal.Truncate(number)
                ? "a number with a fraction"
                : "a number outside the range a whole number here may take",
        JsonValueKind.True or JsonValueKind.False => "a boolean",
        JsonValueKind.Array => "an array",
        JsonValueKind.Object => "an object",
        _ => "null",
    };
}
