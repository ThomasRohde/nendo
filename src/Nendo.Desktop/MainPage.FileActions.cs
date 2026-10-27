using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.Storage.Pickers;
using Nendo.Engine;

namespace Nendo.Desktop;

public sealed partial class MainPage
{
    private bool _nativeFileActionRunning;
    private string? _fileActionNotice;
    private string? _fileActionProposalId;

    /// <summary>
    /// A file action started or stopped. The window turns it into taskbar progress: a
    /// backup of a large file and a frozen application look identical from a taskbar
    /// button, and this is the difference between them.
    /// </summary>
    internal event Action<bool>? FileActionRunning;

    /// <summary>
    /// Whether a native file action is running. Assigned through a property rather than
    /// the field so that nothing can start one without the window hearing about it.
    /// </summary>
    private bool NativeFileActionRunning
    {
        get => _nativeFileActionRunning;
        set
        {
            if (_nativeFileActionRunning == value) return;
            _nativeFileActionRunning = value;
            FileActionRunning?.Invoke(value);
        }
    }

    private async Task<DesktopFileActionView> RunWorkbenchFileActionAsync(WorkbenchFileActionRequest request)
    {
        if (NativeFileActionRunning)
            throw new NendoPreconditionException("file-action-busy", "Finish or cancel the current file action first.");
        NativeFileActionRunning = true;
        _fileActionNotice = null;
        _fileActionProposalId = null;
        try
        {
            switch (request.Action)
            {
                case WorkbenchFileAction.Create: await CreateNativeFileAsync(); break;
                case WorkbenchFileAction.Open: await OpenNativeFileAsync(); break;
                case WorkbenchFileAction.OpenRecent: await OpenRecentNativeFileAsync(request.RecentId!); break;
                case WorkbenchFileAction.OpenDropped: await OpenNativeFileAsync(request.DroppedPath!); break;
                case WorkbenchFileAction.Close: await CloseNativeFileAsync(); break;
                case WorkbenchFileAction.Backup: await BackupNativeFileAsync(); break;
                case WorkbenchFileAction.Duplicate: await CopyNativeFileAsync(NendoIdentityCopyKind.Duplicate); break;
                case WorkbenchFileAction.Fork: await CopyNativeFileAsync(NendoIdentityCopyKind.Fork); break;
                case WorkbenchFileAction.NewFile: await NewNativeFileAsync(); break;
                case WorkbenchFileAction.Restore: await RestoreNativeFileAsync(); break;
                case WorkbenchFileAction.Upgrade: await UpgradeNativeFileAsync(); break;
                case WorkbenchFileAction.Inspect: await InspectNativeFileAsync(); break;
                case WorkbenchFileAction.Diagnostics: await SaveNativeDiagnosticsAsync(); break;
                case WorkbenchFileAction.Export: await ExportNativeDataAsync(); break;
                case WorkbenchFileAction.ImportCsv: await ImportCsvNativeAsync(); break;
                case WorkbenchFileAction.ExportCsv: await ExportCsvNativeAsync(); break;
                case WorkbenchFileAction.EmbedLinkedPictures: await EmbedLinkedPicturesNativeAsync(); break;
                case WorkbenchFileAction.ResolveRecovery: await ResolveNativeRecoveryAsync(); break;
                case WorkbenchFileAction.WebPage: await WebPageNativeAsync(); break;
                default: throw new NendoValidationException("The file action is not supported.");
            }
            return await DesktopFileActionView.CaptureAsync(_session.GetViewAsync, _fileActionNotice) with { ProposalId = _fileActionProposalId };
        }
        finally
        {
            NativeFileActionRunning = false;
            await RefreshNativeRecoveryAsync();
        }
    }

