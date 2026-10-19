namespace Nendo.Desktop.Tests;

/// <summary>
/// Sizes this test process's thread pool for what the suite does, as the LocalMcp suite's
/// TestHostThreads does. The suite runs its methods in parallel, one per
/// processor, and many of them start their own MCP host, write a real file through synchronous
/// SQLite or wait on a child process, each holding a pool thread while it waits. The pool adds a
/// thread beyond its minimum only every half second or so, so a fresh host's first answer
/// queued behind them. A running Nendo has one host and one file: this is the harness's shape,
/// not the product's. Called once, before any test, from the assembly's one initializer.
/// </summary>
internal static class DesktopTestHostThreads
{
    internal static int Minimum => Environment.ProcessorCount * 4;

    internal static void SizeThePool()
    {
        ThreadPool.GetMinThreads(out var workers, out var completion);
        ThreadPool.SetMinThreads(Math.Max(workers, Minimum), completion);
    }
}
