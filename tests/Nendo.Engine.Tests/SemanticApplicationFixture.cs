using System.Text.Json;
using System.Text.Json.Serialization;

namespace Nendo.Engine.Tests;

internal sealed record SemanticFixtureField(
    string FieldId,
    string DisplayName,
    string PhysicalColumnName,
    NendoStorageKind StorageKind,
    bool Required,
    string? Presentation,
    IReadOnlyList<string> Options);

internal sealed record SemanticFixtureEntity(
    string EntityId,
    string DisplayName,
    string PhysicalTableName,
    IReadOnlyList<SemanticFixtureField> Fields);

internal sealed record SemanticFixtureSurface(
    string SurfaceId,
    string RootNodeId,
    string Title,
    IReadOnlyList<string> FieldIds);

internal sealed record SemanticFixtureBoard(
    string SurfaceId,
    string RootNodeId,
    string Title,
    string GroupByFieldId,
    IReadOnlyList<string> CardFieldIds);

internal sealed record SemanticFixtureCommand(
    string SurfaceId,
    string NodeId,
    string Label,
    string EffectKind,
    string FieldId,
    JsonElement Value);

/// <summary>A gallery root: the S2 proof on a fixture, optional so older fixtures need none.</summary>
internal sealed record SemanticFixtureGallery(
    string SurfaceId,
    string RootNodeId,
    string Title,
    string? TitleFieldId,
    string? AccentFieldId,
    IReadOnlyList<string> FieldIds);

/// <summary>A timeline root: the S3 proof on a fixture, optional so older fixtures need none.</summary>
internal sealed record SemanticFixtureTimeline(
    string SurfaceId,
    string RootNodeId,
    string Title,
    string DateFieldId,
    string? EndDateFieldId,
    string? TitleFieldId,
    string? AccentFieldId,
    IReadOnlyList<string> FieldIds);

/// <summary>
/// A front page: the S4 proof on a fixture, optional so older fixtures need none.
/// It is the one root with no record type of its own, so each tile below it names
/// the one it reads — on this fixture that is the single entity, and the two-type
/// reading is proved on the register instead.
/// </summary>
internal sealed record SemanticFixtureOverview(
    string SurfaceId,
    string RootNodeId,
    string Title,
    string Description,
    string CountTitle,
    string RangeFieldId,
    string RangeTitle,
    string RecentTitle,
    int RecentLimit,
    string RecentOrderByFieldId,
    IReadOnlyList<string> RecentFieldIds);

