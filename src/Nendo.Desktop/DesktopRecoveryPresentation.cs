using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal static class DesktopRecoveryPresentation
{
    internal static string Describe(DesktopSessionView view) => view.FileName is null
        ? "No file is open. Open a file or backup, or restart the view."
        : $"{view.FileName}\n" + (view.Health switch
        {
            "normal" => "The file session is open. Restart view to continue from your saved changes.",
            "readOnly" => "Open read-only. Editing and agent access are off.",
            _ => view.Findings.FirstOrDefault()?.Message ?? "Recovery inspection is required before editing can continue.",
        }) + (view.LocationWarning is null ? string.Empty : "\n" + view.LocationWarning.Message);

    internal static string ValidateNewFileName(string name, string extension)
    {
        var leaf = name.Trim();
        var stem = leaf.Split('.')[0].TrimEnd(' ').ToUpperInvariant();
        var deviceName = stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$" or "CLOCK$" ||
            stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) &&
            "123456789¹²³".Contains(stem[3]);
        if (deviceName || leaf.EndsWith('.'))
            throw new NendoValidationException("Choose a filename that is not a reserved Windows device name and does not end with a dot.");
        if (!leaf.EndsWith(extension, StringComparison.OrdinalIgnoreCase)) leaf += extension;
        if (leaf.Length > 180 || leaf.Length <= extension.Length || leaf.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
            leaf != Path.GetFileName(leaf) || leaf.EndsWith(' ') || leaf.EndsWith('.'))
            throw new NendoValidationException("Use a short filename without folder separators or reserved filename characters.");
        return leaf;
    }

    // Deliberate allowlist: no record/schema content, history, file/application
    // identity, source/destination paths, endpoints or device names.
    internal static byte[] DiagnosticBytes(DesktopSessionView view) => JsonSerializer.SerializeToUtf8Bytes(new
    {
        reportVersion = 1,
        createdAt = DateTimeOffset.UtcNow,
        appVersion = typeof(DesktopShellContract).Assembly.GetName().Version?.ToString(),
        view.HasFile,
        view.Health,
        view.Capabilities,
        findingCodes = view.Findings.Select(finding => finding.Code).ToArray(),
        formatVersion = view.Manifest?.FormatVersion,
        minimumHostVersion = view.Manifest?.MinimumHostVersion,
        definitionRevision = view.Manifest?.DefinitionRevision,
        dataRevision = view.Manifest?.DataRevision,
        changeSequence = view.Manifest?.ChangeSequence,
        pendingReplacement = view.ReplacementRecovery?.HasPendingReplacement,
        agentCleanupNeedsAttention = view.AgentCleanupNotice is not null,
        locationWarningCode = view.LocationWarning?.Code,
    }, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true });
}
