using System.Text.RegularExpressions;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// The open file's media origin (ADR-0031 point 10, W-265): embedded pictures streamed from the
/// file, local pictures only when they are what they claim to be, and headers that let a page show
/// a picture without letting script on another origin read it.
/// </summary>
[TestClass]
public sealed class DesktopMediaServingTests
{
    [TestMethod]
    public void TheMediaOriginIsTheFilesAndNoViewCanHaveIt()
    {
        var host = DesktopMediaOrigins.Host("app-one", "instance-one");
        StringAssert.Matches(host, new Regex(@"^media-[0-9a-f]{16}\.example$"));
        Assert.AreEqual(host, DesktopMediaOrigins.Host("app-one", "instance-one"));
        Assert.AreNotEqual(host, DesktopMediaOrigins.Host("app-one", "instance-two"), "Two instances must not share a media origin.");
        Assert.IsTrue(ExtensionOrigins.IsViewHost(host), "The asset server's filter must see it.");
        // A view host ends in a hyphen and ten hexadecimal characters; this label cannot.
        Assert.IsFalse(Regex.IsMatch(host, @"-[0-9a-f]{10}\.example$"));
    }

    [TestMethod]
    public async Task AnEmbeddedPictureIsServedWholeOrByRangeAndCached()
    {
        await using var workspace = new DesktopTestWorkspace();
        var picture = Png(64, 48, 300_000);
        await SeedAsync(workspace.FilePath, picture);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        var origin = new Uri((await session.GetViewAsync()).MediaOrigin!);
        Assert.IsTrue(session.IsMediaHost(origin.Host));

        var sha = NendoExtensionContent.Sha256(picture);
        var answer = await session.ResolveMediaAsync("m/" + sha, "");
        Assert.AreEqual(200, answer.Status);
        Assert.AreEqual("image/png", answer.MediaType);
        Assert.AreEqual(picture.LongLength, answer.Length);
        CollectionAssert.AreEqual(picture, await ReadAllAsync(answer.Open!(0, answer.Length)));
        CollectionAssert.AreEqual(picture[1000..1100], await ReadAllAsync(answer.Open!(1000, 100)), "a range returns exactly its bytes");

        var headers = DesktopMediaResponses.Headers(answer, 200, 0, answer.Length - 1);
        CollectionAssert.Contains(headers.ToList(), "Cache-Control: private, max-age=31536000, immutable");
        CollectionAssert.Contains(headers.ToList(), "X-Content-Type-Options: nosniff");
        Assert.IsFalse(headers.Any(header => header.StartsWith("Access-Control-", StringComparison.OrdinalIgnoreCase)),
            "a CORS header would let script on another origin read the picture");

        Assert.AreEqual(404, (await session.ResolveMediaAsync("m/" + new string('0', 64), "")).Status);
        Assert.AreEqual(404, (await session.ResolveMediaAsync("x/" + sha, "")).Status);
        await session.CloseAsync();
        Assert.AreEqual(404, (await session.ResolveMediaAsync("m/" + sha, "")).Status, "a closed file's pictures are still served");
        Assert.IsFalse(session.IsMediaHost(origin.Host));
    }

