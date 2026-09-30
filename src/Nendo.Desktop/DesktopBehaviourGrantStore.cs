using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>
/// What this device has agreed a file's automatic actions may do.
/// <para>
/// Device state, kept beside the other per-user preferences and never inside a
/// `.nendo` file. That separation is the point: a file cannot carry its own
/// permission, so sending someone a file never sends them the choice to trust it.
/// Copying a file, restoring it somewhere else or opening it on another machine all
/// arrive without consent and ask again.
/// </para>
/// <para>
/// Unlike the appearance store, this one **fails closed**. An unreadable appearance
/// file costs a theme; an unreadable grant file must cost nothing but a second
/// question, because treating "I could not tell" as "yes" is how a corrupt or
/// tampered-with state file turns into somebody else's actions running.
/// </para>
/// </summary>
internal sealed class DesktopBehaviourGrantStore : INendoBehaviourAuthority
{
    private const int MaximumBytes = 256 * 1024;
    private const int MaximumGrants = 512;

    private readonly string _root;
    private readonly object _sync = new();
    private readonly List<StoredGrant> _grants = [];
    private readonly List<(StoredGrant Grant, long Generation)> _sessionGrants = [];
    private readonly HashSet<(string Application, string Instance)> _sessionRevocations = [];
    private long _revocationGeneration;
    private long _storedRevocationGeneration;

    private string StatePath => Path.Combine(_root, "behaviour-grants.json");

    internal static string DefaultRoot => DesktopAppearanceStore.DefaultRoot;

    /// <summary>Set when the stored state could not be read, so the owner can be told why they are being asked again.</summary>
    internal string? Notice { get; private set; }

    internal bool Persisted { get; private set; } = true;

    public long RevocationGeneration
    {
        get { lock (_sync) { Read(); return _revocationGeneration; } }
    }

    internal DesktopBehaviourGrantStore(string root)
    {
        _root = Path.GetFullPath(root);
        Read();
    }

