using System.Reflection;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The proposal's retention must not tell an agent it stays until accepted or rejected,
/// while every workspace is discarded when the file closes (ADR-0007). An agent that hands over
/// by title and trusts it loses the proposal to a close or an upgrade without a word.
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
