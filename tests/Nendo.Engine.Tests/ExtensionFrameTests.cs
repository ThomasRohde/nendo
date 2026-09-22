namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ExtensionFrameTests
{
    [TestMethod]
    public async Task PartialReadsPreserveFrameBoundariesAndCleanEof()
    {
        using var wire = new MemoryStream();
        await NendoExtensionFrameCodec.WriteAsync(wire, "one"u8.ToArray(), 64);
        await NendoExtensionFrameCodec.WriteAsync(wire, "two"u8.ToArray(), 64);
        using var fragmented = new FragmentedStream(wire.ToArray());
        CollectionAssert.AreEqual("one"u8.ToArray(), await NendoExtensionFrameCodec.ReadAsync(fragmented, 64));
        CollectionAssert.AreEqual("two"u8.ToArray(), await NendoExtensionFrameCodec.ReadAsync(fragmented, 64));
        Assert.IsNull(await NendoExtensionFrameCodec.ReadAsync(fragmented, 64));
    }

    [TestMethod]
    public async Task HugeDeclaredLengthIsRejectedBeforeReadingOrAllocatingBody()
    {
        using var wire = new MemoryStream([255, 255, 255, 127]);
        await Assert.ThrowsExactlyAsync<InvalidDataException>(async () => await NendoExtensionFrameCodec.ReadAsync(wire, 65536));
        Assert.AreEqual(4L, wire.Position);
    }

    [TestMethod]
    public async Task TruncatedFramesZeroLengthsAndCancellationNeverBecomeMessages()
    {
        foreach (var bytes in new byte[][] { [1], [3, 0, 0, 0, 1] })
        {
            using var wire = new MemoryStream(bytes);
            await Assert.ThrowsExactlyAsync<EndOfStreamException>(async () => await NendoExtensionFrameCodec.ReadAsync(wire, 64));
        }
        using var zero = new MemoryStream(new byte[4]);
        await Assert.ThrowsExactlyAsync<InvalidDataException>(async () => await NendoExtensionFrameCodec.ReadAsync(zero, 64));
        using var cancelled = new CancellationTokenSource(); cancelled.Cancel();
        using var stream = new MemoryStream([1, 0, 0, 0, 42]);
        await Assert.ThrowsAsync<OperationCanceledException>(async () => await NendoExtensionFrameCodec.ReadAsync(stream, 64, cancelled.Token));
    }

    private sealed class FragmentedStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            base.ReadAsync(buffer[..Math.Min(1, buffer.Length)], cancellationToken);
    }
}
