using Nendo.Engine;

namespace Nendo.Session.Tests;

/// <summary>What Apply changes from a web page says once it has prepared them (ADR-0035).</summary>
[TestClass]
public sealed class WebPageChangesNoticeTests
{
    private static readonly NendoProposalPreview Proposal = new("proposal-1", "Changes from Station.nendo", NendoProposalState.Previewable,
        default, "application-1", "instance-1", 3, [], "digest", 4, [], []);

    [TestMethod]
    public void ChangesReadyToReviewNameTheFileAndWhatWasLeftOut()
    {
        var said = WebPageChangesNotice.Describe(new("Station.nendo", Proposal, 3, 1,
            [new("revision-1", DateTimeOffset.UnixEpoch, "Saved CO2 Scrubbing", "Its records changed in Nendo Station.nendo since the export.")]));
        Assert.AreEqual("3 changes from Station.nendo are ready to review. 1 change was applied before. " +
            "1 left out: Saved CO2 Scrubbing (Its records changed in Nendo Station.nendo since the export).", said);
    }

    [TestMethod]
    public void ManyLeftOutAreCountedAfterTheFirstThree()
    {
        var leftOut = Enumerable.Range(1, 5).Select(index => new NendoWebPageLeftOut($"revision-{index}", DateTimeOffset.UnixEpoch, $"Edit {index}", "Refused.")).ToArray();
        var said = WebPageChangesNotice.Describe(new("Deck.nendo", null, 0, 0, leftOut));
        Assert.AreEqual("No change from Deck.nendo can be applied. 5 left out: Edit 1 (Refused); Edit 2 (Refused); Edit 3 (Refused); and 2 more.", said);
    }

    [TestMethod]
    public void AWorkingFileAlreadyAppliedSaysSo() =>
        Assert.AreEqual("Every change in Deck.nendo is already in this file.",
            WebPageChangesNotice.Describe(new("Deck.nendo", null, 0, 4, [])));
}