    private async Task RefreshNativeRecoveryAsync()
    {
        try
        {
            // Without records: the panel sets a few states from the file name, capabilities,
            // findings and tables, and the full read put every record on the UI thread.
            var view = await _session.GetDefinitionViewAsync();
            if (_unloaded) return;
            RecoverySession.Text = DesktopRecoveryPresentation.Describe(view);
            RecoveryBackup.IsEnabled = view.Capabilities.Backup;
            RecoveryRestore.IsEnabled = DesktopRecoveryPresentation.CanReplace(view);
            RecoveryUpgrade.IsEnabled = DesktopRecoveryPresentation.CanReplace(view) && view.Findings.Any(finding => finding.Code == "upgrade-required");
            RecoveryInspect.IsEnabled = DesktopRecoveryPresentation.CanReinspect(view);
            RecoveryClose.IsEnabled = view.FileName is not null;
            RecoveryExport.IsEnabled = view.Capabilities.Export && view.Entities.Count != 0;
        }
        catch (Exception)
        {
            if (_unloaded) return;
            RecoverySession.Text = "The file session could not be inspected. Close the file or open a verified backup separately.";
            RecoveryBackup.IsEnabled = RecoveryRestore.IsEnabled = RecoveryUpgrade.IsEnabled = false;
            RecoveryExport.IsEnabled = false;
            RecoveryInspect.IsEnabled = RecoveryClose.IsEnabled = _session.HasFile;
        }
        if (!_unloaded)
        {
            RecoveryActions.IsEnabled = !NativeFileActionRunning;
            RecoveryRestart.IsEnabled = RecoveryRestartWithoutViews.IsEnabled = !NativeFileActionRunning;
            await CaptureNativeRecoveryForTestAsync();
        }
    }

    private async Task RunNativeFileActionAsync(Func<Task> action)
    {
        if (NativeFileActionRunning) return;
        NativeFileActionRunning = true;
        RecoveryActions.IsEnabled = RecoveryRestart.IsEnabled = RecoveryRestartWithoutViews.IsEnabled = false;
        RecoveryActivity.IsOpen = false;
        try
        {
            // The session's own generation, not a full read of the file to learn it.
            using var binding = _session.BindFileRequest(_session.CurrentFileSessionId);
            await action();
        }
        catch (Exception exception)
        {
            NativeNotice(DesktopRecoveryPresentation.FailureMessage(exception), InfoBarSeverity.Error);
        }
        finally
        {
            NativeFileActionRunning = false;
            await RefreshNativeRecoveryAsync();
        }
    }

    private async void RecoveryOpen_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(OpenNativeFileAsync);
    private async void RecoveryClose_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(CloseNativeFileAsync);
    private async Task CloseNativeFileAsync()
    {
        if (await ConfirmNativeAsync("Close this file?", "Saved changes remain in the file. Agent access will stop and pending proposals will be discarded.", "Close file"))
        {
            await _session.CloseAsync();
            NativeNotice("File closed. Saved changes remain in the file.");
        }
    }
    private async void RecoveryInspect_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(InspectNativeFileAsync);
    private async Task InspectNativeFileAsync()
    {
        await _session.ReinspectCurrentAsync();
        NativeNotice("The file was inspected again and is open without write access.");
    }

    private async Task OpenNativeFileAsync() => await OpenNativeFileAsync(await PickOpenPathAsync());

    /// <summary>
    /// Opens a file somebody has already chosen: from the picker, or by dragging it onto
    /// the window. One path for both, so a dropped file meets the same instance-collision
    /// warning, the same read-only fallback and the same unsupported-location question as
    /// one picked from the dialog — a drop is a shortcut, not a different way in.
    /// </summary>
    private async Task OpenNativeFileAsync(string? path)
    {
        if (path is null) return;
        // Open in another window already: go there, and leave this window's file open.
        if (await Task.Run(() => DesktopWindowHandoff.TryShowOwnerOf(path))) return;
        if (AlreadyOpenHere(path)) return;
        await OpenNativeAssessmentAsync(await _session.AssessOpenAsync(path));
    }

    /// <summary>
    /// The file chosen is the one open here: nothing to do. It used to be closed and opened
    /// again, ending agent access and discarding pending proposals for no change.
    /// </summary>
    private bool AlreadyOpenHere(string path)
    {
        if (!_session.IsOpenFile(path)) return false;
        NativeNotice("This file is already open here.");
        return true;
    }

    private const string CloseNotice = "The current file will close. Saved changes remain; agent access stops and pending proposals are discarded.";

