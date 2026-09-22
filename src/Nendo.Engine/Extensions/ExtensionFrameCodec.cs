using System.Buffers.Binary;

namespace Nendo.Engine;

/// <summary>Bounded framing only. The transport owner authenticates the OS peer before reading.</summary>
public static class NendoExtensionFrameCodec
{
    public static async ValueTask<byte[]?> ReadAsync(Stream stream, int maximumBytes,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (maximumBytes is < 1 or > 2 * 1024 * 1024) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        var header = new byte[4];
        var first = await stream.ReadAsync(header.AsMemory(0, 1), cancellationToken);
        if (first == 0) return null;
        await stream.ReadExactlyAsync(header.AsMemory(1), cancellationToken);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (length == 0 || length > maximumBytes) throw new InvalidDataException("Extension frame length exceeds the permitted bound.");
        var payload = new byte[(int)length];
        await stream.ReadExactlyAsync(payload, cancellationToken);
        return payload;
    }

    public static async ValueTask WriteAsync(Stream stream, ReadOnlyMemory<byte> payload, int maximumBytes,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(stream);
        if (maximumBytes is < 1 or > 2 * 1024 * 1024) throw new ArgumentOutOfRangeException(nameof(maximumBytes));
        if (payload.Length == 0 || payload.Length > maximumBytes) throw new InvalidDataException("Extension frame length exceeds the permitted bound.");
        var header = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(header, (uint)payload.Length);
        // Caller serializes writers; interleaved writers are not a supported transport.
        await stream.WriteAsync(header, cancellationToken);
        await stream.WriteAsync(payload, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }
}
