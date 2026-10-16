using System.Collections.Concurrent;

namespace Nendo.Engine;

/// <summary>
/// The chunks of pictures a client sends (ADR-0031), by the key they are sent under: an agent over
/// MCP, or a view through the Workbench. In memory only,
/// so a picture that never commits leaves nothing in the file; one left unfinished for fifteen
/// minutes is dropped.
/// </summary>
public sealed class NendoMediaUploads<TResult> where TResult : class
{
    private static readonly TimeSpan Abandoned = TimeSpan.FromMinutes(15);
    private readonly ConcurrentDictionary<string, Upload> _uploads = new(StringComparer.Ordinal);

    private sealed class Upload
    {
        internal readonly MemoryStream Bytes = new();
        internal DateTimeOffset Touched = DateTimeOffset.UtcNow;
    }

    /// <summary>Adds a chunk at its offset: the same chunk again changes nothing; a gap or an overrun is refused.</summary>
    public long Stage(string key, long offset, byte[] chunk)
    {
        foreach (var (staleKey, stale) in _uploads)
            if (DateTimeOffset.UtcNow - stale.Touched > Abandoned) _uploads.TryRemove(staleKey, out _);
        var upload = _uploads.GetOrAdd(key, _ => new Upload());
        lock (upload)
        {
            upload.Touched = DateTimeOffset.UtcNow;
            var held = upload.Bytes.Length;
            if (offset < 0 || offset > held)
                throw new NendoValidationException($"This picture has {held} bytes staged under that key, so the next chunk starts at offset {held}.");
            if (offset + chunk.LongLength > NendoMedia.MaximumItemBytes)
            {
                _uploads.TryRemove(key, out _);
                throw new NendoPreconditionException("media-too-large", $"A picture is at most {NendoMedia.MaximumItemBytes / (1024 * 1024)} MiB.");
            }
            if (offset < held)
            {
                // A retried chunk: what is already staged must be the same bytes.
                var existing = upload.Bytes.GetBuffer().AsSpan((int)offset, (int)Math.Min(chunk.LongLength, held - offset));
                if (!existing.SequenceEqual(chunk.AsSpan(0, existing.Length)))
                    throw new NendoValidationException($"Bytes at offset {offset} differ from what was staged under that key. Start again under a new key.");
                if (offset + chunk.LongLength <= held) return held;
                upload.Bytes.Position = held;
                upload.Bytes.Write(chunk, existing.Length, chunk.Length - existing.Length);
            }
            else
            {
                upload.Bytes.Position = held;
                upload.Bytes.Write(chunk);
            }
            return upload.Bytes.Length;
        }
    }

    public byte[] Take(string key)
    {
        if (!_uploads.TryRemove(key, out var upload)) return [];
        lock (upload) return upload.Bytes.ToArray();
    }

    public void Forget(string key) => _uploads.TryRemove(key, out _);

    private readonly ConcurrentDictionary<string, (TResult Result, DateTimeOffset At)> _committed = new(StringComparer.Ordinal);

    public TResult? Committed(string key)
    {
        foreach (var (staleKey, stale) in _committed)
            if (DateTimeOffset.UtcNow - stale.At > Abandoned) _committed.TryRemove(staleKey, out _);
        return _committed.TryGetValue(key, out var done) ? done.Result : null;
    }

    public void Remember(string key, TResult result) => _committed[key] = (result, DateTimeOffset.UtcNow);
}
