using Nendo.Engine;

namespace Nendo.Engine.Tests;

internal static class IdeaGardenDefinition
{
    internal const string ProposalScope = "studio.p2.proposal";
    internal const string FormSurfaceId = "surface.idea.form";
    internal const string ListSurfaceId = "surface.idea.list";
    internal const string BoardSurfaceId = "surface.idea.board";
    internal const string CommandSurfaceId = "surface.idea.commands";
    internal const string FormRootId = "node.idea.form.root";
    internal const string ListRootId = "node.idea.list.root";
    internal const string BoardRootId = "node.idea.board.root";
    internal const string MoveToTryingCommandId = "command.idea.moveToTrying";
    internal const string MoveToTryingStepId = "node.idea.command.moveToTrying.status";
    private const int ContractVersion = NendoSemanticVocabulary.ContractVersion;

    internal static NendoChangeSet CreateInitialChangeSet(
        NendoSessionSnapshot snapshot,
        string proposalId)
    {
        // Said first: on a file this proposal already set up, the field check below refused the
        // Title it had created itself instead.
        if (snapshot.UiNodes.Count != 0)
        {
            throw new NendoPreconditionException(
                "semantic-definition-exists",
                "This file already contains semantic surfaces; use a focused surface proposal instead.");
        }
        var definition = new List<NendoOperation>();
        var entity = snapshot.Entities.SingleOrDefault(value =>
            value.EntityId == IdeaGarden.IdeaEntityId);
        if (entity is null)
        {
            definition.Add(new CreateEntityOperation(
                OperationId(proposalId, definition.Count),
                IdeaGarden.IdeaEntityId,
                "Idea",
                "idea"));
            definition.Add(new AddFieldOperation(
                OperationId(proposalId, definition.Count),
                IdeaGarden.IdeaEntityId,
                IdeaGarden.IdeaTitleFieldId,
                "Title",
                "title",
                NendoStorageKind.Text,
                required: true,
                presentation: "singleLine"));
        }
        else
        {
            ValidateExistingField(
                entity,
                IdeaGarden.IdeaTitleFieldId,
                "Title",
                NendoStorageKind.Text,
                required: true,
                presentation: null,
                []);
        }

        AddFieldIfMissing(
            entity,
            definition,
            proposalId,
            IdeaGarden.IdeaNotesFieldId,
            "Notes",
            "notes",
            NendoStorageKind.Text,
            "longText",
            []);
        AddFieldIfMissing(
            entity,
            definition,
            proposalId,
            IdeaGarden.IdeaStatusFieldId,
            "Status",
            "status",
            NendoStorageKind.Text,
            "singleChoice",
            IdeaGarden.IdeaStatusOptions);
        AddFieldIfMissing(
            entity,
            definition,
            proposalId,
            IdeaGarden.IdeaEnergyFieldId,
            "Energy",
            "energy",
            NendoStorageKind.Text,
            "singleChoice",
            IdeaGarden.IdeaEnergyOptions);
        AddFieldIfMissing(
            entity,
            definition,
            proposalId,
            IdeaGarden.IdeaCreatedDateFieldId,
            "Created date",
            "created_date",
            NendoStorageKind.Date,
            "date",
            []);
        AddFieldIfMissing(
            entity,
            definition,
            proposalId,
            IdeaGarden.IdeaNextActionFieldId,
            "Next action",
            "next_action",
            NendoStorageKind.Text,
            "singleLine",
            []);

        AddSurfaceDefinition(definition, proposalId);

        var mutations = new List<NendoMutation>
        {
            new(
                ProposalScope,
                $"{proposalId}-definition",
                "studio",
                "Create the Idea Garden structure and surfaces",
                definition.AsReadOnly()),
        };
        var backfill = snapshot.Records
            .Where(record => record.EntityId == IdeaGarden.IdeaEntityId &&
                             (!record.Values.TryGetValue(IdeaGarden.IdeaStatusFieldId, out var value) ||
                              value.ValueKind == System.Text.Json.JsonValueKind.Null))
            .OrderBy(record => record.RecordId, StringComparer.Ordinal)
            .Select((record, index) => (NendoOperation)new SetFieldOperation(
                OperationId(proposalId, definition.Count + index),
                IdeaGarden.IdeaEntityId,
                record.RecordId,
                IdeaGarden.IdeaStatusFieldId,
                record.RecordVersion,
                "Idea"))
            .ToArray();
        if (backfill.Length != 0)
        {
            mutations.Add(new NendoMutation(
                ProposalScope,
                $"{proposalId}-data",
                "studio",
                "Place existing Ideas in the Idea group",
                backfill));
        }
        return new NendoChangeSet(mutations.AsReadOnly()).Validate();
    }

    internal static NendoChangeSet RenameBoardChangeSet(string proposalId, string title) =>
        new NendoChangeSet([
            new NendoMutation(
                ProposalScope,
                $"{proposalId}-definition",
                "studio",
                $"Rename the Idea board to {title}",
                [new SetUiPropertyOperation(
                    OperationId(proposalId, 0),
                    BoardSurfaceId,
                    BoardRootId,
                    "title",
                    title)]),
        ]).Validate();

