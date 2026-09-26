using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    private async Task<OperationEvidence> ExecuteOperationMetadataOrDataAsync(
        NendoOperation operation,
        IReadOnlySet<string> newEntityIds,
        SqliteTransaction transaction,
        CancellationToken cancellationToken) => operation switch
        {
            SetBehaviourDefinitionOperation behaviour => await ExecuteSetBehaviourDefinitionAsync(behaviour, transaction, cancellationToken),
            RemoveBehaviourDefinitionOperation behaviour => await ExecuteRemoveBehaviourDefinitionAsync(behaviour, transaction, cancellationToken),
            DeleteRecordOperation delete => await ExecuteDeleteRecordAsync(delete, transaction, cancellationToken),
            SetChoiceMetadataOperation choice => await ExecuteSetChoiceMetadataAsync(choice, transaction, cancellationToken),
            SetRetiredOperation retired => await ExecuteSetRetiredAsync(retired, transaction, cancellationToken),
            SetFieldRequiredOperation required => await ExecuteSetFieldRequiredAsync(required, transaction, cancellationToken),
            BackfillRetiredFieldOperation backfill => await ExecuteBackfillRetiredFieldAsync(backfill, transaction, cancellationToken),
            RestoreDeletedRecordOperation restore => await ExecuteRestoreDeletedRecordAsync(restore, transaction, cancellationToken),
            ConfigureReferenceOperation reference => await ExecuteConfigureReferenceAsync(reference, transaction, cancellationToken),
            ConvertLegacyReferenceOperation conversion => await ExecuteConvertLegacyReferenceAsync(conversion, transaction, cancellationToken),
            RenameEntityOperation rename => await ExecuteRenameAsync(rename, rename.EntityId, null, rename.DisplayName, rename.ExpectedDefinitionRevision, transaction, cancellationToken),
            RenameFieldOperation rename => await ExecuteRenameAsync(rename, rename.EntityId, rename.FieldId, rename.DisplayName, rename.ExpectedDefinitionRevision, transaction, cancellationToken),
            CreateEntityOperation createEntity => await ExecuteCreateEntityMetadataAsync(
                createEntity,
                transaction,
                cancellationToken),
            AddFieldOperation addField => await ExecuteAddFieldMetadataAsync(
                addField,
                newEntityIds,
                transaction,
                cancellationToken),
            CreateRecordOperation createRecord => await ExecuteCreateRecordAsync(
                createRecord,
                transaction,
                cancellationToken),
            SetFieldOperation setField => await ExecuteSetFieldAsync(
                setField,
                transaction,
                cancellationToken),
            AddUiNodeOperation addUiNode => await ExecuteAddUiNodeAsync(
                addUiNode,
                transaction,
                cancellationToken),
            SetUiPropertyOperation setUiProperty => await ExecuteSetUiPropertyAsync(
                setUiProperty,
                transaction,
                cancellationToken),
            MoveUiNodeOperation moveUiNode => await ExecuteMoveUiNodeAsync(
                moveUiNode,
                transaction,
                cancellationToken),
            RemoveUiNodeOperation removeUiNode => await ExecuteRemoveUiNodeAsync(
                removeUiNode,
                transaction,
                cancellationToken),
            SetApplicationPurposeOperation setPurpose => await ExecuteSetApplicationPurposeAsync(
                setPurpose,
                transaction,
                cancellationToken),
            SetExtensionPackageOperation setPackage => await ExecuteSetExtensionPackageAsync(setPackage, transaction, cancellationToken),
            PutExtensionFileOperation putFile => await ExecutePutExtensionFileAsync(putFile, transaction, cancellationToken),
            RemoveExtensionFileOperation removeFile => await ExecuteRemoveExtensionFileAsync(removeFile, transaction, cancellationToken),
            RemoveExtensionPackageOperation removePackage => await ExecuteRemoveExtensionPackageAsync(removePackage, transaction, cancellationToken),
            SetExtensionStateOperation setState => await ExecuteSetExtensionStateAsync(setState, transaction, cancellationToken),
            _ => throw new NendoValidationException(
                $"Operation type {operation.OperationType} is not supported by format version 1."),
        };

    private async Task<OperationEvidence> ExecuteCreateEntityMetadataAsync(
        CreateEntityOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        ValidatePhysicalIdentifier(operation.PhysicalTableName, "table");
        await RequireUniqueDisplayNameAsync(operation.DisplayName, null, operation.EntityId, transaction, cancellationToken);
        if (await EntityExistsAsync(operation.EntityId, transaction, cancellationToken))
        {
            throw new NendoPreconditionException(
                "entity-exists",
                $"Entity {operation.EntityId} already exists.");
        }

        const string sql = """
            INSERT INTO __nendo_entity (entity_id, display_name, physical_table_name)
            VALUES (@entityId, @displayName, @physicalTableName);
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@entityId", operation.EntityId);
        command.Parameters.AddWithValue("@displayName", operation.DisplayName);
        command.Parameters.AddWithValue("@physicalTableName", operation.PhysicalTableName);
        try
        {
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode == 19)
        {
            throw new NendoValidationException(
                "The requested entity identity or physical table name conflicts with existing schema.");
        }

        return new OperationEvidence(operation, Evidence(new { created = true }));
    }

    private async Task<OperationEvidence> ExecuteAddFieldMetadataAsync(
        AddFieldOperation operation,
        IReadOnlySet<string> newEntityIds,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        ValidatePhysicalIdentifier(operation.PhysicalColumnName, "column");
        if (!newEntityIds.Contains(operation.EntityId)) RequireActive(await GetEntityMappingAsync(operation.EntityId, transaction, cancellationToken));
        await RequireUniqueDisplayNameAsync(operation.DisplayName, operation.EntityId, operation.FieldId, transaction, cancellationToken);
        if (!newEntityIds.Contains(operation.EntityId) && operation.Required)
        {
            // A mutation is the materialization boundary for the definition lane:
            // an entity exists physically from the end of the mutation that created
            // it, so a later mutation adding a required column would leave any row
            // written in between with no value. Name the field and both remedies —
            // the old message named neither, and with thirty-eight fields across
            // five record types there was nothing to guide the caller to the fix.
            throw new NendoPreconditionException(
                "required-field-needs-migration",
                $"Field {operation.FieldId} cannot be added to record type {operation.EntityId} as required, because " +
                $"{operation.EntityId} already exists in the file. Either move this schema.addField into the same " +
                "mutation as the schema.createEntity for that record type, or add the field with required false here " +
                "and require it with schema.setFieldRequired in a later mutation of the same change set.");
        }
        if (!await EntityExistsAsync(operation.EntityId, transaction, cancellationToken))
        {
            throw new NendoPreconditionException(
                "entity-not-found",
                $"Entity {operation.EntityId} does not exist.");
        }

        const string sql = """
            INSERT INTO __nendo_field (
                field_id, entity_id, display_name, physical_column_name, storage_kind, required,
                presentation, options_json)
            VALUES (@fieldId, @entityId, @displayName, @physicalColumnName, @storageKind, @required,
                @presentation, @optionsJson);
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@fieldId", operation.FieldId);
        command.Parameters.AddWithValue("@entityId", operation.EntityId);
        command.Parameters.AddWithValue("@displayName", operation.DisplayName);
        command.Parameters.AddWithValue("@physicalColumnName", operation.PhysicalColumnName);
        command.Parameters.AddWithValue("@storageKind", operation.StorageKind.ToString());
        command.Parameters.AddWithValue("@required", operation.Required ? 1 : 0);
        command.Parameters.AddWithValue("@presentation", (object?)operation.Presentation ?? DBNull.Value);
        command.Parameters.AddWithValue("@optionsJson", JsonSerializer.Serialize(operation.Options));
        try
        {
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode == 19)
        {
            throw new NendoValidationException(
                "The requested field identity or physical column name conflicts with existing schema.");
        }

        // A rating's scale is the last rung of the protected layout ladder, so the first
        // rated field creates the whole prefix, as a first tone and a first behaviour
        // definition do. A file that rates nothing keeps the layout it had.
        if (operation.Presentation == "rating") await WriteRatingScaleAsync(operation, transaction, cancellationToken);

        return new OperationEvidence(operation, Evidence(new { created = true }))
        {
            RequiredHostVersion = operation.Presentation == "rating"
                ? NendoFormat.GalleryAndRatingMinimumHostVersion
                : operation.StorageKind == NendoStorageKind.Decimal
                    ? NendoFormat.ScalarMinimumHostVersion : NendoFormat.MinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteAddUiNodeAsync(
        AddUiNodeOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        ValidateUiNodeKind(operation.Kind);
        if (operation.ParentNodeId is not null)
        {
            await RequireUiNodeAsync(operation.SurfaceId, operation.ParentNodeId, transaction, cancellationToken);
        }

        const string sql = """
            INSERT INTO __nendo_ui_node (node_id, surface_id, parent_node_id, kind, position)
            VALUES (@nodeId, @surfaceId, @parentNodeId, @kind, @position);
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@nodeId", operation.NodeId);
        command.Parameters.AddWithValue("@surfaceId", operation.SurfaceId);
        command.Parameters.AddWithValue("@parentNodeId", (object?)operation.ParentNodeId ?? DBNull.Value);
        command.Parameters.AddWithValue("@kind", operation.Kind);
        command.Parameters.AddWithValue("@position", operation.Position);
        try
        {
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode == 19)
        {
            throw new NendoValidationException(
                "The requested UI node identity or parent conflicts with the semantic definition.");
        }
        return new OperationEvidence(operation, Evidence(new { created = true }));
    }

    private async Task<OperationEvidence> ExecuteSetUiPropertyAsync(
        SetUiPropertyOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        await RequireUiNodeAsync(operation.SurfaceId, operation.NodeId, transaction, cancellationToken);
        const string selectSql = """
            SELECT value_json
            FROM __nendo_ui_property
            WHERE node_id = @nodeId AND property_name = @propertyName;
            """;
        string? previousJson = null;
        await using (var select = Command(selectSql, transaction))
        {
            select.Parameters.AddWithValue("@nodeId", operation.NodeId);
            select.Parameters.AddWithValue("@propertyName", operation.PropertyName);
            // ExecuteScalarAsync returns null when the property has no prior row, and
            // Convert.ToString turns that (and DBNull) into String.Empty, never null —
            // so the retained evidence claimed a prior value existed for a property the
            // node did not carry, and undoing such a revision fed "" to JsonDocument.Parse.
            var scalar = await select.ExecuteScalarAsync(cancellationToken);
            previousJson = scalar is null or DBNull
                ? null
                : Convert.ToString(scalar, CultureInfo.InvariantCulture);
        }

        const string upsertSql = """
            INSERT INTO __nendo_ui_property (node_id, property_name, value_json)
            VALUES (@nodeId, @propertyName, @valueJson)
            ON CONFLICT(node_id, property_name) DO UPDATE SET value_json = excluded.value_json;
            """;
        await using (var upsert = Command(upsertSql, transaction))
        {
            upsert.Parameters.AddWithValue("@nodeId", operation.NodeId);
            upsert.Parameters.AddWithValue("@propertyName", operation.PropertyName);
            upsert.Parameters.AddWithValue("@valueJson", operation.Value.GetRawText());
            await upsert.ExecuteNonQueryAsync(cancellationToken);
        }

        return new OperationEvidence(
            operation,
            Evidence(new
            {
                previousValuePresent = previousJson is not null,
                previousValueJson = previousJson,
            })) { RequiredHostVersion = RequiredHostVersionFor(operation) };
    }

    // A declared contract version pins the minimum host that may open the file.
    private static string RequiredHostVersionFor(SetUiPropertyOperation operation)
    {
        if (operation.PropertyName != "definitionVersion" ||
            operation.Value.ValueKind != JsonValueKind.Number ||
            !operation.Value.TryGetInt32(out var version))
            return NendoFormat.SemanticMinimumHostVersion;
        return version switch
        {
            NendoSemanticVocabulary.ContractVersion => NendoFormat.ComposableSurfacesMinimumHostVersion,
            _ => NendoFormat.SemanticMinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteMoveUiNodeAsync(
        MoveUiNodeOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var current = await RequireUiNodeAsync(operation.SurfaceId, operation.NodeId, transaction, cancellationToken);
        if (operation.ParentNodeId is not null)
        {
            if (operation.ParentNodeId == operation.NodeId)
            {
                throw new NendoValidationException("A UI node cannot be its own parent.");
            }
            await RequireUiNodeAsync(operation.SurfaceId, operation.ParentNodeId, transaction, cancellationToken);
            if (await IsUiDescendantAsync(
                    operation.SurfaceId,
                    operation.NodeId,
                    operation.ParentNodeId,
                    transaction,
                    cancellationToken))
            {
                throw new NendoValidationException("Moving the UI node would create a parent cycle.");
            }
        }

        const string sql = """
            UPDATE __nendo_ui_node
            SET parent_node_id = @parentNodeId, position = @position
            WHERE node_id = @nodeId AND surface_id = @surfaceId;
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@parentNodeId", (object?)operation.ParentNodeId ?? DBNull.Value);
        command.Parameters.AddWithValue("@position", operation.Position);
        command.Parameters.AddWithValue("@nodeId", operation.NodeId);
        command.Parameters.AddWithValue("@surfaceId", operation.SurfaceId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return new OperationEvidence(
            operation,
            Evidence(new { previousParentNodeId = current.ParentNodeId, previousPosition = current.Position }));
    }

    private async Task<OperationEvidence> ExecuteRemoveUiNodeAsync(
        RemoveUiNodeOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        await RequireUiNodeAsync(operation.SurfaceId, operation.NodeId, transaction, cancellationToken);
        var retainedSubtree = await ReadUiSubtreeForEvidenceAsync(
            operation.SurfaceId,
            operation.NodeId,
            transaction,
            cancellationToken);
        const string sql = "DELETE FROM __nendo_ui_node WHERE node_id = @nodeId AND surface_id = @surfaceId;";
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@nodeId", operation.NodeId);
        command.Parameters.AddWithValue("@surfaceId", operation.SurfaceId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return new OperationEvidence(operation, retainedSubtree);
    }

    private async Task<OperationEvidence> ExecuteCreateRecordAsync(
        CreateRecordOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken,
        bool restoring = false)
    {
        if (!restoring && await IsReservedRecordIdAsync(operation.EntityId, operation.RecordId, transaction, cancellationToken))
            throw new NendoPreconditionException("record-id-reserved", "This record ID is retained in deletion history and cannot be reused.");
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, cancellationToken);
        var fieldsById = entity.Fields.ToDictionary(field => field.FieldId, StringComparer.Ordinal);
        RequireActive(entity);
        // A restore replays the retained values of every field the record had, retired
        // ones included, so it must not re-run the per-field retirement check that a fresh
        // create does. The deletion contract retains stored data whether or not a field is
        // later retired; refusing here made a declared-reversible delete unreversible for
        // the whole type. A fresh create still refuses a value for a retired field.
        if (!restoring)
            foreach (var field in entity.Fields.Where(field => operation.Values.ContainsKey(field.FieldId))) RequireActive(entity, field);
        if (operation.ExpectedTargetVersions.Keys.Any(id => !operation.Values.ContainsKey(id)))
            throw new NendoValidationException("Target versions must identify supplied reference fields.");
        foreach (var pair in operation.Values)
            if (fieldsById.TryGetValue(pair.Key, out var referenceField))
            {
                ValidateChoiceAssignment(referenceField, pair.Value);
                await ValidateReferenceValueAsync(referenceField, pair.Value,
                    operation.ExpectedTargetVersions.TryGetValue(pair.Key, out var targetVersion) ? targetVersion : null,
                    transaction, cancellationToken);
            }
        var unknownField = operation.Values.Keys.FirstOrDefault(key => !fieldsById.ContainsKey(key));
        if (unknownField is not null)
        {
            throw (NendoException?)await CalculatedFieldAsync(entity, unknownField, transaction, cancellationToken)
                ?? new NendoValidationException($"Field {unknownField} is not part of entity {operation.EntityId}.");
        }
        var missingRequired = entity.Fields.FirstOrDefault(field =>
            field.Required && !field.Retired &&
            (!operation.Values.TryGetValue(field.FieldId, out var value) || value.ValueKind == JsonValueKind.Null));
        if (missingRequired is not null)
        {
            throw new NendoValidationException($"Required field {missingRequired.FieldId} needs a value.");
        }

        var columns = new List<string> { Quote("__nendo_record_id"), Quote("__nendo_record_version") };
        var parameterNames = new List<string> { "@recordId", "@recordVersion" };
        await using var command = Command(string.Empty, transaction);
        command.Parameters.AddWithValue("@recordId", operation.RecordId);
        command.Parameters.AddWithValue("@recordVersion", 1L);
        for (var index = 0; index < entity.Fields.Count; index++)
        {
            var field = entity.Fields[index];
            var parameterName = $"@value{index.ToString(CultureInfo.InvariantCulture)}";
            columns.Add(Quote(field.PhysicalColumnName));
            parameterNames.Add(parameterName);
            var value = operation.Values.TryGetValue(field.FieldId, out var supplied)
                ? ConvertValue(field, supplied)
                : DBNull.Value;
            command.Parameters.AddWithValue(parameterName, value);
        }
        command.CommandText = $"INSERT INTO {Quote(entity.PhysicalTableName)} ({string.Join(", ", columns)}) VALUES ({string.Join(", ", parameterNames)});";
        try
        {
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode == 19)
        {
            throw new NendoPreconditionException(
                "record-exists-or-invalid",
                $"Record {operation.RecordId} already exists or violates the entity constraints.");
        }

        return new OperationEvidence(operation, Evidence(new { createdVersion = 1 }))
        {
            RequiredHostVersion = entity.Fields.Any(field => field.StorageKind == NendoStorageKind.Decimal)
                ? NendoFormat.ScalarMinimumHostVersion : NendoFormat.MinimumHostVersion,
        };
    }

    /// <summary>
    /// A field ID that is not a stored field may be a calculated one. Only the failure
    /// path reads the definitions, so a write that names a real column costs nothing.
    /// </summary>
    private async Task<NendoPreconditionException?> CalculatedFieldAsync(
        EntityMapping entity,
        string fieldId,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        var derived = await ReadDerivedFieldsAsync(transaction, cancellationToken);
        return derived.TryGetValue(entity.EntityId, out var calculated) &&
            calculated.FirstOrDefault(field => string.Equals(field.FieldId, fieldId, StringComparison.Ordinal)) is { } calculation
                ? NendoCalculatedFieldRefusal.For(entity.EntityId, fieldId, calculation.CalculationId)
                : null;
    }

    private async Task<OperationEvidence> ExecuteSetFieldAsync(
        SetFieldOperation operation,
        SqliteTransaction transaction,
        CancellationToken cancellationToken,
        bool allowRetiredField = false)
    {
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, cancellationToken);
        var field = entity.Fields.SingleOrDefault(candidate => candidate.FieldId == operation.FieldId)
            ?? throw await CalculatedFieldAsync(entity, operation.FieldId, transaction, cancellationToken)
                ?? new NendoPreconditionException(
                    "field-not-found",
                    $"Field {operation.FieldId} does not exist on entity {operation.EntityId}.");
        if (field.Required && operation.Value.ValueKind == JsonValueKind.Null)
        {
            throw new NendoValidationException($"Required field {field.FieldId} cannot be null.");
        }
        RequireActive(entity, allowRetiredField ? null : field);

        var selectSql = $"SELECT {Quote("__nendo_record_version")}, {Quote(field.PhysicalColumnName)} FROM {Quote(entity.PhysicalTableName)} WHERE {Quote("__nendo_record_id")} = @recordId;";
        long currentVersion;
        JsonElement previousValue;
        await using (var select = Command(selectSql, transaction))
        {
            select.Parameters.AddWithValue("@recordId", operation.RecordId);
            await using var reader = await select.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new NendoPreconditionException(
                    "record-not-found",
                    $"Record {operation.RecordId} does not exist.");
            }
            currentVersion = reader.GetInt64(0);
            previousValue = ToJsonElement(reader.IsDBNull(1) ? null : reader.GetValue(1), field.StorageKind);
        }
        if (currentVersion != operation.ExpectedRecordVersion)
        {
            throw new NendoPreconditionException(
                "record-version-conflict",
                $"Record {operation.RecordId} is version {currentVersion}, not {operation.ExpectedRecordVersion}.");
        }

        await ValidateReferenceValueAsync(field, operation.Value, operation.ExpectedTargetRecordVersion, transaction, cancellationToken);
        ValidateChoiceAssignment(field, operation.Value, previousValue);
        var previousTargetRecordVersion = await ReadReferenceVersionAsync(field, previousValue, transaction, cancellationToken);
        var updateSql = $"UPDATE {Quote(entity.PhysicalTableName)} SET {Quote(field.PhysicalColumnName)} = @value, {Quote("__nendo_record_version")} = {Quote("__nendo_record_version")} + 1 WHERE {Quote("__nendo_record_id")} = @recordId AND {Quote("__nendo_record_version")} = @expectedVersion;";
        await using (var update = Command(updateSql, transaction))
        {
            update.Parameters.AddWithValue("@value", ConvertValue(field, operation.Value));
            update.Parameters.AddWithValue("@recordId", operation.RecordId);
            update.Parameters.AddWithValue("@expectedVersion", operation.ExpectedRecordVersion);
            if (await update.ExecuteNonQueryAsync(cancellationToken) != 1)
            {
                throw new NendoPreconditionException(
                    "record-version-conflict",
                    $"Record {operation.RecordId} changed before the field update committed.");
            }
        }

        return new OperationEvidence(
            operation,
            Evidence(new
            {
                previousValue,
                previousTargetRecordVersion,
                appliedVersion = operation.ExpectedRecordVersion + 1,
            }))
        {
            RequiredHostVersion = field.StorageKind == NendoStorageKind.Decimal
                ? NendoFormat.ScalarMinimumHostVersion : NendoFormat.MinimumHostVersion,
        };
    }

    private async Task MaterializeSchemaChangesAsync(
        IReadOnlyList<NendoOperation> operations,
        IReadOnlySet<string> newEntityIds,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        foreach (var createEntity in operations.OfType<CreateEntityOperation>())
        {
            var entity = await GetEntityMappingAsync(createEntity.EntityId, transaction, cancellationToken);
            var columns = new List<string>
            {
                $"{Quote("__nendo_record_id")} TEXT NOT NULL PRIMARY KEY",
                $"{Quote("__nendo_record_version")} INTEGER NOT NULL CHECK ({Quote("__nendo_record_version")} >= 1)",
            };
            columns.AddRange(entity.Fields.Select(field =>
                $"{Quote(field.PhysicalColumnName)} {SqliteType(field.StorageKind)}{(field.Required && !field.Retired ? " NOT NULL" : string.Empty)}"));
            await NonQueryAsync(
                $"CREATE TABLE {Quote(entity.PhysicalTableName)} ({string.Join(", ", columns)});",
                transaction,
                cancellationToken);
        }

        foreach (var addField in operations
                     .OfType<AddFieldOperation>()
                     .Where(operation => !newEntityIds.Contains(operation.EntityId)))
        {
            var entity = await GetEntityMappingAsync(addField.EntityId, transaction, cancellationToken);
            var field = entity.Fields.Single(value => value.FieldId == addField.FieldId);
            await NonQueryAsync(
                $"ALTER TABLE {Quote(entity.PhysicalTableName)} ADD COLUMN {Quote(field.PhysicalColumnName)} {SqliteType(field.StorageKind)};",
                transaction,
                cancellationToken);
        }

        // ADR-0003 note, 2026-09-09: a covering index for the inverse read a
        // related list performs. Created here because the reference column may
        // be added by this same change set, and only for a reference that was
        // just configured. Never on open, never as a repair.
        foreach (var reference in operations.OfType<ConfigureReferenceOperation>())
        {
            var entity = await GetEntityMappingAsync(reference.EntityId, transaction, cancellationToken);
            var field = entity.Fields.SingleOrDefault(value => value.FieldId == reference.FieldId);
            if (field is null ||
                !await TableExistsAsync(entity.PhysicalTableName, transaction, cancellationToken) ||
                !await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, cancellationToken))
                continue;

            // Deliberately outside the __nendo_ protected namespace: the number of
            // reference indexes varies per application, and the protected schema
            // signature is a fixed set of recognised layouts.
            var indexName = $"nendo_ref_{entity.PhysicalTableName}_{field.PhysicalColumnName}";
            await NonQueryAsync(
                $"CREATE INDEX IF NOT EXISTS {Quote(indexName)} ON {Quote(entity.PhysicalTableName)}"
                + $"({Quote(field.PhysicalColumnName)}, {Quote("__nendo_record_id")});",
                transaction,
                cancellationToken);
        }
    }

    private async Task<bool> EntityExistsAsync(
        string entityId,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        await using var command = Command(
            "SELECT EXISTS(SELECT 1 FROM __nendo_entity WHERE entity_id = @entityId);",
            transaction);
        command.Parameters.AddWithValue("@entityId", entityId);
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture) == 1;
    }

    private async Task<EntityMapping> GetEntityMappingAsync(
        string entityId,
        SqliteTransaction? transaction,
        CancellationToken cancellationToken)
    {
        const string entitySql = """
            SELECT entity_id, display_name, physical_table_name
            FROM __nendo_entity
            WHERE entity_id = @entityId;
            """;
        string displayName;
        string physicalTableName;
        await using (var command = Command(entitySql, transaction))
        {
            command.Parameters.AddWithValue("@entityId", entityId);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            if (!await reader.ReadAsync(cancellationToken))
            {
                throw new NendoPreconditionException(
                    "entity-not-found",
                    $"Entity {entityId} does not exist.");
            }
            displayName = reader.GetString(1);
            physicalTableName = reader.GetString(2);
        }

        var hasPresentation = await ColumnExistsAsync(
            "__nendo_field",
            "presentation",
            transaction,
            cancellationToken);
        var hasOptions = await ColumnExistsAsync(
            "__nendo_field",
            "options_json",
            transaction,
            cancellationToken);
        var fieldSql = $"""
            SELECT field_id, entity_id, display_name, physical_column_name, storage_kind, required,
                   {(hasPresentation ? "presentation" : "NULL")},
                   {(hasOptions ? "options_json" : "'[]'")}
            FROM __nendo_field
            WHERE entity_id = @entityId
            ORDER BY rowid;
            """;
        var fields = new List<FieldMapping>();
        await using (var command = Command(fieldSql, transaction))
        {
            command.Parameters.AddWithValue("@entityId", entityId);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                fields.Add(new FieldMapping(
                    reader.GetString(0),
                    reader.GetString(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    Enum.Parse<NendoStorageKind>(reader.GetString(4), ignoreCase: false),
                    reader.GetInt64(5) == 1,
                    reader.IsDBNull(6) ? null : reader.GetString(6),
                    ParseOptions(reader.GetString(7))));
            }
        }
        await PopulateReferencesAsync(fields, transaction, cancellationToken);
        await PopulateChoicesAsync(fields, transaction, cancellationToken);
        await PopulateRatingScalesAsync(fields, transaction, cancellationToken);
        var retiredFields = await RetiredIdsAsync("field", transaction, cancellationToken);
        for (var index = 0; index < fields.Count; index++) fields[index] = fields[index] with { Retired = retiredFields.Contains(fields[index].FieldId) };
        return new EntityMapping(entityId, displayName, physicalTableName, fields)
        { Retired = (await RetiredIdsAsync("entity", transaction, cancellationToken)).Contains(entityId) };
    }

    private static object ConvertValue(FieldMapping field, JsonElement value)
    {
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
        {
            return DBNull.Value;
        }

        try
        {
            object converted = field.StorageKind switch
            {
                NendoStorageKind.Text or NendoStorageKind.Date or NendoStorageKind.DateTime or
                    NendoStorageKind.Uuid or NendoStorageKind.Reference => value.GetString()
                        ?? throw new NendoValidationException($"Field {field.FieldId} requires a string value."),
                NendoStorageKind.Integer => value.GetInt64(),
                NendoStorageKind.Decimal => "nendo.decimal:" + ExactDecimal.Read(value).ToString(CultureInfo.InvariantCulture),
                NendoStorageKind.Boolean => value.GetBoolean() ? 1L : 0L,
                _ => throw new NendoValidationException($"Storage kind {field.StorageKind} is unsupported."),
            };
            if (field.Presentation == "singleChoice" && converted is string choice &&
                !field.Options.Contains(choice, StringComparer.Ordinal))
            {
                // The declared choices are stable IDs, and the received value is the
                // caller's own input, echoed so a string that arrived with its quotes
                // still inside it can be seen for what it is.
                throw new NendoValidationException(
                    $"Value for field {field.FieldId} is not one of its declared choices ({string.Join(", ", field.Options)}); " +
                    $"received \"{(choice.Length > 40 ? choice[..40] + "…" : choice).Replace("\\", "\\\\").Replace("\"", "\\\"")}\".");
            }
            if (field.StorageKind == NendoStorageKind.Date && converted is string date &&
                !DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
            {
                throw new NendoValidationException(
                    $"Value for field {field.FieldId} must use the yyyy-MM-dd date format.");
            }
            if (field.StorageKind == NendoStorageKind.DateTime && converted is string timestamp &&
                (!System.Text.RegularExpressions.Regex.IsMatch(timestamp, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$", System.Text.RegularExpressions.RegexOptions.CultureInvariant) ||
                 !DateTimeOffset.TryParse(timestamp, CultureInfo.InvariantCulture, DateTimeStyles.None, out _)))
                throw new NendoValidationException($"Value for field {field.FieldId} must be an ISO timestamp with an explicit timezone.");
            if (field.StorageKind == NendoStorageKind.Uuid && converted is string uuid && !Guid.TryParseExact(uuid, "D", out _))
                throw new NendoValidationException($"Value for field {field.FieldId} must be a hyphenated UUID.");
            return converted;
        }
        catch (InvalidOperationException)
        {
            throw new NendoValidationException(
                $"Value for field {field.FieldId} does not match storage kind {field.StorageKind}.");
        }
        catch (FormatException)
        {
            throw new NendoValidationException(
                $"Value for field {field.FieldId} does not match storage kind {field.StorageKind}.");
        }
    }

    private static JsonElement ToJsonElement(object? value, NendoStorageKind kind) => kind switch
    {
        NendoStorageKind.Decimal when value is string text && text.StartsWith("nendo.decimal:", StringComparison.Ordinal) =>
            JsonSerializer.SerializeToElement(decimal.Parse(text[14..], CultureInfo.InvariantCulture)),
        NendoStorageKind.Boolean when value is long integer => JsonSerializer.SerializeToElement(integer != 0),
        _ => JsonSerializer.SerializeToElement(value, value?.GetType() ?? typeof(object)),
    };

    private static string SqliteType(NendoStorageKind kind) => kind switch
    {
        NendoStorageKind.Text or NendoStorageKind.Date or NendoStorageKind.DateTime or
            NendoStorageKind.Uuid or NendoStorageKind.Reference => "TEXT",
        NendoStorageKind.Integer or NendoStorageKind.Boolean => "INTEGER",
        NendoStorageKind.Decimal => "NUMERIC",
        _ => throw new NendoValidationException($"Storage kind {kind} is unsupported."),
    };

    private static void ValidatePhysicalIdentifier(string value, string kind)
    {
        if (value.Length is < 1 or > 63 ||
            value.StartsWith("__nendo_", StringComparison.OrdinalIgnoreCase) ||
            value[0] is < 'a' or > 'z' ||
            value.Any(character =>
                (character < 'a' || character > 'z') &&
                (character < '0' || character > '9') &&
                character != '_'))
        {
            throw new NendoValidationException(
                $"Physical {kind} names must be 1-63 lowercase ASCII letters, digits or underscores, begin with a letter and not use the protected prefix.");
        }
    }

    private static string Quote(string identifier) =>
        $"\"{identifier.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";

    // Storage accepts any kind some supported contract version can express.
    // Contract version 3 widened that set, so the additional kinds are read from
    // the vocabulary table rather than repeated here. The compiler still decides
    // whether a kind is legal in a given position and contract version.
    private static void ValidateUiNodeKind(string kind)
    {
        if (kind is not ("recordForm" or "recordList" or "boardSurface" or "fieldBinding" or "recordCommand") &&
            !NendoSemanticVocabulary.Kinds.ContainsKey(kind))
        {
            throw new NendoValidationException(
                $"UI node kind {kind} is not part of any supported semantic contract version.");
        }
    }

    private async Task<(string? ParentNodeId, int Position)> RequireUiNodeAsync(
        string surfaceId,
        string nodeId,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT parent_node_id, position
            FROM __nendo_ui_node
            WHERE node_id = @nodeId AND surface_id = @surfaceId;
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@nodeId", nodeId);
        command.Parameters.AddWithValue("@surfaceId", surfaceId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken))
        {
            throw new NendoPreconditionException(
                "ui-node-not-found",
                $"UI node {nodeId} does not exist on surface {surfaceId}.");
        }
        return (reader.IsDBNull(0) ? null : reader.GetString(0), reader.GetInt32(1));
    }

    private async Task<bool> IsUiDescendantAsync(
        string surfaceId,
        string nodeId,
        string candidateDescendantId,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string sql = """
            WITH RECURSIVE descendants(node_id) AS (
                SELECT node_id FROM __nendo_ui_node WHERE parent_node_id = @nodeId AND surface_id = @surfaceId
                UNION ALL
                SELECT child.node_id
                FROM __nendo_ui_node child
                JOIN descendants parent ON child.parent_node_id = parent.node_id
                WHERE child.surface_id = @surfaceId
            )
            SELECT EXISTS(SELECT 1 FROM descendants WHERE node_id = @candidateId);
            """;
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@nodeId", nodeId);
        command.Parameters.AddWithValue("@surfaceId", surfaceId);
        command.Parameters.AddWithValue("@candidateId", candidateDescendantId);
        return Convert.ToInt64(
            await command.ExecuteScalarAsync(cancellationToken),
            CultureInfo.InvariantCulture) == 1;
    }

    private async Task<string> ReadUiSubtreeForEvidenceAsync(
        string surfaceId,
        string nodeId,
        SqliteTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string sql = """
            WITH RECURSIVE subtree(node_id, surface_id, parent_node_id, kind, position) AS (
                SELECT node_id, surface_id, parent_node_id, kind, position
                FROM __nendo_ui_node
                WHERE node_id = @nodeId AND surface_id = @surfaceId
                UNION ALL
                SELECT child.node_id, child.surface_id, child.parent_node_id, child.kind, child.position
                FROM __nendo_ui_node child
                JOIN subtree parent ON child.parent_node_id = parent.node_id
            )
            SELECT subtree.node_id, subtree.surface_id, subtree.parent_node_id,
                   subtree.kind, subtree.position, property.property_name, property.value_json
            FROM subtree
            LEFT JOIN __nendo_ui_property property ON property.node_id = subtree.node_id
            ORDER BY subtree.node_id, property.property_name;
            """;
        var rows = new List<object>();
        await using var command = Command(sql, transaction);
        command.Parameters.AddWithValue("@nodeId", nodeId);
        command.Parameters.AddWithValue("@surfaceId", surfaceId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            rows.Add(new
            {
                nodeId = reader.GetString(0),
                surfaceId = reader.GetString(1),
                parentNodeId = reader.IsDBNull(2) ? null : reader.GetString(2),
                kind = reader.GetString(3),
                position = reader.GetInt32(4),
                propertyName = reader.IsDBNull(5) ? null : reader.GetString(5),
                valueJson = reader.IsDBNull(6) ? null : reader.GetString(6),
            });
        }
        return Evidence(new { retainedSubtree = rows });
    }
}
