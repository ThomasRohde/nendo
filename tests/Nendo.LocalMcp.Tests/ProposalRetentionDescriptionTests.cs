using System.Reflection;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// ECO-13 (W-221): the proposal's retention told an agent it stays until accepted or rejected,
/// while every workspace is discarded when the file closes (ADR-0007). An agent that handed over
/// by title and trusted it lost the proposal to a close or an upgrade without a word.
/// </summary>
[TestClass]
public sealed class ProposalRetentionDescriptionTests
{
    [TestMethod]
    public void TheRetentionSaysAProposalIsDiscardedWhenTheFileCloses()
    {
        var description = typeof(NendoAgentProposalPreview).GetProperty(nameof(NendoAgentProposalPreview.Retention))!
            .GetCustomAttribute<System.ComponentModel.DescriptionAttribute>()!.Description;
        StringAssert.Contains(description, "until the file closes");
        StringAssert.Contains(description, "discards it");
        Assert.IsLessThanOrEqualTo(2_048, description.Length, "An MCP client cuts a description at 2,048 characters.");
    }
}
