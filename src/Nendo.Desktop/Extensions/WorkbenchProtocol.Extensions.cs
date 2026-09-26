using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static partial class WorkbenchMethods
{
    /// <summary>Turn custom views on or off for this device (<c>device</c>) or for the open file (<c>file</c>).</summary>
    internal const string ExtensionSettingsSet = "extension.settings.set";

    /// <summary>Pick a package folder, zip or legacy archive and prepare a proposal that puts it into the file.</summary>
    internal const string ExtensionImport = "extension.import";

    /// <summary>Write a package the file carries to a new folder, with its manifest, so it can be edited and imported again.</summary>
    internal const string ExtensionExport = "extension.export";

    /// <summary>Prepare a proposal that takes a package and its files out of the file.</summary>
    internal const string ExtensionRemove = "extension.remove";

    /// <summary>Pick a folder and develop a package of the open file from it, on this device (ADR-0013 Phase 4).</summary>
    internal const string ExtensionDevelopLink = "extension.develop.link";

    /// <summary>Stop developing a package from its folder: its views run the file's reviewed code again.</summary>
    internal const string ExtensionDevelopStop = "extension.develop.stop";

    /// <summary>Prepare the proposal Import would prepare from a developed package's folder.</summary>
    internal const string ExtensionDevelopSave = "extension.develop.save";

    /// <summary>A custom view's kept values (<c>nendo.state</c>), only with its actor: one key, or every key with its version.</summary>
    internal const string ExtensionStateRead = "extension.state.read";

    /// <summary>Keep, replace or remove one value of a custom view, only with its actor.</summary>
    internal const string ExtensionStateSet = "extension.state.set";

    /// <summary>
    /// The only methods a request may carry a custom view's actor on (ADR-0013 Phase 3): the
    /// record writes a person's own edit uses. A read carries no actor, and every other method
    /// -- proposals, behaviour, agents, files, sessions, appearance, compensation -- refuses one
    /// with <c>actor-not-allowed</c>. tests/Nendo.Desktop.Tests pins the set.
    /// </summary>
    internal static readonly IReadOnlySet<string> ExtensionWriterMethods = new HashSet<string>(StringComparer.Ordinal)
    {
        DataCreateRecord, DataSetFields, DataDeleteRecord, DataExecuteCommand,
        ProposalPrepareChangeSet, ProposalGet, ExtensionStateRead, ExtensionStateSet,
    };
}

/// <summary>
/// What custom views need from the page that owns the window: the native pickers for package
/// import and export, and, for the journeys, which browser process holds which view.
/// </summary>
internal interface IWorkbenchExtensionHost
{
    /// <summary>A <c>nendo-package.json</c> (meaning its folder), a zip or a <c>.nendoview</c>; null when the person cancels.</summary>
    Task<string?> PickPackageSourceAsync();

    /// <summary>The folder an exported package's own folder is created in; null when the person cancels.</summary>
    Task<string?> PickExportFolderAsync();

    /// <summary>The folder a package is developed from; null when the person cancels.</summary>
    Task<string?> PickDevelopmentFolderAsync();

    /// <summary>The browser's processes and the frames each holds; answered only under NENDO_NATIVE_DIAGNOSTICS=1.</summary>
    Task<IReadOnlyList<ExtensionFrameProcess>> ReadFrameProcessesAsync();
}

internal sealed record ExtensionImportCancelled(bool Cancelled = true);

/// <summary>A view's kept values: each key with its JSON value (null when only keys were asked for) and its version.</summary>
internal sealed record DesktopExtensionStateView(IReadOnlyList<DesktopExtensionStateEntryView> Entries);

internal sealed record DesktopExtensionStateEntryView(string Key, JsonElement? Value, long Version);

/// <summary>Where an export went, by folder name only: the Workbench is never handed a path.</summary>
internal sealed record DesktopExtensionExportView(bool Exported, int FileCount, string? FolderName);

internal sealed partial class WorkbenchProtocolHandler
{
    private IWorkbenchExtensionHost ExtensionHost() => _extensionHost ?? throw new NendoPreconditionException(
        "extension-host-unavailable", "Importing and exporting custom views is unavailable in this host.");

    private async Task<object> ImportExtensionAsync(CancellationToken cancellationToken)
    {
        var picked = await ExtensionHost().PickPackageSourceAsync();
        if (picked is null) return new ExtensionImportCancelled();
        var source = string.Equals(Path.GetFileName(picked), NendoExtensionArchives.ManifestName, StringComparison.OrdinalIgnoreCase)
            ? Path.GetDirectoryName(picked)!
            : picked;
        // Reading, unzipping and hashing up to a package's worth of files is real work; the
        // window keeps drawing while it happens.
        var archive = await Task.Run(() => NendoExtensionArchives.Read(source), cancellationToken);
        return await _session.PrepareExtensionImportAsync(archive, cancellationToken);
    }