    private async Task CreateNativeFileAsync()
    {
        var destination = await PickNewDestinationAsync("Create Nendo file", "Untitled.nendo", ".nendo");
        if (destination is null) return;
        await _session.CreateAsync(destination);
        NativeNotice("Nendo file created. Your workspace is ready.");
    }

    private async Task OpenRecentNativeFileAsync(string recentId)
    {
        if (await _session.ResolveRecentPathAsync(recentId) is { } path)
        {
            if (await Task.Run(() => DesktopWindowHandoff.TryShowOwnerOf(path))) return;
            if (AlreadyOpenHere(path)) return;
        }
        await OpenNativeAssessmentAsync(await _session.AssessRecentAsync(recentId));
    }

    private async Task OpenNativeAssessmentAsync(DesktopFileOpenAssessment assessment)
    {
        if (!assessment.Inspection.Capabilities.ReadData)
            throw new NendoFileOpenException(assessment.Inspection);
        var body = assessment.KnownInstanceCollision
            ? $"Another known file, {assessment.KnownOriginalFileName}, carries the same instance identity. Open that original, or inspect this copy without changing it."
            : assessment.Inspection.CanAcquireWriteAuthority
                ? "Open this application for editing, or choose read-only inspection."
                : string.Join("\n", assessment.Inspection.Findings.Select(finding => finding.Message));
        // Said here, before any choice, rather than in a question of its own ahead of the
        // assessment: the open file closes only once every answer is in.
        if (_session.HasFile) body += "\n\n" + CloseNotice;
        var dialog = NativeDialog(assessment.FileName, body);
        dialog.PrimaryButtonText = assessment.KnownInstanceCollision ? "Open original" : assessment.Inspection.CanAcquireWriteAuthority ? "Open" : "Inspect read-only";
        dialog.SecondaryButtonText = assessment.KnownInstanceCollision || assessment.Inspection.CanAcquireWriteAuthority ? "Open read-only" : string.Empty;
        dialog.CloseButtonText = "Cancel";
        var choice = await dialog.ShowAsync();
        if (choice == ContentDialogResult.None) return;
        if (assessment.KnownInstanceCollision && choice == ContentDialogResult.Primary)
        {
            if (await _session.ResolveRecentPathAsync(assessment.KnownOriginalRecentId!) is { } original && AlreadyOpenHere(original)) return;
            await OpenNativeAssessmentAsync(await _session.AssessRecentAsync(assessment.KnownOriginalRecentId!));
            return;
        }
        var readOnly = choice == ContentDialogResult.Secondary || !assessment.Inspection.CanAcquireWriteAuthority;
        if (!readOnly && assessment.LocationWarning is { } warning)
        {
            var location = NativeDialog("Unsupported writable location", warning.Message);
            location.PrimaryButtonText = "Continue anyway";
            location.SecondaryButtonText = "Open read-only";
            location.CloseButtonText = "Choose another file";
            var locationChoice = await location.ShowAsync();
            if (locationChoice == ContentDialogResult.None) return;
            readOnly = locationChoice == ContentDialogResult.Secondary;
            if (!readOnly) await _session.AcknowledgeOpenLocationAsync(assessment.AssessmentId);
        }
        await OpenAssessedOrReadOnlyAsync(assessment, readOnly);
    }

    /// <summary>
    /// Opens what was assessed, closing the file open here first when there is one: the person
    /// has been told it closes and has answered every question. A writable open another session
    /// refuses offers read-only.
    /// </summary>
    private async Task OpenAssessedOrReadOnlyAsync(DesktopFileOpenAssessment assessment, bool readOnly)
    {
        try
        {
            var open = () => (Task)_session.OpenAssessedAsync(assessment.AssessmentId, readOnly, replaceCurrent: _session.HasFile);
            // A launch racing another Nendo that is opening the same file meets that open's guard
            // before it says who it is. An open from inside a window asked the owner first.
            if (readOnly || !_openingForLaunch) await open();
            else if (await DesktopStartupOpen.OpenOrHandOffAsync(open, assessment.FilePath, cancellationToken: _pageLifetime.Token))
                _handedOffAtLaunch = true;
        }
        catch (NendoWriteOwnershipException) when (!readOnly)
        {
            if (await ConfirmNativeAsync("This file is already in use", "Another Nendo session owns write access. You can inspect this file without changing it.", "Open read-only"))
                await _session.OpenAssessedAsync(assessment.AssessmentId, true, replaceCurrent: _session.HasFile);
        }
    }

