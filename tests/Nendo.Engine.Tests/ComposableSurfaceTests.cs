using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// Contract version 3, accepted by the ADR-0004 2026-09-09 amendment: an ordered
/// node tree whose structure is governed by the vocabulary table rather than by
/// a hard-coded depth-two rule.
/// </summary>
[TestClass]
public sealed class ComposableSurfaceTests
{
    [TestMethod]
    public async Task NestedSectionsCompileBeyondTheVersionOneDepthLimit()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema("e")));
        await coordinator.ApplyAsync(new("test", "ui", "test", "Nested form", NestedForm()));

        var compiled = await service.CompileSemanticUiAsync();
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        var app = compiled.Applications.Single();
        Assert.AreEqual(NendoSemanticVocabulary.ContractVersion, app.ContractVersion);

        var root = app.Surfaces.Single();
        Assert.AreEqual("recordForm", root.Kind);
        var outer = root.Children.Single(node => node.Kind == "section");
        Assert.AreEqual("Details", outer.Properties["title"].GetString());
        var inner = outer.Children.Single(node => node.Kind == "section");
        var binding = inner.Children.Single();
        Assert.AreEqual("fieldBinding", binding.Kind);
        Assert.AreEqual("e-title", binding.Properties["fieldId"].GetString());

        // recordForm > section > section > fieldBinding is four levels; version 1
        // and version 2 permit only a root with fieldBinding children.
        Assert.AreEqual(NendoFormat.ComposableSurfacesMinimumHostVersion,
            (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);
    }

    [TestMethod]
    public async Task ChildOrderFollowsDeclaredPositionAndSurvivesReopen()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema("e")));
        await coordinator.ApplyAsync(new("test", "ui", "test", "Two bindings", TwoBindingForm()));

        var before = (await service.CompileSemanticUiAsync()).Applications.Single();
        var section = before.Surfaces.Single().Children.Single(node => node.Kind == "section");
        CollectionAssert.AreEqual(
            new[] { "e-title", "e-status" },
            section.Children.Select(child => child.Properties["fieldId"].GetString()).ToArray(),
            "Node order is position, and position is meaningful.");

        var digest = before.Digest;
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        coordinator = await workspace.OpenAsync();
        service = new(coordinator);
        Assert.AreEqual(digest, (await service.CompileSemanticUiAsync()).Applications.Single().Digest,
            "Reopening the same file must not move the digest.");

        // Moving a node is a semantic change and must move the digest.
        await coordinator.ApplyAsync(new("test", "move", "test", "Reorder",
            [new MoveUiNodeOperation("move-status", "e-surface", "e-status-binding", "e-section", 0)]));
        var after = (await service.CompileSemanticUiAsync()).Applications.Single();
        Assert.AreNotEqual(digest, after.Digest, "Moving a node must move the digest.");
        CollectionAssert.AreEqual(
            new[] { "e-status", "e-title" },
            after.Surfaces.Single().Children.Single(node => node.Kind == "section")
                .Children.Select(child => child.Properties["fieldId"].GetString()).ToArray());

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
    }

    [TestMethod]
    public async Task DigestIsTakenOverTheExplicitContractVersionThreeProjection()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new("test", "schema", "test", "Schema", Schema("e")));
        await coordinator.ApplyAsync(new("test", "ui", "test", "Nested form", NestedForm()));

        var app = (await service.CompileSemanticUiAsync()).Applications.Single();
        var projected = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            NendoRenderPlanJson.SerializeForDigest(NendoComposableApplicationPlanPayload.From(app))))).ToLowerInvariant();
        Assert.AreEqual(projected, app.Digest);
    }

    // These malformed shapes cannot be produced through the typed operation path:
    // storage refuses an unknown kind, a missing parent, a cross-surface parent
    // and a move that would close a cycle before they are ever written. That
    // defence stays. The compiler must still fail closed on a definition that
    // arrives another way, such as a file written by a different host, so these
    // exercise the compiler directly against a synthesized snapshot.
    [TestMethod]
    [DataRow("unknownKind", "NUI011", "kind")]
    [DataRow("illegalParent", "NUI013", "parentNodeId")]
    [DataRow("nonRootKind", "NUI012", "parentNodeId")]
    [DataRow("unknownProperty", "NUI090", "cssClass")]
    [DataRow("missingRequired", "NUI091", "title")]
    [DataRow("orphan", "NUI014", "parentNodeId")]
    [DataRow("crossSurface", "NUI016", "parentNodeId")]
    [DataRow("cycle", "NUI015", "parentNodeId")]
    public void MalformedTreesFailClosedWithLocalisedDiagnostics(string scenario, string code, string propertyPath)
    {
        var compiled = new NendoSemanticCompiler().Compile(MalformedSource(scenario));

        Assert.IsFalse(compiled.IsValid, "A malformed tree must not compile.");
        Assert.IsEmpty(compiled.Applications, "A core error produces no partial render plan.");
        Assert.IsEmpty(compiled.Applications, "A core error produces no partial application plan.");

        var hit = compiled.Diagnostics.FirstOrDefault(d => d.Code == code);
        Assert.IsNotNull(hit, $"Expected {code}; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
        Assert.AreEqual(NendoDiagnosticSeverity.Error, hit.Severity);
        Assert.IsFalse(string.IsNullOrWhiteSpace(hit.SemanticId), "A diagnostic must name the offending node.");
        Assert.AreEqual(propertyPath, hit.PropertyPath);
        Assert.IsFalse(string.IsNullOrWhiteSpace(hit.Hint));
    }

    // Carried from the removed contract version 1 suite: a record that breaks a
    // rule stays visible with a warning. Suppressing it would hide data behind a
    // validation state the owner never chose.
    [TestMethod]
    public void InvalidRecordProducesWarningsButRemainsInPlan()
    {
        var source = MalformedSource("none");
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal)
        {
            ["e-title"] = JsonSerializer.SerializeToElement("  "),
            ["e-status"] = JsonSerializer.SerializeToElement("archived"),
        };
        var record = new NendoRecordSnapshot("e", "record-one", 1, values);

        var result = new NendoSemanticCompiler().Compile(source with { Records = [record] });

        Assert.IsTrue(result.IsValid, string.Join("; ", result.Diagnostics.Select(d => d.Code)));
        CollectionAssert.AreEqual(
            new[] { "NDATA010", "NDATA011" },
            result.Diagnostics.Select(value => value.Code).ToArray());
        Assert.IsTrue(result.Diagnostics.All(value => value.Severity == NendoDiagnosticSeverity.Warning));
        Assert.IsTrue(result.Applications.Single().Records.Any(value => value.SemanticId == "record-one"));
    }

    // Carried from the removed contract version 1 suite: an empty definition is a
    // deliberate shape, so it compiles to nothing without a malformed diagnostic.
    [TestMethod]
    public void AbsentCustomDefinitionLeavesNoPlanAndNoDiagnostics()
    {
        var result = new NendoSemanticCompiler().Compile(MalformedSource("none") with { UiNodes = [] });

        Assert.IsFalse(result.IsValid);
        Assert.IsEmpty(result.Applications);
        Assert.IsEmpty(result.Diagnostics);
    }

    [TestMethod]
    public void ValidSynthesizedTreeCompilesSoTheMalformedCasesAreIsolated()
    {
        var compiled = new NendoSemanticCompiler().Compile(MalformedSource("none"));
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));
        Assert.AreEqual("recordForm", compiled.Applications.Single().Surfaces.Single().Kind);
    }

    // P6-C: a declared filter and ordering are part of the durable contract, so
    // every element of them is checked against the closed vocabulary and the
    // record type they are declared on.
    [TestMethod]
    [DataRow("retiredFilterField", "NUI272", "fieldId")]
    [DataRow("unknownOperator", "NUI273", "operator")]
    [DataRow("unknownValueKind", "NUI274", "valueKind")]
    [DataRow("valueOnPresenceOperator", "NUI275", "value")]
    [DataRow("missingValue", "NUI276", "value")]
    [DataRow("wrongKindLiteral", "NUI277", "value")]
    [DataRow("unknownOrderField", "NUI278", "orderByFieldId")]
    [DataRow("unknownDirection", "NUI279", "orderDirection")]
    public void MalformedFiltersAndOrderingFailClosed(string scenario, string code, string propertyPath)
    {
        var compiled = new NendoSemanticCompiler().Compile(FilteredSource(scenario));

        Assert.IsFalse(compiled.IsValid, "A malformed filter must not compile.");
        Assert.IsEmpty(compiled.Applications, "A core error produces no partial application plan.");

        var hit = compiled.Diagnostics.FirstOrDefault(d => d.Code == code);
        Assert.IsNotNull(hit, $"Expected {code}; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
        Assert.AreEqual(propertyPath, hit.PropertyPath);
        Assert.IsFalse(string.IsNullOrWhiteSpace(hit.SemanticId));
    }

    [TestMethod]
    public void DeclaredFilterAndOrderingCompile()
    {
        var compiled = new NendoSemanticCompiler().Compile(FilteredSource("none"));
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        var list = compiled.Applications.Single().Surfaces.Single(node => node.Kind == "recordList");
        Assert.AreEqual("e-status", list.Properties["orderByFieldId"].GetString());
        Assert.AreEqual("descending", list.Properties["orderDirection"].GetString());

        var clause = list.Children.Single(child => child.Kind == "filterClause");
        Assert.AreEqual("e-status", clause.Properties["fieldId"].GetString());
        Assert.AreEqual("ne", clause.Properties["operator"].GetString());
        Assert.AreEqual("done", clause.Properties["value"].GetString());
    }

    [TestMethod]
    public void PresenceOperatorsNeedNoValue()
    {
        var compiled = new NendoSemanticCompiler().Compile(FilteredSource("presenceOperator"));
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));
    }

    [TestMethod]
    public void ContractOperatorsMapOntoTheRecordQueryComparisons()
    {
        // The durable contract keeps lte and gte; the record query spells the same
        // comparisons le and ge. Every other operator passes through unchanged.
        Assert.AreEqual("le", NendoSemanticVocabulary.QueryOperatorFor("lte"));
        Assert.AreEqual("ge", NendoSemanticVocabulary.QueryOperatorFor("gte"));
        foreach (var op in new[] { "eq", "ne", "lt", "gt", "isNull", "isNotNull" })
            Assert.AreEqual(op, NendoSemanticVocabulary.QueryOperatorFor(op));
    }

    private static NendoSessionSnapshot FilteredSource(string scenario)
    {
        var retired = scenario == "retiredFilterField";
        var fields = new NendoFieldSnapshot[]
        {
            new("e-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("e-status", "Status", NendoStorageKind.Text, true, "singleChoice", ["new", "done"]) { Retired = retired },
            new("e-rank", "Rank", NendoStorageKind.Integer, false, null, []),
        };

        var clause = new List<(string Name, object Value)> { ("fieldId", "e-status"), ("operator", "ne") };
        var listProperties = new List<(string Name, object Value)>
        {
            ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Open"),
            ("orderByFieldId", "e-status"), ("orderDirection", "descending"),
        };

        switch (scenario)
        {
            case "none":
            case "retiredFilterField":
                clause.Add(("value", "done"));
                break;
            case "unknownOperator":
                clause[1] = ("operator", "startsWith");
                clause.Add(("value", "done"));
                break;
            case "unknownValueKind":
                clause.Add(("valueKind", "yesterday"));
                clause.Add(("value", "done"));
                break;
            case "valueOnPresenceOperator":
                clause[1] = ("operator", "isNull");
                clause.Add(("value", "done"));
                break;
            case "presenceOperator":
                clause[1] = ("operator", "isNotNull");
                break;
            case "missingValue":
                break;
            case "wrongKindLiteral":
                clause[0] = ("fieldId", "e-rank");
                clause.Add(("value", "not a number"));
                break;
            case "unknownOrderField":
                clause.Add(("value", "done"));
                listProperties[3] = ("orderByFieldId", "e-absent");
                break;
            case "unknownDirection":
                clause.Add(("value", "done"));
                listProperties[4] = ("orderDirection", "sideways");
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario), scenario, "Unknown filter scenario.");
        }

        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("e-surface", "e-list", null, "recordList", 0, [.. listProperties]),
            Node("e-surface", "e-title-binding", "e-list", "fieldBinding", 0, ("fieldId", "e-title")),
            Node("e-surface", "e-filter", "e-list", "filterClause", 1, [.. clause]),
        };

        var now = new DateTimeOffset(2026, 9, 9, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "register.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ComposableSurfacesMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [new NendoEntitySnapshot("e", "Axiom", fields)],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    // P6-D: a command owns ordered steps, and every step value is checked against
    // the field it assigns.
    [TestMethod]
    [DataRow("unknownStepField", "NUI284", "fieldId")]
    [DataRow("unknownValueKind", "NUI283", "valueKind")]
    [DataRow("literalWithoutValue", "NUI285", "value")]
    [DataRow("wrongKindLiteral", "NUI277", "value")]
    [DataRow("outsideChoices", "NUI286", "value")]
    [DataRow("todayOnText", "NUI287", "valueKind")]
    [DataRow("clearRequired", "NUI288", "valueKind")]
    [DataRow("valueOnToday", "NUI289", "value")]
    [DataRow("noSteps", "NUI280", null)]
    public void MalformedCommandStepsFailClosed(string scenario, string code, string? propertyPath)
    {
        var compiled = new NendoSemanticCompiler().Compile(CommandSource(scenario));

        Assert.IsFalse(compiled.IsValid, "A malformed command must not compile.");
        Assert.IsEmpty(compiled.Applications);
        var hit = compiled.Diagnostics.FirstOrDefault(d => d.Code == code);
        Assert.IsNotNull(hit, $"Expected {code}; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
        Assert.AreEqual(propertyPath, hit.PropertyPath);
    }

    // The recorded host crash: a non-string command value threw an unhandled
    // exception that surfaced as NENDO_INTERNAL_ERROR instead of a diagnostic.
    [TestMethod]
    [DataRow(true, DisplayName = "boolean")]
    [DataRow(42, DisplayName = "integer")]
    [DataRow(1.5, DisplayName = "decimal")]
    public void TypedCommandValuesAreDiagnosedRatherThanFaulting(object value)
    {
        var compiled = new NendoSemanticCompiler().Compile(CommandSource("typedOnText", value));

        Assert.IsFalse(compiled.IsValid);
        Assert.IsTrue(compiled.Diagnostics.Any(d => d.Code == "NUI277"),
            $"A mistyped command value must produce a diagnostic; got {string.Join(", ", compiled.Diagnostics.Select(d => d.Code))}.");
    }

    [TestMethod]
    public void TypedCommandValuesCompileAgainstTheirOwnStorageKinds()
    {
        var compiled = new NendoSemanticCompiler().Compile(CommandSource("typedSteps"));
        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));

        var command = compiled.Applications.Single().Surfaces.Single()
            .Children.Single(node => node.Kind == "recordCommand");
        Assert.AreEqual("Accept", command.Properties["label"].GetString());
        CollectionAssert.AreEqual(
            new[] { "e-rank", "e-flag", "e-accepted" },
            command.Children.Select(step => step.Properties["fieldId"].GetString()).ToArray(),
            "Steps keep their declared order.");
    }

    // today and now must resolve at execution, not at compilation, or the stored
    // definition and its digest would move with the clock.
    [TestMethod]
    public void ADeclaredTodayDoesNotMakeTheCompiledDefinitionTimeDependent()
    {
        var compiler = new NendoSemanticCompiler();
        var first = compiler.Compile(CommandSource("typedSteps"));
        var second = compiler.Compile(CommandSource("typedSteps"));

        Assert.AreEqual(first.Applications.Single().Digest, second.Applications.Single().Digest);
        var step = first.Applications.Single().Surfaces.Single()
            .Children.Single(node => node.Kind == "recordCommand")
            .Children.Single(child => child.Properties["fieldId"].GetString() == "e-accepted");
        Assert.AreEqual("today", step.Properties["valueKind"].GetString());
        Assert.IsFalse(step.Properties.ContainsKey("value"), "today carries no compiled value.");
    }

    private static NendoSessionSnapshot CommandSource(string scenario, object? typedValue = null)
    {
        var fields = new NendoFieldSnapshot[]
        {
            new("e-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("e-status", "Status", NendoStorageKind.Text, false, "singleChoice", ["new", "done"]),
            new("e-rank", "Rank", NendoStorageKind.Integer, false, null, []),
            new("e-flag", "Flag", NendoStorageKind.Boolean, false, null, []),
            new("e-accepted", "Accepted", NendoStorageKind.Date, false, "date", []),
        };

        var steps = new List<NendoUiNodeSnapshot>();
        void Step(string id, int position, params (string Name, object Value)[] properties) =>
            steps.Add(Node("e-surface", id, "e-command", "commandStep", position, properties));

        switch (scenario)
        {
            case "typedSteps":
                Step("s-rank", 0, ("fieldId", "e-rank"), ("valueKind", "literal"), ("value", 3));
                Step("s-flag", 1, ("fieldId", "e-flag"), ("valueKind", "literal"), ("value", true));
                Step("s-date", 2, ("fieldId", "e-accepted"), ("valueKind", "today"));
                break;
            case "typedOnText":
                Step("s-bad", 0, ("fieldId", "e-title"), ("valueKind", "literal"), ("value", typedValue!));
                break;
            case "unknownStepField":
                Step("s-bad", 0, ("fieldId", "e-absent"), ("valueKind", "literal"), ("value", "x"));
                break;
            case "unknownValueKind":
                Step("s-bad", 0, ("fieldId", "e-title"), ("valueKind", "yesterday"));
                break;
            case "literalWithoutValue":
                Step("s-bad", 0, ("fieldId", "e-title"), ("valueKind", "literal"));
                break;
            case "wrongKindLiteral":
                Step("s-bad", 0, ("fieldId", "e-rank"), ("valueKind", "literal"), ("value", "three"));
                break;
            case "outsideChoices":
                Step("s-bad", 0, ("fieldId", "e-status"), ("valueKind", "literal"), ("value", "archived"));
                break;
            case "todayOnText":
                Step("s-bad", 0, ("fieldId", "e-title"), ("valueKind", "today"));
                break;
            case "clearRequired":
                Step("s-bad", 0, ("fieldId", "e-title"), ("valueKind", "null"));
                break;
            case "valueOnToday":
                Step("s-bad", 0, ("fieldId", "e-accepted"), ("valueKind", "today"), ("value", "2026-09-09"));
                break;
            case "noSteps":
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario), scenario, "Unknown command scenario.");
        }

        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("e-surface", "e-form", null, "recordForm", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Axiom")),
            Node("e-surface", "e-title-binding", "e-form", "fieldBinding", 0, ("fieldId", "e-title")),
            Node("e-surface", "e-command", "e-form", "recordCommand", 1,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("label", "Accept")),
        };
        nodes.AddRange(steps);

        var now = new DateTimeOffset(2026, 9, 9, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "register.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ComposableSurfacesMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [new NendoEntitySnapshot("e", "Axiom", fields)],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    [TestMethod]
    public void VocabularyDescriptionIsDeterministicAndMatchesTheValidatedTable()
    {
        var description = NendoSemanticVocabulary.Describe();
        Assert.AreEqual(description, NendoSemanticVocabulary.Describe(), "The description must be deterministic.");

        using var document = JsonDocument.Parse(description);
        Assert.AreEqual(NendoSemanticVocabulary.ContractVersion, document.RootElement.GetProperty("contractVersion").GetInt32());

        var described = document.RootElement.GetProperty("kinds").EnumerateArray()
            .Select(kind => kind.GetProperty("kind").GetString()!).ToArray();
        CollectionAssert.AreEqual(
            NendoSemanticVocabulary.Kinds.Keys.OrderBy(value => value, StringComparer.Ordinal).ToArray(),
            described,
            "The description must list exactly the kinds the compiler accepts, in a stable order.");

        // A client must be able to read permitted children rather than probe for them.
        CollectionAssert.AreEqual(
            new[] { "count", "max", "min", "sum" },
            document.RootElement.GetProperty("aggregates").EnumerateArray().Select(value => value.GetString()).ToArray(),
            "The description must name only the aggregates this host computes exactly.");

        // A refusal is named with its reason, so an agent is told the truth
        // about avg rather than inferring it from an absence.
        var refused = document.RootElement.GetProperty("refusedAggregates").EnumerateArray().Single();
        Assert.AreEqual("avg", refused.GetProperty("aggregate").GetString());
        StringAssert.Contains(refused.GetProperty("reason").GetString(), "not generally an exact decimal");

        var form = document.RootElement.GetProperty("kinds").EnumerateArray()
            .Single(kind => kind.GetProperty("kind").GetString() == "recordForm");
        CollectionAssert.AreEqual(
            new[] { "fieldBinding", "recordCommand", "section", "tabGroup" },
            form.GetProperty("children").EnumerateArray().Select(value => value.GetString()).ToArray());
        Assert.IsTrue(form.GetProperty("canBeRoot").GetBoolean());

        // How many roots of a kind an entity may own is published, not discovered
        // by failing validation. A record page wanting Mark won and Mark lost hits
        // this immediately, and the remedy is stated with the ceiling.
        foreach (var kind in document.RootElement.GetProperty("kinds").EnumerateArray())
        {
            var root = kind.GetProperty("canBeRoot").GetBoolean();
            // Every root states a ceiling; which ceiling depends on what the root
            // belongs to. The overview belongs to the file, so it declares one per
            // file and none per entity, and a client reading only the per-entity
            // number would otherwise find no ceiling at all.
            var stated = kind.GetProperty("maxRootsPerEntity").ValueKind != JsonValueKind.Null ||
                kind.GetProperty("maxRootsPerFile").ValueKind != JsonValueKind.Null;
            Assert.AreEqual(root, stated,
                $"{kind.GetProperty("kind").GetString()} must declare a root ceiling exactly when it can be a root.");
            Assert.IsFalse(
                kind.GetProperty("maxRootsPerEntity").ValueKind != JsonValueKind.Null &&
                kind.GetProperty("maxRootsPerFile").ValueKind != JsonValueKind.Null,
                $"{kind.GetProperty("kind").GetString()} must not state two different ceilings.");
            Assert.AreEqual(root, kind.GetProperty("rootCardinality").ValueKind != JsonValueKind.Null);
        }
        var command = document.RootElement.GetProperty("kinds").EnumerateArray()
            .Single(kind => kind.GetProperty("kind").GetString() == "recordCommand");
        Assert.AreEqual(NendoSemanticVocabulary.MaximumRootsPerKindPerEntity,
            command.GetProperty("maxRootsPerEntity").GetInt32());
        var cardinality = command.GetProperty("rootCardinality").GetString()!;
        // The grammar follows the number. A hint reading "more than one" against
        // a table that permits eight is worse than no hint at all.
        StringAssert.Contains(cardinality, "at most 8 recordCommand roots");
        StringAssert.Contains(cardinality, "detailSurface");
        StringAssert.Contains(cardinality, "recordForm");
        StringAssert.Contains(cardinality, "commandId");

        // Sibling filter clauses AND, and there is no way to say anything else.
        // That was previously true and unstated, so an author could not confirm
        // that two clauses meant what they intended.
        var clauses = document.RootElement.GetProperty("filterClauses");
        Assert.AreEqual("and", clauses.GetProperty("combinator").GetString());
        StringAssert.Contains(clauses.GetProperty("note").GetString(), "no OR");
    }

    /// <summary>
    /// Two command roots on one entity now compile. An application with a Mark
    /// won and a Mark lost button is ordinary, and as two roots it used to fail;
    /// the remedy was to nest the second, which nothing stated.
    /// </summary>
    [TestMethod]
    public void TwoCommandRootsOnOneEntityCompileAndKeepTheirOwnCommandIdentities()
    {
        var compiled = new NendoSemanticCompiler().Compile(TwoCommandSource(nestSecond: false));

        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));
        CollectionAssert.AreEquivalent(
            new[] { "e-command", "e-command-two" },
            compiled.Applications.Single().Surfaces
                .Where(root => root.Kind == "recordCommand").Select(root => root.SemanticId).ToArray());
    }

    /// <summary>The remedy the refusal names has to work, or it is worse than no hint.</summary>
    [TestMethod]
    public void TheNestedSecondCommandCompilesAndKeepsItsOwnCommandIdentity()
    {
        var compiled = new NendoSemanticCompiler().Compile(TwoCommandSource(nestSecond: true));

        Assert.IsTrue(compiled.IsValid, string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));
        var commands = compiled.Applications.Single().Surfaces
            .SelectMany(root => root.Kind == "recordCommand" ? [root] : Commands(root))
            .ToArray();
        CollectionAssert.AreEquivalent(
            new[] { "e-command", "e-command-two" },
            commands.Select(node => node.SemanticId).ToArray());
    }

    /// <summary>
    /// The ceiling is a bounded product choice, so both sides of it are checked:
    /// eight command roots compile and the ninth refuses, with a message that
    /// counts rather than saying "more than one".
    /// </summary>
    [TestMethod]
    [DataRow(8, true)]
    [DataRow(9, false)]
    public void TheRootCommandCeilingIsEightPerEntity(int roots, bool expected)
    {
        var compiled = new NendoSemanticCompiler().Compile(ManyCommandSource(roots));

        Assert.AreEqual(expected, compiled.IsValid,
            string.Join("; ", compiled.Diagnostics.Select(d => d.Code + ": " + d.Message)));
        if (expected) return;
        var hit = compiled.Diagnostics.Single(diagnostic => diagnostic.Code == "NUI153");
        StringAssert.Contains(hit.Message, "9 recordCommand roots");
        StringAssert.Contains(hit.Message, "at most 8");
        Assert.AreEqual(NendoSemanticVocabulary.RootCardinalityHint("recordCommand"), hit.Hint);
        Assert.IsEmpty(compiled.Applications);
    }

    /// <summary>One entity, one record page and the requested number of command roots.</summary>
    private static NendoSessionSnapshot ManyCommandSource(int roots)
    {
        var fields = new NendoFieldSnapshot[]
        {
            new("e-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("e-flag", "Flag", NendoStorageKind.Boolean, false, null, []),
        };
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("e-surface", "e-page", null, "detailSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Axiom")),
            Node("e-surface", "e-title-binding", "e-page", "fieldBinding", 0, ("fieldId", "e-title")),
        };
        for (var index = 0; index < roots; index++)
        {
            nodes.Add(Node("e-surface", $"e-command-{index}", null, "recordCommand", index + 1,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("label", $"Step {index}")));
            nodes.Add(Node("e-surface", $"e-command-{index}-step", $"e-command-{index}", "commandStep", 0,
                ("fieldId", "e-flag"), ("valueKind", "literal"), ("value", index % 2 == 0)));
        }

        var now = new DateTimeOffset(2026, 9, 12, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "register.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.MultipleCommandRootsMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [new NendoEntitySnapshot("e", "Axiom", fields)],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static IEnumerable<NendoSurfaceNodePlan> Commands(NendoSurfaceNodePlan node) =>
        node.Children.SelectMany(child => child.Kind == "recordCommand" ? [child] : Commands(child));

    /// <summary>
    /// One entity with two commands: as two roots, which is refused, or with the
    /// second nested inside a record page, which is the published remedy.
    /// </summary>
    private static NendoSessionSnapshot TwoCommandSource(bool nestSecond)
    {
        var fields = new NendoFieldSnapshot[]
        {
            new("e-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("e-flag", "Flag", NendoStorageKind.Boolean, false, null, []),
        };
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("e-surface", "e-page", null, "detailSurface", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Axiom")),
            Node("e-surface", "e-title-binding", "e-page", "fieldBinding", 0, ("fieldId", "e-title")),
            Node("e-surface", "e-command", null, "recordCommand", 1,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("label", "Mark won")),
            Node("e-surface", "e-command-step", "e-command", "commandStep", 0,
                ("fieldId", "e-flag"), ("valueKind", "literal"), ("value", true)),
            Node("e-surface", "e-command-two", nestSecond ? "e-page" : null, "recordCommand", nestSecond ? 1 : 2,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("label", "Mark lost")),
            Node("e-surface", "e-command-two-step", "e-command-two", "commandStep", 0,
                ("fieldId", "e-flag"), ("valueKind", "literal"), ("value", false)),
        };

        var now = new DateTimeOffset(2026, 9, 11, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "register.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier, NendoFormat.CurrentVersion, NendoFormat.ComposableSurfacesMinimumHostVersion,
                "application-test", "instance-test", now, now, 4, 6, 10),
            [new NendoEntitySnapshot("e", "Axiom", fields)],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static NendoOperation[] Schema(string entity) =>
    [
        new CreateEntityOperation(entity + "-create", entity, entity, entity + "_records"),
        new AddFieldOperation(entity + "-title-create", entity, entity + "-title", "Title", "title", NendoStorageKind.Text, true),
        new AddFieldOperation(entity + "-status-create", entity, entity + "-status", "Status", "status", NendoStorageKind.Text, true, "singleChoice", ["new", "done"]),
    ];

    private static List<NendoOperation> FormRoot() =>
    [
        new AddUiNodeOperation("root-add", "e-surface", "e-root", null, "recordForm", 0),
        new SetUiPropertyOperation("root-version", "e-surface", "e-root", "definitionVersion", NendoSemanticVocabulary.ContractVersion),
        new SetUiPropertyOperation("root-entity", "e-surface", "e-root", "entityId", "e"),
    ];

    private static NendoOperation[] NestedForm()
    {
        var operations = FormRoot();
        operations.AddRange([
            new AddUiNodeOperation("outer-add", "e-surface", "e-section", "e-root", "section", 0),
            new SetUiPropertyOperation("outer-title", "e-surface", "e-section", "title", "Details"),
            new AddUiNodeOperation("inner-add", "e-surface", "e-inner", "e-section", "section", 0),
            new SetUiPropertyOperation("inner-title", "e-surface", "e-inner", "title", "Identity"),
            new AddUiNodeOperation("binding-add", "e-surface", "e-title-binding", "e-inner", "fieldBinding", 0),
            new SetUiPropertyOperation("binding-field", "e-surface", "e-title-binding", "fieldId", "e-title"),
        ]);
        return operations.ToArray();
    }

    private static NendoOperation[] TwoBindingForm()
    {
        var operations = FormRoot();
        operations.AddRange([
            new AddUiNodeOperation("section-add", "e-surface", "e-section", "e-root", "section", 0),
            new SetUiPropertyOperation("section-title", "e-surface", "e-section", "title", "Details"),
            new AddUiNodeOperation("title-add", "e-surface", "e-title-binding", "e-section", "fieldBinding", 0),
            new SetUiPropertyOperation("title-field", "e-surface", "e-title-binding", "fieldId", "e-title"),
            new AddUiNodeOperation("status-add", "e-surface", "e-status-binding", "e-section", "fieldBinding", 1),
            new SetUiPropertyOperation("status-field", "e-surface", "e-status-binding", "fieldId", "e-status"),
        ]);
        return operations.ToArray();
    }

    private static NendoSessionSnapshot MalformedSource(string scenario)
    {
        var fields = new NendoFieldSnapshot[]
        {
            new("e-title", "Title", NendoStorageKind.Text, true, "singleLine", []),
            new("e-status", "Status", NendoStorageKind.Text, true, "singleChoice", ["new", "done"]),
        };
        var nodes = new List<NendoUiNodeSnapshot>
        {
            Node("e-surface", "e-root", null, "recordForm", 0,
                ("definitionVersion", NendoSemanticVocabulary.ContractVersion), ("entityId", "e"), ("title", "Axiom")),
            Node("e-surface", "e-section", "e-root", "section", 0, ("title", "Details")),
            Node("e-surface", "e-title-binding", "e-section", "fieldBinding", 0, ("fieldId", "e-title")),
        };

        switch (scenario)
        {
            case "none":
                break;
            case "unknownKind":
                nodes.Add(Node("e-surface", "e-chart", "e-section", "chartSurface", 1, ("title", "Trend")));
                break;
            case "illegalParent":
                nodes.Add(Node("e-surface", "e-nested", "e-title-binding", "section", 0, ("title", "Inside a binding")));
                break;
            case "nonRootKind":
                nodes.Add(Node("e-surface", "e-loose", null, "section", 1, ("title", "Loose")));
                break;
            case "unknownProperty":
                nodes[1] = Node("e-surface", "e-section", "e-root", "section", 0, ("title", "Details"), ("cssClass", "danger"));
                break;
            case "missingRequired":
                nodes.Add(Node("e-surface", "e-untitled", "e-root", "section", 1));
                break;
            case "orphan":
                nodes.Add(Node("e-surface", "e-orphan", "e-missing", "section", 1, ("title", "Orphan")));
                break;
            case "crossSurface":
                nodes.Add(Node("other-surface", "e-elsewhere", "e-section", "section", 0, ("title", "Elsewhere")));
                break;
            case "cycle":
                nodes.Add(Node("e-surface", "e-cycle-a", "e-cycle-b", "section", 1, ("title", "A")));
                nodes.Add(Node("e-surface", "e-cycle-b", "e-cycle-a", "section", 2, ("title", "B")));
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario), scenario, "Unknown malformed scenario.");
        }

        var now = new DateTimeOffset(2026, 9, 9, 8, 0, 0, TimeSpan.Zero);
        return new NendoSessionSnapshot(
            "axioms.nendo",
            NendoSessionHealth.Normal,
            new NendoManifestSnapshot(
                NendoFormat.Identifier,
                NendoFormat.CurrentVersion,
                NendoFormat.ComposableSurfacesMinimumHostVersion,
                "application-test",
                "instance-test",
                now,
                now,
                4,
                6,
                10),
            [new NendoEntitySnapshot("e", "Axiom", fields)],
            [],
            nodes,
            new NendoStorageHealthSnapshot("DELETE", "FULL", 2_000, "ok", []));
    }

    private static NendoUiNodeSnapshot Node(
        string surfaceId,
        string nodeId,
        string? parentNodeId,
        string kind,
        int position,
        params (string Name, object Value)[] properties) => new(
            surfaceId,
            nodeId,
            parentNodeId,
            kind,
            position,
            properties.ToDictionary(
                property => property.Name,
                property => JsonSerializer.SerializeToElement(property.Value),
                StringComparer.Ordinal));
}
