using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class ExtensionViewSessionTests
{
    private static readonly NendoExtensionGrant Grant = new("app", "instance", "view", new('a', 64), new('b', 64));
    private static NendoGraphProjection Graph(long revision = 1) => new(revision,
        [new("n1", "One"), new("n2", "Two")], [new("e1", "n1", "n2")]);
    private sealed class Authority : INendoExtensionAuthority
    {
        public long RevocationGeneration { get; set; }
        public bool Granted { get; set; } = true;
        public bool IsGranted(NendoExtensionGrant grant) => Granted && grant == Grant;
    }
    private sealed class Clock : TimeProvider
    {
        public long Ticks { get; set; }
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => Ticks;
    }
    private static byte[] Message(NendoExtensionViewSession session, string method, string? recordId = null, long? generation = null)
    {
        var values = new Dictionary<string, object> { ["version"] = 1, ["session"] = session.SessionId, ["generation"] = generation ?? session.Generation, ["method"] = method };
        if (recordId is not null) values["recordId"] = recordId;
        return JsonSerializer.SerializeToUtf8Bytes(values);
    }
    private static void Ready(NendoExtensionViewSession session) => Assert.IsTrue(session.Receive(Message(session, "ready")).Accepted);

    [TestMethod]
    public void SelectionRequiresReadyApprovedCurrentProjectionAndHostRevision()
    {
        using var session = new NendoExtensionViewSession(Grant, new Authority(), Graph());
        Assert.AreEqual("not-ready", session.Receive(Message(session, "selectRecord", "n1")).Code);
        Ready(session);
        Assert.AreEqual("record-outside-projection", session.Receive(Message(session, "selectRecord", "another-file-record")).Code);
        Assert.IsTrue(session.Receive(Message(session, "selectRecord", "n1")).Accepted);
        Assert.AreEqual("n1", session.GetSelection(Grant, 1)?.RecordId);
        Assert.IsNull(session.GetSelection(Grant, 2), "Changed data must invalidate pending navigation.");
        Assert.IsNull(session.GetSelection(Grant with { InstanceId = "copy" }, 1));
        Assert.IsTrue(session.IsClosed);
    }

    [TestMethod]
    public void GrantDenialAndRevocationCannotBeReapprovedIntoOldSession()
    {
        var authority = new Authority { Granted = false };
        Assert.ThrowsExactly<InvalidOperationException>(() => new NendoExtensionViewSession(Grant, authority, Graph()));
        authority.Granted = true;
        using var session = new NendoExtensionViewSession(Grant, authority, Graph()); Ready(session);
        authority.RevocationGeneration++;
        Assert.AreEqual("not-approved", session.Receive(Message(session, "selectRecord", "n1")).Code);
        authority.Granted = true;
        Assert.IsNull(session.GetSelection(Grant, 1));
        Assert.ThrowsExactly<InvalidOperationException>(() => session.GetInitialization("light", "en"));
    }

    [TestMethod]
    public void NewProjectionClearsSelectionAndRejectsQueuedGeneration()
    {
        using var session = new NendoExtensionViewSession(Grant, new Authority(), Graph()); Ready(session);
        var queued = Message(session, "selectRecord", "n1");
        Assert.IsTrue(session.Receive(queued).Accepted);
        session.ReplaceProjection(Grant, Graph(2));
        Assert.IsNull(session.GetSelection(Grant, 2));
        Assert.AreEqual("stale-generation", session.Receive(queued).Code);
        Assert.IsTrue(session.Receive(Message(session, "selectRecord", "n2")).Accepted);
        Assert.AreEqual("n2", session.GetSelection(Grant, 2)?.RecordId);
    }

    [TestMethod]
    public void FileCopyPackageOrBindingsChangeCannotReuseSession()
    {
        foreach (var changed in new[] { Grant with { ApplicationId = "other" }, Grant with { InstanceId = "copy" }, Grant with { ViewId = "other" }, Grant with { PackageDigest = new('c', 64) }, Grant with { BindingDigest = new('d', 64) } })
        {
            using var session = new NendoExtensionViewSession(Grant, new Authority(), Graph());
            Assert.ThrowsExactly<InvalidOperationException>(() => session.ReplaceProjection(changed, Graph(2)));
            Assert.IsTrue(session.IsClosed);
        }
    }

    [TestMethod]
    public void CrossSessionAndPrivilegedMethodsAreRejected()
    {
        using var first = new NendoExtensionViewSession(Grant, new Authority(), Graph());
        using var second = new NendoExtensionViewSession(Grant, new Authority(), Graph());
        Assert.AreEqual("invalid-session", second.Receive(Message(first, "ready")).Code);
        foreach (var method in new[] { "data.setField", "proposal.promote", "session.openFile", "openRecord", "fetch", "eval" })
            Assert.AreEqual("unknown-method", first.Receive(Message(first, method)).Code);
    }

    [TestMethod]
    public void DuplicateUnknownDeepOversizedAndInvalidUtf8FramesAreRejected()
    {
        using var session = new NendoExtensionViewSession(Grant, new Authority(), Graph());
        var valid = Encoding.UTF8.GetString(Message(session, "ready"));
        Assert.AreEqual("duplicate-property", session.Receive(Encoding.UTF8.GetBytes(valid[..^1] + ",\"version\":1}")).Code);
        Assert.AreEqual("invalid-properties", session.Receive(Encoding.UTF8.GetBytes(valid[..^1] + ",\"path\":\"secret\"}")).Code);
        Assert.AreEqual("invalid-message", session.Receive([0xff, 0xfe]).Code);
        Assert.AreEqual("invalid-message", session.Receive(Encoding.UTF8.GetBytes("[[[[[[[[[0]]]]]]]]]" )).Code);
        Assert.AreEqual("message-too-large", session.Receive(new byte[65537]).Code);
        Ready(session); // Refusal must not accidentally change the readiness state.
    }

    [TestMethod]
    public void FloodIncludingInvalidMessagesClosesSessionAtSixtyPerRollingSecond()
    {
        var clock = new Clock();
        using var session = new NendoExtensionViewSession(Grant, new Authority(), Graph(), clock);
        for (var i = 0; i < 60; i++) Assert.AreEqual("invalid-message", session.Receive("[]"u8).Code);
        Assert.AreEqual("message-rate-exceeded", session.Receive(Message(session, "ready")).Code);
        clock.Ticks = TimeSpan.FromSeconds(2).Ticks;
        Assert.AreEqual("not-approved", session.Receive(Message(session, "ready")).Code);
    }

    [TestMethod]
    public void RollingWindowExpiresButLateReadyDoesNotReviveSession()
    {
        var clock = new Clock();
        using var session = new NendoExtensionViewSession(Grant, new Authority(), Graph(), clock);
        for (var i = 0; i < 60; i++) session.Receive("[]"u8);
        clock.Ticks = TimeSpan.FromSeconds(1).Ticks;
        Ready(session);
        using var late = new NendoExtensionViewSession(Grant, new Authority(), Graph(), clock);
        clock.Ticks += TimeSpan.FromSeconds(5).Ticks;
        Assert.AreEqual("ready-timeout", late.Receive(Message(late, "ready")).Code);
    }

    [TestMethod]
    public void ProjectionRejectsOversizeDuplicatesAndMissingEndpointsButAcceptsCycles()
    {
        foreach (var graph in new[] {
            new NendoGraphProjection(1, Enumerable.Range(0, 501).Select(i => new NendoGraphNode("n" + i, "node")).ToArray(), []),
            new(1, [new("n1", "one"), new("n1", "duplicate")], []),
            new(1, [new("n1", "one")], [new("e", "n1", "missing")]),
            new(1, [new("n1", "one")], [new("e", "n1", "n1"), new("e", "n1", "n1")]),
            new(1, [new("n1", "one")], Enumerable.Range(0, 1001).Select(i => new NendoGraphEdge("e" + i, "n1", "n1")).ToArray()),
            new(1, Enumerable.Range(0, 500).Select(i => new NendoGraphNode("n" + i, new string('x', 4096))).ToArray(), []),
        }) Assert.ThrowsExactly<ArgumentException>(() => new NendoExtensionViewSession(Grant, new Authority(), graph));
        using var cycle = new NendoExtensionViewSession(Grant, new Authority(), new(1,
            [new("n1", "one"), new("n2", "two")], [new("e1", "n1", "n2"), new("e2", "n2", "n1"), new("e3", "n1", "n1")]));
        Ready(cycle);
    }

    [TestMethod]
    public void NodeAndEdgeRecordIdsBelongToSeparateEntityNamespaces()
    {
        using var session = new NendoExtensionViewSession(Grant, new Authority(), new(1,
            [new("same-id", "One")], [new("same-id", "same-id", "same-id")]));
        Ready(session);
        Assert.IsTrue(session.Receive(Message(session, "selectRecord", "same-id")).Accepted);
        Assert.AreEqual("same-id", session.GetSelection(Grant, 1)?.RecordId);
    }

    [TestMethod]
    public void ProjectionCopiesInputsAndNeverDisclosesGrantIdentityOrMutableBuffers()
    {
        var nodes = new List<NendoGraphNode> { new("n1", "one") };
        using var session = new NendoExtensionViewSession(Grant, new Authority(), new(1, nodes, []));
        nodes.Add(new("n2", "injected"));
        Ready(session);
        Assert.AreEqual("record-outside-projection", session.Receive(Message(session, "selectRecord", "n2")).Code);
        var bytes = session.GetInitialization("dark", "en");
        var text = Encoding.UTF8.GetString(bytes);
        Assert.IsFalse(text.Contains(Grant.PackageDigest, StringComparison.Ordinal));
        Assert.IsFalse(text.Contains("applicationId", StringComparison.Ordinal));
        Array.Fill(bytes, (byte)0);
        Assert.IsTrue(JsonDocument.Parse(session.GetInitialization("light", "da")).RootElement.TryGetProperty("projection", out _));
    }

    [TestMethod]
    public void InvalidReplacementDoesNotPartiallyChangeTheOldProjection()
    {
        using var session = new NendoExtensionViewSession(Grant, new Authority(), Graph()); Ready(session);
        session.Receive(Message(session, "selectRecord", "n1"));
        Assert.ThrowsExactly<ArgumentException>(() => session.ReplaceProjection(Grant, new(2, [], [new("e", "x", "y")])));
        Assert.AreEqual(1L, session.Generation);
        Assert.AreEqual("n1", session.GetSelection(Grant, 1)?.RecordId);
    }
}