    /// <summary>
    /// A launch's create (Explorer's New, or a create the command line asked for) into a folder
    /// that may be synced: the question the picker asks, here with no other folder to offer.
    /// </summary>
    private async Task<bool> ConfirmDestinationLocationAsync(string path)
    {
        if (_session.InspectDestinationLocation(path) is not { } warning) return true;
        if (!await ConfirmNativeAsync("Unsupported writable location", warning.Message, "Continue anyway")) return false;
        await _session.AcknowledgeDestinationLocationAsync(path);
        return true;
    }

    private async void RecoveryBackup_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(BackupNativeFileAsync);
    private async Task BackupNativeFileAsync()
    {
        var view = await _session.GetDefinitionViewAsync();
        var destination = await PickNewDestinationAsync("Create backup", $"{Path.GetFileNameWithoutExtension(view.FileName)}.backup.nendo", ".nendo");
        if (destination is null) return;
        var plan = await _session.PrepareBackupAsync(destination, $"native-backup-{Guid.NewGuid():N}");
        var result = await _session.CreateBackupAsync(plan.PlanId);
        NativeNotice($"Backup created: {result.DestinationFileName}. Your open file was not changed.");
    }

    /// <summary>
    /// The File menu's Web page… (ADR-0035): export this file as a page, or apply the changes made
    /// in one. One entry for both keeps the menu within a window's height.
    /// </summary>
    private async Task WebPageNativeAsync()
    {
        var form = new RadioButtons { Header = "Export as" };
        form.Items.Add(new RadioButton { Content = "One page: a single .html file to send or open from disk" });
        form.Items.Add(new RadioButton { Content = "Web app: a folder to publish, which browsers install and open offline" });
        form.SelectedIndex = 0;
        var content = new StackPanel { Spacing = 12 };
        content.Children.Add(new TextBlock
        {
            Text = "Export this file as a web page that opens in any browser with nothing installed, or apply the changes made in such a page from the file it downloaded.",
            TextWrapping = TextWrapping.Wrap,
        });
        content.Children.Add(form);
        var dialog = NativeDialog("Web page", content);
        dialog.PrimaryButtonText = "Export…";
        dialog.SecondaryButtonText = "Apply changes…";
        dialog.CloseButtonText = "Cancel";
        dialog.IsSecondaryButtonEnabled = (await _session.GetDefinitionViewAsync()).Capabilities.Mutate;
        switch (await dialog.ShowAsync())
        {
            case ContentDialogResult.Primary when form.SelectedIndex == 1: await ExportWebAppNativeAsync(); break;
            case ContentDialogResult.Primary: await ExportWebPageNativeAsync(); break;
            case ContentDialogResult.Secondary: await ApplyWebPageNativeAsync(); break;
        }
    }

    /// <summary>
    /// Export → Web app (ADR-0037): the page in an empty folder the person picks, with a manifest,
    /// the service worker and the file's look drawn as its icons, to publish on a web server.
    /// </summary>
    private async Task ExportWebAppNativeAsync()
    {
        var window = Owner ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FolderPicker(window.AppWindow.Id) { SuggestedStartLocation = PickerLocationId.DocumentsLibrary, CommitButtonText = "Export here" };
        var folder = (await picker.PickSingleFolderAsync())?.Path;
        if (folder is null) return;
        if (!await ConfirmNativeAsync("Export this file as a web app?",
            "The web app holds a copy of every record in this file. Anyone who opens it can read them, and can change their own copy. " +
            "Their changes reach this file only when you apply them with Apply changes from a web page. " +
            "Publish the folder on a web server with https, and browsers install it as an app.", "Export")) return;
        var look = _session.CurrentLook ?? throw new InvalidOperationException("The open file has no look to draw.");
        var mark = Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico");
        // A file's own picture that cannot be read or drawn falls back to its tone and letter, as its window icon does.
        IReadOnlyDictionary<int, byte[]> icons;
        try
        {
            var picture = look.Icon is { } icon ? await _session.ReadIconPictureAsync(icon) : null;
            icons = await DesktopFileIcon.DrawPngsAsync(picture is null ? look with { Icon = null } : look, mark, picture, NendoWebAppExport.IconSizes);
        }
        catch (Exception) when (look.Icon is not null)
        {
            icons = await DesktopFileIcon.DrawPngsAsync(look with { Icon = null }, mark, null, NendoWebAppExport.IconSizes);
        }
        var runtime = Path.Combine(AppContext.BaseDirectory, "WebPage");
        await _session.ExportWebAppAsync(Path.Combine(runtime, "Nendo.html"), Path.Combine(runtime, NendoWebAppExport.ServiceWorkerName), icons, folder);
        NativeNotice($"Web app written to {Path.GetFileName(Path.TrimEndingDirectorySeparator(folder))}. Publish the folder on a web server with https, and browsers install it as an app.");
    }

