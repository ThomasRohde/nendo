using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// Stage S6 of ADR-0008, device side: where consent is kept, and what happens when
/// it cannot be read.
/// <para>
/// The store answers one question — may this file run its actions — and it must
/// answer "no" in every case where it is not certain of a "yes". A grant file that
/// is missing, truncated, oversized or edited is not a reason to guess.
/// </para>
/// </summary>
[TestClass]
public sealed class DesktopBehaviourGrantTests
{
    [TestMethod]
    public async Task NothingIsApprovedUntilItIsAndNoStateIsWrittenBefore()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);

        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsTrue(store.Persisted);
        Assert.IsNull(store.Notice);
        Assert.IsFalse(Directory.Exists(workspace.FileHistoryRoot), "Asking about approval created device state.");
    }

    [TestMethod]
    public async Task AnApprovalSurvivesANewStoreAndCoversOnlyWhatItNamed()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        store.Approve(Grant());

        var reopened = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        Assert.IsTrue(reopened.IsGranted(Grant()));
        Assert.IsTrue(reopened.Persisted);
        Assert.IsNull(reopened.Notice);

        // Each field of a grant is part of what was agreed to. A copy of the file, an
        // edited definition, a later revision or a wider capability is a different
        // question and has to be asked again.
        foreach (var other in new[]
        {
            Grant() with { ApplicationId = "application-other" },
            Grant() with { InstanceId = "instance-other" },
            Grant() with { BehaviourDigest = new string('1', 64) },
            Grant() with { ContractVersion = "behaviour-99" },
            Grant() with { DefinitionRevision = 8 },
            Grant() with { Capabilities = NendoBehaviourCapabilities.UpdateRecords | NendoBehaviourCapabilities.DeleteRecords },
        })
        {
            Assert.IsFalse(reopened.IsGranted(other), $"An approval covered something it did not name: {other}");
        }
    }

    [TestMethod]
    public async Task RevokingRemovesEveryApprovalForThatFileAndMovesTheGeneration()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        store.Approve(Grant());
        store.Approve(Grant() with { DefinitionRevision = 4, BehaviourDigest = new string('2', 64) });
        var other = Grant() with { InstanceId = "instance-two" };
        store.Approve(other);
        var generation = store.RevocationGeneration;

        store.Revoke("application-one", "instance-one");

        // Revoking is about the file, not one version of its rules, so every approval
        // for that file goes — and another file's approval is untouched.
        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsFalse(store.IsGranted(Grant() with { DefinitionRevision = 4, BehaviourDigest = new string('2', 64) }));
        Assert.IsTrue(store.IsGranted(other));
        Assert.IsGreaterThan(generation, store.RevocationGeneration,
            "A withdrawal that does not move the generation cannot be noticed by work already in flight.");
        Assert.IsFalse(new DesktopBehaviourGrantStore(workspace.FileHistoryRoot).IsGranted(Grant()));
    }

    [TestMethod]
    [DataRow("not json at all")]
    [DataRow("{}")]
    [DataRow("{\"version\":2,\"grants\":[]}")]
    [DataRow("{\"version\":1,\"grants\":[{\"applicationId\":\"\",\"instanceId\":\"i\",\"behaviourDigest\":\"00\",\"contractVersion\":\"behaviour-1\",\"definitionRevision\":1,\"capabilities\":2}]}")]
    [DataRow("{\"version\":1,\"grants\":[{\"applicationId\":\"application-one\",\"instanceId\":\"instance-one\",\"behaviourDigest\":\"zz\",\"contractVersion\":\"behaviour-1\",\"definitionRevision\":1,\"capabilities\":2}]}")]
    [DataRow("{\"version\":1,\"grants\":[{\"applicationId\":\"application-one\",\"instanceId\":\"instance-one\",\"behaviourDigest\":\"" + Digest + "\",\"contractVersion\":\"behaviour-1\",\"definitionRevision\":1,\"capabilities\":99}]}")]
    public async Task UnreadableStateApprovesNothingAndSaysSo(string contents)
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"), contents);

        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);

        // Failing closed is the whole design. "I could not tell" must never read as
        // "yes", or a damaged state file becomes somebody else's actions running.
        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsFalse(store.Persisted);
        Assert.IsNotNull(store.Notice);
        Assert.DoesNotContain(workspace.FileHistoryRoot, store.Notice, StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AnOversizedDocumentIsRefusedWithoutBeingRead()
    {
        await using var workspace = new DesktopTestWorkspace();
        Directory.CreateDirectory(workspace.FileHistoryRoot);
        await File.WriteAllTextAsync(
            Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"),
            "{\"version\":1,\"grants\":[]," + new string(' ', 300_000) + "}");

        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        Assert.IsFalse(store.IsGranted(Grant()));
        Assert.IsFalse(store.Persisted);
    }

    [TestMethod]
    public async Task ApprovingWritesOneFileAndLeavesNoStagedRemains()
    {
        await using var workspace = new DesktopTestWorkspace();
        var store = new DesktopBehaviourGrantStore(workspace.FileHistoryRoot);
        store.Approve(Grant());
        store.Approve(Grant() with { InstanceId = "instance-two" });

        CollectionAssert.AreEqual(
            new[] { "behaviour-grants.json" },
            Directory.GetFiles(workspace.FileHistoryRoot).Select(Path.GetFileName).ToArray(),
            "Staged temporary state was left behind.");

        // Device state, never application data: nothing here says where the file is.
        var serialized = await File.ReadAllTextAsync(Path.Combine(workspace.FileHistoryRoot, "behaviour-grants.json"));
        Assert.DoesNotContain(workspace.FilePath, serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(workspace.FileHistoryRoot, serialized, StringComparison.OrdinalIgnoreCase);
    }

    private const string Digest = "0000000000000000000000000000000000000000000000000000000000000000";

    private static NendoBehaviourGrant Grant() => new(
        "application-one", "instance-one", Digest, "behaviour-1", 3, NendoBehaviourCapabilities.UpdateRecords);
}
