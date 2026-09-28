using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using Nendo.Engine;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Nendo.Desktop;

/// <summary>The icon files drawn for one look: the icon itself, and the two pictures that are not icons.</summary>
internal sealed record DesktopFileIconFiles(string Icon, string TitleBarImage, string NotificationImage);

/// <summary>
/// Draws a file's icon: the Nendo mark with a badge in the file's tone carrying its letter
/// (W-089, style D on the Per-file icons canvas).
/// <para>
/// Every Nendo window used to carry the same icon, so four files open at once were four
/// identical buttons in Alt+Tab, four identical icons in the notification area and four
/// notifications from the same picture. The mark stays, so each is still recognisably Nendo;
/// the badge says which file. It sits bottom left because Windows draws a taskbar button's
/// status badge bottom right, and the two must not cover each other.
/// </para>
/// <para>
/// Drawn here rather than shipped, because a letter is anything a file's name starts with.
/// The mark comes from the shipped icon's own frames, the badge is computed with exact
/// coverage at each size, and the letter is set in Segoe UI Semibold four times over and
/// scaled down, so it is smooth whatever the system's font smoothing says. Below 24 pixels the
/// badge is a dot: a letter there is a smudge. The results are kept by look, not by file, in
/// the device state, and drawn once.
/// </para>
/// </summary>
internal static class DesktopFileIcon
{
    /// <summary>Raised when the drawing changes, so an icon drawn by an older build is drawn again.</summary>
    internal const int StyleVersion = 1;

    /// <summary>The frames the icon file carries: the sizes the shell asks for at 100 to 400 percent.</summary>
    internal static IReadOnlyList<int> IconSizes { get; } = [16, 20, 24, 32, 40, 48, 64, 256];

    private const int Supersample = 4;

    /// <summary>
    /// The tones as the icon draws them: the light theme's choice tones (<c>--tone-*</c> under
    /// <c>:root</c> in 02-tokens.css, which a test holds this table to). A raster icon cannot follow
    /// the theme, and the light values keep their contrast on a light taskbar and a dark one alike.
    /// </summary>
    internal static IReadOnlyDictionary<string, int> ToneColours { get; } = new Dictionary<string, int>(StringComparer.Ordinal)
    {
        ["red"] = 0xC93A3A,
        ["orange"] = 0xC75A17,
        ["amber"] = 0xA37608,
        ["green"] = 0x1F8A52,
        ["teal"] = 0x16837E,
        ["blue"] = 0x2F63D6,
        ["violet"] = 0x7446D4,
        ["grey"] = 0x677080,
    };

    /// <summary>Where drawn icons are kept on this device.</summary>
    internal static string CacheRoot(string deviceStateRoot) => Path.Combine(deviceStateRoot, "icons");

    /// <summary>The name the files for this look are kept under: the look and nothing about the file.</summary>
    internal static string KeyFor(NendoResolvedLook look) =>
        $"file-v{StyleVersion}-{look.Tone}-{Convert.ToHexString(Encoding.UTF8.GetBytes(look.Letter)).ToLowerInvariant()}";

    /// <summary>
    /// The files for this look, drawn now if this device has not drawn them before.
    /// </summary>
    /// <param name="cacheRoot">Where drawn icons are kept (<see cref="CacheRoot"/>).</param>
    /// <param name="look">The file's look as it is drawn.</param>
    /// <param name="markIconPath">The shipped application icon, whose frames are the mark.</param>
    internal static async Task<DesktopFileIconFiles> EnsureAsync(
        string cacheRoot, NendoResolvedLook look, string markIconPath, CancellationToken cancellationToken = default)
    {
        var key = KeyFor(look);
        var files = new DesktopFileIconFiles(
            Path.Combine(cacheRoot, key + ".ico"),
            Path.Combine(cacheRoot, key + "-32.png"),
            Path.Combine(cacheRoot, key + "-96.png"));
        if (File.Exists(files.Icon) && File.Exists(files.TitleBarImage) && File.Exists(files.NotificationImage)) return files;

        var mark = ReadIconFrames(await File.ReadAllBytesAsync(markIconPath, cancellationToken));
        var frames = new List<(int Size, byte[] Png)>();
        foreach (var size in IconSizes)
        {
            frames.Add((size, await EncodePngAsync(await RenderAsync(mark, look, size, cancellationToken), size)));
        }
        Directory.CreateDirectory(cacheRoot);
        WriteAtomically(files.Icon, IconFile(frames));
        WriteAtomically(files.TitleBarImage, await EncodePngAsync(await RenderAsync(mark, look, 32, cancellationToken), 32));
        WriteAtomically(files.NotificationImage, await EncodePngAsync(await RenderAsync(mark, look, 96, cancellationToken), 96));
        return files;
    }

