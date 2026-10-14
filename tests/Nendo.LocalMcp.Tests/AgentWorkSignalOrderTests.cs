namespace Nendo.LocalMcp.Tests;

/// <summary>
/// R2SP-12. The work signal took each state under its lock and delivered it after releasing
/// it, so two overlapping calls' deliveries were in no order: one call's idle could arrive
/// after the next call's busy, and the window said nothing was running for the whole of a
/// long write.
/// </summary>
[TestClass]
public sealed class AgentWorkSignalOrderTests
{
    [TestMethod]
    public async Task AnEarlierCallsIdleNeverArrivesAfterALaterCallsBusy()
    {
        var signal = new NendoAgentWorkSignal();
        var delivered = new List<NendoAgentWork>();
        using var idleArrived = new ManualResetEventSlim();
        using var releaseIdle = new ManualResetEventSlim();
        var heldOnce = 0;
        signal.SetHandler(work =>
        {
            // The first idle is held on its way to the window, as a request thread preempted
            // between taking the state and handing it over would hold it.
            if (!work.Busy && Interlocked.Exchange(ref heldOnce, 1) == 0)
            {
                idleArrived.Set();
                releaseIdle.Wait(TimeSpan.FromSeconds(10));
            }
            lock (delivered) delivered.Add(work);
        });

        var first = signal.Begin("Claude Code", "nendo.change_set.validate");
        var ending = Task.Run(first.Dispose);
        Assert.IsTrue(idleArrived.Wait(TimeSpan.FromSeconds(10)), "The first call's idle was never delivered.");
        // The planner's poll begins a long call while the first call's idle is still on its way.
        var beginning = Task.Run(() => signal.Begin("nendo-planner-mod", "nendo://application/entity/nd.work/records"));
        await Task.WhenAny(beginning, Task.Delay(500));
        releaseIdle.Set();
        await ending;
        var second = await beginning;

        NendoAgentWork last;
        lock (delivered) last = delivered[^1];
        Assert.IsTrue(last.Busy,
            $"The window was last told {(last.Busy ? "busy" : "idle")} while the second call was still running: " +
            string.Join(", ", delivered.Select(work => work.Busy ? "busy" : "idle")));
        Assert.IsTrue(signal.Peek().Busy);
        second.Dispose();
        lock (delivered) Assert.IsFalse(delivered[^1].Busy, "The last call's end said idle.");
    }

    [TestMethod]
    public void AStateOlderThanOneAlreadyDeliveredIsDropped()
    {
        var signal = new NendoAgentWorkSignal();
        var delivered = new List<bool>();
        signal.SetHandler(work => delivered.Add(work.Busy));
        // Two calls' states taken in order, the older one handed over last.
        signal.Announce(new NendoAgentWork(true, "nendo-planner-mod", "nendo.lease.status"), 2);
        signal.Announce(new NendoAgentWork(false, "Claude Code", "nendo.change_set.validate"), 1);
        CollectionAssert.AreEqual(new[] { true }, delivered, "A stale idle reached the window after a newer busy.");
    }
}