    /// <summary>
    /// Export → Web page (ADR-0035): one page, written where the person picks, that opens this
    /// application in a browser with a Duplicate of the file in it. The runtime ships with Nendo.
    /// </summary>
    private async Task ExportWebPageNativeAsync()
    {
        var view = await _session.GetDefinitionViewAsync();
        var destination = await PickNewDestinationAsync("Export as web page", $"{Path.GetFileNameWithoutExtension(view.FileName)}.html", ".html");
        if (destination is null) return;
        if (!await ConfirmNativeAsync("Export this file as a web page?",
            "The page holds a copy of every record in this file. Anyone who opens it can read them, and can change their own copy. " +
            "Their changes reach this file only when you apply them with Apply changes from a web page.", "Export")) return;
        await _session.ExportWebPageAsync(Path.Combine(AppContext.BaseDirectory, "WebPage", "Nendo.html"), destination);
        NativeNotice($"Web page written: {Path.GetFileName(destination)}. It opens in a browser with nothing installed.");
    }

    /// <summary>
    /// Apply changes from a web page (ADR-0035): the person picks the page's downloaded working file,
    /// and its changes come back as one proposal for them to review.
    /// </summary>
    private async Task ApplyWebPageNativeAsync()
    {
        var window = Owner ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FileOpenPicker(window.AppWindow.Id) { CommitButtonText = "Apply changes", FileTypeFilter = { ".nendo" } };
        var file = await picker.PickSingleFileAsync();
        if (file is null) return;
        var changes = await _session.PrepareWebPageChangesAsync(file.Path);
        _fileActionProposalId = changes.Proposal?.ProposalId;
        _fileActionNotice = WebPageChangesNotice.Describe(changes);
    }

    private async Task CopyNativeFileAsync(NendoIdentityCopyKind kind)
    {
        var view = await _session.GetDefinitionViewAsync();
        var label = kind == NendoIdentityCopyKind.Duplicate ? "Duplicate" : "Fork";
        var destination = await PickNewDestinationAsync($"{label} file", $"{Path.GetFileNameWithoutExtension(view.FileName)}.{label.ToLowerInvariant()}.nendo", ".nendo");
        if (destination is null) return;
        var plan = await _session.PrepareIdentityCopyAsync(kind, destination, $"desktop-copy-{Guid.NewGuid():N}");
        var meaning = kind == NendoIdentityCopyKind.Duplicate
            ? "Create an independent working copy of this application with a new instance identity. Existing records, definitions and history are preserved."
            : "Start a new application from this file, with new application and instance identities and a record of its origin. Existing records, definitions and history are preserved.";
        if (!await ConfirmNativeAsync($"{label} this file?", $"{meaning}\n\nThe copy records an irreversible identity transition. Your open file will not change.", $"Create {label.ToLowerInvariant()}")) return;
        var result = await _session.CreateIdentityCopyAsync(plan.PlanId);
        NativeNotice($"{label} created: {result.DestinationFileName}. Your original file is still open.");
    }