    /// <summary>
    /// One size of the icon, as straight-alpha BGRA rows from the top: the mark, then a white
    /// ring, the tone, and the letter from 24 pixels up.
    /// </summary>
    internal static async Task<byte[]> RenderAsync(
        IReadOnlyDictionary<int, byte[]> mark, NendoResolvedLook look, int size, CancellationToken cancellationToken = default)
    {
        if (!ToneColours.TryGetValue(look.Tone, out var tone))
            throw new ArgumentException($"'{look.Tone}' is not a tone this icon can draw.", nameof(look));
        var source = mark.Keys.Where(frame => frame >= size).DefaultIfEmpty(mark.Keys.Max()).Min();
        var pixels = await DecodeAsync(mark[source], size);
        cancellationToken.ThrowIfCancellationRequested();

        // Premultiplied, so each layer lays over the last by one rule.
        var canvas = new float[size * size * 4];
        for (var index = 0; index < size * size; index++)
        {
            var alpha = pixels[index * 4 + 3] / 255f;
            canvas[index * 4 + 0] = pixels[index * 4 + 0] / 255f * alpha;
            canvas[index * 4 + 1] = pixels[index * 4 + 1] / 255f * alpha;
            canvas[index * 4 + 2] = pixels[index * 4 + 2] / 255f * alpha;
            canvas[index * 4 + 3] = alpha;
        }

        var badge = BadgeFor(size);
        var toneBlue = (tone & 0xFF) / 255f;
        var toneGreen = ((tone >> 8) & 0xFF) / 255f;
        var toneRed = ((tone >> 16) & 0xFF) / 255f;
        var letter = size >= 24 ? LetterCoverage(look.Letter, badge, size) : null;
        for (var y = 0; y < size; y++)
        {
            for (var x = 0; x < size; x++)
            {
                var distance = MathF.Sqrt(Square(x + 0.5f - badge.CentreX) + Square(y + 0.5f - badge.CentreY));
                var ring = Math.Clamp(badge.Outer - distance + 0.5f, 0f, 1f);
                if (ring <= 0f) continue;
                var fill = Math.Clamp(badge.Inner - distance + 0.5f, 0f, 1f);
                var index = (y * size + x) * 4;
                Over(canvas, index, 1f, 1f, 1f, ring);
                Over(canvas, index, toneBlue, toneGreen, toneRed, fill);
                if (letter is not null) Over(canvas, index, 1f, 1f, 1f, fill * letter[y * size + x]);
            }
        }

        var result = new byte[size * size * 4];
        for (var index = 0; index < size * size; index++)
        {
            var alpha = canvas[index * 4 + 3];
            result[index * 4 + 3] = ToByte(alpha);
            if (alpha <= 0f) continue;
            result[index * 4 + 0] = ToByte(canvas[index * 4 + 0] / alpha);
            result[index * 4 + 1] = ToByte(canvas[index * 4 + 1] / alpha);
            result[index * 4 + 2] = ToByte(canvas[index * 4 + 2] / alpha);
        }
        return result;
    }

    /// <summary>Where the badge sits at a size, and how big it is: the canvas's proportions.</summary>
    internal static (float CentreX, float CentreY, float Outer, float Inner) BadgeFor(int size)
    {
        var diameter = size * (size <= 16 ? 0.50f : size <= 32 ? 0.52f : 0.46f);
        var ring = Math.Max(size * (size <= 32 ? 0.07f : 0.05f), 1f);
        var outer = diameter / 2f;
        return (outer + size * 0.01f, size - outer - size * 0.01f, outer, outer - ring);
    }

    /// <summary>The frames of an icon file, by size, as the PNG each one carries.</summary>
    internal static IReadOnlyDictionary<int, byte[]> ReadIconFrames(byte[] icon)
    {
        var frames = new Dictionary<int, byte[]>();
        if (icon.Length < 6 || BinaryPrimitives.ReadUInt16LittleEndian(icon.AsSpan(2)) != 1) return frames;
        var count = BinaryPrimitives.ReadUInt16LittleEndian(icon.AsSpan(4));
        for (var entry = 0; entry < count && 6 + (entry + 1) * 16 <= icon.Length; entry++)
        {
            var at = 6 + entry * 16;
            var size = icon[at] == 0 ? 256 : icon[at];
            var length = BinaryPrimitives.ReadInt32LittleEndian(icon.AsSpan(at + 8));
            var offset = BinaryPrimitives.ReadInt32LittleEndian(icon.AsSpan(at + 12));
            if (offset < 0 || length <= 8 || offset + length > icon.Length) continue;
            var data = icon.AsSpan(offset, length);
            // Only frames stored as PNG: every frame of the shipped icon is, and a bitmap frame
            // would need a second decoder for no picture this draws.
            if (!data[..8].SequenceEqual(PngSignature)) continue;
            frames[size] = data.ToArray();
        }
        if (frames.Count == 0) throw new InvalidDataException("The application icon carries no frame the file icon can be drawn from.");
        return frames;
    }

