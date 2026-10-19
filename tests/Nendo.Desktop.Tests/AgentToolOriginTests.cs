namespace Nendo.Desktop.Tests;

/// <summary>
/// A launched agent's tool step and permission card say "Nendo" for a tool that goes
/// through this file's MCP server. Every Nendo file's server offers the same tools, so the name
/// of a server the person registered for another file matched too, and a delete in the Planner
/// was labelled as this file's own boundary.
/// </summary>
[TestClass]
public sealed class AgentToolOriginTests
{
    [TestMethod]
    [DataRow("mcp__nendo__nendo_data_set_field")]
    [DataRow("mcp__nendo__nendo.lease.acquire")]
    [DataRow("nendo-nendo-read-resource")]
    [DataRow("nendo.read.resource")]
    [DataRow("nendo_change_set_validate")]
    [DataRow("mcp_nendo_nendo_data_set_field")]
    public void ThisSessionsServerIsNendo(string toolName) =>
        Assert.AreEqual("nendo", AgentConversation.Origin(null, "other", toolName), toolName);

    [TestMethod]
    [DataRow("mcp__nendo-planner__nendo_data_delete_record")]
    [DataRow("mcp__nendo-bcm__nendo_change_set_accept")]
    [DataRow("nendo-planner-nendo-lease-acquire")]
    [DataRow("mcp__other__nendo_read_resource")]
    public void AnotherServerOfferingTheSameToolsIsTheAgentsOwn(string toolName)
    {
        Assert.AreEqual("agent", AgentConversation.Origin(null, "other", toolName), $"{toolName}, by its metadata name");
        Assert.AreEqual("agent", AgentConversation.Origin(toolName, "other", null), $"{toolName}, by its title");
    }

    /// <summary>
    /// What agents send: another server's tool by its metadata name, titled with the bare tool name
    /// or with its input. The metadata name decides.
    /// </summary>
    [TestMethod]
    [DataRow("mcp__nendo-planner__nendo_data_delete_record", "nendo.data.delete_record")]
    [DataRow("mcp__nendo-planner__nendo_data_delete_record", "nendo.data.delete_record (nendo-planner MCP Server)")]
    [DataRow("Grep", "Grep nendo.data.set_field")]
    [DataRow("Read", "Read nendo://application/manifest")]
    public void TheToolsOwnNameDecidesOverItsTitle(string toolName, string title) =>
        Assert.AreEqual("agent", AgentConversation.Origin(title, "read", toolName), $"{toolName} titled {title}");
}