    /// <summary>
    /// WebView2 reads a picture's stream synchronously on the UI thread. A read whose async half
    /// queued back to that thread waited on itself for ever: on the real host no embedded picture
    /// loaded and every bridge request after one hung (W-274). Measured on a thread whose context,
    /// like a blocked UI thread, never runs what is queued to it.
    /// </summary>
    [TestMethod]
    public void ASynchronousReadOnABlockedUiThreadStillCompletes()
    {
        var content = Enumerable.Range(0, 4096).Select(index => (byte)index).ToArray();
        var stream = new DesktopMediaContentStream(async (offset, buffer, token) =>
        {
            // Like the Engine's gate and SQLite reads: a continuation that wants the caller's context.
            await Task.Delay(5, token);
            var count = (int)Math.Min(buffer.Length, content.Length - offset);
            content.AsMemory((int)offset, count).CopyTo(buffer);
            return count;
        }, 0, content.Length);
        var read = -1;
        var thread = new Thread(() =>
        {
            SynchronizationContext.SetSynchronizationContext(new NeverRunsContext());
            read = stream.Read(new byte[1024], 0, 1024);
        }) { IsBackground = true };
        thread.Start();
        Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(10)), "The read deadlocked on the thread it was waiting on.");
        Assert.AreEqual(1024, read);
    }

    /// <summary>
    /// The same, for the asynchronous read WebView2's random-access adapter starts on the UI
    /// thread and then waits for: begun there, the Engine's read resumed there and never finished,
    /// and no embedded picture loaded (W-274).
    /// </summary>
    [TestMethod]
    public void AnAsynchronousReadBegunOnABlockedUiThreadStillCompletes()
    {
        var content = Enumerable.Range(0, 4096).Select(index => (byte)index).ToArray();
        var stream = new DesktopMediaContentStream(async (offset, buffer, token) =>
        {
            await Task.Delay(5, token);
            var count = (int)Math.Min(buffer.Length, content.Length - offset);
            content.AsMemory((int)offset, count).CopyTo(buffer);
            return count;
        }, 0, content.Length);
        var read = -1;
        var thread = new Thread(() =>
        {
            SynchronizationContext.SetSynchronizationContext(new NeverRunsContext());
            read = stream.ReadAsync(new byte[1024]).AsTask().GetAwaiter().GetResult();
        }) { IsBackground = true };
        thread.Start();
        Assert.IsTrue(thread.Join(TimeSpan.FromSeconds(10)), "The read begun on the UI thread waited for that thread to resume it.");
        Assert.AreEqual(1024, read);
    }

    /// <summary>A UI thread that is busy waiting: what is posted to it never runs.</summary>
    private sealed class NeverRunsContext : SynchronizationContext
    {
        public override void Post(SendOrPostCallback callback, object? state) { }
        public override void Send(SendOrPostCallback callback, object? state) { }
    }

    /// <summary>Alone, since the allocation it measures is the whole process's.</summary>
    [TestMethod]
    [DoNotParallelize]
    public async Task ALargePictureIsStreamedNotHeldWhole()
    {
        await using var workspace = new DesktopTestWorkspace();
        var picture = Png(4000, 3000, 60 * 1024 * 1024);
        await SeedAsync(workspace.FilePath, picture);
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        await session.GetViewAsync();
        var answer = await session.ResolveMediaAsync("m/" + NendoExtensionContent.Sha256(picture), "");
        picture = null;
        GC.Collect();

        var before = GC.GetTotalAllocatedBytes(precise: true);
        await using (var stream = answer.Open!(0, answer.Length))
        {
            var buffer = new byte[1024 * 1024];
            long total = 0;
            int read;
            while ((read = await stream.ReadAsync(buffer)) > 0) total += read;
            Assert.AreEqual(answer.Length, total);
        }
        var allocated = GC.GetTotalAllocatedBytes(precise: true) - before;
        Assert.IsLessThan(16L * 1024 * 1024, allocated, $"serving a 60 MiB picture allocated {allocated / (1024 * 1024)} MiB");
    }

    [TestMethod]
    public async Task ALocalPictureIsServedOnlyWhenItIsAFileOfItsOwnType()
    {
        await using var workspace = new DesktopTestWorkspace();
        await SeedAsync(workspace.FilePath, Png(2, 2, 64));
        var folder = Path.GetDirectoryName(workspace.FilePath)!;
        var cover = Png(10, 10, 2048);
        await File.WriteAllBytesAsync(Path.Combine(folder, "cover.png"), cover);
        Directory.CreateDirectory(Path.Combine(folder, "folder.png"));
        await File.WriteAllBytesAsync(Path.Combine(folder, "renamed.png"), "MZ\u0090\u0000 not a picture"u8.ToArray());
        await File.WriteAllTextAsync(Path.Combine(folder, "notes.jpg"), "just text");
        await File.WriteAllBytesAsync(Path.Combine(folder, "cover.txt"), cover);
        await File.WriteAllTextAsync(Path.Combine(folder, "mark.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>");

        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await session.OpenAsync(workspace.FilePath);
        await session.GetViewAsync();

        foreach (var address in new[] { Path.Combine(folder, "cover.png"), @".\cover.png", "./cover.png" })
        {
            var answer = await session.ResolveMediaAsync("f/", "?a=" + Uri.EscapeDataString(address));
            Assert.AreEqual(200, answer.Status, address);
            CollectionAssert.AreEqual(cover, await ReadAllAsync(answer.Open!(0, answer.Length)), address);
            CollectionAssert.Contains(DesktopMediaResponses.Headers(answer, 200, 0, answer.Length - 1).ToList(), "Cache-Control: no-store");
        }
        // WebView2 takes a body only as a random-access stream, which must seek: a window of a
        // local file that could not was refused there, and every linked picture answered 500 (W-274).
        var local = await session.ResolveMediaAsync("f/", "?a=" + Uri.EscapeDataString(@".\cover.png"));
        var window = local.Open!(100, 200);
        Assert.IsTrue(window.CanSeek, "A body that cannot seek is refused by WebView2, and the picture is answered as a server error.");
        window.Position = 50;
        CollectionAssert.AreEqual(cover[150..300], await ReadAllAsync(window), "a seek within the range reads from there");

        foreach (var address in new[] { @".\folder.png", @".\renamed.png", @".\notes.jpg", @".\cover.txt", @".\missing.png", "cover.png",
                     "https://example.org/cover.png", "media:" + new string('a', 64) })
            Assert.AreEqual(404, (await session.ResolveMediaAsync("f/", "?a=" + Uri.EscapeDataString(address))).Status, address);

        var svg = await session.ResolveMediaAsync("f/", "?a=" + Uri.EscapeDataString(@".\mark.svg"));
        Assert.AreEqual("image/svg+xml", svg.MediaType);
        Assert.IsTrue(DesktopMediaResponses.Headers(svg, 200, 0, svg.Length - 1).Any(header => header.StartsWith("Content-Security-Policy: sandbox", StringComparison.Ordinal)),
            "an SVG opened on its own would run its script");
    }

    [TestMethod]
    public void RangesAreReadAsAMediaElementSendsThem()
    {
        Assert.IsTrue(DesktopMediaResponses.TryRange("bytes=0-99", 1000, out var start, out var end));
        Assert.AreEqual((0L, 99L), (start, end));
        Assert.IsTrue(DesktopMediaResponses.TryRange("bytes=900-", 1000, out start, out end));
        Assert.AreEqual((900L, 999L), (start, end));
        Assert.IsTrue(DesktopMediaResponses.TryRange("bytes=-10", 1000, out start, out end));
        Assert.AreEqual((990L, 999L), (start, end));
        Assert.IsTrue(DesktopMediaResponses.TryRange("bytes=5000000000-", 6_000_000_000, out start, out _), "a long offset");
        Assert.IsFalse(DesktopMediaResponses.TryRange("bytes=0-1,5-6", 1000, out _, out _));
        Assert.IsFalse(DesktopMediaResponses.TryRange("bytes=1000-", 1000, out _, out _));
    }

    private static async Task SeedAsync(string path, byte[] picture)
    {
        await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "media-serving-test");
        await coordinator.ApplyAsync(new NendoMutation("test", "picture", "test", "Embed a picture", [PutMediaOperation.FromContent("put", picture)]));
    }

    private static async Task<byte[]> ReadAllAsync(Stream stream)
    {
        await using (stream)
        {
            using var copy = new MemoryStream();
            await stream.CopyToAsync(copy);
            return copy.ToArray();
        }
    }

    private static byte[] Png(int width, int height, int length)
    {
        var bytes = new byte[Math.Max(length, 33)];
        new Random(width * 31 + height).NextBytes(bytes);
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52 }.CopyTo(bytes, 0);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(16), (uint)width);
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(20), (uint)height);
        return bytes;
    }
}
