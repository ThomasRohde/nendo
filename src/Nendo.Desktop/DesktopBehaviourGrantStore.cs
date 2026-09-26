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
    private readonly List<StoredGrant> _grants = [];

    private string StatePath => Path.Combine(_root, "behaviour-grants.json");

    internal static string DefaultRoot => DesktopAppearanceStore.DefaultRoot;

    /// <summary>Set when the stored state could not be read, so the owner can be told why they are being asked again.</summary>
    internal string? Notice { get; private set; }

    internal bool Persisted { get; private set; } = true;

    public long RevocationGeneration { get; private set; }

    internal DesktopBehaviourGrantStore(string root)
    {
        _root = Path.GetFullPath(root);
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) throw new JsonException("The approval document exceeds its limit.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            var document = JsonSerializer.Deserialize<StoredGrantDocument>(bytes, new JsonSerializerOptions { MaxDepth = 8 });
            if (document?.Version != 1 || document.Grants is null || document.Grants.Count > MaximumGrants)
                throw new JsonException("Unsupported approval document.");
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
            Persisted = false;
            Notice = "Saved approvals could not be read, so nothing is approved on this device. Your files and their data are unaffected; approve again to allow automatic actions.";
        }
    }

    public bool IsGranted(NendoBehaviourGrant required)
    {
        ArgumentNullException.ThrowIfNull(required);
        foreach (var stored in _grants)
        {
            if (stored.Matches(required)) return true;
        }
        return false;
    }

    /// <summary>Records consent for exactly this behaviour, in this file, at this revision.</summary>
    internal void Approve(NendoBehaviourGrant grant)
    {
        ArgumentNullException.ThrowIfNull(grant);
        if (IsGranted(grant)) return;
        if (_grants.Count >= MaximumGrants) _grants.RemoveAt(0);
        _grants.Add(StoredGrant.From(grant));
        Save();
    }

    /// <summary>
    /// Withdraws every approval for one file, whatever behaviour or revision it was
    /// given for. Revoking is about the file, not about one version of its rules.
    /// </summary>
    internal void Revoke(string applicationId, string instanceId)
    {
        var removed = _grants.RemoveAll(stored =>
            string.Equals(stored.ApplicationId, applicationId, StringComparison.Ordinal) &&
            string.Equals(stored.InstanceId, instanceId, StringComparison.Ordinal));
        if (removed == 0) return;
        // Moved before the write, so a save that fails still leaves the withdrawal in
        // force for this session rather than appearing not to have happened.
        RevocationGeneration++;
        Save();
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
                JsonSerializer.Serialize(stream, new StoredGrantDocument(1, _grants));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
            ownedStage = null;
            Persisted = true;
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // The approval stands for this session; it will have to be given again next
            // launch. Saying so is better than either losing it silently or pretending
            // it was stored.
            Persisted = false;
            Notice = "This approval applies for now, but could not be saved for the next launch.";
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

    private sealed record StoredGrantDocument(int Version, IReadOnlyList<StoredGrant?> Grants);

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
