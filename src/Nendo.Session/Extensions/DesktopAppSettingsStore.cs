using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Session;

/// <summary>
/// The personal values of the settings apps declare (ADR-0038), kept on this computer by package
/// ID, so a choice holds for every file that carries the app. Device preference, never in the
/// file: a copy of the file carries the app's defaults and its shared values, not these.
/// <para>
/// Fails soft, like the appearance store: a document that cannot be read leaves every app on the
/// file's values and its defaults, and the next change starts it again. Each read takes the
/// document as it is now, so a choice made in another window is this one's too.
/// </para>
/// </summary>
internal sealed class DesktopAppSettingsStore
{
    internal const int MaximumBytes = 256 * 1024;
    internal const int MaximumPackages = 256;
    internal const int MaximumSettingsPerPackage = 64;
    private readonly string _root;
    private string StatePath => Path.Combine(_root, "app-settings.json");

    internal DesktopAppSettingsStore(string root)
    {
        _root = DesktopDeviceStateLayout.Views(root);
    }

    /// <summary>A sentence when the kept values could not be read, else null.</summary>
    internal string? Notice { get; private set; }

    /// <summary>This computer's values for one package, by setting ID.</summary>
    internal IReadOnlyDictionary<string, JsonElement> Values(string packageId) =>
        Stored().TryGetValue(packageId, out var values) ? values : new Dictionary<string, JsonElement>(StringComparer.Ordinal);

    /// <summary>
    /// Keeps one value, or with null takes it away. The caller has checked it against the
    /// package's declaration; this keeps it bounded.
    /// </summary>
    internal void Set(string packageId, string settingId, JsonElement? value)
    {
        using var guard = DesktopDeviceStateLock.Enter("views.app-settings");
        var stored = Stored().ToDictionary(pair => pair.Key, pair => new Dictionary<string, JsonElement>(pair.Value, StringComparer.Ordinal), StringComparer.Ordinal);
        if (!stored.TryGetValue(packageId, out var values)) stored[packageId] = values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        if (value is { } kept) values[settingId] = kept.Clone(); else values.Remove(settingId);
        if (values.Count == 0) stored.Remove(packageId);
        if (stored.Count > MaximumPackages) throw new NendoValidationException($"This computer keeps settings for at most {MaximumPackages} apps.");
        if (values.Count > MaximumSettingsPerPackage) throw new NendoValidationException($"An app keeps at most {MaximumSettingsPerPackage} settings.");
        var document = new StoredAppSettings(1, stored);
        var bytes = JsonSerializer.SerializeToUtf8Bytes(document);
        if (bytes.Length > MaximumBytes) throw new NendoValidationException("That value would make this computer's app settings too large to keep.");
        try
        {
            DesktopStateFile.Replace(_root, StatePath, "app-settings", stream => stream.Write(bytes));
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new NendoPreconditionException("setting-not-saved", "That choice could not be kept on this computer.");
        }
    }

    private Dictionary<string, Dictionary<string, JsonElement>> Stored()
    {
        try
        {
            var document = DesktopStateFile.Read<StoredAppSettings>(StatePath, MaximumBytes, 8);
            if (document is not { Version: 1, Packages: { } packages }) throw new JsonException("Unsupported app settings document.");
            Notice = null;
            return packages.ToDictionary(pair => pair.Key, pair => new Dictionary<string, JsonElement>(pair.Value, StringComparer.Ordinal), StringComparer.Ordinal);
        }
        catch (Exception exception) when (exception is FileNotFoundException or DirectoryNotFoundException)
        {
            return new(StringComparer.Ordinal);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            Notice = "This computer's app settings could not be read. Apps use the file's values and their defaults.";
            return new(StringComparer.Ordinal);
        }
    }

    private sealed record StoredAppSettings(int Version, Dictionary<string, Dictionary<string, JsonElement>> Packages);
}
