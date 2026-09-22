using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class RuntimeRecoveryActionsFixtureTests
{
    [TestMethod]
    public async Task RuntimeOutsideEditFixtureInvalidatesExistingWriteAuthority()
    {
        await using var workspace = new EngineTestWorkspace();
        var repositoryRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        await RuntimeLifecycleFixture.CreateAsync(workspace.FilePath, "idea-garden", repositoryRoot);
        await using var owner = await NendoWriteCoordinator.OpenAsync(workspace.FilePath, "runtime-fixture-test");
        var service = new NendoApplicationService(owner);
        await RuntimeRecoveryActionsFixture.SimulateOutsideEditAsync(workspace.FilePath);
        await Assert.ThrowsAsync<NendoRecoveryRequiredException>(() => service.SetFieldAsync(new(
            NendoApplicationService.IdeaEntityId, "idea-1", NendoApplicationService.IdeaTitleFieldId, 1,
            "Must not commit", new("runtime-fixture-test", "denied", "test"))));
        Assert.IsFalse(service.Capabilities.Mutate);
    }

    [TestMethod]
    public async Task NativeRecoveryFixturesHaveKnownClassificationsAndReadableProjections()
    {
        await using var workspace = new EngineTestWorkspace();
        var root = Path.GetDirectoryName(workspace.FilePath)!;
        var repositoryRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        await RuntimeRecoveryActionsFixture.CreateAsync(root, repositoryRoot);
        foreach (var (name, finding) in new[] { ("broken", "invalid-surface"), ("unknown", "unsupported-field-semantics"), ("legacy", "upgrade-required") })
        {
            var path = Path.Combine(root, name + ".nendo");
            var before = await File.ReadAllBytesAsync(path);
            var inspection = await NendoWriteCoordinator.InspectAsync(path);
            Assert.IsFalse(inspection.CanAcquireWriteAuthority);
            Assert.IsTrue(inspection.Findings.Any(item => item.Code == finding), name);
            Assert.IsTrue(inspection.Capabilities.ReadData);
            Assert.IsTrue(inspection.Capabilities.Export);
            Assert.IsTrue(inspection.Capabilities.Backup);
            using var projected = JsonDocument.Parse(await RuntimeRecoveryActionsFixture.InspectAsync(path));
            Assert.IsGreaterThan(0, projected.RootElement.GetProperty("Records").GetArrayLength());
            CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(path));
            Assert.IsFalse(File.Exists(path + ".write-owner"));
        }
    }
}
