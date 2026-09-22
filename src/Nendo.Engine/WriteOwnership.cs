using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

internal sealed class WriteOwnershipLease : IDisposable
{
    private FileStream? _stream;

    private WriteOwnershipLease(FileStream stream)
    {
        _stream = stream;
    }

    internal static WriteOwnershipLease Acquire(string applicationPath, string ownerId)
    {
        var lockPath = $"{applicationPath}.write-owner";
        try
        {
            var stream = new FileStream(lockPath, new FileStreamOptions
            {
                Access = FileAccess.ReadWrite,
                Mode = FileMode.OpenOrCreate,
                Share = FileShare.Read,
                Options = FileOptions.DeleteOnClose | FileOptions.WriteThrough,
            });
            try
            {
                stream.SetLength(0);
                var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
                {
                    ownerId,
                    processId = Environment.ProcessId,
                }));
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
                return new WriteOwnershipLease(stream);
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }
        catch (IOException)
        {
            throw new NendoWriteOwnershipException(
                "Another Nendo coordinator already owns writes for this file.");
        }
        catch (UnauthorizedAccessException)
        {
            throw new NendoWriteOwnershipException(
                "Write ownership could not be acquired for this Nendo file.");
        }
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref _stream, null)?.Dispose();
    }
}
