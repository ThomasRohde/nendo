using Microsoft.Web.WebView2.Core;
using Microsoft.Windows.Storage.Pickers;
using Nendo.Engine;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Nendo.Desktop;

public sealed partial class MainPage : IWorkbenchMediaHost
{
    /// <summary>
    /// A picture dropped on a media field (ADR-0031): its path read from WebView2's own file object,
    /// as a dropped Nendo file's is, so the page can only ever name a file a person dropped.
    /// </summary>
    private static string? DroppedPicturePath(CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            foreach (var candidate in args.AdditionalObjects ?? [])
                if (candidate is CoreWebView2File file && NendoMedia.MediaTypeForExtension(Path.GetExtension(file.Path)) is not null)
                    return file.Path;
            return null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    async Task<string?> IWorkbenchMediaHost.PickPictureAsync(string commitText)
    {
        var window = Owner ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FileOpenPicker(window.AppWindow.Id) { CommitButtonText = commitText };
        foreach (var extension in NendoMedia.PictureTypes.Values.SelectMany(extensions => extensions)) picker.FileTypeFilter.Add(extension);
        return (await picker.PickSingleFileAsync())?.Path;
    }

    async Task<string?> IWorkbenchMediaHost.PickPictureSaveAsync(string suggestedName, string extension)
    {
        var window = Owner ?? throw new InvalidOperationException("The Nendo window is unavailable.");
        var picker = new FileSavePicker(window.AppWindow.Id) { SuggestedFileName = suggestedName, DefaultFileExtension = extension };
        picker.FileTypeChoices.Add("Picture", [extension]);
        return (await picker.PickSaveFileAsync())?.Path;
    }

    /// <summary>
    /// A picture on the clipboard: a copied picture file as it is, or copied pixels encoded as PNG,
    /// which every picture Nendo stores can be shown as.
    /// </summary>
    async Task<(byte[] Content, string Name)?> IWorkbenchMediaHost.ReadClipboardPictureAsync()
    {
        var content = Clipboard.GetContent();
        if (content.Contains(StandardDataFormats.StorageItems))
        {
            foreach (var item in await content.GetStorageItemsAsync())
                if (item is Windows.Storage.StorageFile file && NendoMedia.MediaTypeForExtension(Path.GetExtension(file.Path)) is not null)
                    return (await File.ReadAllBytesAsync(file.Path), file.Name);
        }
        if (!content.Contains(StandardDataFormats.Bitmap)) return null;
        var reference = await content.GetBitmapAsync();
        using var source = await reference.OpenReadAsync();
        var decoder = await BitmapDecoder.CreateAsync(source);
        var pixels = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        using var output = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, output);
        encoder.SetSoftwareBitmap(pixels);
        await encoder.FlushAsync();
        var bytes = new byte[output.Size];
        using (var reader = new DataReader(output.GetInputStreamAt(0)))
        {
            await reader.LoadAsync((uint)output.Size);
            reader.ReadBytes(bytes);
        }
        return (bytes, "Pasted picture.png");
    }
}
