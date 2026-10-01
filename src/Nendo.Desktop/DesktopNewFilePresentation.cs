using System.Diagnostics;
using System.Globalization;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>The words and the window for a new file of the open application (ADR-0022).</summary>
internal static class DesktopNewFilePresentation
{
    /// <summary>What the new file keeps and leaves out, before the person chooses where it goes.</summary>
    internal static string Summary(NendoNewFilePreview preview, string? fileName)
    {
        var kept = preview.Types.Where(type => type.Kept > 0).Select(type => Count(type.Kept, type.DisplayName)).ToArray();
        var keeps = kept.Length == 0
            ? "It starts with no records."
            : $"It starts with {Join(kept)}.";
        var source = fileName ?? "this file";
        return $"A new file of this application, with its record types, screens and custom views. {keeps}\n\n" +
            $"It leaves out {preview.LeftOut.ToString("N0", CultureInfo.CurrentCulture)} record{(preview.LeftOut == 1 ? "" : "s")} of {source}'s work, " +
            $"and folds its {preview.Revisions.ToString("N0", CultureInfo.CurrentCulture)} changes of history into one. {source} stays as it is.\n\n" +
            "The new file asks again before its automatic actions run on this device.";
    }

    /// <summary>Why no new file can be made: each kept record that points at one left out.</summary>
    internal static string Conflicts(NendoNewFilePreview preview, IReadOnlyList<NendoEntitySnapshot> entities)
    {
        string Type(string entityId) => entities.FirstOrDefault(entity => entity.EntityId == entityId)?.DisplayName ?? entityId;
        string Field(string entityId, string fieldId) =>
            entities.FirstOrDefault(entity => entity.EntityId == entityId)?.Fields.FirstOrDefault(field => field.FieldId == fieldId)?.DisplayName ?? fieldId;
        var lines = preview.Conflicts.Select(conflict =>
            $"• {Type(conflict.EntityId)} {conflict.RecordId}: its {Field(conflict.EntityId, conflict.FieldId)} is {Type(conflict.TargetEntityId)} {conflict.TargetRecordId}, which is left out.");
        var more = preview.ConflictCount > preview.Conflicts.Count
            ? $"\n…and {(preview.ConflictCount - preview.Conflicts.Count).ToString("N0", CultureInfo.CurrentCulture)} more."
            : string.Empty;
        return $"{preview.ConflictCount.ToString("N0", CultureInfo.CurrentCulture)} record{(preview.ConflictCount == 1 ? " that a new file keeps points" : "s that a new file keeps point")} at records it leaves out, " +
            "so it would hold references to nothing:\n\n" + string.Join("\n", lines) + more +
            "\n\nKeep the record it points at, or leave the pointing record out, in Studio. Nothing was changed.";
    }

    /// <summary>The name offered for the new file: the application's label, or the file's own name.</summary>
    internal static string SuggestedName(string? label, string? fileName)
    {
        var stem = label ?? $"{Path.GetFileNameWithoutExtension(fileName ?? "Untitled")} new";
        var safe = new string(stem.Select(character => Path.GetInvalidFileNameChars().Contains(character) ? ' ' : character).ToArray()).Trim();
        return $"{(safe.Length == 0 ? "Untitled" : safe)}.nendo";
    }

    /// <summary>Opens the new file the way a double-click does: in a Nendo of its own.</summary>
    internal static void OpenInItsOwnWindow(string path)
    {
        var executable = Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "Nendo.Desktop.exe");
        var start = new ProcessStartInfo(executable) { UseShellExecute = false };
        start.ArgumentList.Add(path);
        using var _ = Process.Start(start);
    }

    private static string Count(long count, string type) => $"{count.ToString("N0", CultureInfo.CurrentCulture)} {type}";

    private static string Join(IReadOnlyList<string> parts) => parts.Count switch
    {
        1 => parts[0],
        2 => $"{parts[0]} and {parts[1]}",
        _ => $"{string.Join(", ", parts.Take(parts.Count - 1))} and {parts[^1]}",
    };
}
