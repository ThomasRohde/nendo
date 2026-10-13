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
        if (ReadStored() is { } stored) Take(stored);
    }

    /// <summary>
    /// Reads the document again, so a choice made in another window is this one's as well.
    /// <para>
    /// Every open file is a window of its own, in a process of its own, and each used to keep
    /// what it read at startup: the window that had not been told about another one's choice
    /// went on recording, and the next thing it saved put the old choice back (DSH-09). A
    /// document that cannot be read leaves what this window has.
    /// </para>
    /// </summary>
    internal void Refresh()
    {
        if (ReadStored() is { } stored) Take(stored);
    }

    internal DesktopShellView View() => new(CloseAction, TrayIntroShown, RecordViewFailures, Persisted, Notice);

    internal void SetCloseAction(string closeAction)
    {
        if (!IsCloseAction(closeAction))
            throw new NendoValidationException("The close button either minimises to the notification area or exits.");
        if (string.Equals(CloseAction, closeAction, StringComparison.Ordinal)) return;
        Change(stored => stored with { CloseAction = closeAction },
            "The close behaviour applies to this window, but could not be saved for the next launch.");
    }

    internal void SetRecordViewFailures(bool record)
    {
        if (RecordViewFailures == record) return;
        Change(stored => stored with { RecordViewFailures = record },
            "View-failure recording applies to this window, but the choice could not be saved for the next launch.");
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
        Change(stored => stored with { TrayIntroShown = true },
            "The notification-area notice was shown, but could not be recorded for the next launch.");
    }

    /// <summary>
    /// One field changed, on the document as it is now rather than as this window last read it,
    /// so another window's choice in the other fields survives. Read and written under the
    /// device-state lock; failing to take it within a second goes ahead unguarded, as every
    /// fail-soft store does.
    /// </summary>
    private void Change(Func<StoredShell, StoredShell> change, string failureNotice)
    {
        var next = change(Current());
        try
        {
            using var guard = DesktopDeviceStateLock.Enter("shell");
            // A missing or unreadable document holds no other window's choice to keep.
            next = change(ReadStored() ?? Current());
            DesktopStateFile.Replace(_root, StatePath, "shell", stream => JsonSerializer.Serialize(stream, next));
            Persisted = true;
            Notice = null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            Persisted = false;
            Notice = failureNotice;
        }
        Take(next);
    }

    private StoredShell Current() => new(1, CloseAction, TrayIntroShown, RecordViewFailures);

    private void Take(StoredShell stored)
    {
        CloseAction = stored.CloseAction;
        TrayIntroShown = stored.TrayIntroShown;
        // Absent in a document written before this existed, which is a device that
        // has never chosen: it gets the default rather than an off it never asked for.
        RecordViewFailures = stored.RecordViewFailures ?? true;
    }

    /// <summary>The saved document, or null when there is none or it cannot be read.</summary>
    private const string ReadFailureNotice = "The saved close behaviour could not be read. The close button minimises to the notification area; the tray menu still exits.";

    private StoredShell? ReadStored()
    {
        try
        {
            var bytes = DesktopStateFile.ReadBytes(StatePath, MaximumBytes, "Shell document exceeds its limit.");
            var document = JsonSerializer.Deserialize<StoredShell>(bytes, new JsonSerializerOptions { MaxDepth = 4 });
            if (document?.Version != 1 || !IsCloseAction(document.CloseAction)) throw new JsonException("Unsupported shell document.");
            ForgetReadFailure();
            return document;
        }
        catch (FileNotFoundException) { ForgetReadFailure(); return null; }
        catch (DirectoryNotFoundException) { ForgetReadFailure(); return null; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            Persisted = false;
            Notice = ReadFailureNotice;
            return null;
        }
    }

    /// <summary>A read that worked takes back what an earlier one that failed said, and only that.</summary>
    private void ForgetReadFailure()
    {
        if (!string.Equals(Notice, ReadFailureNotice, StringComparison.Ordinal)) return;
        Notice = null;
        Persisted = true;
    }

    private static bool IsCloseAction(string? value) => value is "tray" or "exit";

    private sealed record StoredShell(int Version, string CloseAction, bool TrayIntroShown, bool? RecordViewFailures);
}
