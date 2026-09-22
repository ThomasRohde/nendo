using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class RuntimeLifecycleFixtureTests
{
    [TestMethod]
    [DataRow("idea-garden", "field.idea.status", "idea-1", "idea-2", "Idea")]
    [DataRow("decision-log", "field.decision.state", "decision-001", "decision-002", "Proposed")]
    public async Task OwnedFixtureContainsVisibleBoardRecordsAndPreservedEditHistory(
        string application, string groupField, string firstId, string secondId, string initialGroup)
    {
        await using var workspace = new EngineTestWorkspace();
        var repositoryRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        await RuntimeLifecycleFixture.CreateAsync(workspace.FilePath, application, repositoryRoot);
        using var document = JsonDocument.Parse(await RuntimeLifecycleFixture.InspectAsync(workspace.FilePath));
        Assert.IsTrue(document.RootElement.GetProperty("SemanticValid").GetBoolean());
        var records = document.RootElement.GetProperty("Records").EnumerateArray().ToArray();
        Assert.HasCount(2, records);
        var first = records.Single(record => record.GetProperty("RecordId").GetString() == firstId);
        var second = records.Single(record => record.GetProperty("RecordId").GetString() == secondId);
        Assert.AreEqual(initialGroup, first.GetProperty("Values").GetProperty(groupField).GetString());
        Assert.AreEqual(1L, first.GetProperty("RecordVersion").GetInt64());
        Assert.AreEqual(2L, second.GetProperty("RecordVersion").GetInt64());
        Assert.IsGreaterThanOrEqualTo(4, document.RootElement.GetProperty("History").GetArrayLength());
    }
}
