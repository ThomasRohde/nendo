using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>Consent belongs to this device and physical file, never to portable file contents.</summary>
internal sealed class DesktopExtensionGrantStore(string deviceRoot)
{
    private const int MaximumBytes = 256 * 1024;
    private const int MaximumGrants = 256;
    private static readonly JsonSerializerOptions JsonOptions = new()
    { MaxDepth = 8, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    private readonly string _root = Path.GetFullPath(deviceRoot);
    private readonly object _sync = new();
    private List<Entry> _entries = [];
    private string? _fingerprint;
    private long _generation;
    private bool _writeFailed;
    private string StatePath => Path.Combine(_root, "extension-grants.json");
    internal string? Notice { get; private set; }
    internal bool Persisted { get; private set; } = true;

    internal INendoExtensionAuthority ForFile(string physicalFileKey)
    {
        if (!Id(physicalFileKey)) throw new ArgumentException("A native physical file identity is required.");
        return new FileAuthority(this, physicalFileKey);
    }

    internal void Approve(string physicalFileKey, NendoExtensionGrant grant)
    {
        var entry = new Entry(physicalFileKey, grant);
        if (!Valid(entry)) throw new ArgumentException("The custom-view approval is invalid.");
        Mutate(entries =>
        {
            entries.RemoveAll(e => SameView(e, entry));
            if (entries.Count >= MaximumGrants) throw new IOException("Remove an unused custom-view approval before adding another.");
            entries.Add(entry);
        });
    }

    internal void Revoke(string physicalFileKey, string applicationId, string instanceId, string? viewId = null)
    {
        // Deny in memory even if the device state cannot be written. Never report that failure as persisted.
        lock (_sync)
        {
            Refresh();
            _entries.RemoveAll(e => e.PhysicalFileKey == physicalFileKey && e.Grant.ApplicationId == applicationId &&
                e.Grant.InstanceId == instanceId && (viewId is null || e.Grant.ViewId == viewId));
            _generation++;
            try
            {
                Mutate(entries => entries.RemoveAll(e => e.PhysicalFileKey == physicalFileKey && e.Grant.ApplicationId == applicationId &&
                    e.Grant.InstanceId == instanceId && (viewId is null || e.Grant.ViewId == viewId)));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                _entries.Clear(); _writeFailed = true; Persisted = false;
                Notice = "Custom views are disabled in this session, but the withdrawal could not be saved. Retry before reopening Nendo.";
                throw;
            }
        }
    }

    private void Mutate(Action<List<Entry>> change)
    {
        lock (_sync)
        {
            string? stage = null;
            try
            {
                Directory.CreateDirectory(_root);
                RejectLink(_root);
                var lockPath = Path.Combine(_root, "extension-grants.lock");
                if (File.Exists(lockPath)) RejectLink(lockPath);
                using var mutation = new FileStream(lockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                // Read again under the cross-process writer lock, retaining another host's changes.
                _writeFailed = false;
                // A failed write denies everything in memory; its old fingerprint must not
                // make a retry treat that cleared list as the still-intact saved document.
                _fingerprint = null;
                Refresh();
                var next = _entries.ToList();
                change(next);
                var bytes = JsonSerializer.SerializeToUtf8Bytes(new Document(1, next), JsonOptions);
                if (bytes.Length > MaximumBytes) throw new IOException("The custom-view approval inventory exceeds its size limit.");
                stage = Path.Combine(_root, "extension-grants-" + Guid.NewGuid().ToString("N") + ".tmp");
                using (var output = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                { output.Write(bytes); output.Flush(flushToDisk: true); }
                if (File.Exists(StatePath)) RejectLink(StatePath);
                File.Move(stage, StatePath, overwrite: true);
                stage = null;
                Adopt(next, Convert.ToHexString(SHA256.HashData(bytes)));
                Persisted = true; Notice = null;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                _entries.Clear(); _writeFailed = true; _generation++; Persisted = false;
                Notice = "Custom-view approval could not be saved. Nothing is approved in this session; retry the device operation.";
                throw;
            }
            finally
            {
                if (stage is not null)
                    try { File.Delete(stage); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private void Refresh()
    {
        if (_writeFailed) return;
        try
        {
            if (Directory.Exists(_root)) RejectLink(_root);
            if (File.Exists(StatePath)) RejectLink(StatePath);
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length is <= 0 or > MaximumBytes) throw new JsonException("Approval state exceeds its bounds.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            var fingerprint = Convert.ToHexString(SHA256.HashData(bytes));
            if (fingerprint == _fingerprint) return;
            using (var json = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 })) RejectDuplicateKeys(json.RootElement);
            var document = JsonSerializer.Deserialize<Document>(bytes, JsonOptions);
            if (document?.Version != 1 || document.Grants is null || document.Grants.Count > MaximumGrants ||
                document.Grants.Any(e => !Valid(e)) || document.Grants.Distinct().Count() != document.Grants.Count)
                throw new JsonException("Approval state is malformed.");
            Adopt(document.Grants, fingerprint);
            Persisted = true; Notice = null;
        }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException)
        { Adopt([], "missing"); Persisted = true; Notice = null; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            Adopt([], "unreadable"); Persisted = false;
            Notice = "Saved custom-view approvals could not be read. Approve again after repairing device settings.";
        }
    }

    private void Adopt(List<Entry> entries, string fingerprint)
    {
        if (_entries.Any(old => !entries.Contains(old))) _generation++;
        _entries = entries; _fingerprint = fingerprint;
    }

    private static void RejectDuplicateKeys(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            { if (!keys.Add(property.Name)) throw new JsonException("Duplicate approval property."); RejectDuplicateKeys(property.Value); }
        }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) RejectDuplicateKeys(item);
    }

    private static bool Id(string? value) => value is { Length: > 0 and <= 256 } && !string.IsNullOrWhiteSpace(value);
    private static bool Digest(string? value) => value is { Length: 64 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool Valid(Entry? entry) => entry is not null && Id(entry.PhysicalFileKey) && entry.Grant is { } grant &&
        Id(grant.ApplicationId) && Id(grant.InstanceId) && Id(grant.ViewId) && Digest(grant.PackageDigest) && Digest(grant.BindingDigest) && grant.ProtocolVersion == 1;
    private static bool SameView(Entry first, Entry second) => first.PhysicalFileKey == second.PhysicalFileKey &&
        first.Grant.ApplicationId == second.Grant.ApplicationId && first.Grant.InstanceId == second.Grant.InstanceId && first.Grant.ViewId == second.Grant.ViewId;
    private static void RejectLink(string path)
    { if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Custom-view device state links are not supported."); }

    private sealed record Entry(string PhysicalFileKey, NendoExtensionGrant Grant);
    private sealed record Document(int Version, List<Entry> Grants);
    private sealed class FileAuthority(DesktopExtensionGrantStore store, string physicalFileKey) : INendoExtensionAuthority
    {
        public long RevocationGeneration { get { lock (store._sync) { store.Refresh(); return store._generation; } } }
        public bool IsGranted(NendoExtensionGrant grant)
        { lock (store._sync) { store.Refresh(); return store._entries.Contains(new(physicalFileKey, grant)); } }
    }
}
