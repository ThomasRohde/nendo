using System.Runtime.InteropServices;
using Windows.Graphics;

namespace Nendo.Desktop;

/// <summary>
/// The picture of a dragged tab under the pointer (ADR-0002), as Windows Terminal draws the tab
/// it drags: a window of its own above every other, which the pointer passes through and which
/// never takes the focus, so it can follow the pointer past the edge of the window the tab came
/// from and over any other. A layered window draws a premultiplied picture with its own
/// transparency and needs no class of its own, no painting and no messages.
/// </summary>
internal sealed class DesktopTabDragPicture : IDisposable
{
    private nint _window;
    private nint _bitmap;

    /// <summary>The picture's window, so a search for the window under the pointer can pass it by.</summary>
    internal nint Handle => _window;

    internal SizeInt32 Size { get; }

    /// <summary>How opaque the picture's middle pixel is drawn, out of 255, for the journey.</summary>
    internal int CentreAlpha { get; }

    /// <summary>Whether Windows shows the picture's window now.</summary>
    internal bool Shown => _window != 0 && IsWindowVisible(_window);

    private DesktopTabDragPicture(nint window, nint bitmap, SizeInt32 size, int centreAlpha)
    {
        _window = window;
        _bitmap = bitmap;
        Size = size;
        CentreAlpha = centreAlpha;
    }

    /// <summary>A picture window showing <paramref name="pixels"/> (premultiplied BGRA rows) at <paramref name="at"/>; null when Windows refuses one.</summary>
    internal static DesktopTabDragPicture? TryShow(byte[] pixels, int width, int height, PointInt32 at)
    {
        if (width <= 0 || height <= 0 || pixels.Length != width * height * 4) return null;
        var window = CreateWindowExW(ExLayered | ExTransparent | ExToolWindow | ExTopmost | ExNoActivate, "Static", "", Popup,
            at.X, at.Y, width, height, 0, 0, GetModuleHandleW(null), 0);
        if (window == 0) return null;
        var screen = GetDC(0);
        var memory = CreateCompatibleDC(screen);
        var header = new BitmapInfoHeader
        {
            Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(), Width = width, Height = -height, Planes = 1, BitCount = 32,
        };
        var bitmap = CreateDIBSection(screen, ref header, 0, out var bits, 0, 0);
        var shown = false;
        try
        {
            if (bitmap == 0 || bits == 0) return null;
            Marshal.Copy(pixels, 0, bits, pixels.Length);
            var previous = SelectObject(memory, bitmap);
            var place = new NativePoint(at.X, at.Y);
            var size = new NativeSize(width, height);
            var origin = new NativePoint(0, 0);
            var blend = new BlendFunction(0, 0, DesktopTabWindowRules.PictureOpacity, SourceAlpha);
            shown = UpdateLayeredWindow(window, screen, ref place, ref size, memory, ref origin, 0, ref blend, UlwAlpha);
            SelectObject(memory, previous);
            if (!shown) return null;
            ShowWindow(window, ShowNoActivate);
            return new DesktopTabDragPicture(window, bitmap, new SizeInt32(width, height), pixels[((height / 2) * width + width / 2) * 4 + 3]);
        }
        finally
        {
            DeleteDC(memory);
            ReleaseDC(0, screen);
            if (!shown)
            {
                if (bitmap != 0) DeleteObject(bitmap);
                DestroyWindow(window);
            }
        }
    }

    /// <summary>Move the picture so its top left is at <paramref name="at"/>, above every other window.</summary>
    internal void MoveTo(PointInt32 at)
    {
        if (_window == 0) return;
        SetWindowPos(_window, Topmost, at.X, at.Y, 0, 0, NoSize | NoActivate | ShowWindowFlag);
    }

    public void Dispose()
    {
        if (_window != 0) DestroyWindow(_window);
        if (_bitmap != 0) DeleteObject(_bitmap);
        _window = 0;
        _bitmap = 0;
    }

    private const uint Popup = 0x80000000;
    private const uint ExLayered = 0x00080000;
    private const uint ExTransparent = 0x00000020;
    private const uint ExToolWindow = 0x00000080;
    private const uint ExTopmost = 0x00000008;
    private const uint ExNoActivate = 0x08000000;
    private const int ShowNoActivate = 4;
    private const uint UlwAlpha = 0x2;
    private const byte SourceAlpha = 0x1;
    private const uint NoSize = 0x0001;
    private const uint NoActivate = 0x0010;
    private const uint ShowWindowFlag = 0x0040;
    private static readonly nint Topmost = -1;

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct NativePoint(int X, int Y);

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct NativeSize(int Width, int Height);

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct BlendFunction(byte Operation, byte Flags, byte SourceConstantAlpha, byte AlphaFormat);

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
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
        public uint ColoursUsed;
        public uint ColoursImportant;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateWindowExW(uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height, nint parent, nint menu, nint instance, nint parameter);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern nint GetModuleHandleW(string? moduleName);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShowWindow(nint window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowVisible(nint window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowPos(nint window, nint after, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UpdateLayeredWindow(nint window, nint screen, ref NativePoint place, ref NativeSize size,
        nint source, ref NativePoint origin, uint colourKey, ref BlendFunction blend, uint flags);

    [DllImport("user32.dll")]
    private static extern nint GetDC(nint window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(nint window, nint context);

    [DllImport("gdi32.dll")]
    private static extern nint CreateCompatibleDC(nint context);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteDC(nint context);

    [DllImport("gdi32.dll")]
    private static extern nint CreateDIBSection(nint context, ref BitmapInfoHeader header, uint usage, out nint bits, nint section, uint offset);

    [DllImport("gdi32.dll")]
    private static extern nint SelectObject(nint context, nint item);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(nint item);
}
