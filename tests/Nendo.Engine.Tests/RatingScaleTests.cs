using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A rating is an Integer field drawn on a closed scale, ADR-0004 2026-09-14 amendment,
/// slice S2. The scale is carried by the existing field operation: stored in its own
/// protected table at the end of the layout ladder, read back wherever the field already
/// flows, refused by name when it cannot be drawn, and never a bound on what may be
/// written — a number outside it is a data issue the reader states.
/// </summary>
[TestClass]
public sealed class RatingScaleTests
{
    [TestMethod]
    public async Task ARatingScaleIsStoredReadBackAndRaisesTheMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Ratings", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "name", "Name", "name", NendoStorageKind.Text, true),
        ]));
        var before = await service.GetSnapshotAsync();
        Assert.AreNotEqual(NendoFormat.GalleryAndRatingMinimumHostVersion, before.Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(new("test", "rate", "test", "A confidence rating", [
            new AddFieldOperation("r", "entry", "confidence", "Confidence", "confidence", NendoStorageKind.Integer, false, "rating", null, 1, 5),
        ]));
        var after = await service.GetSnapshotAsync();
        var field = Field(after, "confidence");
        Assert.AreEqual("rating", field.Presentation);
        Assert.AreEqual(new NendoRatingScale(1, 5), field.Scale);
        // A file that draws a scale states the host that draws it.
        Assert.AreEqual(NendoFormat.GalleryAndRatingMinimumHostVersion, after.Manifest.MinimumHostVersion);
        // A field without a scale carries none, so nothing reads a bound nobody set.
        Assert.IsNull(Field(after, "name").Scale);

        // Retiring the field keeps the recorded minimum: removing a feature never lowers
        // what a file states it once needed.
        await coordinator.ApplyAsync(new("test", "retire", "test", "Retire the rating", [
            new SetRetiredOperation("x", "entry", "confidence", true, after.Manifest.DefinitionRevision),
        ]));
        Assert.AreEqual(NendoFormat.GalleryAndRatingMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
    }

    [TestMethod]
    [DataRow(NendoStorageKind.Text, "rating", 1L, 5L, "requires Integer storage")]
    [DataRow(NendoStorageKind.Integer, "rating", null, null, "must declare both min and max")]
    [DataRow(NendoStorageKind.Integer, "rating", 1L, null, "must declare both min and max")]
    [DataRow(NendoStorageKind.Integer, "rating", 5L, 5L, "must be greater than")]
    [DataRow(NendoStorageKind.Integer, "rating", 5L, 1L, "must be greater than")]
    [DataRow(NendoStorageKind.Integer, "rating", 1L, 11L, "at most 10 values")]
    [DataRow(NendoStorageKind.Integer, null, 1L, 5L, "Only rating fields can declare a scale")]
    [DataRow(NendoStorageKind.Text, "singleLine", 1L, 5L, "Only rating fields can declare a scale")]
    public void AScaleThatCannotBeDrawnIsRefusedByName(
        NendoStorageKind storageKind, string? presentation, long? min, long? max, string reason)
    {
        var refusal = Assert.ThrowsExactly<ArgumentException>(() => new AddFieldOperation(
            "r", "entry", "confidence", "Confidence", "confidence", storageKind, false, presentation, null, min, max));

        StringAssert.Contains(refusal.Message, reason);
    }

    /// <summary>
    /// The span counts both ends, so ten values are accepted and eleven are not. The
    /// refusal names the span it was given rather than only the rule.
    /// </summary>
    [TestMethod]
    public void TheScaleCarriesAtMostTenValuesCountingBothEnds()
    {
        var widest = new AddFieldOperation(
            "r", "entry", "confidence", "Confidence", "confidence", NendoStorageKind.Integer, false, "rating", null, 1, 10);
        Assert.AreEqual(new NendoRatingScale(1, 10), widest.Scale);
        // A scale need not start at one: an author may rate from zero, or between two
        // numbers that mean something in their own domain.
        Assert.AreEqual(new NendoRatingScale(-2, 2),
            new AddFieldOperation("r", "entry", "c", "C", "c", NendoStorageKind.Integer, false, "rating", null, -2, 2).Scale);

        var refusal = Assert.ThrowsExactly<ArgumentException>(() => new AddFieldOperation(
            "r", "entry", "confidence", "Confidence", "confidence", NendoStorageKind.Integer, false, "rating", null, 0, 10));
        StringAssert.Contains(refusal.Message, "is 11");
    }

    /// <summary>
    /// An operation that declares no scale must hash exactly what it hashed before
    /// ratings existed, or every stored field operation's digest moves under the feet of
    /// idempotent replay.
    /// </summary>
    [TestMethod]
    public void AFieldWithoutAScaleKeepsItsCanonicalBytes()
    {
        var plain = new AddFieldOperation("f", "entry", "name", "Name", "name", NendoStorageKind.Text, true, "singleLine");

        StringAssert.Contains(
            plain.CanonicalJson(),
            """{"displayName":"Name","entityId":"entry","fieldId":"name","physicalColumnName":"name","presentation":"singleLine","required":true,"storageKind":"Text"}""");

        var rated = new AddFieldOperation(
            "r", "entry", "confidence", "Confidence", "confidence", NendoStorageKind.Integer, false, "rating", null, 1, 5);
        StringAssert.Contains(rated.CanonicalJson(), "\"max\":5,\"min\":1");
    }

    [TestMethod]
    public async Task AFileWithARatingLandsOnTheScaleLayoutAndReopensWithIt()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Ratings", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("r", "entry", "confidence", "Confidence", "confidence", NendoStorageKind.Integer, false, "rating", null, 1, 5),
        ]));
        var final = await service.GetSnapshotAsync();
        Assert.AreEqual(new NendoRatingScale(1, 5), Field(final, "confidence").Scale);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // The first rated field creates the whole ladder, as a first tone does.
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-v1", inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding =>
            finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift" or "unsupported-field-semantics"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        var reopened = await service.GetSnapshotAsync();
        Assert.AreEqual(JsonSerializer.Serialize(final.Entities), JsonSerializer.Serialize(reopened.Entities));
        Assert.AreEqual(new NendoRatingScale(1, 5), Field(reopened, "confidence").Scale);
    }

    [TestMethod]
    public async Task AFileWithoutARatingKeepsItsLayoutAndItsMinimumHost()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Plain", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("c", "entry", "count", "Count", "count", NendoStorageKind.Integer, false),
        ]));
        var after = await service.GetSnapshotAsync();
        Assert.IsNull(Field(after, "count").Scale);
        Assert.AreEqual(NendoFormat.MinimumHostVersion, after.Manifest.MinimumHostVersion);
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);

        // A plain Integer does not move the file up the ladder.
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("production-semantic-v1", inspection.Layout);
    }

    /// <summary>
    /// A scale bounds the drawing, not the column. A rating may be declared over values
    /// that already exist, so a number outside it is written, read back exactly, and
    /// stated as a data issue rather than refused or rounded into range.
    /// </summary>
    [TestMethod]
    public async Task AValueOutsideTheScaleIsWrittenAndStatedRatherThanRefused()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Ratings", [
            new CreateEntityOperation("e", "entry", "Entry", "entries"),
            new AddFieldOperation("f", "entry", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("r", "entry", "confidence", "Confidence", "confidence", NendoStorageKind.Integer, false, "rating", null, 1, 5),
        ]));
        await coordinator.ApplyAsync(new("test", "list", "test", "A list", [
            new AddUiNodeOperation("list-add", "s", "list", null, "recordList", 0),
            new SetUiPropertyOperation("list-version", "s", "list", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
            new SetUiPropertyOperation("list-entity", "s", "list", "entityId", "entry"),
            new AddUiNodeOperation("bind-add", "s", "bind", "list", "fieldBinding", 0),
            new SetUiPropertyOperation("bind-field", "s", "bind", "fieldId", "confidence"),
        ]));
        await service.CreateRecordAsync(new("entry", "r1", Values(4), Context("in")));
        await service.CreateRecordAsync(new("entry", "r2", Values(9), Context("out")));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, "A value outside a scale is a warning, not a refusal.");
        var warning = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NDATA012");
        Assert.AreEqual("r2", warning.SemanticId);
        Assert.AreEqual("confidence", warning.PropertyPath);
        Assert.AreEqual(NendoDiagnosticSeverity.Warning, warning.Severity);
        StringAssert.Contains(warning.Message, "scale 1–5");
        StringAssert.Contains(warning.Hint, "corrected in Studio");

        // The number survives exactly; nothing was clamped on the way in or out.
        Assert.AreEqual(9L, compiled.Applications.Single().Records
            .Single(record => record.SemanticId == "r2").Values["confidence"].GetInt64());
    }

    private static NendoFieldSnapshot Field(NendoSessionSnapshot snapshot, string fieldId) =>
        snapshot.Entities.Single().Fields.Single(field => field.FieldId == fieldId);

    private static Dictionary<string, object?> Values(long confidence) => new(StringComparer.Ordinal)
    {
        ["name"] = "Entry",
        ["confidence"] = confidence,
    };

    private static NendoRequestContext Context(string key) => new("test", key, "test");
}