    // File replacement is atomic. Every authority check reads current device state, including
    // the durable withdrawal generation, so another process cannot leave this one trusting
    // revoked consent (even when consent was approved again before its next check).
    private void Read()
    {
        _grants.Clear();
        _storedRevocationGeneration = 0;
        var readable = true;
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) throw new JsonException("The approval document exceeds its limit.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            var document = JsonSerializer.Deserialize<StoredGrantDocument>(bytes, new JsonSerializerOptions { MaxDepth = 8 });
            if (document?.Version != 1 || document.Grants is null || document.Grants.Count > MaximumGrants || document.RevocationGeneration < 0)
                throw new JsonException("Unsupported approval document.");
            _storedRevocationGeneration = document.RevocationGeneration;
            _revocationGeneration = Math.Max(_revocationGeneration, _storedRevocationGeneration);
            // An explicit withdrawal in another process also withdraws an approval that
            // this process could not save. An unrelated future save must not restore it.
            _sessionGrants.RemoveAll(grant => grant.Generation < _storedRevocationGeneration);
            // The reader fills a missing or null member with null whatever the declared
            // type says, so every entry and every string in it is checked before use.
            foreach (var grant in document.Grants)
            {
                if (grant is null || !grant.IsWellFormed()) throw new JsonException("An approval entry is not well formed.");
                _grants.Add(grant);
            }
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            // Nothing is trusted from a state file that could not be read in full.
            _grants.Clear();
            readable = false;
            Persisted = false;
            Notice = "Saved approvals could not be read, so nothing is approved on this device. Your files and their data are unaffected; approve again to allow automatic actions.";
        }
        _grants.RemoveAll(grant => _sessionRevocations.Contains((grant.ApplicationId, grant.InstanceId)));
        foreach (var pending in _sessionGrants)
            if (!_grants.Contains(pending.Grant)) _grants.Add(pending.Grant);
        // Merged approvals are held to the same bound as saved ones, oldest first, or the
        // next save would write a document every later read refuses as a whole.
        if (_grants.Count > MaximumGrants) _grants.RemoveRange(0, _grants.Count - MaximumGrants);
        if (_sessionGrants.Count != 0 || _sessionRevocations.Count != 0)
            Notice = "This approval change applies for now, but could not be saved for the next launch.";
        else if (readable)
        {
            Persisted = true;
            Notice = null;
        }
    }

    public bool IsGranted(NendoBehaviourGrant required)
    {
        ArgumentNullException.ThrowIfNull(required);
        lock (_sync)
        {
            Read();
            return _grants.Any(stored => stored.Matches(required));
        }
    }

    /// <summary>Records consent for exactly this behaviour, in this file, at this revision.</summary>
    internal void Approve(NendoBehaviourGrant grant)
    {
        ArgumentNullException.ThrowIfNull(grant);
        Change(() =>
        {
            var stored = StoredGrant.From(grant);
            if (!_sessionGrants.Any(pending => pending.Grant == stored))
                _sessionGrants.Add((stored, _storedRevocationGeneration));
            if (_grants.Contains(stored)) return;
            if (_grants.Count >= MaximumGrants) _grants.RemoveAt(0);
            _grants.Add(stored);
        });
    }

    /// <summary>Withdraws every approval for one file, including approvals another process kept.</summary>
    internal void Revoke(string applicationId, string instanceId) => Change(() =>
    {
        _sessionRevocations.Add((applicationId, instanceId));
        _sessionGrants.RemoveAll(pending => pending.Grant.ApplicationId == applicationId && pending.Grant.InstanceId == instanceId);
        _grants.RemoveAll(stored => stored.ApplicationId == applicationId && stored.InstanceId == instanceId);
        // Before the write: an unsaved withdrawal still applies to this session.
        _revocationGeneration++;
    });

    private void Change(Action change)
    {
        lock (_sync)
        {
            try
            {
                using var guard = DesktopDeviceStateLock.EnterRequired(StatePath);
                Read();
                change();
                Save();
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // No shared write without serialization. Retain only this session's explicit
                // choices, which will be merged with a fresh document on the next save.
                Read();
                change();
                Persisted = false;
                Notice = "This approval change applies for now, but could not be saved for the next launch.";
            }
        }
    }

    private void Save()
    {
        string? ownedStage = null;
        try
        {
            Directory.CreateDirectory(_root);
            var stage = Path.Combine(_root, $"behaviour-grants-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                ownedStage = stage;
                JsonSerializer.Serialize(stream, new StoredGrantDocument(1, _grants, _revocationGeneration));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
            ownedStage = null;
            Persisted = true;
            Notice = null;
            _sessionGrants.Clear();
            _sessionRevocations.Clear();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // The approval stands for this session; it will have to be given again next
            // launch. Saying so is better than either losing it silently or pretending
            // it was stored.
            Persisted = false;
            Notice = "This approval change applies for now, but could not be saved for the next launch.";
        }
        finally
        {
            if (ownedStage is not null)
            {
                try { File.Delete(ownedStage); }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
            }
        }
    }

    private sealed record StoredGrantDocument(int Version, IReadOnlyList<StoredGrant?> Grants, long RevocationGeneration = 0);

    private sealed record StoredGrant(
        string ApplicationId,
        string InstanceId,
        string BehaviourDigest,
        string ContractVersion,
        long DefinitionRevision,
        int Capabilities)
    {
        internal static StoredGrant From(NendoBehaviourGrant grant) => new(
            grant.ApplicationId, grant.InstanceId, grant.BehaviourDigest,
            grant.ContractVersion, grant.DefinitionRevision, (int)grant.Capabilities);

        internal bool IsWellFormed() =>
            !string.IsNullOrWhiteSpace(ApplicationId) && ApplicationId.Length <= 200 &&
            !string.IsNullOrWhiteSpace(InstanceId) && InstanceId.Length <= 200 &&
            BehaviourDigest is { Length: 64 } && BehaviourDigest.All(Uri.IsHexDigit) &&
            !string.IsNullOrWhiteSpace(ContractVersion) && ContractVersion.Length <= 64 &&
            DefinitionRevision >= 0 && Capabilities is >= 0 and <= 7;

        internal bool Matches(NendoBehaviourGrant required) =>
            string.Equals(ApplicationId, required.ApplicationId, StringComparison.Ordinal) &&
            string.Equals(InstanceId, required.InstanceId, StringComparison.Ordinal) &&
            string.Equals(BehaviourDigest, required.BehaviourDigest, StringComparison.Ordinal) &&
            string.Equals(ContractVersion, required.ContractVersion, StringComparison.Ordinal) &&
            DefinitionRevision == required.DefinitionRevision &&
            Capabilities == (int)required.Capabilities;
    }
}
