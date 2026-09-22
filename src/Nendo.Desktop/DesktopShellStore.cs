using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed record DesktopShellView(string CloseAction, bool TrayIntroShown, bool RecordViewFailures, bool Persisted, string? Notice);

/// <summary>
/// What the window's close button does, and whether the notification area has been
/// explained once.
/// <para>
/// Device preference only, never application data, and deliberately **fails soft**
/// like the appearance store rather than closed like the grant store. The worst an
/// unreadable file can cost here is that a window closes the way a new installation
/// closes; nothing about authority, consent or data rests on it, so refusing to
/// start over a lost preference would be the larger failure.
/// </para>
/// </summary>
internal sealed class DesktopShellStore
{
    private const int MaximumBytes = 4096;
    private readonly string _root;
    private string StatePath => Path.Combine(_root, "shell.json");

    /// <summary>"tray" or "exit". Tray is the default: an agent's work outlives the window.</summary>
    internal string CloseAction { get; private set; } = "tray";

    /// <summary>Whether this device has already been told where the window went.</summary>
    internal bool TrayIntroShown { get; private set; }

    /// <summary>
    /// Whether to keep a device-local record when the app view stops responding.
    /// <para>
    /// On unless it is switched off, which is the opposite of how a log usually
    /// arrives. A view failure is rare, costs the person their window, and leaves
    /// nothing behind: asking them to have turned recording on beforehand is asking
    /// them to have predicted it. The tray menu switches it off in one click, and
    /// the record is capped and carries no file path, identity or record contents.
    /// </para>
    /// </summary>
    internal bool RecordViewFailures { get; private set; } = true;

    internal bool Persisted { get; private set; } = true;
    internal string? Notice { get; private set; }

    internal static string DefaultRoot => DesktopAppearanceStore.DefaultRoot;

    internal DesktopShellStore(string root)
    {
        _root = Path.GetFullPath(root);
        try
        {
            using var stream = new FileStream(StatePath, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete);
            if (stream.Length > MaximumBytes) throw new JsonException("Shell document exceeds its limit.");
            var bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
            var document = JsonSerializer.Deserialize<StoredShell>(bytes, new JsonSerializerOptions { MaxDepth = 4 });
            if (document?.Version != 1 || !IsCloseAction(document.CloseAction)) throw new JsonException("Unsupported shell document.");
            CloseAction = document.CloseAction;
            TrayIntroShown = document.TrayIntroShown;
            // Absent in a document written before this existed, which is a device that
            // has never chosen: it gets the default rather than an off it never asked for.
            RecordViewFailures = document.RecordViewFailures ?? true;
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            Persisted = false;
            Notice = "The saved close behaviour could not be read. The close button minimises to the notification area; the tray menu still exits.";
        }
    }

    internal DesktopShellView View() => new(CloseAction, TrayIntroShown, RecordViewFailures, Persisted, Notice);

    internal void SetCloseAction(string closeAction)
    {
        if (!IsCloseAction(closeAction))
            throw new NendoValidationException("The close button either minimises to the notification area or exits.");
        if (string.Equals(CloseAction, closeAction, StringComparison.Ordinal)) return;
        CloseAction = closeAction;
        Save("The close behaviour applies to this window, but could not be saved for the next launch.");
    }

    internal void SetRecordViewFailures(bool record)
    {
        if (RecordViewFailures == record) return;
        RecordViewFailures = record;
        Save("View-failure recording applies to this window, but the choice could not be saved for the next launch.");
    }

    /// <summary>
    /// Records that the one-time explanation has been shown. Set before the notice is
    /// raised rather than after: showing it twice is a worse outcome than not showing
    /// it at all, and a device whose state root is unwritable would otherwise explain
    /// the notification area on every single close.
    /// </summary>
    internal void MarkTrayIntroShown()
    {
        if (TrayIntroShown) return;
        TrayIntroShown = true;
        Save("The notification-area notice was shown, but could not be recorded for the next launch.");
    }

    private void Save(string failureNotice)
    {
        string? ownedStage = null;
        try
        {
            Directory.CreateDirectory(_root);
            var stage = Path.Combine(_root, $"shell-{Guid.NewGuid():N}.tmp");
            using (var stream = new FileStream(stage, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            {
                ownedStage = stage;
                JsonSerializer.Serialize(stream, new StoredShell(1, CloseAction, TrayIntroShown, RecordViewFailures));
                stream.Flush(flushToDisk: true);
            }
            File.Move(stage, StatePath, overwrite: true);
            ownedStage = null;
            Persisted = true;
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            Persisted = false;
            Notice = failureNotice;
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

    private static bool IsCloseAction(string? value) => value is "tray" or "exit";

    private sealed record StoredShell(int Version, string CloseAction, bool TrayIntroShown, bool? RecordViewFailures);
}
