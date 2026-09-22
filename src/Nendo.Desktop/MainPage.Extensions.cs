using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.Storage.Pickers;
using Nendo.Engine;

namespace Nendo.Desktop;

public sealed partial class MainPage
{
    private DesktopExtensionPane? _extensionPane;
    /// <summary>
    /// What the Workbench keeps when the boundary is dragged toward it. A floor rather than
    /// a target: its own layout already folds the rail into a top bar below 840.
    /// </summary>
    private const double WorkbenchMinimumWidth = 420;
    private bool _splitterWired;
    private Microsoft.UI.Xaml.Input.Pointer? _splitterPointer;
    private double _splitterOrigin;
    private double _splitterStartWidth;

    private void ShowExtensionPane(DesktopExtensionPane pane)
    {
        _extensionPane?.Close();
        pane.Closed += () =>
        {
            if (!ReferenceEquals(_extensionPane, pane)) return;
            _extensionPane = null;
            ExtensionHost.Children.Clear();
            ExtensionColumn.MinWidth = 0;
            ExtensionColumn.Width = new GridLength(0);
            ExtensionSplitterColumn.Width = new GridLength(0);
        };
        _extensionPane = pane;
        ExtensionHost.Children.Add(pane);
        WireExtensionSplitter();
        // Half the window to begin with, never narrower than the graph's measured compact
        // layout. From there the boundary is the person's to move.
        ExtensionColumn.MinWidth = 480;
        ExtensionColumn.Width = new GridLength(1, GridUnitType.Star);
        ExtensionSplitterColumn.Width = new GridLength(ExtensionSplitter.Thickness);
    }

    private void WireExtensionSplitter()
    {
        if (_splitterWired) return;
        _splitterWired = true;
        // A captured pointer rather than a manipulation: capture is what keeps the moves
        // coming once the pointer has left a strip eight pixels wide, and it behaves the
        // same for a mouse, a pen and a finger.
        ExtensionSplitter.PointerPressed += (_, e) =>
        {
            if (_extensionPane is null) return;
            HoldPaneWidth();
            _splitterStartWidth = ExtensionColumn.Width.Value;
            _splitterOrigin = e.GetCurrentPoint(ShellGrid).Position.X;
            if (ExtensionSplitter.CapturePointer(e.Pointer)) _splitterPointer = e.Pointer;
            // The contained view is not resized along the drag; see the pane for what that costs.
            _extensionPane.SuspendPlacement();
            e.Handled = true;
        };
        ExtensionSplitter.PointerMoved += (_, e) =>
        {
            if (_splitterPointer is null || e.Pointer.PointerId != _splitterPointer.PointerId) return;
            // Measured from where the press landed, not from the last move, so a drag cannot
            // drift away from the pointer over its length.
            SetPaneWidth(_splitterStartWidth - (e.GetCurrentPoint(ShellGrid).Position.X - _splitterOrigin));
            e.Handled = true;
        };
        ExtensionSplitter.PointerReleased += (_, e) =>
        {
            if (_splitterPointer is null) return;
            ExtensionSplitter.ReleasePointerCapture(e.Pointer);
            _splitterPointer = null;
            _extensionPane?.ResumePlacement();
            e.Handled = true;
        };
        // Also on capture lost, or a drag that ends any other way leaves the view hidden.
        ExtensionSplitter.PointerCaptureLost += (_, _) => { _splitterPointer = null; _extensionPane?.ResumePlacement(); };
        ExtensionSplitter.KeyDown += (_, e) =>
        {
            var step = e.Key switch
            {
                Windows.System.VirtualKey.Left => 16.0,
                Windows.System.VirtualKey.Right => -16.0,
                _ => 0.0,
            };
            if (step == 0) return;
            e.Handled = true;
            HoldPaneWidth();
            MovePaneBoundary(step);
        };
        // Back to the half the view opened at, which is otherwise unreachable once moved.
        ExtensionSplitter.DoubleTapped += (_, e) =>
        {
            e.Handled = true;
            if (_extensionPane is not null) ExtensionColumn.Width = new GridLength(1, GridUnitType.Star);
        };
        // A shrinking window must not squeeze the Workbench out behind a pane whose width is
        // now a number rather than a share of what there is.
        ShellGrid.SizeChanged += (_, _) => MovePaneBoundary(0);
    }

    /// <summary>Turn the opening half-share into a number, once, so that it can be moved.</summary>
    private void HoldPaneWidth()
    {
        if (ExtensionColumn.Width.IsStar) ExtensionColumn.Width = new GridLength(ExtensionHost.ActualWidth);
    }