internal sealed record SemanticApplicationFixture(
    string Fixture,
    string Purpose,
    SemanticFixtureEntity Entity,
    SemanticFixtureSurface Form,
    SemanticFixtureSurface List,
    SemanticFixtureBoard Board,
    SemanticFixtureCommand Command,
    SemanticFixtureTimeline? Timeline = null,
    SemanticFixtureGallery? Gallery = null,
    SemanticFixtureOverview? Overview = null)
{
    internal static SemanticApplicationFixture Load(string fixtureName, string? repositoryRoot = null)
    {
        var path = FixturePath(fixtureName, "expected-shape.json", repositoryRoot);
        return JsonSerializer.Deserialize<SemanticApplicationFixture>(
                   File.ReadAllText(path),
                   JsonOptions)
               ?? throw new InvalidOperationException($"Fixture {fixtureName} is empty.");
    }

    internal IReadOnlyList<SemanticFixtureRecord> LoadRecords(string? repositoryRoot = null) =>
        JsonSerializer.Deserialize<IReadOnlyList<SemanticFixtureRecord>>(
            File.ReadAllText(FixturePath(Fixture, "records.json", repositoryRoot)),
            JsonOptions)
        ?? throw new InvalidOperationException($"Fixture {Fixture} records are empty.");

    internal NendoChangeSet DefinitionChangeSet(string proposalId)
    {
        var operations = new List<NendoOperation>();
        Add(operations, ordinal => new CreateEntityOperation(
            OperationId(proposalId, ordinal),
            Entity.EntityId,
            Entity.DisplayName,
            Entity.PhysicalTableName));
        foreach (var field in Entity.Fields)
        {
            Add(operations, ordinal => new AddFieldOperation(
                OperationId(proposalId, ordinal),
                Entity.EntityId,
                field.FieldId,
                field.DisplayName,
                field.PhysicalColumnName,
                field.StorageKind,
                field.Required,
                field.Presentation,
                field.Options));
        }

        AddSurface(operations, proposalId, Form, "recordForm", "form");
        AddSurface(operations, proposalId, List, "recordList", "list");
        AddBoard(operations, proposalId);
        AddTimeline(operations, proposalId);
        AddGallery(operations, proposalId);
        AddOverview(operations, proposalId);
        AddCommand(operations, proposalId);

        return new NendoChangeSet([
            new NendoMutation(
                "fixture.semantic",
                $"{proposalId}-definition",
                "test",
                $"Create {Entity.DisplayName} application",
                operations.AsReadOnly()),
        ]).Validate();
    }

    private void AddSurface(
        ICollection<NendoOperation> operations,
        string proposalId,
        SemanticFixtureSurface surface,
        string kind,
        string role)
    {
        AddRoot(operations, proposalId, surface.SurfaceId, surface.RootNodeId, kind, surface.Title);
        AddBindings(operations, proposalId, surface.SurfaceId, surface.RootNodeId, role, surface.FieldIds);
    }

    private void AddBoard(ICollection<NendoOperation> operations, string proposalId)
    {
        AddRoot(
            operations,
            proposalId,
            Board.SurfaceId,
            Board.RootNodeId,
            "boardSurface",
            Board.Title);
        AddProperty(
            operations,
            proposalId,
            Board.SurfaceId,
            Board.RootNodeId,
            "groupByFieldId",
            Board.GroupByFieldId);
        AddBindings(
            operations,
            proposalId,
            Board.SurfaceId,
            Board.RootNodeId,
            "card",
            Board.CardFieldIds);
    }

    private void AddTimeline(ICollection<NendoOperation> operations, string proposalId)
    {
        if (Timeline is null) return;
        AddRoot(operations, proposalId, Timeline.SurfaceId, Timeline.RootNodeId, "timelineSurface", Timeline.Title);
        AddProperty(operations, proposalId, Timeline.SurfaceId, Timeline.RootNodeId, "dateFieldId", Timeline.DateFieldId);
        if (Timeline.EndDateFieldId is not null)
            AddProperty(operations, proposalId, Timeline.SurfaceId, Timeline.RootNodeId, "endDateFieldId", Timeline.EndDateFieldId);
        if (Timeline.TitleFieldId is not null)
            AddProperty(operations, proposalId, Timeline.SurfaceId, Timeline.RootNodeId, "titleFieldId", Timeline.TitleFieldId);
        if (Timeline.AccentFieldId is not null)
            AddProperty(operations, proposalId, Timeline.SurfaceId, Timeline.RootNodeId, "accentFieldId", Timeline.AccentFieldId);
        AddBindings(operations, proposalId, Timeline.SurfaceId, Timeline.RootNodeId, "timeline", Timeline.FieldIds);
    }

    private void AddGallery(ICollection<NendoOperation> operations, string proposalId)
    {
        if (Gallery is null) return;
        AddRoot(operations, proposalId, Gallery.SurfaceId, Gallery.RootNodeId, "gallerySurface", Gallery.Title);
        if (Gallery.TitleFieldId is not null)
            AddProperty(operations, proposalId, Gallery.SurfaceId, Gallery.RootNodeId, "titleFieldId", Gallery.TitleFieldId);
        if (Gallery.AccentFieldId is not null)
            AddProperty(operations, proposalId, Gallery.SurfaceId, Gallery.RootNodeId, "accentFieldId", Gallery.AccentFieldId);
        AddBindings(operations, proposalId, Gallery.SurfaceId, Gallery.RootNodeId, "gallery", Gallery.FieldIds);
    }

    /// <summary>
    /// The front page. It declares no entityId of its own — that is what makes it
    /// the file's rather than a record type's — and every tile under it names the
    /// record type it reads instead.
    /// </summary>
    private void AddOverview(ICollection<NendoOperation> operations, string proposalId)
    {
        if (Overview is null) return;
        var surfaceId = Overview.SurfaceId;
        var rootNodeId = Overview.RootNodeId;
        Add(operations, ordinal => new AddUiNodeOperation(
            OperationId(proposalId, ordinal), surfaceId, rootNodeId, null, "overviewSurface", 0));
        AddProperty(operations, proposalId, surfaceId, rootNodeId, "definitionVersion", NendoSemanticVocabulary.ContractVersion);
        AddProperty(operations, proposalId, surfaceId, rootNodeId, "title", Overview.Title);
        AddProperty(operations, proposalId, surfaceId, rootNodeId, "description", Overview.Description);

        var countNodeId = $"{rootNodeId}.count";
        Add(operations, ordinal => new AddUiNodeOperation(
            OperationId(proposalId, ordinal), surfaceId, countNodeId, rootNodeId, "summaryTile", 0));
        AddProperty(operations, proposalId, surfaceId, countNodeId, "entityId", Entity.EntityId);
        AddProperty(operations, proposalId, surfaceId, countNodeId, "aggregate", "count");
        AddProperty(operations, proposalId, surfaceId, countNodeId, "title", Overview.CountTitle);

        var rangeNodeId = $"{rootNodeId}.range";
        Add(operations, ordinal => new AddUiNodeOperation(
            OperationId(proposalId, ordinal), surfaceId, rangeNodeId, rootNodeId, "rangeTile", 1));
        AddProperty(operations, proposalId, surfaceId, rangeNodeId, "entityId", Entity.EntityId);
        AddProperty(operations, proposalId, surfaceId, rangeNodeId, "fieldId", Overview.RangeFieldId);
        AddProperty(operations, proposalId, surfaceId, rangeNodeId, "title", Overview.RangeTitle);

        var recentNodeId = $"{rootNodeId}.recent";
        Add(operations, ordinal => new AddUiNodeOperation(
            OperationId(proposalId, ordinal), surfaceId, recentNodeId, rootNodeId, "recentList", 2));
        AddProperty(operations, proposalId, surfaceId, recentNodeId, "entityId", Entity.EntityId);
        AddProperty(operations, proposalId, surfaceId, recentNodeId, "title", Overview.RecentTitle);
        AddProperty(operations, proposalId, surfaceId, recentNodeId, "limit", Overview.RecentLimit);
        AddProperty(operations, proposalId, surfaceId, recentNodeId, "orderByFieldId", Overview.RecentOrderByFieldId);
        AddProperty(operations, proposalId, surfaceId, recentNodeId, "orderDirection", "descending");
        AddBindings(operations, proposalId, surfaceId, recentNodeId, "overview-recent", Overview.RecentFieldIds);
    }

    private void AddCommand(ICollection<NendoOperation> operations, string proposalId)
    {
        Add(operations, ordinal => new AddUiNodeOperation(
            OperationId(proposalId, ordinal),
            Command.SurfaceId,
            Command.NodeId,
            null,
            "recordCommand",
            0));
        AddProperty(operations, proposalId, Command.SurfaceId, Command.NodeId, "definitionVersion", NendoSemanticVocabulary.ContractVersion);
        AddProperty(operations, proposalId, Command.SurfaceId, Command.NodeId, "entityId", Entity.EntityId);
        AddProperty(operations, proposalId, Command.SurfaceId, Command.NodeId, "label", Command.Label);
        // A command owns ordered steps rather than one inline effect.
        var stepNodeId = $"{Command.NodeId}.step";
        Add(operations, ordinal => new AddUiNodeOperation(
            OperationId(proposalId, ordinal),
            Command.SurfaceId,
            stepNodeId,
            Command.NodeId,
            "commandStep",
            0));
        AddProperty(operations, proposalId, Command.SurfaceId, stepNodeId, "fieldId", Command.FieldId);
        AddProperty(operations, proposalId, Command.SurfaceId, stepNodeId, "valueKind", "literal");
        AddProperty(operations, proposalId, Command.SurfaceId, stepNodeId, "value", Command.Value);
    }

    private void AddRoot(
        ICollection<NendoOperation> operations,
        string proposalId,
        string surfaceId,
        string rootNodeId,
        string kind,
        string title)
    {
        Add(operations, ordinal => new AddUiNodeOperation(
            OperationId(proposalId, ordinal),
            surfaceId,
            rootNodeId,
            null,
            kind,
            0));
        AddProperty(operations, proposalId, surfaceId, rootNodeId, "definitionVersion", NendoSemanticVocabulary.ContractVersion);
        AddProperty(operations, proposalId, surfaceId, rootNodeId, "entityId", Entity.EntityId);
        AddProperty(operations, proposalId, surfaceId, rootNodeId, "title", title);
    }

    private static void AddBindings(
        ICollection<NendoOperation> operations,
        string proposalId,
        string surfaceId,
        string rootNodeId,
        string role,
        IReadOnlyList<string> fieldIds)
    {
        for (var position = 0; position < fieldIds.Count; position++)
        {
            var fieldId = fieldIds[position];
            var nodeId = $"node.fixture.{role}.{position:D2}";
            Add(operations, ordinal => new AddUiNodeOperation(
                OperationId(proposalId, ordinal),
                surfaceId,
                nodeId,
                rootNodeId,
                "fieldBinding",
                position));
            AddProperty(operations, proposalId, surfaceId, nodeId, "fieldId", fieldId);
        }
    }

    private static void AddProperty(
        ICollection<NendoOperation> operations,
        string proposalId,
        string surfaceId,
        string nodeId,
        string propertyName,
        object value) => Add(operations, ordinal => new SetUiPropertyOperation(
            OperationId(proposalId, ordinal),
            surfaceId,
            nodeId,
            propertyName,
            value));

    private static void Add(
        ICollection<NendoOperation> operations,
        Func<int, NendoOperation> create) => operations.Add(create(operations.Count));

    private static string OperationId(string proposalId, int ordinal) =>
        $"{proposalId}-operation-{ordinal:D3}";

    private static string FixturePath(string fixtureName, string fileName, string? repositoryRoot)
    {
        repositoryRoot ??= Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        var path = Path.Combine(repositoryRoot, "fixtures", fixtureName, fileName);
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"Fixture file {fileName} was not found.", path);
        }
        return path;
    }

    private static JsonSerializerOptions JsonOptions { get; } = CreateJsonOptions();

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        };
        options.Converters.Add(new JsonStringEnumConverter());
        return options;
    }
}

internal sealed record SemanticFixtureRecord(
    string RecordId,
    IReadOnlyDictionary<string, JsonElement> Values)
{
    internal IReadOnlyDictionary<string, object?> ToValues() => Values.ToDictionary(
        pair => pair.Key,
        pair => (object?)pair.Value.Clone(),
        StringComparer.Ordinal);
}
