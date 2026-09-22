using System.Text.Json;
using System.Text.Json.Serialization;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

internal sealed record ProtocolFixtureField(
    string FieldId,
    string DisplayName,
    string PhysicalColumnName,
    NendoStorageKind StorageKind,
    bool Required,
    string? Presentation,
    IReadOnlyList<string> Options);

internal sealed record ProtocolFixtureEntity(
    string EntityId,
    string DisplayName,
    string PhysicalTableName,
    IReadOnlyList<ProtocolFixtureField> Fields);

internal sealed record ProtocolFixtureSurface(
    string SurfaceId,
    string RootNodeId,
    string Title,
    IReadOnlyList<string> FieldIds);

internal sealed record ProtocolFixtureBoard(
    string SurfaceId,
    string RootNodeId,
    string Title,
    string GroupByFieldId,
    IReadOnlyList<string> CardFieldIds);

internal sealed record ProtocolFixtureCommand(
    string SurfaceId,
    string NodeId,
    string Label,
    string EffectKind,
    string FieldId,
    JsonElement Value);

internal sealed record ProtocolFixtureRecord(
    string RecordId,
    IReadOnlyDictionary<string, JsonElement> Values);

/// <summary>A gallery root: the S2 proof on a fixture, optional so older fixtures need none.</summary>
internal sealed record ProtocolFixtureGallery(
    string SurfaceId,
    string RootNodeId,
    string Title,
    string? TitleFieldId,
    string? AccentFieldId,
    IReadOnlyList<string> FieldIds);

/// <summary>A timeline root: the S3 proof on a fixture, optional so older fixtures need none.</summary>
internal sealed record ProtocolFixtureTimeline(
    string SurfaceId,
    string RootNodeId,
    string Title,
    string DateFieldId,
    string? EndDateFieldId,
    string? TitleFieldId,
    string? AccentFieldId,
    IReadOnlyList<string> FieldIds);

internal sealed record SemanticProtocolFixture(
    string Fixture,
    ProtocolFixtureEntity Entity,
    ProtocolFixtureSurface Form,
    ProtocolFixtureSurface List,
    ProtocolFixtureBoard Board,
    ProtocolFixtureCommand Command,
    ProtocolFixtureTimeline? Timeline = null,
    ProtocolFixtureGallery? Gallery = null)
{
    internal static SemanticProtocolFixture Load(string fixtureName) =>
        JsonSerializer.Deserialize<SemanticProtocolFixture>(
            File.ReadAllText(FixturePath(fixtureName, "expected-shape.json")),
            JsonOptions)
        ?? throw new InvalidOperationException($"Fixture {fixtureName} is empty.");

    internal IReadOnlyList<ProtocolFixtureRecord> LoadRecords() =>
        JsonSerializer.Deserialize<IReadOnlyList<ProtocolFixtureRecord>>(
            File.ReadAllText(FixturePath(Fixture, "records.json")),
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
        AddCommand(operations, proposalId);
        return new NendoChangeSet([
            new NendoMutation(
                "fixture.p3",
                $"{proposalId}-definition",
                "test",
                $"Create {Entity.DisplayName} application",
                operations),
        ]).Validate();
    }

    private void AddSurface(
        ICollection<NendoOperation> operations,
        string proposalId,
        ProtocolFixtureSurface surface,
        string kind,
        string role)
    {
        AddRoot(operations, proposalId, surface.SurfaceId, surface.RootNodeId, kind, surface.Title);
        AddBindings(operations, proposalId, surface.SurfaceId, surface.RootNodeId, role, surface.FieldIds);
    }

    private void AddBoard(ICollection<NendoOperation> operations, string proposalId)
    {
        AddRoot(operations, proposalId, Board.SurfaceId, Board.RootNodeId, "boardSurface", Board.Title);
        AddProperty(operations, proposalId, Board.SurfaceId, Board.RootNodeId, "groupByFieldId", Board.GroupByFieldId);
        AddBindings(operations, proposalId, Board.SurfaceId, Board.RootNodeId, "card", Board.CardFieldIds);
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
            var nodeId = $"node.p3.{role}.{position:D2}";
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

    private static void Add(ICollection<NendoOperation> operations, Func<int, NendoOperation> create) =>
        operations.Add(create(operations.Count));

    private static string OperationId(string proposalId, int ordinal) =>
        $"{proposalId}-operation-{ordinal:D3}";

    private static string FixturePath(string fixtureName, string fileName)
    {
        var repositoryRoot = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", ".."));
        var path = Path.Combine(repositoryRoot, "fixtures", fixtureName, fileName);
        return File.Exists(path)
            ? path
            : throw new FileNotFoundException($"Fixture file {fileName} was not found.", path);
    }

    private static JsonSerializerOptions JsonOptions { get; } = CreateJsonOptions();

    private static JsonSerializerOptions CreateJsonOptions()
    {
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
        options.Converters.Add(new JsonStringEnumConverter());
        return options;
    }
}
