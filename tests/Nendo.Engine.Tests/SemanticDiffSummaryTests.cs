using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class SemanticDiffSummaryTests
{
    /// <summary>
    /// The board line embeds the record type's name as the person chose it, and read
    /// "one column per Initiatives" when the type was named in the plural (W-044). "Per
    /// {name} record" reads the same either way; the singular is asserted with the CRM's
    /// Account, this is the plural.
    /// </summary>
    [TestMethod]
    public void AReferenceBoardLineReadsCorrectlyForAPluralRecordTypeName()
    {
        var changeSet = ChangeSet(
            new CreateEntityOperation("op-entity", "entity.initiative", "Initiatives", "initiatives"),
            new AddFieldOperation("op-name", "entity.initiative", "field.initiative.name", "Name", "name", NendoStorageKind.Text, true, "singleLine", []),
            new AddFieldOperation("op-ref", "entity.task", "field.task.initiative", "Initiative", "initiative", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("op-config", "entity.task", "field.task.initiative", "entity.initiative", "field.initiative.name", 4),
            new AddUiNodeOperation("op-board", "surface.task.board", "node.board", null, "boardSurface", 0),
            new SetUiPropertyOperation("op-group", "surface.task.board", "node.board", "groupByFieldId", "field.task.initiative"));

        var line = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary)
            .Single(summary => summary.StartsWith("Give the board", StringComparison.Ordinal));

        Assert.AreEqual(
            $"Give the board one column per Initiatives record, from Initiative, and draw nothing above {NendoSemanticVocabulary.MaximumReferenceBoardColumns} of them.",
            line);
    }

    // A proposal summary is built before validation can turn a bad value into a diagnostic, so it must
    // render every JSON kind an agent can legally send. Assuming a string here surfaced as an unhandled
    // fault translated to NENDO_INTERNAL_ERROR rather than a reviewable diagnostic.
    [TestMethod]
    [DataRow("Doing", DisplayName = "string")]
    [DataRow(true, DisplayName = "boolean")]
    [DataRow(42, DisplayName = "integer")]
    [DataRow(1.5, DisplayName = "decimal")]
    public void CommandValueOfEveryScalarKindProducesAReadableSummary(object value)
    {
        var summary = SummarizeProperty("value", value);

        StringAssert.StartsWith(summary, "Set the command value to");
        Assert.IsFalse(summary.Contains("blank", StringComparison.Ordinal), summary);
    }

    [TestMethod]
    public void NonStringSurfacePropertiesDoNotFaultTheSummary()
    {
        foreach (var property in new[] { "groupByFieldId", "title", "label", "fieldId", "entityId" })
        {
            var summary = SummarizeProperty(property, 7);
            Assert.IsFalse(string.IsNullOrWhiteSpace(summary), property);
        }
    }

    // The summary is the human accept gate. Deriving a plausible display name from
    // an identifier lets a proposal describe fields that do not exist, which is
    // exactly what teaches a reviewer to skim the diff.
    [TestMethod]
    public void FieldsThatDoNotExistAreNamedAsUnknownRatherThanInvented()
    {
        var summary = SummarizeProperty("fieldId", "field.task.energy");

        StringAssert.Contains(summary, "unknown field \"field.task.energy\"");
        Assert.IsFalse(summary.Contains("Energy", StringComparison.Ordinal),
            "An unresolved identifier must not be rendered as a display name.");
    }

    [TestMethod]
    public void UnknownRecordTypeAndBindingAreAlsoFlagged()
    {
        StringAssert.Contains(SummarizeProperty("entityId", "entity.absent"), "unknown record type \"entity.absent\"");
        StringAssert.Contains(SummarizeProperty("fieldId", "field.task.absent"), "unknown field \"field.task.absent\"");
        StringAssert.Contains(SummarizeProperty("groupByFieldId", "field.task.absent"), "unknown field \"field.task.absent\"");
    }

    [TestMethod]
    public void FieldCreatedInTheSameChangeSetResolvesToItsNewName()
    {
        var changeSet = ChangeSet(
            new AddFieldOperation("op-add", "entity.task", "field.task.owner", "Owner", "owner", NendoStorageKind.Text, false),
            new SetUiPropertyOperation("op-bind", "surface.task.board", "node.task.board.binding", "fieldId", "field.task.owner"));

        var entries = SemanticDiff.From(changeSet, Active());

        StringAssert.Contains(entries[1].Summary, "Owner");
    }

    [TestMethod]
    public void NewVocabularyKindsProduceReadableEntries()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-section", "surface.task.form", "node.task.section", "node.task.form.root", "section", 0),
            new SetUiPropertyOperation("op-title", "surface.task.form", "node.task.section", "title", "Details"),
            new MoveUiNodeOperation("op-move", "surface.task.form", "node.task.section", "node.task.form.root", 2));

        var entries = SemanticDiff.From(changeSet, Active());

        Assert.AreEqual("Add the section \"Details\".", entries[0].Summary,
            "A section is not a surface, and the accept gate should say which it is.");
        StringAssert.Contains(entries[1].Summary, "the section \"Details\"");
        StringAssert.Contains(entries[1].Summary, "position 2");
    }

    // The accept gate must describe every contract version 3 kind, or a reviewer
    // sees identifiers prettified into names that were never chosen.
    [TestMethod]
    public void EveryContractVersionThreeKindHasItsOwnEntry()
    {
        var kinds = new[] { "detailSurface", "section", "tabGroup", "relatedList", "fieldBinding", "recordCommand", "commandStep", "filterClause", "summaryTile", "calendarSurface", "timelineSurface", "gallerySurface" };
        var operations = kinds.Select((kind, index) =>
            (NendoOperation)new AddUiNodeOperation($"op-{index}", "surface.task", $"node.task.{kind}", index == 0 ? null : "node.task.detailSurface", kind, index)).ToArray();

        var entries = SemanticDiff.From(ChangeSet(operations), Active());

        for (var index = 0; index < kinds.Length; index++)
        {
            var summary = entries[index].Summary;
            Assert.AreNotEqual($"Add a {kinds[index]} node.", summary,
                $"{kinds[index]} has no summary of its own and fell through.");
            Assert.IsFalse(summary.Contains("node.task.", StringComparison.Ordinal),
                $"{kinds[index]} is described by its identifier: {summary}");
            // "section" is both the contract name and the ordinary English word, so
            // the check is that a kind has its own sentence, not that it avoids a word.
        }
    }

    [TestMethod]
    public void PropertyMeaningFollowsTheNodeThatCarriesIt()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-relation", "surface.task", "node.relation", null, "relatedList", 0),
            new SetUiPropertyOperation("op-relation-title", "surface.task", "node.relation", "title", "Notes"),
            new SetUiPropertyOperation("op-relation-target", "surface.task", "node.relation", "targetEntityId", "entity.task"),
            new AddUiNodeOperation("op-filter", "surface.task", "node.filter", "node.relation", "filterClause", 1),
            new SetUiPropertyOperation("op-filter-field", "surface.task", "node.filter", "fieldId", "field.task.title"),
            new SetUiPropertyOperation("op-filter-op", "surface.task", "node.filter", "operator", "ne"),
            new SetUiPropertyOperation("op-filter-value", "surface.task", "node.filter", "value", "Done"),
            new AddUiNodeOperation("op-step", "surface.task", "node.step", null, "commandStep", 2),
            new SetUiPropertyOperation("op-step-field", "surface.task", "node.step", "fieldId", "field.task.title"),
            new SetUiPropertyOperation("op-step-kind", "surface.task", "node.step", "valueKind", "today"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Add the related records \"Notes\".", entries[0], "A relation is not a surface.");
        Assert.AreEqual("Show records of Task.", entries[1]);
        // A clause added and filled in one change set is one line, not four (W-044).
        Assert.AreEqual("Show only records where Title is not Done.", entries[2], "A filter is one statement, not a node and three properties.");
        Assert.AreEqual("Add a field this command sets.", entries[3]);
        Assert.AreEqual("Set Title when the command runs.", entries[4]);
        Assert.AreEqual("Use the date the command runs.", entries[5]);
        Assert.HasCount(6, entries);
    }

    /// <summary>
    /// How a section starts rides on the line that adds it, and stands alone when it is
    /// changed on a section the file already has (ADR-0004, 2026-09-20 amendment).
    /// </summary>
    [TestMethod]
    public void HowASectionStartsIsSaidOnTheLineThatAddsItAndAloneWhenChanged()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-page", "surface.task", "node.page", null, "detailSurface", 0),
            new AddUiNodeOperation("op-lately", "surface.task", "node.lately", "node.page", "section", 0),
            new SetUiPropertyOperation("op-lately-title", "surface.task", "node.lately", "title", "Lately"),
            new SetUiPropertyOperation("op-lately-opens", "surface.task", "node.lately", "opens", "closed"),
            new SetUiPropertyOperation("op-existing-closed", "surface.task", "node.existing", "opens", "closed"),
            new SetUiPropertyOperation("op-existing-open", "surface.task", "node.existing", "opens", "open"));
        var active = Active() with
        {
            UiNodes =
            [
                new NendoUiNodeSnapshot("surface.task", "node.existing", "node.page", "section", 3,
                    new Dictionary<string, JsonElement>(StringComparer.Ordinal) { ["title"] = JsonSerializer.SerializeToElement("Evidence") }),
            ],
        };

        var entries = SemanticDiff.From(changeSet, active).Select(entry => entry.Summary).ToArray();

        CollectionAssert.AreEqual(new[]
        {
            "Add a record page.",
            "Add the section \"Lately\", starting closed.",
            "Start the section closed.",
            "Start the section open.",
        }, entries, string.Join("\n", entries));
    }

    /// <summary>
    /// A filter clause used to cost four lines, the first of which said nothing:
    /// "Add a condition that narrows what this surface shows." then the field, the
    /// comparison and the value each on a line of its own, so a proposal with two
    /// filters spent eight lines on them. It is one statement now, in the words a
    /// reviewer would use, for every comparison the vocabulary has; on a progress
    /// ring it says what is counted rather than what is shown; and a property changed
    /// on a clause the person already has still stands on its own line, because that
    /// is a change to something they have.
    /// </summary>
    [TestMethod]
    public void AFilterClauseAddedInOneChangeSetReadsAsOneStatement()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-list", "surface.task", "node.list", null, "recordList", 0),
            new AddUiNodeOperation("op-eq", "surface.task", "node.eq", "node.list", "filterClause", 0),
            new SetUiPropertyOperation("op-eq-field", "surface.task", "node.eq", "fieldId", "field.task.project"),
            new SetUiPropertyOperation("op-eq-op", "surface.task", "node.eq", "operator", "eq"),
            new SetUiPropertyOperation("op-eq-value", "surface.task", "node.eq", "value", "Alpha"),
            new AddUiNodeOperation("op-gte", "surface.task", "node.gte", "node.list", "filterClause", 1),
            new SetUiPropertyOperation("op-gte-field", "surface.task", "node.gte", "fieldId", "field.task.estimateHours"),
            new SetUiPropertyOperation("op-gte-op", "surface.task", "node.gte", "operator", "gte"),
            new SetUiPropertyOperation("op-gte-value", "surface.task", "node.gte", "value", 8),
            new AddUiNodeOperation("op-null", "surface.task", "node.null", "node.list", "filterClause", 2),
            new SetUiPropertyOperation("op-null-field", "surface.task", "node.null", "fieldId", "field.task.due"),
            new SetUiPropertyOperation("op-null-op", "surface.task", "node.null", "operator", "isNull"),
            new AddUiNodeOperation("op-ring", "surface.task", "node.ring", "node.list", "progressTile", 3),
            new SetUiPropertyOperation("op-ring-title", "surface.task", "node.ring", "title", "Alpha share"),
            new AddUiNodeOperation("op-counted", "surface.task", "node.counted", "node.ring", "filterClause", 0),
            new SetUiPropertyOperation("op-counted-field", "surface.task", "node.counted", "fieldId", "field.task.project"),
            new SetUiPropertyOperation("op-counted-op", "surface.task", "node.counted", "operator", "ne"),
            new SetUiPropertyOperation("op-counted-value", "surface.task", "node.counted", "value", "Alpha"),
            // A clause the file already has, being re-pointed: its own line, as before.
            new SetUiPropertyOperation("op-existing-value", "surface.task", "node.existing", "value", "Done"));
        var active = Active() with
        {
            UiNodes =
            [
                new NendoUiNodeSnapshot("surface.task", "node.existing", "node.list", "filterClause", 9,
                    new Dictionary<string, JsonElement>(StringComparer.Ordinal)),
            ],
        };

        var entries = SemanticDiff.From(changeSet, active).Select(entry => entry.Summary).ToArray();

        CollectionAssert.AreEqual(new[]
        {
            "Add record list.",
            "Show only records where Project is Alpha.",
            "Show only records where Estimate hours is at least 8.",
            "Show only records where Due is empty.",
            "Add the progress ring \"Alpha share\".",
            "Count only records where Project is not Alpha.",
            "Compare against Done.",
        }, entries, string.Join("\n", entries));
    }

    /// <summary>
    /// Several roots of a kind are ordinary now, so a summary naming only the
    /// noun stops identifying one. A named node is described by its name, and a
    /// name shared with another node is counted off against its namesakes. This
    /// test asserted the stable ID until W-041: telling two lines apart is still
    /// the requirement, and an identifier is no longer how it is met.
    /// </summary>
    [TestMethod]
    public void TwoSurfacesSharingATitleAreStillDistinguishableInTheDiff()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-one", "surface.task", "node.open", null, "recordList", 0),
            new SetUiPropertyOperation("op-one-title", "surface.task", "node.open", "title", "Deals"),
            new AddUiNodeOperation("op-two", "surface.task", "node.closed", null, "recordList", 1),
            new SetUiPropertyOperation("op-two-title", "surface.task", "node.closed", "title", "Deals"),
            new RemoveUiNodeOperation("op-remove", "surface.task", "node.closed"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreNotEqual(entries[0], entries[1], "Two identical review lines describe two different changes.");
        StringAssert.Contains(entries[0], "the first of two");
        StringAssert.Contains(entries[1], "the second of two");
        StringAssert.Contains(entries[2], "the second of two");
        foreach (var entry in entries)
        {
            Assert.IsFalse(entry.Contains("node.", StringComparison.Ordinal),
                $"A node identifier reached a reviewer-facing sentence: {entry}");
        }
    }

    /// <summary>
    /// A named surface is named in the diff. Before several roots of a kind were
    /// admitted, "the record list" identified one thing; now it identifies a kind.
    /// </summary>
    [TestMethod]
    public void ARemovalNamesTheSurfaceRatherThanItsKindAlone()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-add", "surface.task", "node.open", null, "recordList", 0),
            new SetUiPropertyOperation("op-title", "surface.task", "node.open", "title", "Open deals"),
            new RemoveUiNodeOperation("op-remove", "surface.task", "node.open"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        StringAssert.Contains(entries[1], "Open deals");
        StringAssert.Contains(entries[1], "the record list");
    }

    /// <summary>
    /// Moving a section into a tab group is what makes it a tab, and taking it
    /// out is what stops it being one. A position change describes neither.
    /// </summary>
    [TestMethod]
    public void TabMembershipIsStatedRatherThanSummarisedAsAPositionChange()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-group", "surface.task", "node.tabs", "node.page", "tabGroup", 0),
            new SetUiPropertyOperation("op-group-title", "surface.task", "node.tabs", "title", "Details"),
            new AddUiNodeOperation("op-section", "surface.task", "node.identity", "node.page", "section", 1),
            new SetUiPropertyOperation("op-section-title", "surface.task", "node.identity", "title", "Identity"),
            new MoveUiNodeOperation("op-in", "surface.task", "node.identity", "node.tabs", 1),
            new MoveUiNodeOperation("op-out", "surface.task", "node.identity", null, 3));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Add the tab group \"Details\".", entries[0]);
        Assert.AreEqual("Add the section \"Identity\".", entries[1]);
        StringAssert.Contains(entries[2], "tab 2");
        StringAssert.Contains(entries[2], "Details");
        StringAssert.Contains(entries[3], "no longer a tab");
    }

    /// <summary>
    /// Scope decides whether a number is one column or a whole surface, and a
    /// date binding decides where a record appears. Both need their own words.
    /// </summary>
    [TestMethod]
    public void ScopeAndCalendarDateBindingHaveTheirOwnEntries()
    {
        // The scope lines stand alone on a tile the file already has (W-052 folds them
        // into the line that adds a new tile, tested below).
        var changeSet = ChangeSet(
            new SetUiPropertyOperation("op-scope-group", "surface.task", "node.existing-tile", "scope", "group"),
            new SetUiPropertyOperation("op-scope-surface", "surface.task", "node.existing-tile", "scope", "surface"),
            new AddUiNodeOperation("op-calendar", "surface.task", "node.calendar", null, "calendarSurface", 1),
            new SetUiPropertyOperation("op-date", "surface.task", "node.calendar", "dateFieldId", "field.task.due"));
        var active = Active() with
        {
            UiNodes =
            [
                new NendoUiNodeSnapshot("surface.task", "node.existing-tile", "node.board", "summaryTile", 0,
                    new Dictionary<string, JsonElement>(StringComparer.Ordinal)),
            ],
        };

        var entries = SemanticDiff.From(changeSet, active).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Count one board column rather than the whole surface.", entries[0]);
        Assert.AreEqual("Count every record this surface shows, on every page.", entries[1]);
        StringAssert.Contains(entries[2], "calendar");
        Assert.AreEqual("Place each record on the calendar by Due.", entries[3]);
    }

    /// <summary>
    /// An ordering was two lines of which the second meant nothing alone, and a summary
    /// tile was three for one number (W-052). Each is one line when it arrives with its
    /// node, in the field's own terms; a property changed on a node the file already
    /// has keeps its own line, because that is a change to something the person has.
    /// </summary>
    [TestMethod]
    public void AnOrderingAndASummaryTileEachReadAsOneLine()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-board", "surface.task", "node.board", null, "boardSurface", 0),
            new SetUiPropertyOperation("op-board-title", "surface.task", "node.board", "title", "Delivered by initiative"),
            new SetUiPropertyOperation("op-board-order", "surface.task", "node.board", "orderByFieldId", "field.task.due"),
            new SetUiPropertyOperation("op-board-direction", "surface.task", "node.board", "orderDirection", "descending"),
            new AddUiNodeOperation("op-tile", "surface.task", "node.tile", "node.board", "summaryTile", 0),
            new SetUiPropertyOperation("op-tile-title", "surface.task", "node.tile", "title", "Delivered"),
            new SetUiPropertyOperation("op-tile-aggregate", "surface.task", "node.tile", "aggregate", "count"),
            new SetUiPropertyOperation("op-tile-scope", "surface.task", "node.tile", "scope", "group"),
            new AddUiNodeOperation("op-list", "surface.task", "node.list", null, "recordList", 1),
            new SetUiPropertyOperation("op-list-title", "surface.task", "node.list", "title", "Open"),
            new SetUiPropertyOperation("op-list-order", "surface.task", "node.list", "orderByFieldId", "field.task.title"),
            new SetUiPropertyOperation("op-list-direction", "surface.task", "node.list", "orderDirection", "ascending"),
            new AddUiNodeOperation("op-sum", "surface.task", "node.sum", "node.list", "summaryTile", 0),
            new SetUiPropertyOperation("op-sum-title", "surface.task", "node.sum", "title", "Pipeline"),
            new SetUiPropertyOperation("op-sum-aggregate", "surface.task", "node.sum", "aggregate", "sum"),
            new SetUiPropertyOperation("op-sum-field", "surface.task", "node.sum", "fieldId", "field.task.estimateHours"),
            new AddUiNodeOperation("op-rank", "surface.task", "node.rank", null, "rankedList", 2),
            new SetUiPropertyOperation("op-rank-title", "surface.task", "node.rank", "title", "Biggest"),
            new SetUiPropertyOperation("op-rank-by", "surface.task", "node.rank", "rankByFieldId", "field.task.estimateHours"),
            new SetUiPropertyOperation("op-rank-direction", "surface.task", "node.rank", "orderDirection", "descending"),
            new SetUiPropertyOperation("op-rank-limit", "surface.task", "node.rank", "limit", 10),
            // On nodes the file already has, each property keeps its own line.
            new SetUiPropertyOperation("op-existing-direction", "surface.task", "node.existing-board", "orderDirection", "ascending"),
            new SetUiPropertyOperation("op-existing-aggregate", "surface.task", "node.existing-tile", "aggregate", "sum"));
        var active = Active() with
        {
            UiNodes =
            [
                new NendoUiNodeSnapshot("surface.task", "node.existing-board", null, "boardSurface", 5,
                    new Dictionary<string, JsonElement>(StringComparer.Ordinal)),
                new NendoUiNodeSnapshot("surface.task", "node.existing-tile", "node.existing-board", "summaryTile", 0,
                    new Dictionary<string, JsonElement>(StringComparer.Ordinal)),
            ],
        };

        var entries = SemanticDiff.From(changeSet, active).Select(entry => entry.Summary).ToArray();

        CollectionAssert.AreEqual(new[]
        {
            "Add the grouped board \"Delivered by initiative\".",
            "Order by Due, newest first.",
            "Count the records in each column as \"Delivered\".",
            "Add the record list \"Open\".",
            "Order by Title, A to Z.",
            "Total Estimate hours over every record shown as \"Pipeline\".",
            "Add the ranking \"Biggest\".",
            "Rank the records by Estimate hours, largest first.",
            "Rank at most 10 of them.",
            "Order ascending.",
            "Total the field exactly.",
        }, entries, string.Join("\n", entries));
    }

    /// <summary>
    /// A timeline's four field roles each decide something a reviewer can picture:
    /// where an entry sits, where its span ends, what titles it and what tones it.
    /// The title and accent words differ from the record page's, because an entry
    /// is not a page.
    /// </summary>
    [TestMethod]
    public void TimelineFieldRolesHaveTheirOwnEntries()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-timeline", "surface.task", "node.timeline", null, "timelineSurface", 0),
            new SetUiPropertyOperation("op-date", "surface.task", "node.timeline", "dateFieldId", "field.task.due"),
            new SetUiPropertyOperation("op-end", "surface.task", "node.timeline", "endDateFieldId", "field.task.due"),
            new SetUiPropertyOperation("op-title", "surface.task", "node.timeline", "titleFieldId", "field.task.title"),
            new SetUiPropertyOperation("op-accent", "surface.task", "node.timeline", "accentFieldId", "field.task.project"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        StringAssert.Contains(entries[0], "timeline");
        Assert.AreEqual("Place each record on the timeline by Due.", entries[1]);
        Assert.AreEqual("End each span at Due.", entries[2]);
        Assert.AreEqual("Title each entry with Title.", entries[3]);
        Assert.AreEqual("Colour each entry by Project.", entries[4]);
    }

    /// <summary>
    /// A gallery's two field roles are the record page's, said as a person sees them: a
    /// card is titled and toned, not headed and coloured.
    /// </summary>
    [TestMethod]
    public void GalleryFieldRolesHaveTheirOwnEntries()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-gallery", "surface.task", "node.gallery", null, "gallerySurface", 0),
            new SetUiPropertyOperation("op-title", "surface.task", "node.gallery", "titleFieldId", "field.task.title"),
            new SetUiPropertyOperation("op-accent", "surface.task", "node.gallery", "accentFieldId", "field.task.project"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        StringAssert.Contains(entries[0], "gallery");
        Assert.AreEqual("Title each card with Title.", entries[1]);
        Assert.AreEqual("Colour each card by Project.", entries[2]);
    }

    /// <summary>
    /// A proposal that defines a calculation and then shows it on a screen described
    /// the binding as "unknown field" — seven times, on the one screen whose job is
    /// to earn the person's trust — because name resolution read stored fields only.
    /// </summary>
    [TestMethod]
    public void ACalculatedFieldDefinedInTheSameChangeSetIsNamedAsACalculation()
    {
        var changeSet = ChangeSet(
            new SetBehaviourDefinitionOperation("op-calc", new NendoCalculationDefinition(
                "entity.task.remaining", "entity.task", "remaining", "Remaining hours", NendoBehaviourScalar.Decimal, false,
                "estimate", [NendoBehaviourBinding.SameRecordField("estimate", "entity.task", "field.task.estimateHours", NendoBehaviourScalar.Decimal, true)], []), 4),
            new SetUiPropertyOperation("op-bind", "surface.task.page", "node.task.page.binding", "fieldId", "remaining"),
            new SetUiPropertyOperation("op-visible", "surface.task.page", "node.task.page.section", "visibleWhen", "remaining"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Show the calculated field Remaining hours.", entries[1]);
        Assert.IsFalse(entries[1].Contains("unknown", StringComparison.Ordinal), entries[1]);
        Assert.AreEqual("Show this only when Remaining hours is yes.", entries[2]);
    }

    [TestMethod]
    public void ACalculatedFieldTheFileAlreadyHasResolvesByItsName()
    {
        var active = Active();
        var task = active.Entities.Single();
        var withCalculation = active with
        {
            Entities = [task with { DerivedFields = [new NendoDerivedFieldSnapshot("overdue", "Overdue", "entity.task.overdue", NendoBehaviourScalar.Boolean, false, "due < today")] }],
        };
        var changeSet = ChangeSet(
            new SetUiPropertyOperation("op-bind", "surface.task.page", "node.task.page.binding", "fieldId", "overdue"),
            new SetUiPropertyOperation("op-filter", "surface.task.list", "node.task.list.filter", "fieldId", "field.task.absent"));

        var entries = SemanticDiff.From(changeSet, withCalculation).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Show the calculated field Overdue.", entries[0]);
        StringAssert.Contains(entries[1], "unknown field \"field.task.absent\"", "A field that exists nowhere is still unknown.");
    }

    private static string SummarizeProperty(string propertyName, object? value)
    {
        var entries = SemanticDiff.From(
            ChangeSet(new SetUiPropertyOperation("operation-diff", "surface.task.board", "node.task.board.root", propertyName, value)),
            Active());

        Assert.HasCount(1, entries);
        return entries[0].Summary;
    }

    // F-058: every stored field read as its display name and nothing else — "Add Pages
    // field.", "Add Author field." — so a reviewer could not tell an Integer from a
    // reference to another record type and could not see which fields were required.
    // Every fact asserted here is on the addField operation being described.
    [TestMethod]
    public void AFieldSaysWhatKindOfValueItHoldsAndWhetherItIsRequired()
    {
        var entries = SemanticDiff.From(ChangeSet(
            new AddFieldOperation("op-pages", "entity.task", "field.task.pages", "Pages", "pages", NendoStorageKind.Integer, false),
            new AddFieldOperation("op-name", "entity.task", "field.task.name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("op-done", "entity.task", "field.task.done", "Done", "done", NendoStorageKind.Boolean, false),
            new AddFieldOperation("op-started", "entity.task", "field.task.started", "Started", "started", NendoStorageKind.Date, false, "date"),
            new AddFieldOperation("op-notes", "entity.task", "field.task.notes", "Notes", "notes", NendoStorageKind.Text, false, "longText"),
            new AddFieldOperation("op-rating", "entity.task", "field.task.rating", "Rating", "rating", NendoStorageKind.Integer, false, "rating", null, 1, 5)),
            Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Add Pages, a whole number.", entries[0]);
        Assert.AreEqual("Add Name, a line of text, required.", entries[1]);
        Assert.AreEqual("Add Done, a yes or no.", entries[2]);
        Assert.AreEqual("Add Started, a date.", entries[3]);
        Assert.AreEqual("Add Notes, a paragraph of text.", entries[4]);
        Assert.AreEqual("Add Rating, a rating from 1 to 5.", entries[5]);
    }

    // The options used to be visible only as setChoiceMetadata lines, and those exist
    // only where the options are given tones — so a choice field with no tones went
    // through review with nothing said about its options at all. This is that field:
    // one operation, no metadata, four options that a reviewer can still read.
    [TestMethod]
    public void AChoiceFieldNamesItsOptionsWithoutAnyChoiceMetadata()
    {
        var changeSet = ChangeSet(new AddFieldOperation(
            "op-status", "entity.task", "field.task.status", "Status", "status", NendoStorageKind.Text, false,
            "singleChoice", ["Wishlist", "Reading", "Finished", "Abandoned"]));

        var entries = SemanticDiff.From(changeSet, Active());

        Assert.HasCount(1, entries, "No setChoiceMetadata operation exists here to carry the options.");
        Assert.AreEqual("Add Status, a choice of Wishlist, Reading, Finished or Abandoned.", entries[0].Summary);
    }

    [TestMethod]
    public void AChoiceOptionIsNamedByTheWordTheChangeSetGivesIt()
    {
        var changeSet = ChangeSet(
            new AddFieldOperation("op-status", "entity.task", "field.task.status", "Status", "status", NendoStorageKind.Text, false,
                "singleChoice", ["wishlist", "reading"]),
            new SetChoiceMetadataOperation("op-meta", "entity.task", "field.task.status", "wishlist", "Want to read", false, 4));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Add Status, a choice of Want to read or reading.", entries[0],
            "The chosen word is preferred over the stored one; the option nobody renamed keeps its own.");
    }

    // The refusal path already writes this well: deleting a referenced record names the
    // count, the record type, the field, which records and the remedy. The review that
    // creates the same reference said "Choose the reference target type and label."
    [TestMethod]
    public void AReferenceSaysWhatPointsAtWhatAndByWhichLabel()
    {
        var changeSet = ChangeSet(
            new CreateEntityOperation("op-entity", "entity.author", "Author", "author"),
            new AddFieldOperation("op-name", "entity.author", "field.author.name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("op-by", "entity.task", "field.task.by", "Written by", "written_by", NendoStorageKind.Reference, false),
            new ConfigureReferenceOperation("op-ref", "entity.task", "field.task.by", "entity.author", "field.author.name", 4));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Add Written by, a reference to Author.", entries[2],
            "The target is configured later in the same change set, and the pre-pass has it.");
        Assert.AreEqual("Point Written by on Task at Author, labelled by Name.", entries[3]);
    }

    // A binding cost two lines of which the first said nothing: "Show a field on its
    // surface." then "Bind to Title." The book screens produced about forty such pairs.
    [TestMethod]
    public void ABindingAndTheFieldItBindsAreOneSentence()
    {
        // The surface ID and its root node are different identifiers, as they are in a real
        // file. Naming them the same thing hid a defect: the sentence resolved the surface
        // ID as if it were a node, and against a real file said "on an unknown node".
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-root", "surface.task.form", "node.task.form.root", null, "recordForm", 0),
            new SetUiPropertyOperation("op-root-title", "surface.task.form", "node.task.form.root", "title", "Task"),
            new AddUiNodeOperation("op-bind", "surface.task.form", "node.bind", "node.task.form.root", "fieldBinding", 1),
            new SetUiPropertyOperation("op-bind-field", "surface.task.form", "node.bind", "fieldId", "field.task.title"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.HasCount(2, entries, "The binding carries its field, and the form carries its name.");
        Assert.AreEqual("Add the record form \"Task\".", entries[0]);
        Assert.AreEqual("Show Title on the record form \"Task\".", entries[1]);
    }

    // A binding onto a surface whose root is in neither the change set nor the active file
    // says the field and stops, rather than describing a node that does not exist.
    [TestMethod]
    public void ABindingOntoAnUnknownSurfaceNamesTheFieldAndNothingElse()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-bind", "surface.absent", "node.bind", null, "fieldBinding", 0),
            new SetUiPropertyOperation("op-bind-field", "surface.absent", "node.bind", "fieldId", "field.task.title"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Show Title.", entries[0]);
        Assert.IsFalse(entries[0].Contains("unknown", StringComparison.Ordinal), entries[0]);
    }

    // Owner-reported from the rendered review panel, 2026-09-17: a board read "Add grouped
    // board." with its name six lines below, under five configuration lines belonging to a
    // screen the reviewer could not yet name. The same complaint the binding pair carried.
    [TestMethod]
    public void ARootIsAnnouncedByItsNameRatherThanNamedSixLinesLater()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-board", "surface.by-client", "node.by-client", null, "boardSurface", 0),
            new SetUiPropertyOperation("op-version", "surface.by-client", "node.by-client", "definitionVersion", 3),
            new SetUiPropertyOperation("op-entity", "surface.by-client", "node.by-client", "entityId", "entity.task"),
            new SetUiPropertyOperation("op-title", "surface.by-client", "node.by-client", "title", "Open work by client"),
            new SetUiPropertyOperation("op-group", "surface.by-client", "node.by-client", "groupByFieldId", "field.task.project"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Add the grouped board \"Open work by client\".", entries[0]);
        Assert.HasCount(3, entries,
            "The name is in the first line and the contract version of a new root is not a sentence anyone can act on.");
        Assert.IsFalse(entries.Any(entry => entry.StartsWith("Name the surface", StringComparison.Ordinal)),
            "The naming line is carried by the line that adds the node.");
        Assert.IsFalse(entries.Any(entry => entry.Contains("semantic contract version", StringComparison.Ordinal)),
            "A root being added declares the version this host authors; it is not a change to review.");
        Assert.AreEqual("Bind the surface to Task.", entries[1]);
        Assert.AreEqual("Group records by Project.", entries[2]);
    }

    // Renaming something the file already has is a change to something the person has, and
    // keeps its own line -- the fold applies only to a node this change set is adding.
    [TestMethod]
    public void RenamingAnExistingSurfaceKeepsItsOwnLine()
    {
        var changeSet = ChangeSet(
            new SetUiPropertyOperation("op-title", "surface.task", "node.existing", "title", "Renamed"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        Assert.AreEqual("Name the surface Renamed.", entries[0]);
    }

    // W-041's acceptance: no reviewer-facing sentence contains a node ID. Two roots of a
    // kind may legitimately share a title, and the summary used to tell them apart by
    // printing the stable identifier at whoever was reading.
    [TestMethod]
    public void SurfacesSharingATitleAreCountedRatherThanIdentified()
    {
        var changeSet = ChangeSet(
            new AddUiNodeOperation("op-a", "surface.open.a", "surface.open.a", null, "recordList", 0),
            new SetUiPropertyOperation("op-a-title", "surface.open.a", "surface.open.a", "title", "Open work"),
            new AddUiNodeOperation("op-b", "surface.open.b", "surface.open.b", null, "recordList", 1),
            new SetUiPropertyOperation("op-b-title", "surface.open.b", "surface.open.b", "title", "Open work"),
            new RemoveUiNodeOperation("op-remove", "surface.open.b", "surface.open.b"));

        var entries = SemanticDiff.From(changeSet, Active()).Select(entry => entry.Summary).ToArray();

        foreach (var entry in entries)
        {
            Assert.IsFalse(entry.Contains("surface.open.", StringComparison.Ordinal),
                $"A node identifier reached a reviewer-facing sentence: {entry}");
        }
        Assert.AreEqual("Add the record list \"Open work\" (the second of two).", entries[1]);
        Assert.AreEqual("Remove the record list \"Open work\" (the second of two) from its surface.", entries[2]);
    }

    private static NendoChangeSet ChangeSet(params NendoOperation[] operations) => new(
    [
        new NendoMutation("proposal-diff", "diff-definition", "test", "Summarize surface properties", operations),
    ]);

    private static NendoSessionSnapshot Active()
    {
        var fields = new NendoFieldSnapshot[]
        {
            new("field.task.title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("field.task.project", "Project", NendoStorageKind.Text, false, "singleLine", []),
            new("field.task.estimateHours", "Estimate hours", NendoStorageKind.Decimal, false, null, []),
            new("field.task.due", "Due", NendoStorageKind.Date, false, "date", []),
        };
        var now = new DateTimeOffset(2026, 9, 9, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "tasks.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier,
                NendoFormat.CurrentVersion,
                NendoFormat.SemanticMinimumHostVersion,
                "application-test",
                "instance-test",
                now,
                now,
                4,
                6,
                10),
            [new NendoEntitySnapshot("entity.task", "Task", fields)],
            [],
            [],
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }
}
