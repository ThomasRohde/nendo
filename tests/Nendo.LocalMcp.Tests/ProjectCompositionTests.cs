namespace Nendo.LocalMcp.Tests;

[TestClass]
public sealed class ProjectCompositionTests
{
    [TestMethod]
    public void ProductionAdapterSymbolIsDiscoverable()
    {
        CollectionAssert.AreEqual(
            new[]
            {
                "Disabled",
                "ReadOnly",
                "DataMutation",
                "ApplicationAuthoring",
                "Unattended",
            },
            Enum.GetNames<AgentAccessMode>());
    }
}
