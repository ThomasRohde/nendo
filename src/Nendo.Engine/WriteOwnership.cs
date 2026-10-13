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
        // Only a sharing or lock violation means another owner; a write-protected volume or a full
        // disk is a place Nendo cannot write, and is said to be (ESC-01).
        catch (IOException exception) when ((exception.HResult & 0xFFFF) is 32 or 33)
        {
            throw new NendoWriteOwnershipException(
                "Another Nendo coordinator already owns writes for this file.");
        }
        catch (IOException)
        {
            throw new NendoWriteOwnershipException(
                "Write ownership could not be acquired for this Nendo file.", "write-ownership-denied");
        }
        catch (UnauthorizedAccessException)
        {
            // A folder or file Nendo may not write in, as distinct from another owner (ESC-01).
            throw new NendoWriteOwnershipException(
                "Write ownership could not be acquired for this Nendo file.", "write-ownership-denied");
        }
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref _stream, null)?.Dispose();
    }
}