    /// <summary>An icon file of PNG frames, which Windows reads at every size since Vista.</summary>
    internal static byte[] IconFile(IReadOnlyList<(int Size, byte[] Png)> frames)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);
        writer.Write((ushort)0);
        writer.Write((ushort)1);
        writer.Write((ushort)frames.Count);
        var offset = 6 + frames.Count * 16;
        foreach (var (size, png) in frames)
        {
            writer.Write((byte)(size >= 256 ? 0 : size));
            writer.Write((byte)(size >= 256 ? 0 : size));
            writer.Write((byte)0);
            writer.Write((byte)0);
            writer.Write((ushort)1);
            writer.Write((ushort)32);
            writer.Write(png.Length);
            writer.Write(offset);
            offset += png.Length;
        }
        foreach (var (_, png) in frames) writer.Write(png);
        writer.Flush();
        return stream.ToArray();
    }

    private static async Task<byte[]> DecodeAsync(byte[] png, int size)
    {
        using var stream = new InMemoryRandomAccessStream();
        await stream.WriteAsync(png.AsBuffer());
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        var transform = new BitmapTransform
        {
            ScaledWidth = (uint)size,
            ScaledHeight = (uint)size,
            InterpolationMode = BitmapInterpolationMode.Fant,
        };
        var data = await decoder.GetPixelDataAsync(
            BitmapPixelFormat.Bgra8, BitmapAlphaMode.Straight, transform,
            ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
        return data.DetachPixelData();
    }

    private static async Task<byte[]> EncodePngAsync(byte[] bgra, int size)
    {
        using var stream = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
        encoder.SetPixelData(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Straight, (uint)size, (uint)size, 96, 96, bgra);
        await encoder.FlushAsync();
        var bytes = new byte[stream.Size];
        using var reader = new DataReader(stream.GetInputStreamAt(0));
        await reader.LoadAsync((uint)stream.Size);
        reader.ReadBytes(bytes);
        return bytes;
    }

    /// <summary>
    /// How much of each pixel the letter covers, in the icon's own pixels: set four times as large
    /// in white on black, centred on its ink rather than its line box so a capital sits in the
    /// middle of the dot, and averaged down.
    /// </summary>
    private static float[] LetterCoverage(string letter, (float CentreX, float CentreY, float Outer, float Inner) badge, int size)
    {
        var box = (int)MathF.Ceiling(badge.Inner * 2f * Supersample) + 4 * Supersample;
        var glyph = RenderText(letter, box, (int)MathF.Round(badge.Inner * 1.30f * Supersample));
        var (left, top, right, bottom) = InkBounds(glyph, box);
        var coverage = new float[size * size];
        if (right < left) return coverage;
        // Where the ink's middle lands, in super-sampled pixels of the icon: the dot's centre,
        // a little high, which is where the eye puts the middle of a capital.
        var targetX = badge.CentreX * Supersample;
        var targetY = (badge.CentreY - badge.Inner * 0.03f) * Supersample;
        var shiftX = targetX - (left + right + 1) / 2f;
        var shiftY = targetY - (top + bottom + 1) / 2f;
        for (var y = 0; y < size; y++)
        {
            for (var x = 0; x < size; x++)
            {
                var sum = 0f;
                for (var sy = 0; sy < Supersample; sy++)
                {
                    for (var sx = 0; sx < Supersample; sx++)
                    {
                        var gx = (int)MathF.Floor(x * Supersample + sx + 0.5f - shiftX);
                        var gy = (int)MathF.Floor(y * Supersample + sy + 0.5f - shiftY);
                        if (gx >= 0 && gy >= 0 && gx < box && gy < box) sum += glyph[gy * box + gx];
                    }
                }
                coverage[y * size + x] = sum / (Supersample * Supersample);
            }
        }
        return coverage;
    }

    private static (int Left, int Top, int Right, int Bottom) InkBounds(float[] glyph, int box)
    {
        int left = box, top = box, right = -1, bottom = -1;
        for (var y = 0; y < box; y++)
        {
            for (var x = 0; x < box; x++)
            {
                if (glyph[y * box + x] < 0.25f) continue;
                left = Math.Min(left, x);
                right = Math.Max(right, x);
                top = Math.Min(top, y);
                bottom = Math.Max(bottom, y);
            }
        }
        return (left, top, right, bottom);
    }

    /// <summary>White text on black in a square box, read back as coverage from 0 to 1.</summary>
    private static float[] RenderText(string text, int box, int pixelHeight)
    {
        var coverage = new float[box * box];
        var dc = CreateCompatibleDC(IntPtr.Zero);
        if (dc == IntPtr.Zero) return coverage;
        var info = new BITMAPINFO
        {
            Header = new BITMAPINFOHEADER
            {
                Size = (uint)Marshal.SizeOf<BITMAPINFOHEADER>(),
                Width = box,
                Height = -box,
                Planes = 1,
                BitCount = 32,
            },
        };
        var bitmap = CreateDIBSection(dc, ref info, 0, out var bits, IntPtr.Zero, 0);
        var font = IntPtr.Zero;
        try
        {
            if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) return coverage;
            Marshal.Copy(new byte[box * box * 4], 0, bits, box * box * 4);
            SelectObject(dc, bitmap);
            font = CreateFontW(-pixelHeight, 0, 0, 0, FontWeightSemibold, 0, 0, 0, DefaultCharset, OutTrueTypePrecision, 0,
                AntialiasedQuality, 0, "Segoe UI");
            if (font != IntPtr.Zero) SelectObject(dc, font);
            SetBkMode(dc, Transparent);
            SetTextColor(dc, 0x00FFFFFF);
            var rect = new RECT { Right = box, Bottom = box };
            DrawTextW(dc, text, text.Length, ref rect, DtCenter | DtVCenter | DtSingleLine | DtNoPrefix | DtNoClip);
            GdiFlush();
            var pixels = new byte[box * box * 4];
            Marshal.Copy(bits, pixels, 0, pixels.Length);
            for (var index = 0; index < box * box; index++)
            {
                var brightest = Math.Max(pixels[index * 4], Math.Max(pixels[index * 4 + 1], pixels[index * 4 + 2]));
                coverage[index] = brightest / 255f;
            }
            return coverage;
        }
        finally
        {
            if (font != IntPtr.Zero) DeleteObject(font);
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            DeleteDC(dc);
        }
    }

    private static void Over(float[] canvas, int index, float blue, float green, float red, float alpha)
    {
        if (alpha <= 0f) return;
        var keep = 1f - alpha;
        canvas[index + 0] = blue * alpha + canvas[index + 0] * keep;
        canvas[index + 1] = green * alpha + canvas[index + 1] * keep;
        canvas[index + 2] = red * alpha + canvas[index + 2] * keep;
        canvas[index + 3] = alpha + canvas[index + 3] * keep;
    }

    private static float Square(float value) => value * value;

    private static byte ToByte(float value) => (byte)Math.Clamp((int)MathF.Round(value * 255f), 0, 255);

    private static void WriteAtomically(string path, byte[] bytes)
    {
        var stage = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllBytes(stage, bytes);
            File.Move(stage, path, overwrite: true);
        }
        finally
        {
            try { File.Delete(stage); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
        }
    }

    private static ReadOnlySpan<byte> PngSignature => [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    private const int FontWeightSemibold = 600;
    private const uint DefaultCharset = 1;
    private const uint OutTrueTypePrecision = 4;
    private const uint AntialiasedQuality = 4;
    private const int Transparent = 1;
    private const uint DtCenter = 0x1;
    private const uint DtVCenter = 0x4;
    private const uint DtSingleLine = 0x20;
    private const uint DtNoClip = 0x100;
    private const uint DtNoPrefix = 0x800;

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public uint Size;
        public int Width;
        public int Height;
        public ushort Planes;
        public ushort BitCount;
        public uint Compression;
        public uint SizeImage;
        public int XPelsPerMeter;
        public int YPelsPerMeter;
        public uint ClrUsed;
        public uint ClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO
    {
        public BITMAPINFOHEADER Header;
        public uint Colors;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFO info, uint usage, out IntPtr bits, IntPtr section, uint offset);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr value);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr dc);

    [DllImport("gdi32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFontW(int height, int width, int escapement, int orientation, int weight,
        uint italic, uint underline, uint strikeOut, uint charSet, uint outPrecision, uint clipPrecision,
        uint quality, uint pitchAndFamily, string faceName);

    [DllImport("gdi32.dll")]
    private static extern int SetBkMode(IntPtr dc, int mode);

    [DllImport("gdi32.dll")]
    private static extern uint SetTextColor(IntPtr dc, uint colour);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int DrawTextW(IntPtr dc, string text, int count, ref RECT rect, uint format);

    [DllImport("gdi32.dll")]
    private static extern bool GdiFlush();
}
