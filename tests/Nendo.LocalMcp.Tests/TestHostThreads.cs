namespace Nendo.LocalMcp.Tests;

/// <summary>
/// Sizes this test process's thread pool for what the suite does, which is not what Nendo does.
///
/// The suite runs its methods in parallel, one per processor, and most of them start their own
/// MCP host and write a real file through synchronous SQLite. Each of those holds a pool thread
/// while it waits. Measured under the full gate on 2026-09-26: fourteen handshakes took 2.9 to
/// 3.7 s instead of well under one, with the pool at 23 threads against a minimum of 22, up to
/// 21 busy and 10 items queued. The pool adds a thread beyond its minimum only every half
/// second or so. On a busier machine the same handshake ran past the client's 10 s bound and
/// was reported as "the server does not support the requested protocol version".
///
/// A running Nendo has one host and one file, so this is the test harness's shape, not the
/// product's. The fix is to size the harness rather than to lengthen the bound, which would
/// only hide a stall of the same kind somewhere else. ProtocolResourceTests.ConnectAsync still
/// reports a slow handshake with the pool's counters, so a regression is visible.
/// </summary>
[TestClass]
public static class TestHostThreads
{
    [AssemblyInitialize]
    public static void SizeThePool(TestContext _)
    {
        ThreadPool.GetMinThreads(out var workers, out var completion);
        ThreadPool.SetMinThreads(Math.Max(workers, Environment.ProcessorCount * 4), completion);
    }
}
