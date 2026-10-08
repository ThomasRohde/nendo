using System.Diagnostics;

namespace Nendo.Engine.Tests;

/// <summary>
/// Opens a file through the Engine straight after a child process that had it open was killed
/// (F-134, the second half; W-198).
///
/// <see cref="ObservedFile"/> covers the tests' own reads. The Engine's open pins the path with
/// <c>FileShare.ReadWrite</c> and no <c>Delete</c>, so a handle still on the file that does not
/// share reading, or that holds delete access, refuses it with a sharing violation: the killed
/// child's last handle on its way out, or a scanner looking at what the child wrote. On
/// 2026-10-08 that failed one full gate at <c>OpenPathPin</c>, after the child's writer marker had
/// already gone. Which process held the file for a moment is not what these tests check; what
/// the Engine does with the file is. So a sharing violation is waited out for a bounded time and
/// the holder named; any other refusal is the answer and fails at once, and a holder that never
/// lets go still fails.
/// </summary>
internal static class LingeringHandle
{
    internal static readonly TimeSpan Bound = TimeSpan.FromSeconds(15);

    /// <summary>
    /// Run <paramref name="open"/>, and while it is refused by a sharing violation on
    /// <paramref name="path"/>, log the holder and try again until <paramref name="bound"/>.
    /// </summary>
    internal static async Task<T> OpenAsync<T>(string path, Func<Task<T>> open, TimeSpan? bound = null, Action<string>? log = null)
    {
        var limit = bound ?? Bound;
        var elapsed = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                return await open();
            }
            catch (IOException error) when (IsSharingViolation(error) && elapsed.Elapsed < limit)
            {
                (log ?? Console.WriteLine)($"LingeringHandle: {Path.GetFileName(path)} refused after {elapsed.ElapsedMilliseconds} ms, held by {ObservedFile.Holders(path)}: {error.Message}");
                await Task.Delay(100);
            }
        }
    }

    /// <summary>ERROR_SHARING_VIOLATION or ERROR_LOCK_VIOLATION: another handle, not the file's contents.</summary>
    internal static bool IsSharingViolation(IOException error) => (error.HResult & 0xFFFF) is 32 or 33;
}
