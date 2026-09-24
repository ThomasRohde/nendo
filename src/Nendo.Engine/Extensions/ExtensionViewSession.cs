using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nendo.Engine;

/// <summary>Device consent for one exact view in one file instance; never stored in the file.</summary>
public sealed record NendoExtensionGrant(string ApplicationId, string InstanceId, string ViewId,
    string PackageDigest, string BindingDigest, int ProtocolVersion = 1);

public interface INendoExtensionAuthority
{
    long RevocationGeneration { get; }
    bool IsGranted(NendoExtensionGrant grant);
}

/// <summary>
/// <see cref="Values"/> is protocol 2's: the node type's disclosed fields by ID, each as
/// exact text or null. Null on protocol 1, and then absent from what the page receives.
/// </summary>
public sealed record NendoGraphNode(string Id, string Label, string? Status = null)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, string?>? Values { get; init; }
}
public sealed record NendoGraphEdge(string Id, string SourceId, string TargetId)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, string?>? Values { get; init; }
}
/// <summary>A disclosed field, named once: <paramref name="Of"/> is <c>node</c> or <c>edge</c>.</summary>
public sealed record NendoGraphField(string Id, string Name, string Type, string Of);
/// <summary>
/// Protocol 2 adds <see cref="Fields"/>, the disclosed fields in authored order, and
/// <see cref="HiddenEdges"/>, the links a node filter left without an endpoint. Both stay
/// null on protocol 1, so its projection is byte-for-byte what it was.
/// </summary>
public sealed record NendoGraphProjection(long SourceChangeSequence,
    IReadOnlyList<NendoGraphNode> Nodes, IReadOnlyList<NendoGraphEdge> Edges)
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<NendoGraphField>? Fields { get; init; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? HiddenEdges { get; init; }
}
public sealed record NendoExtensionMessageResult(bool Accepted, string Code);
public sealed record NendoExtensionSelection(string RecordId, long Generation, long SourceChangeSequence);

/// <summary>
/// Closed protocol state machine. Its caller must authenticate the transport peer before
/// delivering a frame; the nonce is correlation, not a substitute for OS peer identity.
/// No operation here opens a file, queries storage, navigates, or mutates records.
/// </summary>
public sealed class NendoExtensionViewSession : IDisposable
{
    public const int MaximumMessageBytes = 64 * 1024;
    public const int MaximumProjectionBytes = 1024 * 1024;
    public const int MaximumNodes = 500;
    public const int MaximumEdges = 1000;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly object _sync = new();
    private readonly NendoExtensionGrant _grant;
    private readonly INendoExtensionAuthority _authority;
    private readonly long _revocationGeneration;
    private readonly TimeProvider _clock;
    private readonly Queue<long> _messageTimes = new();
    private readonly long _started;
    private readonly int _protocol;
    private HashSet<string> _recordIds = [];
    private byte[] _projection = [];
    private long _generation = 1;
    private long _sourceChangeSequence;
    private string? _selected;
    private bool _ready;
    private bool _closed;

