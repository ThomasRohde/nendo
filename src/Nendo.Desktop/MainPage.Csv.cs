using System.Text;
using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.Storage.Pickers;
using Nendo.Engine;

namespace Nendo.Desktop;

public sealed partial class MainPage
{
    private static string CsvDisplayValue(object? value) => value switch
    {
        null => "Not set (null)",
        string text => text.Length == 0 ? "Empty text (\"\")" : "“" + text + "”",
        _ => JsonSerializer.Serialize(value),
    };
    private async Task<T> CsvWorkAsync<T>(string title, Func<CancellationToken, Task<T>> work)
    {
        using var cancellation = new CancellationTokenSource();
        var dialog = NativeDialog(title, new ProgressRing { IsActive = true, Width = 40, Height = 40 });
        dialog.CloseButtonText = "Cancel";
        var task = work(cancellation.Token);
        dialog.Opened += async (_, _) => { try { await task; } catch { /* Propagated by the awaited task below. */ } finally { dialog.Hide(); } };
        await dialog.ShowAsync();
        if (!task.IsCompleted) cancellation.Cancel();
        return await task;
    }

    private async Task<NendoEntitySnapshot?> PickCsvEntityAsync(string title)
    {
        var view = await _session.GetViewAsync();
        if (!view.Capabilities.Mutate) throw new NendoPreconditionException("csv-unavailable", "Open a healthy writable file for normal CSV operations.");
        var entities = view.Entities.Where(entity => !entity.Retired).OrderBy(entity => entity.DisplayName, StringComparer.Ordinal).ToArray();
        if (entities.Length == 0) throw new NendoValidationException("Create a record type first.");
        var selector = new ComboBox { Header = "Record type", ItemsSource = entities, DisplayMemberPath = "DisplayName", SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetAutomationId(selector, "csv.entity");
        var dialog = NativeDialog(title, selector); dialog.PrimaryButtonText = "Continue"; dialog.CloseButtonText = "Cancel";
        return await dialog.ShowAsync() == ContentDialogResult.Primary ? (NendoEntitySnapshot)selector.SelectedItem : null;
    }

    private async Task ImportCsvNativeAsync()
    {
        var expectedDefinitionRevision = (await _session.GetViewAsync()).Manifest?.DefinitionRevision;
        var entity = await PickCsvEntityAsync("Import CSV into a record type"); if (entity is null) return;
        var window = App.CurrentWindow ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FileOpenPicker(window.AppWindow.Id) { CommitButtonText = "Select CSV", FileTypeFilter = { ".csv" } };
        var file = await picker.PickSingleFileAsync(); if (file is null) return;
        var document = await CsvWorkAsync("Read and validate CSV", async cancellationToken =>
        {
            await using var stream = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous);
            if (stream.Length > NendoCsvProfile.MaximumBytes) throw new NendoValidationException("CSV exceeds 16 MiB. Split it into smaller files.");
            var bytes = new byte[checked((int)stream.Length)]; await stream.ReadExactlyAsync(bytes, cancellationToken);
            return await Task.Run(() => NendoCsvProfile.Parse(bytes, cancellationToken), cancellationToken);
        });
        if (document.Rows.Count == 0) { NativeNotice("CSV contains only headers; no records imported."); return; }
        var panel = new StackPanel { Spacing = 12 };
        panel.Children.Add(new TextBlock { Text = $"{document.Rows.Count} rows. Imports create new records; existing records stay unchanged. Maximum 100 rows per accepted batch. Limits: 16 MiB, 10,000 rows, 100 columns, 64 Ki characters per cell.", TextWrapping = TextWrapping.Wrap });
        var profile = new ComboBox { Header = "CSV profile", ItemsSource = new[] { "External CSV — literal text", "Nendo CSV — escaped null marker" }, SelectedIndex = 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetAutomationId(profile, "csv.profile"); panel.Children.Add(profile);
        var empty = new CheckBox { Content = "External CSV: treat empty cells as null (otherwise text stays empty)", IsChecked = false };
        AutomationProperties.SetAutomationId(empty, "csv.emptyNull"); panel.Children.Add(empty);
        panel.Children.Add(new TextBlock { Text = "Nendo CSV: \\N means null; a doubled leading backslash preserves literal text. Formula-like text is preserved in both profiles. Fields use their declared scalar types; choice and reference values must be stable IDs.", TextWrapping = TextWrapping.Wrap });
        var selectors = new List<(NendoFieldSnapshot Field, ComboBox Selector)>();
        foreach (var field in entity.Fields.Where(field => !field.Retired))
        {
            var names = new[] { "Do not import" }.Concat(document.Headers).ToArray();
            var index = document.Headers.ToList().FindIndex(header => header == field.DisplayName);
            var selector = new ComboBox { Header = $"{field.DisplayName} · {field.StorageKind}{(field.Required ? " · Required" : "")}", ItemsSource = names, SelectedIndex = index + 1, HorizontalAlignment = HorizontalAlignment.Stretch };
            AutomationProperties.SetAutomationId(selector, "csv.mapping." + field.FieldId); panel.Children.Add(selector); selectors.Add((field, selector));
        }
        var mappingDialog = NativeDialog("Map CSV columns", new ScrollViewer { MaxHeight = 410, Content = panel });
        mappingDialog.PrimaryButtonText = "Validate first batch"; mappingDialog.CloseButtonText = "Cancel";
        if (await mappingDialog.ShowAsync() != ContentDialogResult.Primary) return;
        var mappings = selectors.Where(item => item.Selector.SelectedIndex > 0).Select(item => new NendoCsvMapping(item.Selector.SelectedIndex - 1, item.Field.FieldId)).ToArray();
        var options = new NendoCsvOptions(profile.SelectedIndex == 1, empty.IsChecked == true);
        var committed = 0;
        try
        {
            while (committed < document.Rows.Count)
            {
                var batchId = Guid.NewGuid().ToString("N");
                var batch = await CsvWorkAsync("Validate CSV batch", token => _session.PrepareCsvBatchAsync(document, entity.EntityId, mappings, options, committed, batchId, token, expectedDefinitionRevision));
                var description = new StringBuilder($"{committed} records already committed; {document.Rows.Count - committed} remain.\nThis batch creates {batch.Rows.Count} records atomically. Cancelling retains earlier committed batches.\n\n");
                foreach (var row in batch.Rows)
                {
                    description.AppendLine($"CSV row {row.SourceRow}:");
                    foreach (var value in row.Values) description.AppendLine($"  {entity.Fields.Single(field => field.FieldId == value.Key).DisplayName}: {CsvDisplayValue(value.Value)}");
                }
                foreach (var diagnostic in batch.Proposal.Diagnostics) description.AppendLine(diagnostic.Message);
                var review = NativeDialog("Review CSV batch", new ScrollViewer { MaxHeight = 410, Content = new TextBlock { Text = description.ToString(), TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true } });
                review.PrimaryButtonText = $"Import {batch.Rows.Count} records";
                review.IsPrimaryButtonEnabled = batch.Proposal.State == NendoProposalState.Previewable;
                review.CloseButtonText = "Cancel remaining import";
                if (await review.ShowAsync() != ContentDialogResult.Primary)
                {
                    await _session.RejectProposalAsync(batch.Proposal.ProposalId);
                    NativeNotice($"CSV import stopped: {committed} records committed; {document.Rows.Count - committed} not imported."); return;
                }
                try
                {
                    var result = await _session.PromoteProposalAsync(batch.Proposal.ProposalId, expectedOperationDigest: batch.Proposal.OperationDigest);
                    if (!result.Promotion.Applied) throw new NendoPreconditionException("csv-batch-not-applied", "The batch was not applied. Review the current file and retry remaining rows.");
                }
                catch (Exception exception) when (exception is NendoException or IOException or OperationCanceledException)
                {
                    // Resolve the exact durable receipt before counting or retrying.
                    if (await _session.GetProposalReceiptAsync(batch.Proposal.ProposalId) is null)
                        throw new NendoPreconditionException("csv-outcome-unresolved", $"Batch {batch.Proposal.ProposalId} has no confirmed receipt. {exception.Message}");
                }
                committed += batch.Rows.Count;
            }
            NativeNotice($"CSV import complete: {committed} new records. Each accepted batch has a durable proposal receipt and History entry.");
        }
        catch (Exception exception) when (exception is NendoException or IOException or OperationCanceledException)
        {
            NativeNotice($"CSV import stopped after {committed} confirmed records. {exception.Message} Check History before retrying any batch whose outcome was interrupted.", InfoBarSeverity.Error);
        }
    }

    private async Task ExportCsvNativeAsync()
    {
        var entity = await PickCsvEntityAsync("Export a record type as faithful CSV"); if (entity is null) return;
        var review = NativeDialog("Faithful Nendo CSV", "Exports active fields and exact values, including formula-like text. Null is \\N; literal leading backslashes are escaped. Use the Nendo CSV profile to import it. This creates a new file and is not a backup.");
        review.PrimaryButtonText = "Choose destination"; review.CloseButtonText = "Cancel";
        if (await review.ShowAsync() != ContentDialogResult.Primary) return;
        var destination = await PickNewDestinationAsync("Export CSV", "nendo-data.csv", ".csv"); if (destination is null) return;
        if (File.Exists(destination)) throw new NendoValidationException("A file already exists at that name. Choose a new name.");
        var staging = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            var count = await CsvWorkAsync("Export faithful CSV", async cancellationToken =>
            {
                await using var writer = new StreamWriter(new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None), new UTF8Encoding(false));
                return await _session.ExportCsvAsync(entity.EntityId, writer, cancellationToken);
            });
            await _session.ValidateFileRequestAsync(CancellationToken.None);
            File.Move(staging, destination, false);
            NativeNotice($"CSV export complete: {count} records. Use the Nendo CSV profile for faithful import.");
        }
        finally { if (File.Exists(staging)) File.Delete(staging); }
    }
}
