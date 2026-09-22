using System.Text.Json;

namespace Nendo.LocalMcp.Tests;

internal static class ReadingQueueAuthoringFixture
{
    internal const string EntityId = "entity.readingItem";
    internal const string TitleFieldId = "field.readingItem.title";
    internal const string AuthorFieldId = "field.readingItem.author";
    internal const string StateFieldId = "field.readingItem.state";
    internal const string AddedDateFieldId = "field.readingItem.addedDate";
    internal const string CommandId = "command.readingItem.start";

    internal static IReadOnlyList<NendoAgentOperationInput> Operations()
    {
        var operations = new List<NendoAgentOperationInput>();
        operations.Add(Operation("schema.createEntity", new
        {
            entityId = EntityId,
            displayName = "Reading item",
        }));
        AddField(operations, TitleFieldId, "Title", "Text", true, "singleLine", []);
        AddField(operations, AuthorFieldId, "Author", "Text", false, "singleLine", []);
        AddField(
            operations,
            StateFieldId,
            "State",
            "Text",
            true,
            "singleChoice",
            ["Queued", "Reading", "Done"]);
        AddField(operations, AddedDateFieldId, "Added date", "Date", false, "date", []);

        AddSurface(
            operations,
            "surface.readingItem.form",
            "node.readingItem.form.root",
            "recordForm",
            "Reading item",
            "form",
            [TitleFieldId, AuthorFieldId, StateFieldId, AddedDateFieldId]);
        AddSurface(
            operations,
            "surface.readingItem.list",
            "node.readingItem.list.root",
            "recordList",
            "Reading queue",
            "list",
            [TitleFieldId, AuthorFieldId, StateFieldId]);
        AddBoard(operations);
        AddCommand(operations);
        return operations;
    }

    private static void AddField(
        ICollection<NendoAgentOperationInput> operations,
        string fieldId,
        string displayName,
        string storageKind,
        bool required,
        string presentation,
        string[] options) => operations.Add(Operation("schema.addField", new
        {
            entityId = EntityId,
            fieldId,
            displayName,
            storageKind,
            required,
            presentation,
            options,
        }));

    private static void AddSurface(
        ICollection<NendoAgentOperationInput> operations,
        string surfaceId,
        string rootNodeId,
        string kind,
        string title,
        string role,
        IReadOnlyList<string> fieldIds)
    {
        AddRoot(operations, surfaceId, rootNodeId, kind, title);
        for (var index = 0; index < fieldIds.Count; index++)
        {
            var nodeId = $"node.readingItem.{role}.{index:D2}";
            operations.Add(Operation("ui.addNode", new
            {
                surfaceId,
                nodeId,
                parentNodeId = rootNodeId,
                kind = "fieldBinding",
                position = index,
            }));
            AddProperty(operations, surfaceId, nodeId, "fieldId", fieldIds[index]);
        }
    }

    private static void AddBoard(ICollection<NendoAgentOperationInput> operations)
    {
        const string surfaceId = "surface.readingItem.board";
        const string rootNodeId = "node.readingItem.board.root";
        AddRoot(operations, surfaceId, rootNodeId, "boardSurface", "Reading flow");
        AddProperty(operations, surfaceId, rootNodeId, "groupByFieldId", StateFieldId);
        foreach (var (fieldId, index) in new[] { TitleFieldId, AuthorFieldId }.Select((value, index) => (value, index)))
        {
            var nodeId = $"node.readingItem.card.{index:D2}";
            operations.Add(Operation("ui.addNode", new
            {
                surfaceId,
                nodeId,
                parentNodeId = rootNodeId,
                kind = "fieldBinding",
                position = index,
            }));
            AddProperty(operations, surfaceId, nodeId, "fieldId", fieldId);
        }
    }

    private static void AddCommand(ICollection<NendoAgentOperationInput> operations)
    {
        const string surfaceId = "surface.readingItem.commands";
        operations.Add(Operation("ui.addNode", new
        {
            surfaceId,
            nodeId = CommandId,
            parentNodeId = (string?)null,
            kind = "recordCommand",
            position = 0,
        }));
        AddProperty(operations, surfaceId, CommandId, "definitionVersion", 3);
        AddProperty(operations, surfaceId, CommandId, "entityId", EntityId);
        AddProperty(operations, surfaceId, CommandId, "label", "Start reading");
        const string stepId = "node.readingItem.command.step";
        operations.Add(Operation("ui.addNode", new
        {
            surfaceId,
            nodeId = stepId,
            parentNodeId = CommandId,
            kind = "commandStep",
            position = 0,
        }));
        AddProperty(operations, surfaceId, stepId, "fieldId", StateFieldId);
        AddProperty(operations, surfaceId, stepId, "valueKind", "literal");
        AddProperty(operations, surfaceId, stepId, "value", "Reading");
    }

    private static void AddRoot(
        ICollection<NendoAgentOperationInput> operations,
        string surfaceId,
        string rootNodeId,
        string kind,
        string title)
    {
        operations.Add(Operation("ui.addNode", new
        {
            surfaceId,
            nodeId = rootNodeId,
            parentNodeId = (string?)null,
            kind,
            position = 0,
        }));
        AddProperty(operations, surfaceId, rootNodeId, "definitionVersion", 3);
        AddProperty(operations, surfaceId, rootNodeId, "entityId", EntityId);
        AddProperty(operations, surfaceId, rootNodeId, "title", title);
    }

    private static void AddProperty(
        ICollection<NendoAgentOperationInput> operations,
        string surfaceId,
        string nodeId,
        string propertyName,
        object? value) => operations.Add(Operation("ui.setProperty", new
        {
            surfaceId,
            nodeId,
            propertyName,
            value,
        }));

    private static NendoAgentOperationInput Operation(string type, object payload) =>
        new(type, JsonSerializer.SerializeToElement(payload, NendoMcpJson.Options));
}