    public string SessionId { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    public long Generation { get { lock (_sync) return _generation; } }
    public bool IsClosed { get { lock (_sync) return _closed; } }

    public NendoExtensionViewSession(NendoExtensionGrant grant, INendoExtensionAuthority authority,
        NendoGraphProjection projection, TimeProvider? clock = null)
    {
        ArgumentNullException.ThrowIfNull(grant);
        ArgumentNullException.ThrowIfNull(authority);
        if (grant.ProtocolVersion is not (1 or NendoExtensionViewDefinition.FieldsProtocolVersion) || !Id(grant.ApplicationId) || !Id(grant.InstanceId) || !Id(grant.ViewId)
            || !Digest(grant.PackageDigest) || !Digest(grant.BindingDigest))
            throw new ArgumentException("The extension grant is invalid.", nameof(grant));
        _grant = grant;
        _protocol = grant.ProtocolVersion;
        _authority = authority;
        _revocationGeneration = authority.RevocationGeneration;
        _clock = clock ?? TimeProvider.System;
        _started = _clock.GetTimestamp();
        if (!Authorized()) throw new InvalidOperationException("Extension execution is not approved.");
        SetProjection(projection);
    }

    /// <summary>Only the selected data and correlation identity cross into the renderer.</summary>
    public byte[] GetInitialization(string theme, string locale)
    {
        lock (_sync)
        {
            EnsureAuthorized();
            if (theme is not ("light" or "dark") || !Text(locale, 64)) throw new ArgumentException("Invalid presentation context.");
            using var projection = JsonDocument.Parse(_projection);
            return JsonSerializer.SerializeToUtf8Bytes(new
            {
                version = _protocol, method = "initialize", session = SessionId, generation = _generation,
                theme, locale, projection = projection.RootElement,
            }, JsonOptions);
        }
    }

    public byte[] ReplaceProjection(NendoExtensionGrant currentGrant, NendoGraphProjection projection)
    {
        lock (_sync)
        {
            EnsureAuthorized();
            if (currentGrant != _grant) { Close(); throw new InvalidOperationException("The view binding changed; new approval is required."); }
            if (projection.SourceChangeSequence < _sourceChangeSequence) throw new ArgumentException("Projection revision moved backwards.");
            SetProjection(projection); // Validate before altering any existing selection/generation.
            _generation = checked(_generation + 1);
            _selected = null;
            using var document = JsonDocument.Parse(_projection);
            return JsonSerializer.SerializeToUtf8Bytes(new
            {
                version = _protocol, method = "replaceProjection", session = SessionId,
                generation = _generation, projection = document.RootElement,
            }, JsonOptions);
        }
    }

    public NendoExtensionMessageResult Receive(ReadOnlySpan<byte> utf8)
    {
        lock (_sync)
        {
            if (!Authorized()) { Close(); return Refuse("not-approved"); }
            var now = _clock.GetTimestamp();
            if (!_ready && _clock.GetElapsedTime(_started, now) >= TimeSpan.FromSeconds(5))
            { Close(); return Refuse("ready-timeout"); }
            while (_messageTimes.TryPeek(out var oldest) && _clock.GetElapsedTime(oldest, now) >= TimeSpan.FromSeconds(1)) _messageTimes.Dequeue();
            if (_messageTimes.Count >= 60) { Close(); return Refuse("message-rate-exceeded"); }
            _messageTimes.Enqueue(now); // Invalid frames consume the budget too.
            if (utf8.Length > MaximumMessageBytes) return Refuse("message-too-large");
            try
            {
                var text = StrictUtf8.GetString(utf8);
                using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 8 });
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return Refuse("invalid-message");
                var properties = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var property in root.EnumerateObject())
                    if (!properties.TryAdd(property.Name, property.Value)) return Refuse("duplicate-property");
                if (!Integer(properties, "version", out var version) || version != _protocol
                    || !String(properties, "session", out var session) || session != SessionId
                    || !Integer(properties, "generation", out var generation)) return Refuse("invalid-session");
                if (generation != _generation) return Refuse("stale-generation");
                if (!String(properties, "method", out var method)) return Refuse("invalid-message");
                var expectedKeys = method switch
                {
                    "ready" => new[] { "version", "session", "generation", "method" },
                    "selectRecord" => ["version", "session", "generation", "method", "recordId"],
                    "reportError" => ["version", "session", "generation", "method", "code", "message"],
                    _ => [],
                };
                if (expectedKeys.Length == 0) return Refuse("unknown-method");
                if (properties.Count != expectedKeys.Length || expectedKeys.Any(key => !properties.ContainsKey(key))) return Refuse("invalid-properties");
                if (method == "ready")
                {
                    if (_ready) return Refuse("already-ready");
                    _ready = true; return new(true, "ready");
                }
                if (!_ready) return Refuse("not-ready");
                if (method == "selectRecord")
                {
                    if (!String(properties, "recordId", out var recordId) || !_recordIds.Contains(recordId!)) return Refuse("record-outside-projection");
                    _selected = recordId;
                    return new(true, "selected");
                }
                if (!String(properties, "code", out var code) || code is not ("render-failed" or "unsupported-projection")
                    || !String(properties, "message", out var message) || !Text(message, 1024)) return Refuse("invalid-error");
                // Renderer text is not a host instruction, navigation target or telemetry payload.
                _selected = null;
                return new(true, code);
            }
            catch (Exception e) when (e is JsonException or DecoderFallbackException or InvalidOperationException or ArgumentException)
            { return Refuse("invalid-message"); }
        }
    }

    /// <summary>Called only by host UI on an actual Open record gesture, with its current revision.</summary>
    public NendoExtensionSelection? GetSelection(NendoExtensionGrant currentGrant, long currentChangeSequence)
    {
        lock (_sync)
        {
            if (!Authorized() || currentGrant != _grant) { Close(); return null; }
            if (!_ready || currentChangeSequence != _sourceChangeSequence || _selected is null) return null;
            return new(_selected, _generation, _sourceChangeSequence);
        }
    }

    public void Dispose() { lock (_sync) Close(); }

    private void SetProjection(NendoGraphProjection projection)
    {
        ArgumentNullException.ThrowIfNull(projection);
        if (projection.SourceChangeSequence < 0 || projection.Nodes is null || projection.Edges is null
            || projection.Nodes.Count > MaximumNodes || projection.Edges.Count > MaximumEdges)
            throw new ArgumentException("The graph exceeds the projection limits.");
        var nodes = projection.Nodes.ToArray();
        var edges = projection.Edges.ToArray();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in nodes)
            if (node is null || !Id(node.Id) || !Text(node.Label, 4096) || node.Status is not null && !Text(node.Status, 4096) || !ids.Add(node.Id))
                throw new ArgumentException("The graph contains an invalid or duplicate node.");
        var edgeIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var edge in edges)
            if (edge is null || !Id(edge.Id) || !edgeIds.Add(edge.Id)
                || !ids.Contains(edge.SourceId) || !ids.Contains(edge.TargetId))
                throw new ArgumentException("The graph contains a duplicate edge or an endpoint outside its projection.");
        CheckDisclosure(projection, nodes, edges);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(projection with { Nodes = nodes, Edges = edges }, JsonOptions);
        if (bytes.Length > MaximumProjectionBytes) throw new ArgumentException("The serialized graph exceeds the projection limit.");
        _recordIds = ids; _projection = bytes; _sourceChangeSequence = projection.SourceChangeSequence;
    }

    /// <summary>
    /// Nothing reaches the page that the projection does not name. On protocol 1 no
    /// field list and no values at all; on protocol 2 every value belongs to a field the
    /// projection lists, for the record type it lists it under, and nothing else.
    /// </summary>
    private void CheckDisclosure(NendoGraphProjection projection, NendoGraphNode[] nodes, NendoGraphEdge[] edges)
    {
        if (_protocol == 1)
        {
            if (projection.Fields is not null || projection.HiddenEdges is not null ||
                nodes.Any(n => n.Values is not null) || edges.Any(e => e.Values is not null))
                throw new ArgumentException("A protocol-1 projection discloses no further fields.");
            return;
        }
        var fields = projection.Fields ?? throw new ArgumentException("A protocol-2 projection names its disclosed fields.");
        if (projection.HiddenEdges is not >= 0) throw new ArgumentException("A protocol-2 projection states how many links it hid.");
        var byOwner = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal) { ["node"] = [], ["edge"] = [] };
        foreach (var field in fields)
            if (field is null || !Id(field.Id) || !Text(field.Name, 256) || !Text(field.Type, 32) ||
                !byOwner.TryGetValue(field.Of, out var owned) || !owned.Add(field.Id) ||
                owned.Count > NendoExtensionViewDefinition.MaximumDisclosedFieldsPerType)
                throw new ArgumentException("The projection names an invalid or duplicate disclosed field.");
        void Values(IReadOnlyDictionary<string, string?>? values, string owner)
        {
            if (values is null || values.Count != byOwner[owner].Count ||
                values.Any(pair => !byOwner[owner].Contains(pair.Key) || pair.Value is not null && !Text(pair.Value, 4096)))
                throw new ArgumentException("A record carries a value for a field the projection does not disclose.");
        }
        foreach (var node in nodes) Values(node.Values, "node");
        foreach (var edge in edges) Values(edge.Values, "edge");
    }

    private bool Authorized()
    {
        if (_closed) return false;
        try
        {
            return _authority.RevocationGeneration == _revocationGeneration && _authority.IsGranted(_grant)
                && _authority.RevocationGeneration == _revocationGeneration;
        }
        catch { Close(); return false; } // Unreadable device authority cannot become approval.
    }
    private void EnsureAuthorized() { if (!Authorized()) { Close(); throw new InvalidOperationException("Extension session is closed or approval was withdrawn."); } }
    private void Close() { _closed = true; _selected = null; _recordIds.Clear(); _projection = []; _messageTimes.Clear(); }
    private static NendoExtensionMessageResult Refuse(string code) => new(false, code);
    private static bool Id(string? value) => Text(value, 256) && !string.IsNullOrWhiteSpace(value);
    private static bool Digest(string? value) => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool Text(string? value, int max)
    {
        if (value is null || value.Length > max) return false;
        try { _ = StrictUtf8.GetByteCount(value); return true; } catch (EncoderFallbackException) { return false; }
    }
    private static bool String(Dictionary<string, JsonElement> values, string key, out string? value)
    {
        value = null;
        if (!values.TryGetValue(key, out var item) || item.ValueKind != JsonValueKind.String) return false;
        value = item.GetString(); return value is not null;
    }
    private static bool Integer(Dictionary<string, JsonElement> values, string key, out long value)
    {
        value = 0;
        return values.TryGetValue(key, out var item) && item.ValueKind == JsonValueKind.Number && item.TryGetInt64(out value);
    }
}