    private void MovePaneBoundary(double by)
    {
        if (_extensionPane is null || ExtensionColumn.Width.IsStar) return;
        SetPaneWidth(ExtensionColumn.Width.Value + by);
    }

    private void SetPaneWidth(double width)
    {
        if (_extensionPane is null) return;
        var room = ShellGrid.ActualWidth - ExtensionSplitter.Thickness - WorkbenchMinimumWidth;
        // A window too narrow for both keeps the pane at its own minimum rather than below it.
        var widest = Math.Max(ExtensionColumn.MinWidth, room);
        ExtensionColumn.Width = new GridLength(Math.Clamp(width, ExtensionColumn.MinWidth, widest));
    }
    private static TextBlock ExtensionText(string text) => new()
    { Text = text, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };

    /// <summary>
    /// One thing this dialog can do, drawn as a row: the label at the leading edge and a chevron
    /// at the trailing one. Six stretched default buttons with centred labels read as a stack of
    /// rectangles rather than as a list of choices, which is what the owner met on 2026-09-21.
    /// </summary>
    private Button ExtensionActionRow(string text)
    {
        var content = new Grid();
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        content.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        var label = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
        var chevron = new FontIcon { Glyph = "", FontSize = 12, Opacity = .6, VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(chevron, 1);
        content.Children.Add(label);
        content.Children.Add(chevron);
        var button = new Button { Content = content, Style = (Style)Resources["ExtensionActionStyle"] };
        // The composed content is not a string, so the row states its own accessible name.
        AutomationProperties.SetName(button, text);
        return button;
    }

    private async Task ManageCustomViewsNativeAsync()
    {
        var session = await _session.GetViewAsync();
        var actions = new List<string> { "Install an offline package", "Export an installed package", "Remove an installed package" };
        if (session.UiNodes.Any(n => n.Kind == NendoExtensionViewDefinition.NodeKind))
        { actions.Add("Review permission for a view"); actions.Add("Disable a view"); actions.Add("Open a custom view"); }
        // Plain buttons, one per action: a choice hidden in a combo box behind a Continue button lost the owner.
        var body = new StackPanel { Spacing = 8, MaxWidth = 540 };
        body.Children.Add(ExtensionText("Packages are installed on this device. Your Nendo file keeps its records and view definitions; installing a package does not allow it to run."));
        var dialog = NativeDialog("Custom views", body);
        AutomationProperties.SetAutomationId(dialog, "extensions.manage");
        dialog.CloseButtonText = "Close";
        var chosen = -1;
        for (var index = 0; index < actions.Count; index++)
        {
            var choice = index;
            var button = ExtensionActionRow(actions[index]);
            AutomationProperties.SetAutomationId(button, "extensions.action." + choice);
            button.Click += (_, _) => { chosen = choice; dialog.Hide(); };
            body.Children.Add(button);
        }
        await dialog.ShowAsync();
        switch (chosen)
        {
            case 0: await InstallExtensionPackageNativeAsync(); break;
            case 1: await ExportExtensionPackageNativeAsync(); break;
            case 2: await RemoveExtensionPackageNativeAsync(); break;
            case 3: await ReviewExtensionNativeAsync(); break;
            case 4: await ReviewExtensionNativeAsync(disable: true); break;
            case 5: await ReviewExtensionNativeAsync(open: true); break;
        }
    }

    private async Task InstallExtensionPackageNativeAsync()
    {
        var window = App.CurrentWindow ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        // Opened straight from the view's next-step button: bring Nendo forward so its picker is visible.
        window.Activate();
        var picker = new FileOpenPicker(window.AppWindow.Id)
        { SuggestedStartLocation = PickerLocationId.Downloads, CommitButtonText = "Review package", FileTypeFilter = { ".nendoview", ".zip" } };
        var selected = await picker.PickSingleFileAsync();
        if (selected is null) return;
        byte[] bytes;
        using (var stream = new FileStream(selected.Path, FileMode.Open, FileAccess.Read, FileShare.Read))
            bytes = DesktopExtensionPackageStore.ReadBounded(stream);
        var package = await Task.Run(() => _session.ExtensionPackages.Inspect(bytes));
        var body = new StackPanel { Spacing = 12, MaxWidth = 540 };
        body.Children.Add(ExtensionText(package.PackageId + " · " + package.Version));
        body.Children.Add(ExtensionText("Unsigned package. Its digest identifies these bytes; it does not identify a trusted publisher."));
        body.Children.Add(ExtensionText("License: " + package.License));
        body.Children.Add(ExtensionText("SHA-256: " + package.Digest));
        body.Children.Add(ExtensionText("A view may read only the fields you later approve and suggest a record selection. Installation grants no permission to run. Keep the original package for offline transfer."));
        var review = NativeDialog("Install custom-view package?", new ScrollViewer { Content = body, MaxHeight = 440 });
        AutomationProperties.SetAutomationId(review, "extensions.install");
        review.PrimaryButtonText = "Install package"; review.CloseButtonText = "Cancel";
        if (await review.ShowAsync() != ContentDialogResult.Primary) return;
        await Task.Run(() => _session.ExtensionPackages.Install(bytes));
        NativeNotice("Installed " + package.PackageId + " " + package.Version + ". No view was approved or started.");
    }

    private sealed record PackageChoice(DesktopExtensionPackageInfo Package)
    {
        public string Label => Package.PackageId is { } id ? id + " · " + Package.Version + " · " + Package.Digest[..12]
            : "Unavailable package · " + Package.Digest[..12];
    }

    private async Task<DesktopExtensionPackageInfo?> PickExtensionPackageNativeAsync(string title, bool includeUnavailable)
    {
        var packages = (await Task.Run(() => _session.ExtensionPackages.List()))
            .Where(p => includeUnavailable || p.State == "available").Select(p => new PackageChoice(p)).ToArray();
        if (packages.Length == 0) { NativeNotice("No matching custom-view packages are installed.", InfoBarSeverity.Informational); return null; }
        var selector = new ComboBox { Header = "Package and version", ItemsSource = packages, DisplayMemberPath = "Label", SelectedIndex = 0,
            HorizontalAlignment = HorizontalAlignment.Stretch, MaxWidth = 540 };
        AutomationProperties.SetAutomationId(selector, "extensions.package");
        var dialog = NativeDialog(title, selector); dialog.PrimaryButtonText = "Continue"; dialog.CloseButtonText = "Cancel";
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? ((PackageChoice)selector.SelectedItem).Package : null;
    }

    private async Task ExportExtensionPackageNativeAsync()
    {
        var selected = await PickExtensionPackageNativeAsync("Export offline package", false);
        if (selected is null) return;
        using var held = _session.ExtensionPackages.Acquire(selected.Digest, selected.PackageId!, selected.Version!);
        var window = App.CurrentWindow ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FileSavePicker(window.AppWindow.Id)
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            SuggestedFileName = selected.PackageId + "-" + selected.Version, DefaultFileExtension = ".nendoview",
            CommitButtonText = "Export package", FileTypeChoices = { { "Nendo custom-view package", new List<string> { ".nendoview" } } },
        };
        var destination = await picker.PickSaveFileAsync();
        if (destination is null) return;
        var stage = Path.Combine(Path.GetDirectoryName(destination.Path)!, ".nendo-export-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            await File.WriteAllBytesAsync(stage, held.ExportArchive());
            File.Move(stage, destination.Path, overwrite: true);
        }
        finally { if (File.Exists(stage)) File.Delete(stage); }
        NativeNotice("Exported the exact offline package. Its digest is unchanged.");
    }

