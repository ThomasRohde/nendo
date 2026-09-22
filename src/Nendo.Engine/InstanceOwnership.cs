using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Nendo.Engine;

/// <summary>
/// A Windows kernel-object lifetime guard, independent of paths and threads.
/// It is not an event signal protocol: only atomic creation grants ownership.
/// Closing the last handle (including process termination) releases the name.
/// </summary>
internal sealed class InstanceOwnershipLease : IDisposable
{
    private EventWaitHandle? _handle;

    private InstanceOwnershipLease(EventWaitHandle handle) => _handle = handle;

    internal static InstanceOwnershipLease Acquire(string instanceId)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Local instance ownership currently supports Windows only.");
        try
        {
            var handle = new EventWaitHandle(false, EventResetMode.ManualReset, ObjectNameFor(instanceId), out var created);
            if (!created)
            {
                handle.Dispose();
                throw new NendoWriteOwnershipException(
                    "This application instance is already open for editing in another Nendo session. Open it read-only or create a Duplicate or Fork.",
                    "instance-in-use");
            }
            return new(handle);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException or WaitHandleCannotBeOpenedException or IOException)
        {
            throw new NendoWriteOwnershipException("Nendo could not establish exclusive local ownership of this application instance.", "instance-guard-unavailable");
        }
    }

    internal static string ObjectNameFor(string instanceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instanceId);
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        using var identity = WindowsIdentity.GetCurrent();
        var user = identity.User?.Value ?? throw new UnauthorizedAccessException("No Windows user identity is available.");
        return $"Global\\Nendo.Instance.v1.{Digest(user)}.{Digest(instanceId)}";
    }

    private static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    public void Dispose() => Interlocked.Exchange(ref _handle, null)?.Dispose();
}
