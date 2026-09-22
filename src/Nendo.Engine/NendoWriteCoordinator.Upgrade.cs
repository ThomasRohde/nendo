using Nendo.Engine.Storage;

namespace Nendo.Engine;

public sealed partial class NendoWriteCoordinator
{
    private readonly Dictionary<string, UpgradeContext> _upgrades = new(StringComparer.Ordinal);
    internal Action<string>? UpgradeCheckpoint { get; set; }
    internal Action? BeforeUpgradeCommit { get; set; }
    internal int? UpgradeMaximumPageCountForTest { get; set; }

    public async Task<NendoUpgradePlan> PrepareUpgradeAsync(string requestId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        if (requestId.Length > 200) throw new NendoValidationException("The upgrade request ID is too long.");
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            if (_upgrades.TryGetValue(requestId, out var previous)) return previous.Plan;
            if (_upgrades.Count >= 32) throw new NendoPreconditionException("upgrade-session-limit", "Reopen the file before preparing another upgrade.");
            var inspected = await InspectUpgradeSourceAsync(cancellationToken);
            var id = $"upgrade-{Guid.NewGuid():N}";
            var retained = $"{Path.GetFileNameWithoutExtension(_path)}.pre-upgrade-{id[8..]}.nendo";
            var current = inspected.Inspection.Manifest!;
            var upgraded = current with { MinimumHostVersion = NendoFormat.SemanticMinimumHostVersion };
            var retention = "The pre-upgrade file and receipt stay beside the application without automatic expiry or deletion.";
            // Two staging copies, rollback journal and bounded metadata headroom.
            // An estimate for confirmation, never a guarantee of available space.
            var estimatedBytes = checked(_pathPin!.Length * 3 + 16 * 1024 * 1024);
            var plan = new NendoUpgradePlan(id, SqliteNendoStore.LegacyUpgradeId, FileName, retained,
                SqliteNendoStore.LegacyUpgradeSourceLayout, SqliteNendoStore.LegacyUpgradeTargetLayout,
                current, upgraded, estimatedBytes, retention);
            var observation = new NendoFileObservation(inspected.Inspection, LocalFileIdentity.Read(_pathPin).Key, inspected.ContentDigest);
            // Common replacement engine is private and bounded to Restore or this
            // registered upgrade. It is not a generic caller-supplied transform.
            var replacement = new RestoreContext(new(id, FileName, retained, current, upgraded, 0, retention),
                _path, observation, inspected.ContentDigest!, null, LocalFileIdentity.Read(_pathPin), RestoreProposalStamp());
            _upgrades.Add(requestId, new(plan, replacement));
            return plan;
        }
        finally { _gate.Release(); }
    }

    public async Task<NendoUpgradeResult> UpgradeAsync(string planId, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed || _replacementRetired, this);
            var context = _upgrades.Values.SingleOrDefault(value => value.Plan.PlanId == planId)
                ?? throw new NendoPreconditionException("upgrade-plan-not-found", "Prepare and review a new upgrade before continuing.");
            var current = await InspectUpgradeSourceAsync(cancellationToken);
            if (current.ContentDigest != context.Replacement.CurrentDigest)
                throw new NendoPreconditionException("upgrade-source-changed", "The older file changed after confirmation. Inspect it again.");
            if (_instanceOwnership is null)
            {
                _instanceOwnership = InstanceOwnershipLease.Acquire(context.Plan.Current.InstanceId);
                try { _ownership = WriteOwnershipLease.Acquire(_path, $"upgrade-{Environment.ProcessId}"); }
                catch { _instanceOwnership.Dispose(); _instanceOwnership = null; throw; }
            }
            var result = await ExecuteReplacementCoreAsync(context.Replacement, upgrade: true, cancellationToken);
            return new(result.PlanId, context.Plan.UpgradeId, result.FileName, result.RetainedFileName, result.ReceiptFileName, result.Manifest)
            {
                OpenObservation = result.OpenObservation,
            };
        }
        finally { _gate.Release(); }
    }

    private async Task<InspectedNendoFile> InspectUpgradeSourceAsync(CancellationToken cancellationToken)
    {
        if (_readOnlySnapshot is null || _pathPin is null || _proposals.Count != 0)
            throw new NendoPreconditionException("upgrade-unavailable", "Open a recognised older file for recovery inspection before upgrading it.");
        var inspected = await SqliteNendoStore.InspectAsync(_path, cancellationToken);
        if (!SqliteNendoStore.CanUpgradeLegacy(inspected))
            throw new NendoPreconditionException("upgrade-source-unsupported", "This file does not match a registered production upgrade path. No migration or repair was attempted.");
        if (inspected.ContentDigest != _readOnlyContentDigest)
            throw new NendoPreconditionException("upgrade-source-changed", "The older file changed since inspection. Reopen it before upgrading.");
        return inspected;
    }

    private sealed record UpgradeContext(NendoUpgradePlan Plan, RestoreContext Replacement);
}