    /// <summary>
    /// Develop from folder: the host opens its own folder picker, so the Workbench never names a
    /// path, and the answer is the session view, whose package says the folder by name only.
    /// </summary>
    private async Task<object> LinkExtensionFolderAsync(string packageId, CancellationToken cancellationToken)
    {
        var folder = await ExtensionHost().PickDevelopmentFolderAsync();
        if (folder is null) return new ExtensionImportCancelled();
        return await _session.LinkExtensionFolderAsync(packageId, folder, cancellationToken);
    }

    /// <summary>
    /// A view's kept values. The package is the actor's, never a parameter, so a view reads only
    /// its own package's state; the view ID comes from the broker's mount, or is empty for the
    /// state a package's views share.
    /// </summary>
    private async Task<DesktopExtensionStateView> ReadExtensionStateAsync(JsonElement payload, string? writer, CancellationToken cancellationToken)
    {
        var packageId = StatePackage(writer);
        var viewId = StateViewId(payload);
        string? key = payload.TryGetProperty("key", out var named) && named.ValueKind == JsonValueKind.String ? named.GetString() : null;
        var entries = await _session.ReadExtensionStateAsync(packageId, viewId, key, cancellationToken);
        return new DesktopExtensionStateView(entries.Select(entry => new DesktopExtensionStateEntryView(
            entry.Key, entry.ValueJson.Length == 0 ? null : JsonDocument.Parse(entry.ValueJson).RootElement.Clone(), entry.Version)).ToArray());
    }

    /// <summary>Keep, replace or remove one value (null) in the actor's package, as one revision History names it by.</summary>
    private async Task<DesktopMutationView> SetExtensionStateAsync(JsonElement payload, string? writer, CancellationToken cancellationToken)
    {
        var packageId = StatePackage(writer);
        var viewId = StateViewId(payload);
        var key = RequiredString(payload, "key", Nendo.Engine.NendoExtensionLimits.StateKeyCharacters);
        if (!payload.TryGetProperty("value", out var value))
            throw new NendoValidationException("Request property value is required; null removes the key.");
        long? expectedVersion = payload.TryGetProperty("expectedVersion", out var expected) && expected.ValueKind == JsonValueKind.Number
            ? expected.GetInt64() : null;
        return await _session.SetExtensionStateAsync(packageId, viewId, key,
            value.ValueKind == JsonValueKind.Null ? null : value.GetRawText(), expectedVersion,
            RequiredString(payload, "description", 200), RequiredString(payload, "idempotencyKey", 120), writer!, cancellationToken);
    }

    private static string StatePackage(string? writer) => writer is { Length: > 10 } actor
        ? actor["extension:".Length..]
        : throw new NendoPreconditionException("actor-not-allowed", "A view's state is read and written only in its package's name.");

    private static string StateViewId(JsonElement payload) =>
        payload.TryGetProperty("viewId", out var value) && value.ValueKind == JsonValueKind.String &&
        value.GetString() is { Length: <= Nendo.Engine.NendoExtensionLimits.StateViewIdCharacters } viewId
            ? viewId
            : throw new NendoValidationException("Request property viewId is required: a view's ID, or empty for the package's shared state.");

    private async Task<DesktopExtensionExportView> ExportExtensionAsync(string packageId, CancellationToken cancellationToken)
    {
        var (package, files) = await _session.ReadExtensionPackageAsync(packageId, cancellationToken);
        var parent = await ExtensionHost().PickExportFolderAsync();
        if (parent is null) return new(false, 0, null);
        var folder = Path.Combine(parent, package.PackageId);
        await Task.Run(() =>
        {
            if (Directory.Exists(folder) && Directory.EnumerateFileSystemEntries(folder).Any())
                throw new NendoPreconditionException("extension-export-exists",
                    $"A folder named {package.PackageId} with files in it is already there. Choose another place, or empty that folder first.");
            Directory.CreateDirectory(folder);
            foreach (var file in files)
            {
                var target = Path.GetFullPath(Path.Combine(folder, file.Path.Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(Path.GetFullPath(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    throw new NendoValidationException($"The package path {file.Path} does not stay inside its folder.");
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.WriteAllBytes(target, file.Content);
            }
            File.WriteAllBytes(Path.Combine(folder, NendoExtensionArchives.ManifestName), NendoExtensionArchives.Manifest(package));
        }, cancellationToken);
        return new(true, files.Count, package.PackageId);
    }
}
