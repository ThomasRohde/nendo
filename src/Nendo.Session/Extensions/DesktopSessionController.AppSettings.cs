using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// The personal values of the settings apps declare (ADR-0038): kept on this computer by package,
/// checked against the open file's declaration with the Engine's own rule, never in the file.
/// </summary>
internal sealed partial class DesktopSessionController
{
    private DesktopAppSettingsStore? _appSettings;

    private DesktopAppSettingsStore AppSettings => _appSettings ??= new DesktopAppSettingsStore(_deviceStateRoot);

    /// <summary>This computer's values for a package that still fit what it declares now.</summary>
    private IReadOnlyDictionary<string, JsonElement> PersonalSettings(NendoExtensionPackageSnapshot package)
    {
        if (package.Settings.Count == 0) return new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var kept = AppSettings.Values(package.PackageId);
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var declaration in package.Settings)
            if (NendoPackageSettings.AllowsPersonal(declaration) && kept.TryGetValue(declaration.Id, out var value)
                && NendoPackageSettings.Fits(declaration, value, out _))
                values[declaration.Id] = value;
        return values;
    }

    /// <summary>
    /// Keeps this computer's value for one of the open file's app settings, or with null takes it
    /// away, then tells every window, whose views hear it as <c>settingsChanged</c>.
    /// </summary>
    internal async Task<DesktopSessionView> SetPackageSettingAsync(string packageId, string settingId, JsonElement value, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var service = _service ?? throw new NendoPreconditionException("no-file-open", "Open a file before changing an app's settings.");
            var snapshot = await service.GetDefinitionSnapshotAsync(cancellationToken);
            var package = snapshot.ExtensionPackages.FirstOrDefault(item => string.Equals(item.PackageId, packageId, StringComparison.Ordinal))
                ?? throw new NendoPreconditionException("extension-package-not-found", $"This file carries no package {packageId}.");
            var declaration = package.Settings.FirstOrDefault(item => string.Equals(item.Id, settingId, StringComparison.Ordinal))
                ?? throw new NendoPreconditionException("package-setting-not-found", $"The package {packageId} declares no setting {settingId}.");
            if (!NendoPackageSettings.AllowsPersonal(declaration))
                throw new NendoPreconditionException("package-setting-shared", $"The setting {settingId} of {packageId} is kept in the file, for everyone who opens it: change it with a proposal.");
            if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            {
                AppSettings.Set(packageId, settingId, null);
            }
            else
            {
                if (!NendoPackageSettings.Fits(declaration, value, out var reason))
                    throw new NendoPreconditionException("package-setting-invalid", reason ?? $"That is not a value of the setting {settingId}.");
                AppSettings.Set(packageId, settingId, value);
            }
            ExtensionSettingsChanged?.Invoke();
            return await ReadViewAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }
}