    /// <summary>
    /// A new file of this application (ADR-0022): what it keeps and leaves out first, then where,
    /// then the file, opened in a window of its own. The open file does not change.
    /// </summary>
    private async Task NewNativeFileAsync()
    {
        var view = await _session.GetDefinitionViewAsync();
        var preview = await _session.PreviewNewFileAsync();
        var title = preview.MenuLabel.TrimEnd('…');
        if (!preview.CanCreate)
        {
            var refusal = NativeDialog(title, new ScrollViewer { MaxHeight = 320, Content = new TextBlock { Text = DesktopNewFilePresentation.Conflicts(preview, view.Entities), TextWrapping = TextWrapping.Wrap } });
            refusal.CloseButtonText = "Close";
            await refusal.ShowAsync();
            return;
        }
        var summary = NativeDialog(title, new ScrollViewer { MaxHeight = 320, Content = new TextBlock { Text = DesktopNewFilePresentation.Summary(preview, view.FileName), TextWrapping = TextWrapping.Wrap } });
        summary.PrimaryButtonText = "Choose where";
        summary.CloseButtonText = "Cancel";
        if (await summary.ShowAsync() != ContentDialogResult.Primary) return;
        var destination = await PickNewDestinationAsync(title, DesktopNewFilePresentation.SuggestedName(preview.Label, view.FileName), ".nendo");
        if (destination is null) return;
        var result = await _session.CreateNewFileAsync(destination, $"desktop-new-{Guid.NewGuid():N}");
        DesktopNewFilePresentation.OpenInItsOwnWindow(destination);
        NativeNotice($"{result.DestinationFileName} made with {result.KeptRecords:N0} record{(result.KeptRecords == 1 ? "" : "s")}, and opening in its own window. This file was not changed.");
    }

