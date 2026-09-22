using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.Storage.Pickers;
using Nendo.Engine;

namespace Nendo.Desktop;

public sealed partial class MainPage
{
    private async void RecoveryResolve_Click(object sender, RoutedEventArgs e) => await RunNativeFileActionAsync(ResolveNativeRecoveryAsync);

    private async Task ResolveNativeRecoveryAsync()
    {
        var view = await _session.GetViewAsync();
        var hasPending = view.FileName is not null && (await _session.GetReplacementRecoveryAsync()).HasPendingReplacement;
        string? selectedReceipt = null;
        if (!hasPending)
        {
            if (!await ConfirmNativeAsync("Choose a recovery record",
                    "Choose the application.nendo.recovery.json file beside an interrupted Restore or upgrade. This also works when the application file itself is missing. No file changes until you review and confirm a verified choice.", "Choose record")) return;
            var window = App.CurrentWindow ?? throw new InvalidOperationException("The Nendo window is unavailable.");
            var picker = new FileOpenPicker(window.AppWindow.Id)
            {
                SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
                CommitButtonText = "Review recovery record",
                FileTypeFilter = { ".json" },
            };
            selectedReceipt = (await picker.PickSingleFileAsync())?.Path;
            if (selectedReceipt is null) return;
        }
        var review = await _session.PrepareReplacementResolutionAsync(selectedReceipt);
        var plan = review.Plan;
        var content = new StackPanel { Spacing = 12 };
        content.Children.Add(new TextBlock
        {
            Text = $"{plan.FileName}\n\nChoose a verified file to reopen. Other recovery copies will be kept.",
            TextWrapping = TextWrapping.Wrap,
        });
        var selector = new ComboBox { Header = "File to use", HorizontalAlignment = HorizontalAlignment.Stretch, SelectedIndex = -1 };
        AutomationProperties.SetAutomationId(selector, "file.recoveryChoice");
        foreach (var option in plan.Options)
            selector.Items.Add(new ComboBoxItem { Content = $"{RecoveryChoiceLabel(option.Choice)} (change {option.Manifest.ChangeSequence})", Tag = option.Choice });
        if (plan.Options.Count != 0) content.Children.Add(selector);
        else content.Children.Add(new TextBlock { Text = "No file can be safely selected here. Keep all copies. Close the file if it is in use, then review again, or open a verified backup separately.", TextWrapping = TextWrapping.Wrap });
        content.Children.Add(new TextBlock
        {
            Text = review.ClosesCurrentFile
                ? "Continuing closes the current file, stops agent access and discards pending proposals."
                : "Agent access stays off after recovery.",
            TextWrapping = TextWrapping.Wrap,
        });
        var details = new StackPanel { Spacing = 12 };
        details.Children.Add(new TextBlock { Text = plan.RetentionPolicy, TextWrapping = TextWrapping.Wrap });
        foreach (var status in new[] { plan.Recovery.Active, plan.Recovery.Retained, plan.Recovery.Staged, plan.Recovery.PreChangeBackup }.OfType<NendoRecoveryFileStatus>())
            details.Children.Add(new TextBlock { Text = $"{status.FileName}: {RecoveryStateLabel(status.State)}", TextWrapping = TextWrapping.Wrap });
        var retainedFiles = new Expander { Header = "Recovery copies and retention", Content = details, HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetAutomationId(retainedFiles, "file.recoveryDetails");
        content.Children.Add(retainedFiles);
        var dialog = NativeDialog("Review interrupted replacement", new ScrollViewer
        {
            MaxHeight = Math.Clamp(XamlRoot.Size.Height - 230, 100, 280),
            Content = content,
        });
        dialog.PrimaryButtonText = plan.Options.Count == 0 ? string.Empty : "Use selected file";
        dialog.IsPrimaryButtonEnabled = false;
        dialog.CloseButtonText = "Cancel";
        selector.SelectionChanged += (_, _) =>
        {
            dialog.IsPrimaryButtonEnabled = selector.SelectedItem is ComboBoxItem;
            _ = CaptureNativeDialogForTestAsync(dialog);
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        if (review.LocationWarning is { } warning)
        {
            if (!await ConfirmNativeAsync("Unsupported writable location", warning.Message, "Continue anyway")) return;
            await _session.AcknowledgeRecoveryLocationAsync(review.ReviewId);
        }
        var result = await _session.ResolveReplacementAsync(review.ReviewId,
            (NendoReplacementResolutionChoice)((ComboBoxItem)selector.SelectedItem).Tag, ownerConfirmed: true);
        NativeNotice(result.Notice ?? $"Recovery acknowledged. The selected file is open; agent access is off. The record is retained as {result.Resolution.AcknowledgedReceiptFileName}. Other recovery copies were kept.",
            result.Notice is null ? InfoBarSeverity.Success : InfoBarSeverity.Warning);
    }

    private static string RecoveryChoiceLabel(NendoReplacementResolutionChoice choice) => choice switch
    {
        NendoReplacementResolutionChoice.KeepActive => "Keep the file at the application name",
        NendoReplacementResolutionChoice.UseRetainedOriginal => "Use the original from before replacement",
        NendoReplacementResolutionChoice.UseStagedReplacement => "Use the prepared replacement",
        _ => "Unavailable",
    };

    private static string RecoveryStateLabel(string state) => state switch
    {
        "verifiedOriginal" => "verified original",
        "verifiedReplacement" => "verified replacement",
        "missing" => "not present",
        "changed" => "changed; not a verified choice",
        _ => "could not be verified",
    };
}