    private async Task RemoveExtensionPackageNativeAsync()
    {
        var selected = await PickExtensionPackageNativeAsync("Remove installed package", true);
        if (selected is null) return;
        if (!await ConfirmNativeAsync("Remove this package?", (selected.PackageId ?? "Unavailable package") + "\n" + selected.Digest +
            "\n\nRecords and view definitions stay in your files. A view that pins this package will show that it is missing. Close any running view first.", "Remove package")) return;
        await Task.Run(() => _session.ExtensionPackages.Remove(selected.Digest));
        NativeNotice("Removed the device package. Records and view definitions are unchanged.");
    }

    private sealed record ViewChoice(string Id, string Title);
    private async Task ReviewExtensionNativeAsync(bool disable = false, bool open = false, string? requestedViewId = null)
    {
        var session = await _session.GetViewAsync();
        var choices = session.UiNodes.Where(n => n.Kind == NendoExtensionViewDefinition.NodeKind)
            .Select(n => new ViewChoice(n.NodeId, n.Properties.TryGetValue("title", out var title) ? title.GetString() ?? n.NodeId : n.NodeId)).ToArray();
        if (choices.Length == 0) return;
        var selector = new ComboBox { Header = "View in this file", ItemsSource = choices, DisplayMemberPath = "Title", SelectedIndex = 0,
            HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetAutomationId(selector, "extensions.view");
        var chooser = NativeDialog(open ? "Open custom view" : disable ? "Disable custom view" : "Review custom-view permission", selector);
        AutomationProperties.SetAutomationId(chooser, "extensions.choose");
        // The button says what it does; a chooser that said Review when it opened the view misled the owner.
        chooser.PrimaryButtonText = open ? "Open" : disable ? "Disable" : "Review"; chooser.CloseButtonText = "Cancel";
        if (requestedViewId is null && await chooser.ShowAsync() != ContentDialogResult.Primary) return;
        var selected = requestedViewId is null ? (ViewChoice)selector.SelectedItem :
            choices.SingleOrDefault(c => c.Id == requestedViewId) ?? throw new NendoValidationException("This custom view is no longer in the file.");
        var viewId = selected.Id;
        if (open)
        {
            var helper = Path.Combine(AppContext.BaseDirectory, "ExtensionHost");
#if DEBUG
            if (!Directory.Exists(helper)) helper = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "Nendo.ExtensionHost", "debug"));
#endif
            var run = await _session.StartExtensionAsync(viewId, helper,
                Path.Combine(DesktopRuntimeConfiguration.DeviceStateRoot ?? DesktopAppearanceStore.DefaultRoot, "extension-runs"),
                ActualTheme == ElementTheme.Dark ? "dark" : "light", System.Globalization.CultureInfo.CurrentUICulture.Name);
            try
            {
                var pane = new DesktopExtensionPane(_session, run, selected.Title, ActualTheme,
                    () => { RouteTo("studio"); App.CurrentWindow?.Activate(); },
                    (fileSessionId, entityId, recordId) =>
                    {
                        PostWorkbenchEvent(WorkbenchEvents.OpenRecord,new { fileSessionId, entityId, recordId });
                        App.CurrentWindow?.Activate();
                    });
                ShowExtensionPane(pane);
            }
            catch { await run.DisposeAsync(); throw; }
            return;
        }
        if (disable)
        {
            if (await ConfirmNativeAsync("Disable this custom view?", "The view's permission will be withdrawn on this device. Your records and view definition stay in the file.", "Disable view"))
            { await _session.DisableExtensionAsync(viewId); NativeNotice("Disabled this custom view. Your records are unchanged."); }
            return;
        }
        var review = await _session.PrepareExtensionConsentAsync(viewId);
        var view = review.View; var fields = view.Disclosure;
        var body = new StackPanel { Spacing = 12, MaxWidth = 540 };
        body.Children.Add(ExtensionText(view.Definition.Title + " · " + view.Definition.PackageId + " " + view.Definition.PackageVersion));
        body.Children.Add(ExtensionText("Unsigned package. Allow only if you trust the source of these exact bytes."));
        body.Children.Add(ExtensionText("Reads: " + fields.NodeType + " — record IDs, " + fields.NodeLabel +
            (fields.StatusField is { } status ? ", " + status : "") + ".\nRelationships: " + fields.EdgeType + " — record IDs, " + fields.SourceField + " → " + fields.TargetField + "."));
        body.Children.Add(ExtensionText("It can suggest a record selection. It cannot edit records. Open record and Studio remain controlled by Nendo. This permission applies only to this physical file, view, package and field bindings on this device."));
        body.Children.Add(ExtensionText("SHA-256: " + view.Definition.PackageDigest));
        if (view.Notice is { } notice) body.Children.Add(ExtensionText(notice));
        var consent = NativeDialog("Allow this custom view?", new ScrollViewer { Content = body, MaxHeight = 440 });
        AutomationProperties.SetAutomationId(consent, "extensions.consent");
        consent.PrimaryButtonText = view.IsApproved ? "Keep permission" : "Allow this view";
        consent.SecondaryButtonText = view.IsApproved ? "Disable this view" : "";
        consent.CloseButtonText = "Cancel";
        var result = await consent.ShowAsync();
        if (result == ContentDialogResult.Primary)
        { await _session.ApproveExtensionAsync(review.ReviewId); NativeNotice("Permission saved for this exact view. It has not been started."); }
        else if (result == ContentDialogResult.Secondary)
        { await _session.DisableExtensionAsync(viewId); NativeNotice("Disabled this custom view. Your records are unchanged."); }
    }
}
