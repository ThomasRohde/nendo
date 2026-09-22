using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// The real-host behaviour journey drives a window against this file, so what the
/// file actually contains is checked here rather than inferred from a screenshot.
/// A journey asserting against a fixture that quietly stopped holding a failing
/// calculation would pass while proving nothing.
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class RuntimeBehaviourFixtureTests
{
    [TestMethod]
    public async Task TheFixtureHoldsCalculatedFieldsAValueAFailureAndAnUnapprovedAction()
    {
        await using var workspace = new EngineTestWorkspace();
        await RuntimeBehaviourFixture.CreateAsync(workspace.FilePath);
        using var document = JsonDocument.Parse(await RuntimeBehaviourFixture.InspectAsync(workspace.FilePath));

        CollectionAssert.AreEqual(
            new[] { "completion", "doneCount", "taskCount" },
            document.RootElement.GetProperty("derivedFields").EnumerateArray()
                .Select(field => field.GetString()).OrderBy(field => field, StringComparer.Ordinal).ToArray());

        var live = document.RootElement.GetProperty("live");
        Assert.AreEqual("2", live.GetProperty("taskCount").GetString());
        Assert.AreEqual("1", live.GetProperty("doneCount").GetString());
        Assert.AreEqual("50.0", live.GetProperty("completion").GetString(),
            "The journey reads this number on screen, so it must be exact here first.");

        Assert.AreEqual(NendoCalculationCodes.DivideByZero, document.RootElement.GetProperty("failing").GetString(),
            "The forced error the journey reads is meant to be a division by zero, not some other failure.");

        // The fixture must not have approved itself: asking the device is the
        // journey's first act, and a file that arrives already trusted cannot show it.
        var coordinator = await NendoWriteCoordinator.OpenAsync(workspace.FilePath, "owned-behaviour-fixture");
        await using (coordinator)
        {
            var service = new NendoApplicationService(coordinator);
            var tasks = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "t2");
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.SetFieldAsync(
                new("tasks", "t2", "done", tasks.RecordVersion, true, new("owned-runtime", "edit", "test"))));
        }
    }
}
