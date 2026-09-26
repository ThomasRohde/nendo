namespace Nendo.Engine.Tests;

/// <summary>
/// A bounded wait on a child process's output that says, when it runs out, what the test
/// process itself was doing.
///
/// The child writes its readiness line within a second or two, and the wait for it ran out
/// at 20 s under the full gate. The line is read by an async continuation in this process,
/// so a timeout can mean either a slow child or a starved thread pool here that never got
/// round to reading it. The pool's own counters at that moment tell the two apart.
/// </summary>
internal static class TestWaits
{
    /// <summary>
    /// How long a child process may take to say it is ready: start pwsh, load the Engine, open
    /// the fixture. Measured on 2026-09-26 under the full gate: a 20 s wait ran out with this
    /// process's pool at 32 threads, 24 busy and nothing queued, so the reader was ready and the
    /// child was slow to start. Start-up time is not what these tests measure, so the bound is
    /// generous; a child that never answers still fails, and says what the pool was doing.
    /// </summary>
    public static readonly TimeSpan ChildStart = TimeSpan.FromSeconds(60);

    public static async Task<T> WithinAsync<T>(this Task<T> task, TimeSpan bound, string what)
    {
        try { return await task.WaitAsync(bound); }
        catch (TimeoutException)
        {
            throw new TimeoutException($"Waited {bound.TotalSeconds:0} s for {what}. {PoolState()}");
        }
    }

    public static string PoolState()
    {
        ThreadPool.GetAvailableThreads(out var workers, out _);
        ThreadPool.GetMaxThreads(out var maxWorkers, out _);
        ThreadPool.GetMinThreads(out var minWorkers, out _);
        return $"Thread pool: {ThreadPool.ThreadCount} threads (min {minWorkers}, busy {maxWorkers - workers}), " +
            $"{ThreadPool.PendingWorkItemCount} work items queued, {Environment.ProcessorCount} processors.";
    }
}
