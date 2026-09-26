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