    private static void AddSurfaceDefinition(ICollection<NendoOperation> operations, string proposalId)
    {
        AddRoot(
            operations,
            proposalId,
            FormSurfaceId,
            FormRootId,
            "recordForm",
            "Idea form");
        AddBindings(
            operations,
            proposalId,
            FormSurfaceId,
            FormRootId,
            "form",
            [
                IdeaGarden.IdeaTitleFieldId,
                IdeaGarden.IdeaNotesFieldId,
                IdeaGarden.IdeaStatusFieldId,
                IdeaGarden.IdeaEnergyFieldId,
                IdeaGarden.IdeaCreatedDateFieldId,
                IdeaGarden.IdeaNextActionFieldId,
            ]);

        AddRoot(
            operations,
            proposalId,
            ListSurfaceId,
            ListRootId,
            "recordList",
            "All ideas");
        AddBindings(
            operations,
            proposalId,
            ListSurfaceId,
            ListRootId,
            "list",
            [
                IdeaGarden.IdeaTitleFieldId,
                IdeaGarden.IdeaStatusFieldId,
                IdeaGarden.IdeaEnergyFieldId,
                IdeaGarden.IdeaNextActionFieldId,
            ]);

        AddRoot(
            operations,
            proposalId,
            BoardSurfaceId,
            BoardRootId,
            "boardSurface",
            "Idea board");
        AddProperty(
            operations,
            proposalId,
            BoardSurfaceId,
            BoardRootId,
            "groupByFieldId",
            IdeaGarden.IdeaStatusFieldId);
        var cardFields = new[]
        {
            IdeaGarden.IdeaTitleFieldId,
            IdeaGarden.IdeaEnergyFieldId,
            IdeaGarden.IdeaNextActionFieldId,
        };
        AddBindings(
            operations,
            proposalId,
            BoardSurfaceId,
            BoardRootId,
            "card",
            cardFields);

        operations.Add(new AddUiNodeOperation(
            OperationId(proposalId, operations.Count),
            CommandSurfaceId,
            MoveToTryingCommandId,
            null,
            "recordCommand",
            0));
        AddProperty(operations, proposalId, CommandSurfaceId, MoveToTryingCommandId, "definitionVersion", ContractVersion);
        AddProperty(operations, proposalId, CommandSurfaceId, MoveToTryingCommandId, "entityId", IdeaGarden.IdeaEntityId);
        AddProperty(operations, proposalId, CommandSurfaceId, MoveToTryingCommandId, "label", "Move to Trying");
        operations.Add(new AddUiNodeOperation(
            OperationId(proposalId, operations.Count),
            CommandSurfaceId,
            MoveToTryingStepId,
            MoveToTryingCommandId,
            "commandStep",
            0));
        AddProperty(operations, proposalId, CommandSurfaceId, MoveToTryingStepId, "fieldId", IdeaGarden.IdeaStatusFieldId);
        AddProperty(operations, proposalId, CommandSurfaceId, MoveToTryingStepId, "valueKind", "literal");
        AddProperty(operations, proposalId, CommandSurfaceId, MoveToTryingStepId, "value", "Trying");
    }

    private static void AddRoot(
        ICollection<NendoOperation> operations,
        string proposalId,
        string surfaceId,
        string nodeId,
        string kind,
        string title)
    {
        operations.Add(new AddUiNodeOperation(
            OperationId(proposalId, operations.Count),
            surfaceId,
            nodeId,
            null,
            kind,
            0));
        AddProperty(operations, proposalId, surfaceId, nodeId, "definitionVersion", ContractVersion);
        AddProperty(operations, proposalId, surfaceId, nodeId, "entityId", IdeaGarden.IdeaEntityId);
        AddProperty(operations, proposalId, surfaceId, nodeId, "title", title);
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
            var shortId = fieldId["field.idea.".Length..];
            var nodeId = $"node.idea.{role}.{shortId}";
            operations.Add(new AddUiNodeOperation(
                OperationId(proposalId, operations.Count),
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
        object value) => operations.Add(new SetUiPropertyOperation(
            OperationId(proposalId, operations.Count),
            surfaceId,
            nodeId,
            propertyName,
            value));

    private static void AddFieldIfMissing(
        NendoEntitySnapshot? entity,
        ICollection<NendoOperation> operations,
        string proposalId,
        string fieldId,
        string displayName,
        string physicalName,
        NendoStorageKind storageKind,
        string presentation,
        IReadOnlyList<string> options)
    {
        if (entity?.Fields.SingleOrDefault(field => field.FieldId == fieldId) is { } existing)
        {
            ValidateExistingField(
                entity,
                fieldId,
                displayName,
                storageKind,
                required: false,
                presentation,
                options);
            return;
        }
        operations.Add(new AddFieldOperation(
            OperationId(proposalId, operations.Count),
            IdeaGarden.IdeaEntityId,
            fieldId,
            displayName,
            physicalName,
            storageKind,
            required: false,
            presentation,
            options));
    }

    private static void ValidateExistingField(
        NendoEntitySnapshot entity,
        string fieldId,
        string displayName,
        NendoStorageKind storageKind,
        bool required,
        string? presentation,
        IReadOnlyList<string> options)
    {
        var field = entity.Fields.SingleOrDefault(value => value.FieldId == fieldId)
            ?? throw new NendoPreconditionException("field-not-found", $"Required field {displayName} is missing.");
        // The Title this proposal creates is single-line; an older file's has no presentation.
        var acceptedPresentation = fieldId == IdeaGarden.IdeaTitleFieldId &&
                                   field.Presentation is null or "singleLine" && presentation is null;
        if (field.DisplayName != displayName || field.StorageKind != storageKind ||
            field.Required != required ||
            (!acceptedPresentation && field.Presentation != presentation) ||
            !field.Options.SequenceEqual(options, StringComparer.Ordinal))
        {
            throw new NendoPreconditionException(
                "idea-field-conflict",
                $"Existing field {displayName} does not match the Idea Garden contract.");
        }
    }

    private static string OperationId(string proposalId, int ordinal) =>
        NendoCanonical.DeterministicId("operation", ProposalScope, proposalId, ordinal);
}
