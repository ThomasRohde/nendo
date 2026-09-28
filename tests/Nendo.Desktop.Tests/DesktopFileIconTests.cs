using System.Text.RegularExpressions;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// W-089. Every Nendo window carried the same icon, so several open files were identical
/// buttons in Alt+Tab, identical icons in the notification area and identical notifications.
/// Each file's icon is now the mark with a badge in its tone carrying its letter.
/// </summary>
[TestClass]
public sealed class DesktopFileIconTests
{
    private static string Mark => File.Exists(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"))
        ? Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico")
        : Path.Combine(RepositoryRoot(), "src", "Nendo.Desktop", "Assets", "AppIcon.ico");

    [TestMethod]
    public async Task TheIconCarriesEveryFrameTheShellAsksForAndIsDrawnOncePerLook()
    {
        await using var workspace = new DesktopTestWorkspace();
        var root = DesktopFileIcon.CacheRoot(workspace.FileHistoryRoot);
        var look = new NendoResolvedLook("violet", "B", true, true);
        var files = await DesktopFileIcon.EnsureAsync(root, look, Mark);

        var frames = DesktopFileIcon.ReadIconFrames(await File.ReadAllBytesAsync(files.Icon));
        CollectionAssert.AreEqual(DesktopFileIcon.IconSizes.ToArray(), frames.Keys.Order().ToArray());
        Assert.IsGreaterThan(0L, new FileInfo(files.TitleBarImage).Length);
        Assert.IsGreaterThan(0L, new FileInfo(files.NotificationImage).Length);
        StringAssert.Contains(Path.GetFileName(files.Icon), "violet", "Kept by look, so every file with this look shares it.");

        var drawnAt = File.GetLastWriteTimeUtc(files.Icon);
        await Task.Delay(50);
        var again = await DesktopFileIcon.EnsureAsync(root, look, Mark);
        Assert.AreEqual(files, again);
        Assert.AreEqual(drawnAt, File.GetLastWriteTimeUtc(files.Icon), "A look drawn once is not drawn again.");

        if (Environment.GetEnvironmentVariable("NENDO_ICON_SAMPLES") is { Length: > 0 } samples)
        {
            foreach (var tone in DesktopFileIcon.ToneColours.Keys)
            {
                await DesktopFileIcon.EnsureAsync(samples, new NendoResolvedLook(tone, tone[..1].ToUpperInvariant(), true, true), Mark);
            }
        }
    }

    [TestMethod]
    [DataRow("violet", 48)]
    [DataRow("teal", 32)]
    [DataRow("amber", 24)]
    [DataRow("green", 16)]
    [DataRow("grey", 256)]
    public async Task TheBadgeIsTheToneRingedInWhiteAndTheMarkIsStillThere(string tone, int size)
    {
        var mark = DesktopFileIcon.ReadIconFrames(await File.ReadAllBytesAsync(Mark));
        var pixels = await DesktopFileIcon.RenderAsync(mark, new NendoResolvedLook(tone, "W", true, true), size);
        Assert.HasCount(size * size * 4, pixels);
        var badge = DesktopFileIcon.BadgeFor(size);
        var colour = DesktopFileIcon.ToneColours[tone];

        // The tone fills the dot: most of the pixels well inside it are the tone itself,
        // opaque, and the rest are the letter.
        int inside = 0, toned = 0;
        for (var y = 0; y < size; y++)
        {
            for (var x = 0; x < size; x++)
            {
                if (Distance(x, y, badge) > badge.Inner - 1f) continue;
                inside++;
                if (Near(Pixel(pixels, size, x, y), colour)) toned++;
            }
        }
        Assert.IsGreaterThan(0, inside, $"{size}px has a dot to measure");
        // Where a letter shares a small dot, it can take most of it; the tone must still be plain.
        Assert.IsGreaterThanOrEqualTo(inside * (size >= 24 ? 0.3 : 0.5), (double)toned,
            $"{tone} at {size}px: {toned} of {inside} pixels inside the dot are the tone");

        // Where the ring is wide enough to hold a whole pixel, that pixel is white.
        if (badge.Outer - badge.Inner >= 2.5f)
        {
            var ringMiddle = (badge.Outer + badge.Inner) / 2f;
            var ring = Pixel(pixels, size, (int)MathF.Floor(badge.CentreX - ringMiddle), (int)MathF.Floor(badge.CentreY));
            Assert.IsTrue(Near(ring, 0xFFFFFF), $"ring at {size}px is {ring}");
        }

        // The arch is the mark, untouched by the badge.
        var markPixel = Pixel(pixels, size, (int)(size * 0.50f), (int)(size * 0.28f));
        Assert.IsGreaterThan(200, markPixel.Alpha, $"the mark at {size}px");
    }

    [TestMethod]
    public async Task TheLetterIsDrawnFrom24PixelsUpAndLeftOutBelow()
    {
        var mark = DesktopFileIcon.ReadIconFrames(await File.ReadAllBytesAsync(Mark));
        // A pixel of the letter is one much lighter than the tone it sits on.
        int LetterPixels(byte[] pixels, int size)
        {
            var badge = DesktopFileIcon.BadgeFor(size);
            var count = 0;
            for (var y = 0; y < size; y++)
            {
                for (var x = 0; x < size; x++)
                {
                    if (Distance(x, y, badge) > badge.Inner - 1f) continue;
                    var pixel = Pixel(pixels, size, x, y);
                    if (pixel.Red + pixel.Green + pixel.Blue > 3 * 190) count++;
                }
            }
            return count;
        }
        var look = new NendoResolvedLook("violet", "W", true, true);
        Assert.IsGreaterThanOrEqualTo(10, LetterPixels(await DesktopFileIcon.RenderAsync(mark, look, 48), 48), "A W at 48px is there to read.");
        Assert.IsGreaterThanOrEqualTo(2, LetterPixels(await DesktopFileIcon.RenderAsync(mark, look, 24), 24), "…and at 24px.");
        Assert.AreEqual(0, LetterPixels(await DesktopFileIcon.RenderAsync(mark, look, 16), 16), "At 16px the badge is a dot.");
        Assert.IsGreaterThanOrEqualTo(10, LetterPixels(await DesktopFileIcon.RenderAsync(mark, look with { Letter = "Ø" }, 48), 48),
            "A letter from beyond ASCII is drawn too.");
    }

    [TestMethod]
    public void TheIconsTonesAreTheLightThemesChoiceTones()
    {
        var tokens = File.ReadAllText(Path.Combine(RepositoryRoot(), "src", "Nendo.Workbench", "src", "styles", "02-tokens.css"));
        var light = tokens[..tokens.IndexOf(":root[data-theme=\"dark\"]", StringComparison.Ordinal)];
        var declared = Regex.Matches(light, @"--tone-(?<name>[a-z]+):\s*#(?<hex>[0-9a-fA-F]{6});")
            .ToDictionary(match => match.Groups["name"].Value, match => Convert.ToInt32(match.Groups["hex"].Value, 16));
        CollectionAssert.AreEquivalent(NendoLook.Tones.ToArray(), declared.Keys.ToArray());
        foreach (var (name, value) in declared)
        {
            Assert.AreEqual(value, DesktopFileIcon.ToneColours[name], $"--tone-{name} and the icon's {name} have drifted apart.");
        }
    }

    private static float Distance(int x, int y, (float CentreX, float CentreY, float Outer, float Inner) badge) =>
        MathF.Sqrt(MathF.Pow(x + 0.5f - badge.CentreX, 2) + MathF.Pow(y + 0.5f - badge.CentreY, 2));

    private static bool Near((byte Blue, byte Green, byte Red, byte Alpha) pixel, int rgb) =>
        pixel.Alpha == 255 &&
        Math.Abs(pixel.Red - ((rgb >> 16) & 0xFF)) <= 12 &&
        Math.Abs(pixel.Green - ((rgb >> 8) & 0xFF)) <= 12 &&
        Math.Abs(pixel.Blue - (rgb & 0xFF)) <= 12;

    private static (byte Blue, byte Green, byte Red, byte Alpha) Pixel(byte[] pixels, int size, int x, int y)
    {
        var index = (y * size + x) * 4;
        return (pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]);
    }

    private static string RepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) return directory.FullName;
        }
        throw new InvalidOperationException("The repository root was not found above the test output.");
    }
}
