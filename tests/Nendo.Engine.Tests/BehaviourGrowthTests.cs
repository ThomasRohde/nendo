namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0008 obligation P8: the growth path. One new bounded pure function and one
/// read-only consumer of the calculation service, both added through the machinery
/// that already exists rather than beside it.
/// <para>
/// The point is not the two features. It is that adding them needed no new evaluator,
/// no second catalogue and no way for a surface to run code — and that the closed
/// function set stayed closed while they were added.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class BehaviourGrowthTests
{
    [TestMethod]
    public async Task ANewPureFunctionArrivesThroughTheOrdinaryCatalogue()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await InstallAsync(coordinator, service, Calculation("project.nameLength", "nameLength", "Name length",
            NendoBehaviourScalar.Integer, "TextLength(name)"));

        var project = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1");
        var result = project.Calculations.Single(item => item.FieldId == "nameLength");
        Assert.AreEqual(NendoCalculationState.Value, result.State, $"{result.ErrorCode} {result.ErrorMessage}");
        Assert.AreEqual(7L, result.Value.GetInt64(), "TextLength did not count the characters of 'Project'.");

        // It is published the same way every other function is, so discovery finds it
        // without anybody editing a second table.
        var published = NendoBehaviourVocabulary.Description().Functions;
        var described = published.Single(function => function.Name == "TextLength");
        CollectionAssert.AreEqual(new[] { "text" }, described.ParameterTypes.ToArray());
        Assert.AreEqual("integer", described.ResultType);
        Assert.AreEqual(1, described.MinimumArguments);
        Assert.AreEqual(1, described.MaximumArguments);
    }

    /// <summary>
    /// ADR-0008, 2026-09-20 amendment, through the service a screen reads: the same
    /// empty input reads as an empty result under a calculation declared to allow one,
    /// and as calculation-missing-input under one declared always to answer. The
    /// planner's unrated work items are the first case.
    /// </summary>
    [TestMethod]
    public async Task AnOptionalResultOverAnEmptyInputReadsEmptyAndARequiredOneReadsAnError()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await InstallAsync(coordinator, service, new NendoCalculationDefinition("project.doubled", "projects", "doubled", "Doubled rating",
            NendoBehaviourScalar.Integer, true, "rating * 2",
            [NendoBehaviourBinding.SameRecordField("rating", "projects", "rating", NendoBehaviourScalar.Integer, true)]));
        await InstallAsync(coordinator, service, new NendoCalculationDefinition("project.insisted", "projects", "insisted", "Insisted rating",
            NendoBehaviourScalar.Integer, false, "rating * 2",
            [NendoBehaviourBinding.SameRecordField("rating", "projects", "rating", NendoBehaviourScalar.Integer, true)]));

        var project = (await service.GetSnapshotAsync()).Records.Single(record => record.RecordId == "p1");
        var quiet = project.Calculations.Single(item => item.FieldId == "doubled");
        Assert.AreEqual(NendoCalculationState.Empty, quiet.State, $"{quiet.ErrorCode} {quiet.ErrorMessage}");
        var loud = project.Calculations.Single(item => item.FieldId == "insisted");
        Assert.AreEqual(NendoCalculationState.Error, loud.State);
        Assert.AreEqual(NendoCalculationCodes.MissingInput, loud.ErrorCode);
    }

    [TestMethod]
    public void ARefusalIsPublishedThroughTheOrdinaryCatalogue()
    {
        var described = NendoBehaviourVocabulary.Description().Functions.Single(function => function.Name == "Refuse");
        CollectionAssert.AreEqual(new[] { "text" }, described.ParameterTypes.ToArray());
        Assert.AreEqual(1, described.MinimumArguments);
        Assert.AreEqual(1, described.MaximumArguments);
        Assert.Contains("choice", described.Summary, StringComparison.Ordinal);
    }

    /// <summary>
    /// The published binding shapes and the shapes the codec accepts are one table.
    /// Each shape is exercised the way an author would send it: exactly its required
    /// keys read, one key beyond them is refused by name, and one short is refused
    /// naming what is missing.
    /// </summary>
    [TestMethod]
    public void EveryPublishedBindingKeyIsAcceptedAndEveryAcceptedKeyIsPublished()
    {
        var published = NendoBehaviourVocabulary.Description().Bindings;
        Assert.HasCount(NendoBindingShape.All.Count, published);
        foreach (var shape in NendoBindingShape.All)
        {
            var row = published.Single(candidate => candidate.Kind == shape.Kind.ToString() && candidate.Aggregate == shape.Aggregate?.ToString());
            CollectionAssert.AreEqual(shape.RequiredKeys.ToArray(), row.RequiredFields.ToArray(), shape.Name);
            CollectionAssert.AreEqual(shape.OptionalKeys.ToArray(), row.OptionalFields.ToArray(), shape.Name);

            var complete = shape.RequiredKeys.ToDictionary(key => key, Value, StringComparer.Ordinal);
            complete["kind"] = shape.Kind.ToString();
            if (shape.Aggregate is { } aggregate) complete["aggregate"] = aggregate.ToString();
            Read(complete);

            var extra = new Dictionary<string, object?>(complete, StringComparer.Ordinal) { ["aggregateFieldId"] = "x" };
            var refused = Assert.ThrowsExactly<NendoValidationException>(() => Read(extra), shape.Name).Message;
            StringAssert.Contains(refused, "aggregateFieldId", shape.Name);
            StringAssert.Contains(refused, shape.Name, shape.Name);

            foreach (var key in shape.RequiredKeys.Where(key => key is not ("bindingId" or "kind" or "aggregate")))
            {
                var short_ = new Dictionary<string, object?>(complete, StringComparer.Ordinal);
                short_.Remove(key);
                var message = Assert.ThrowsExactly<NendoValidationException>(() => Read(short_), $"{shape.Name} without {key}").Message;
                StringAssert.Contains(message, $"needs {key}", $"{shape.Name} without {key}");
                StringAssert.Contains(message, NendoBindingShape.Purpose(key), $"{shape.Name} without {key}");
            }
        }

        static object? Value(string key) => key switch
        {
            "resultType" => "Integer",
            "nullable" => false,
            "kind" or "aggregate" => null,
            _ => key,
        };

        static void Read(Dictionary<string, object?> binding)
        {
            var body = System.Text.Json.JsonSerializer.Serialize(new
            {
                entityId = "entityId", fieldId = "calculated", displayName = "Calculated", resultType = "Integer", resultNullable = false,
                expression = "bindingId", callAliases = Array.Empty<object>(), bindings = new[] { binding },
            });
            NendoBehaviourCodec.Read("entityId.calculated", NendoBehaviourKind.Calculation, NendoBehaviourContract.Version, body,
                NendoBehaviourBodySource.Authored);
        }
    }

    [TestMethod]
    public async Task AFunctionThatWouldReachTheNetworkIsRefusedByName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);

        // Nothing declares this function absent. It is absent because the set is
        // closed: a name that is not in the catalogue is refused rather than resolved
        // from the evaluator's own built-ins or from anything a library brought along.
        foreach (var attempt in new[] { "Fetch('https://example.invalid')", "HttpGet(name)", "ReadFile(name)", "Now()" })
        {
            var refused = await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
                InstallAsync(coordinator, service, Calculation("project.reach", "reach", "Reach",
                    NendoBehaviourScalar.Text, attempt)));
            StringAssert.Contains(refused.Message, "is not a function this formula may call", StringComparison.Ordinal);
        }

        Assert.IsEmpty((await service.GetSnapshotAsync()).Entities
            .Single(entity => entity.EntityId == "projects").DerivedFields,
            "A refused definition was installed anyway.");
    }

    [TestMethod]
    public async Task ASurfaceMayHideANodeOnACalculationButNeverOnAStoredValue()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await InstallAsync(coordinator, service, Calculation("project.isNamed", "isNamed", "Is named",
            NendoBehaviourScalar.Boolean, "TextLength(name) > 0"));

        await coordinator.ApplyAsync(new("test", "surface", "test", "A conditionally shown field", [
            .. FormRoot(),
            new AddUiNodeOperation("name-add", "project-surface", "project-name", "project-root", "fieldBinding", 0),
            new SetUiPropertyOperation("name-field", "project-surface", "project-name", "fieldId", "name"),
            new AddUiNodeOperation("note-add", "project-surface", "project-note", "project-root", "fieldBinding", 1),
            new SetUiPropertyOperation("note-field", "project-surface", "project-note", "fieldId", "note"),
            new SetUiPropertyOperation("note-visible", "project-surface", "project-note", "visibleWhen", "isNamed"),
        ]));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(item => item.Code + ": " + item.Message)));
        var note = compiled.Applications.Single().Surfaces.Single()
            .Children.Single(child => child.Properties.TryGetValue("fieldId", out var value) && value.GetString() == "note");
        Assert.AreEqual("isNamed", note.Properties["visibleWhen"].GetString());

        // The file now says it needs a host that can evaluate the calculation, because
        // one that cannot has no way to know whether to show the node.
        Assert.AreEqual(NendoFormat.ConditionalVisibilityMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        // A stored field is refused: hiding one field behind another's typed value is
        // a form rule this contract does not define.
        await coordinator.ApplyAsync(new("test", "stored", "test", "Point it at a stored field", [
            new SetUiPropertyOperation("note-stored", "project-surface", "project-note", "visibleWhen", "name"),
        ]));
        var refused = await service.CompileSemanticUiAsync();
        Assert.IsFalse(refused.IsValid);
        var diagnostic = refused.Diagnostics.Single(item => item.Code == "NUI330");
        StringAssert.Contains(diagnostic.Hint, "reads a calculation", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task VisibilityNeedsAYesOrNoAnswerAndCannotConcealStudioOrGrantWriteAuthority()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = await SeedAsync(coordinator);
        await InstallAsync(coordinator, service, Calculation("project.nameLength", "nameLength", "Name length",
            NendoBehaviourScalar.Integer, "TextLength(name)"));

        await coordinator.ApplyAsync(new("test", "surface", "test", "Hide on a number", [
            .. FormRoot(),
            new AddUiNodeOperation("name-add", "project-surface", "project-name", "project-root", "fieldBinding", 0),
            new SetUiPropertyOperation("name-field", "project-surface", "project-name", "fieldId", "name"),
            new AddUiNodeOperation("note-add", "project-surface", "project-note", "project-root", "fieldBinding", 1),
            new SetUiPropertyOperation("note-field", "project-surface", "project-note", "fieldId", "note"),
            new SetUiPropertyOperation("note-visible", "project-surface", "project-note", "visibleWhen", "nameLength"),
        ]));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsFalse(compiled.IsValid, "A number was accepted where a yes-or-no answer is needed.");
        Assert.IsTrue(compiled.Diagnostics.Any(item => item.Code == "NUI331"));

        // Studio does not read the surface at all, so an invalid one cannot take the
        // permanent route into the file away.
        var snapshot = await service.GetSnapshotAsync();
        Assert.IsNotEmpty(snapshot.Records);
        Assert.IsNotEmpty(snapshot.Entities.Single(entity => entity.EntityId == "projects").Fields);

        // And visibility is not a capability: it names a calculation, and a calculation
        // reads. There is no surface property that writes.
        var writable = NendoSemanticVocabulary.Kinds.Values
            .SelectMany(kind => kind.Properties)
            .Where(property => property.Contains("visible", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        CollectionAssert.AreEqual(new[] { "visibleWhen", "visibleWhen" }, writable,
            "Visibility gained a second property; each one is a place a surface could start deciding writes.");
    }

    private static NendoCalculationDefinition Calculation(
        string definitionId, string fieldId, string displayName, NendoBehaviourScalar resultType, string expression) =>
        new(definitionId, "projects", fieldId, displayName, resultType, false, expression,
            [NendoBehaviourBinding.SameRecordField("name", "projects", "name", NendoBehaviourScalar.Text, false)]);

    private static async Task InstallAsync(
        NendoWriteCoordinator coordinator, NendoApplicationService service, NendoBehaviourDefinition definition)
    {
        var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
        await coordinator.ApplyAsync(new("test", "install-" + definition.DefinitionId, "test", "Install " + definition.DefinitionId,
            [new SetBehaviourDefinitionOperation("install-" + definition.DefinitionId, definition, revision)]));
    }

    private static NendoOperation[] FormRoot() =>
    [
        new AddUiNodeOperation("root-add", "project-surface", "project-root", null, "recordForm", 0),
        new SetUiPropertyOperation("root-version", "project-surface", "project-root", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
        new SetUiPropertyOperation("root-entity", "project-surface", "project-root", "entityId", "projects"),
    ];

    private static async Task<NendoApplicationService> SeedAsync(NendoWriteCoordinator coordinator)
    {
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Projects", [
            new CreateEntityOperation("projects", "projects", "Projects", "projects"),
            new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
            new AddFieldOperation("p-note", "projects", "note", "Note", "note", NendoStorageKind.Text, false),
            new AddFieldOperation("p-rating", "projects", "rating", "Rating", "rating", NendoStorageKind.Integer, false),
        ]));
        await service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["name"] = "Project", ["note"] = "Kept" },
            new NendoRequestContext("test", "p1", "test")));
        return service;
    }
}
