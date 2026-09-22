using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Nendo.Desktop;

public sealed partial class MainPage
{
    private bool _nativeCaptureWritten;

    // Captures only this application's native XAML at the minimum test size.
    // No screen capture, focus manipulation or keyboard input. Explicitly opt-in.
    private async Task CaptureNativeRecoveryForTestAsync()
    {
        var testState = DesktopRuntimeConfiguration.NativeCaptureRoot;
        if (_nativeCaptureWritten || string.IsNullOrWhiteSpace(testState) || _unloaded ||
            RecoveryPanel.Visibility != Visibility.Visible || !RecoveryActions.IsEnabled ||
            ActualWidth <= 0 || ActualWidth > 1024 || ActualHeight <= 0 || ActualHeight > 720) return;
        _nativeCaptureWritten = true;
        try
        {
            var root = Path.GetFullPath(testState);
            Directory.CreateDirectory(root);
            await WriteNativeImageForTestAsync(this, Path.Combine(root, "native-recovery.png"));
            var appearance = App.CurrentWindow?.GetAppearance();
            var metadata = System.Text.Json.JsonSerializer.Serialize(new
            {
                appearance?.Preference, appearance?.Effective, appearance?.Persisted,
                PageTheme = ActualTheme.ToString(), RecoveryTheme = RecoveryPanel.ActualTheme.ToString(),
                FrameTheme = (App.CurrentWindow?.Content as FrameworkElement)?.ActualTheme.ToString(),
                FrameRequestedTheme = (App.CurrentWindow?.Content as FrameworkElement)?.RequestedTheme.ToString(),
                TitleBarTheme = App.CurrentWindow?.AppWindow.TitleBar.PreferredTheme.ToString(),
            });
            await File.WriteAllTextAsync(Path.Combine(root, "native-appearance.json"), metadata);
        }
        catch (Exception) { _nativeCaptureWritten = false; }
    }

    private static async Task CaptureNativeDialogForTestAsync(ContentDialog dialog)
    {
        var testState = DesktopRuntimeConfiguration.NativeCaptureRoot;
        if (string.IsNullOrWhiteSpace(testState)) return;
        try
        {
            var root = Path.GetFullPath(testState);
            Directory.CreateDirectory(root);
            await WriteNativeImageForTestAsync(dialog, Path.Combine(root, "native-dialog.png"));
            await File.WriteAllTextAsync(Path.Combine(root, "native-dialog-theme.json"),
                System.Text.Json.JsonSerializer.Serialize(new
                {
                    Requested = dialog.RequestedTheme.ToString(), Actual = dialog.ActualTheme.ToString(),
                    Title = dialog.Title as string,
                    PrimaryEnabled = dialog.IsPrimaryButtonEnabled,
                    Appearance = App.CurrentWindow?.GetAppearance(),
                }));
        }
        catch (Exception) { } // Diagnostic failure cannot affect an owner action.
    }

    private static async Task WriteNativeImageForTestAsync(FrameworkElement element, string path)
    {
        var bitmap = new RenderTargetBitmap();
        await bitmap.RenderAsync(element);
        var pixels = await bitmap.GetPixelsAsync();
        var bytes = new byte[pixels.Length];
        using (var reader = DataReader.FromBuffer(pixels)) reader.ReadBytes(bytes);
        using var encoded = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, encoded);
        encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied,
            (uint)bitmap.PixelWidth, (uint)bitmap.PixelHeight, 96, 96, bytes);
        await encoder.FlushAsync();
        if (encoded.Size > 16 * 1024 * 1024) throw new IOException("Owned capture exceeds its limit.");
        using var pngReader = new DataReader(encoded.GetInputStreamAt(0));
        await pngReader.LoadAsync((uint)encoded.Size);
        var png = new byte[encoded.Size];
        pngReader.ReadBytes(png);
        await using var output = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        await output.WriteAsync(png);
    }
}