    private async void RecoveryRestore_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(RestoreNativeFileAsync);
    private async Task RestoreNativeFileAsync()
    {
        if (!await ConfirmCurrentWritableLocationAsync()) return;
        var backupPath = await PickOpenPathAsync();
        if (backupPath is null) return;
        var plan = await _session.PrepareRestoreAsync(backupPath, $"native-restore-{Guid.NewGuid():N}");
        var message = $"Restore {plan.BackupFileName}?\n\nCurrent change sequence: {plan.Current.ChangeSequence}. Backup change sequence: {plan.Restored.ChangeSequence}.\n\n" +
            $"Agent access will stop. {plan.PendingProposalCount} pending proposal(s) will be discarded.\n\n" +
            $"The current file will be retained beside the application as {plan.RetainedFileName}. It will not be deleted automatically.";
        if (!await ConfirmNativeAsync("Restore this backup?", message, "Restore backup")) return;
        var result = await _session.RestoreAsync(plan.PlanId, true);
        NativeNotice(result.Notice ?? $"Backup restored. The previous file is retained as {result.Restore.RetainedFileName}. Agent access is off.",
            result.Notice is null ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
    }

    private async void RecoveryUpgrade_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(UpgradeNativeFileAsync);
    private async Task UpgradeNativeFileAsync()
    {
        if (!await ConfirmCurrentWritableLocationAsync()) return;
        var plan = await _session.PrepareUpgradeAsync($"native-upgrade-{Guid.NewGuid():N}");
        var message = $"Upgrade {plan.FileName} for this version of Nendo?\n\nYour identities, records and existing history will be preserved. " +
            $"Allow approximately {Math.Ceiling(plan.EstimatedAdditionalBytes / 1048576d):0} MB of extra space; this estimate does not verify available space.\n\n" +
            $"The original will be retained beside the application as {plan.RetainedFileName}, without automatic deletion.";
        if (!await ConfirmNativeAsync("Upgrade this file?", message, "Upgrade file")) return;
        var result = await _session.UpgradeAsync(plan.PlanId);
        NativeNotice(result.Notice ?? $"File upgraded. The original is retained as {result.Upgrade.RetainedFileName}. Agent access is off.",
            result.Notice is null ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
    }

    private async void RecoveryDiagnostics_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(SaveNativeDiagnosticsAsync);
    private async Task SaveNativeDiagnosticsAsync()
    {
        var destination = await PickNewDestinationAsync("Save diagnostics", "nendo-diagnostics.json", ".json");
        if (destination is null) return;
        var bytes = DesktopRecoveryPresentation.DiagnosticBytes(await _session.GetDefinitionViewAsync());
        // CreateNew never consumes a pre-existing file, including an empty picker
        // placeholder. On an I/O failure a partial report may remain for inspection.
        await using var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
        try
        {
            await output.WriteAsync(bytes);
            await output.FlushAsync();
            output.Flush(flushToDisk: true);
        }
        catch (IOException)
        {
            NativeNotice("Diagnostics could not be fully saved. A partial report may remain at the selected name; choose a new name to retry.", InfoBarSeverity.Error);
            return;
        }
        NativeNotice("Diagnostics saved without file paths, record contents or application identities.");
    }

    private async Task<string?> PickNewDestinationAsync(string title, string suggestedName, string extension)
    {
        while (true)
        {
            var window = Owner ?? throw new InvalidOperationException("The Nendo window is unavailable.");
            var picker = new FolderPicker(window.AppWindow.Id)
            {
                SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
                CommitButtonText = "Select folder",
            };
            var folder = await picker.PickSingleFolderAsync();
            if (folder is null) return null;
            var name = new TextBox { Header = "New filename", Text = suggestedName, MaxLength = 180 };
            AutomationProperties.SetAutomationId(name, "file.destinationName");
            var content = new StackPanel { Spacing = 12 };
            content.Children.Add(new TextBlock { Text = "Choose a new name. Existing files, including empty files, will not be replaced.", TextWrapping = TextWrapping.Wrap });
            content.Children.Add(name);
            var dialog = NativeDialog(title, content);
            dialog.PrimaryButtonText = "Save";
            dialog.CloseButtonText = "Cancel";
            if (await dialog.ShowAsync() != ContentDialogResult.Primary) return null;
            var destination = Path.Combine(folder.Path, DesktopRecoveryPresentation.ValidateNewFileName(name.Text, extension));
            if (_session.InspectDestinationLocation(destination) is not { } warning) return destination;
            var location = NativeDialog("Unsupported writable location", warning.Message);
            location.PrimaryButtonText = "Continue anyway";
            location.SecondaryButtonText = "Change folder";
            location.CloseButtonText = "Cancel";
            var choice = await location.ShowAsync();
            if (choice == ContentDialogResult.None) return null;
            if (choice == ContentDialogResult.Secondary) continue;
            await _session.AcknowledgeDestinationLocationAsync(destination);
            return destination;
        }
    }

    private async Task<bool> ConfirmCurrentWritableLocationAsync()
    {
        var view = await _session.GetDefinitionViewAsync();
        if (view.LocationWarning is not { } warning) return true;
        if (!await ConfirmNativeAsync("Unsupported writable location", warning.Message, "Continue anyway")) return false;
        await _session.AcknowledgeCurrentLocationAsync();
        return true;
    }

    private async void RecoveryExport_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(ExportNativeDataAsync);

    private async Task ExportNativeDataAsync()
    {
        var view = await _session.GetDefinitionViewAsync();
        if (!view.Capabilities.Export || view.Entities.Count == 0)
            throw new NendoPreconditionException("export-unavailable", "There is no proven-readable table to export in this session.");
        var entities = view.Entities.OrderBy(entity => entity.DisplayName, StringComparer.Ordinal).ToArray();
        var entity = entities[0];
        if (entities.Length > 1)
        {
            var selector = new ComboBox { Header = "Table to export", ItemsSource = entities, DisplayMemberPath = "DisplayName", SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
            AutomationProperties.SetAutomationId(selector, "file.exportTable");
            var chooser = NativeDialog("Export one table", selector);
            chooser.PrimaryButtonText = "Continue";
            chooser.CloseButtonText = "Cancel";
            if (await chooser.ShowAsync() != ContentDialogResult.Primary) return;
            entity = (NendoEntitySnapshot)selector.SelectedItem;
        }
        // A table over the row or byte limit is written in parts, each starting after the last
        // record the part before it wrote.
        string? after = null;
        for (var part = 1; ; part++)
        {
            var saved = await ExportNativePartAsync(entity, part, after);
            if (saved?.NextAfterRecordId is not { } next) return;
            if (!await ConfirmNativeAsync($"Export part {part + 1}",
                    $"The parts so far hold {saved.PrecedingRecordCount + saved.ExportedRecordCount} of {saved.SourceRecordCount} records. Export the next part to a new CSV file?",
                    "Export next part")) return;
            after = next;
        }
    }

    private async Task<NendoRecoveryExportPlan?> ExportNativePartAsync(NendoEntitySnapshot entity, int part, string? after)
    {
        var destination = await PickNewDestinationAsync("Export readable data", part == 1 ? "nendo-recovery.csv" : $"nendo-recovery-part-{part}.csv", ".csv");
        if (destination is null) return null;
        var plan = await _session.PrepareRecoveryExportAsync(entity.EntityId, destination, $"desktop-export-{Guid.NewGuid():N}", afterRecordId: after);
        var range = plan.PrecedingRecordCount == 0 ? "" : $" after the {plan.PrecedingRecordCount} in earlier parts";
        var message = $"{plan.EntityName}: {plan.ExportedRecordCount} of {plan.SourceRecordCount} records{range} from the inspected snapshot at change {plan.ChangeSequence}.\n\n" +
            string.Join("\n\n", plan.Findings.Select(finding => finding.Message));
        if (plan.OmittedFieldIds.Count != 0)
            message += $"\n\nExcluded field IDs (first {Math.Min(20, plan.OmittedFieldIds.Count)} of {plan.OmittedFieldIds.Count}):\n" + string.Join("\n", plan.OmittedFieldIds.Take(20));
        var content = new ScrollViewer { MaxHeight = 240, Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap } };
        var review = NativeDialog(plan.IsPartial ? "Review partial recovery export" : "Review recovery export", content);
        review.PrimaryButtonText = plan.IsPartial ? "Export partial CSV" : "Export CSV";
        review.CloseButtonText = "Cancel";
        if (await review.ShowAsync() != ContentDialogResult.Primary) return null;
        var result = await _session.CreateRecoveryExportAsync(plan.PlanId, plan.IsPartial);
        NativeNotice($"{(result.Export.IsPartial ? "Partial CSV" : "CSV")} saved: {result.Export.ExportedRecordCount} of {result.Export.SourceRecordCount} records{range}. This is not a backup. Your Nendo file was not changed.",
            result.Export.IsPartial ? InfoBarSeverity.Warning : InfoBarSeverity.Success);
        return result.Export;
    }

    private ContentDialog NativeDialog(string title, object content)
    {
        var dialog = new ContentDialog
        {
            Title = title, Content = content, XamlRoot = XamlRoot, RequestedTheme = ActualTheme,
            DefaultButton = ContentDialogButton.Close,
        };
        AutomationProperties.SetAutomationId(dialog, "file.confirmation");
        // The dialog lives in a popup and takes the page's theme as it opens. It follows the page
        // while open, so a Windows theme switch under System does not leave it in the old one.
        void FollowTheme(FrameworkElement page, object _) => dialog.RequestedTheme = page.ActualTheme;
        dialog.Opened += (_, _) => { dialog.RequestedTheme = ActualTheme; ActualThemeChanged += FollowTheme; };
        dialog.Closed += (_, _) => ActualThemeChanged -= FollowTheme;
        if (DesktopRuntimeConfiguration.NativeCaptureRoot is not null)
            dialog.Opened += (_, _) => { _ = CaptureNativeDialogForTestAsync(dialog); };
        return dialog;
    }

    private async Task<bool> ConfirmNativeAsync(string title, string body, string action)
    {
        var dialog = NativeDialog(title, body);
        dialog.PrimaryButtonText = action;
        dialog.CloseButtonText = "Cancel";
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private void NativeNotice(string message, InfoBarSeverity severity = InfoBarSeverity.Success)
    {
        _fileActionNotice = message;
        if (_unloaded) return;
        RecoveryActivity.Title = string.Empty;
        RecoveryActivity.Message = message;
        RecoveryActivity.Severity = severity;
        RecoveryActivity.IsOpen = true;
    }
}
