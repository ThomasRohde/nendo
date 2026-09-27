using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// A record type's declared hierarchy, ADR-0019. Its own table on the last rung of the
    /// layout ladder, for the reason the tone, scale and purpose tables give: the protected
    /// layout is a fingerprint of verbatim DDL, so a fresh file and an older one that gains a
    /// hierarchy must end with byte-identical schema text. One row per record type; a field
    /// is the parent or the order of at most one hierarchy.
    /// </summary>
    private const string HierarchySchemaSql = """
        CREATE TABLE __nendo_hierarchy (
            entity_id TEXT NOT NULL PRIMARY KEY,
            parent_field_id TEXT NOT NULL UNIQUE,
            order_field_id TEXT NULL UNIQUE,
            CHECK (order_field_id IS NULL OR order_field_id != parent_field_id),
            FOREIGN KEY (entity_id) REFERENCES __nendo_entity(entity_id),
            FOREIGN KEY (parent_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (order_field_id) REFERENCES __nendo_field(field_id)
        );
        """;

    /// <summary>Brings the protected layout up to the hierarchy rung: the whole ladder, then the hierarchy table.</summary>
    private async Task EnsureHierarchyLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureExtensionLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_hierarchy", transaction, ct)) await NonQueryAsync(HierarchySchemaSql, transaction, ct);
    }

    /// <summary>Every declared hierarchy by record type. A file that never declared one carries no table.</summary>
    private async Task<Dictionary<string, NendoHierarchy>> ReadHierarchiesAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var hierarchies = new Dictionary<string, NendoHierarchy>(StringComparer.Ordinal);
        if (!await TableExistsAsync("__nendo_hierarchy", transaction, ct)) return hierarchies;
        await using var query = Command("SELECT entity_id,parent_field_id,order_field_id FROM __nendo_hierarchy;", transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
            hierarchies[rows.GetString(0)] = new(rows.GetString(1), rows.IsDBNull(2) ? null : rows.GetString(2));
        return hierarchies;
    }

    /// <summary>
    /// A stored declaration must still describe a tree this host can enforce: an optional
    /// self-reference as the parent and, if named, an Integer field of the same record type as
    /// the order. Anything else is drift, reported at open rather than enforced wrongly.
    /// </summary>
    private async Task<bool> HierarchyMetadataIsValidAsync(IReadOnlyList<EntityMapping> entities, CancellationToken ct)
    {
        foreach (var (entityId, hierarchy) in await ReadHierarchiesAsync(null, ct))
        {
            var entity = entities.SingleOrDefault(candidate => candidate.EntityId == entityId);
            var parent = entity?.Fields.SingleOrDefault(field => field.FieldId == hierarchy.ParentFieldId);
            if (entity is null || parent is null || parent.StorageKind != NendoStorageKind.Reference ||
                parent.Reference?.TargetEntityId != entityId || parent.Required) return false;
            if (hierarchy.OrderFieldId is { } orderId &&
                entity.Fields.SingleOrDefault(field => field.FieldId == orderId) is not { StorageKind: NendoStorageKind.Integer }) return false;
        }
        return true;
    }

    private async Task<OperationEvidence> ExecuteDeclareHierarchyAsync(DeclareHierarchyOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        RequireActive(entity);
        if (entity.Hierarchy is not null)
            throw new NendoPreconditionException("hierarchy-already-declared",
                $"{entity.DisplayName} already has a hierarchy. Remove it first to declare a different one.");
        var parent = entity.Fields.SingleOrDefault(field => field.FieldId == operation.ParentFieldId)
            ?? throw new NendoPreconditionException("field-not-found", $"Field {operation.ParentFieldId} does not belong to {entity.DisplayName}.");
        RequireActive(entity, parent);
        if (parent.StorageKind != NendoStorageKind.Reference || parent.Reference?.TargetEntityId != entity.EntityId)
            throw new NendoPreconditionException("hierarchy-parent-invalid",
                $"The parent field must be a reference configured to {entity.DisplayName} itself.");
        if (parent.Required)
            throw new NendoPreconditionException("hierarchy-parent-required",
                "A tree needs top-level records, so the parent field must be optional.");
        if (operation.OrderFieldId is { } orderId)
        {
            var order = entity.Fields.SingleOrDefault(field => field.FieldId == orderId)
                ?? throw new NendoPreconditionException("field-not-found", $"Field {orderId} does not belong to {entity.DisplayName}.");
            RequireActive(entity, order);
            if (order.StorageKind != NendoStorageKind.Integer)
                throw new NendoPreconditionException("hierarchy-order-invalid", "The order field must be an Integer field of the same record type.");
        }

        await RequireTreeAsync(entity, parent, transaction, ct);
        await EnsureHierarchyLayoutAsync(transaction, ct);
        await using (var insert = Command(
            "INSERT INTO __nendo_hierarchy(entity_id,parent_field_id,order_field_id) VALUES(@entity,@parent,@order);", transaction))
        {
            insert.Parameters.AddWithValue("@entity", entity.EntityId);
            insert.Parameters.AddWithValue("@parent", parent.FieldId);
            insert.Parameters.AddWithValue("@order", (object?)operation.OrderFieldId ?? DBNull.Value);
            try
            {
                await insert.ExecuteNonQueryAsync(ct);
            }
            catch (SqliteException exception) when (exception.SqliteErrorCode == 19)
            {
                throw new NendoPreconditionException("hierarchy-field-in-use",
                    "The parent or order field already belongs to another hierarchy.");
            }
        }
        return new OperationEvidence(operation, Evidence(new { appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        {
            RequiredHostVersion = NendoFormat.HierarchyMinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteRemoveHierarchyAsync(RemoveHierarchyOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var removed = entity.Hierarchy
            ?? throw new NendoPreconditionException("hierarchy-not-declared", $"{entity.DisplayName} has no hierarchy to remove.");
        foreach (var definition in (await ReadBehaviourDefinitionsAsync(transaction, ct)).Values)
            if (BindingsOf(definition).Any(binding => binding.EntityId == entity.EntityId &&
                    (binding.Kind is NendoBindingKind.SubtreeAggregate or NendoBindingKind.HierarchyPath || binding.AcrossSubtree)))
                throw new NendoPreconditionException("hierarchy-field-in-use",
                    $"'{definition.DefinitionId}' reads {entity.DisplayName}'s hierarchy. Change or remove that calculation first.");
        // An outline is the hierarchy drawn, so without one it would not compile, and a surface
        // that does not compile switches every custom screen off. Refused here instead.
        foreach (var node in await ReadUiNodesAsync(transaction, ct))
            if (node.Kind == "outlineSurface" && node.Properties.TryGetValue("entityId", out var target) &&
                target.ValueKind == JsonValueKind.String && target.GetString() == entity.EntityId)
                throw new NendoPreconditionException("hierarchy-field-in-use",
                    $"The outline '{node.NodeId}' shows {entity.DisplayName}'s hierarchy. Remove that outline first.");
        await using (var delete = Command("DELETE FROM __nendo_hierarchy WHERE entity_id=@entity;", transaction))
        {
            delete.Parameters.AddWithValue("@entity", entity.EntityId);
            await delete.ExecuteNonQueryAsync(ct);
        }
        return new OperationEvidence(operation, Evidence(new
        {
            previousParentFieldId = removed.ParentFieldId,
            previousOrderFieldId = removed.OrderFieldId,
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = NendoFormat.HierarchyMinimumHostVersion,
        };
    }

    private static RemoveHierarchyOperation CreateDeclareHierarchyInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            canonical.RootElement.GetProperty("payload").GetProperty("entityId").GetString()!,
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    private static DeclareHierarchyOperation CreateRemoveHierarchyInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var prior = evidence.RootElement;
        var order = prior.GetProperty("previousOrderFieldId");
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            canonical.RootElement.GetProperty("payload").GetProperty("entityId").GetString()!,
            prior.GetProperty("previousParentFieldId").GetString()!,
            order.ValueKind == JsonValueKind.String ? order.GetString() : null,
            prior.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    /// <summary>
    /// Declaring on existing data: every record must be reachable from a top-level record within
    /// the depth bound. A record that is not is on a loop, or under one, or too deep; the refusal
    /// names them rather than repairing anything.
    /// </summary>
    private async Task RequireTreeAsync(EntityMapping entity, FieldMapping parent, SqliteTransaction transaction, CancellationToken ct)
    {
        // A record type created in the same mutation has no table yet, and so no records.
        if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct)) return;
        var table = Quote(entity.PhysicalTableName);
        var column = Quote(parent.PhysicalColumnName);
        var parents = new Dictionary<string, string?>(StringComparer.Ordinal);
        await using (var all = Command($"SELECT __nendo_record_id, {column} FROM {table};", transaction))
        await using (var rows = await all.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
                parents[rows.GetString(0)] = rows.IsDBNull(1) ? null : rows.GetString(1);

        var depth = new Dictionary<string, int>(StringComparer.Ordinal);
        int DepthOf(string id)
        {
            // Iterative, so a long chain cannot overflow the stack; a loop reads as unreachable.
            var path = new List<string>();
            var onPath = new HashSet<string>(StringComparer.Ordinal);
            var current = id;
            int known;
            while (true)
            {
                if (depth.TryGetValue(current, out known)) break;
                if (!onPath.Add(current)) { known = -1; break; }
                path.Add(current);
                if (parents.GetValueOrDefault(current) is not { } up || !parents.ContainsKey(up)) { known = 0; break; }
                current = up;
            }
            for (var index = path.Count - 1; index >= 0; index--)
            {
                known = known < 0 ? -1 : known + 1;
                depth[path[index]] = known;
            }
            return depth[id];
        }
        foreach (var id in parents.Keys) DepthOf(id);

        var loops = new List<string>();
        var named = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in parents.Keys.Where(id => depth[id] < 0).OrderBy(id => id, StringComparer.Ordinal))
        {
            // Walk up until a record repeats; the loop is the stretch from its first visit.
            var seen = new List<string>();
            var current = id;
            while (!seen.Contains(current)) { seen.Add(current); current = parents[current]!; }
            var loop = seen.Skip(seen.IndexOf(current)).ToList();
            if (!named.Add(loop.Min(StringComparer.Ordinal)!)) continue;
            loops.Add(string.Join(" → ", loop.Append(loop[0])));
            if (loops.Count == 5) break;
        }
        if (loops.Count > 0)
            throw new NendoPreconditionException("hierarchy-cycle-present",
                $"{entity.DisplayName} already holds records that are their own ancestors, so it is not a tree: " +
                $"{string.Join("; ", loops)}. Change their parents first; nothing was repaired.");
        var tooDeep = depth.Where(pair => pair.Value > NendoHierarchyLimits.MaximumDepth)
            .Select(pair => pair.Key).OrderBy(id => id, StringComparer.Ordinal).Take(5).ToList();
        if (tooDeep.Count > 0)
            throw new NendoPreconditionException("hierarchy-too-deep",
                $"{entity.DisplayName} has records deeper than {NendoHierarchyLimits.MaximumDepth} levels, such as {string.Join(", ", tooDeep)}. " +
                "Move them up first; nothing was repaired.");
    }

    /// <summary>
    /// The rule every parent write obeys once a hierarchy is declared: a record may not become
    /// its own parent or sit under one of its own descendants, and nothing may end up deeper
    /// than <see cref="NendoHierarchyLimits.MaximumDepth"/>. Checked in the write's transaction,
    /// walking up from the proposed parent, so its cost is the depth rather than the tree.
    /// </summary>
    private async Task RequireHierarchyPlacementAsync(EntityMapping entity, FieldMapping field, string recordId, JsonElement value,
        bool newRecord, SqliteTransaction transaction, CancellationToken ct)
    {
        if (entity.Hierarchy?.ParentFieldId != field.FieldId || value.ValueKind != JsonValueKind.String) return;
        var parent = value.GetString()!;
        if (parent == recordId)
            throw new NendoPreconditionException("hierarchy-cycle", $"{recordId} cannot be its own parent.");
        var table = Quote(entity.PhysicalTableName);
        var column = Quote(field.PhysicalColumnName);

        // The proposed parent and its ancestors, nearest first.
        var ancestors = new List<string>();
        await using (var up = Command($"""
            WITH RECURSIVE up(id, n) AS (
              SELECT @parent, 1
              UNION ALL
              SELECT t.{column}, up.n + 1 FROM {table} t JOIN up ON t.__nendo_record_id = up.id
              WHERE t.{column} IS NOT NULL AND up.n <= @limit)
            SELECT id FROM up ORDER BY n;
            """, transaction))
        {
            up.Parameters.AddWithValue("@parent", parent);
            up.Parameters.AddWithValue("@limit", NendoHierarchyLimits.MaximumDepth);
            await using var rows = await up.ExecuteReaderAsync(ct);
            while (await rows.ReadAsync(ct)) ancestors.Add(rows.GetString(0));
        }
        var at = ancestors.IndexOf(recordId);
        if (at >= 0)
            throw new NendoPreconditionException("hierarchy-cycle",
                $"Putting {recordId} under {parent} would make it its own ancestor: " +
                $"{string.Join(" → ", ancestors.Take(at + 1).Prepend(recordId))}.");

        // How far the record's own subtree reaches below it; a new record has none.
        var below = 0;
        if (!newRecord)
        {
            await using var down = Command($"""
                WITH RECURSIVE down(id, d) AS (
                  SELECT __nendo_record_id, 1 FROM {table} WHERE {column} = @record
                  UNION ALL
                  SELECT n.__nendo_record_id, down.d + 1 FROM {table} n JOIN down ON n.{column} = down.id WHERE down.d <= @limit)
                SELECT coalesce(max(d), 0) FROM down;
                """, transaction);
            down.Parameters.AddWithValue("@record", recordId);
            down.Parameters.AddWithValue("@limit", NendoHierarchyLimits.MaximumDepth);
            below = Convert.ToInt32(await down.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
        }
        var deepest = ancestors.Count + 1 + below;
        if (deepest > NendoHierarchyLimits.MaximumDepth)
            throw new NendoPreconditionException("hierarchy-too-deep",
                $"Putting {recordId} under {parent} would reach {deepest} levels; a hierarchy holds at most {NendoHierarchyLimits.MaximumDepth}.");
    }

    /// <summary>A field a hierarchy depends on cannot be retired or made required while it is declared.</summary>
    private static void RequireNotHierarchyField(EntityMapping entity, string? fieldId, string change)
    {
        if (entity.Hierarchy is not { } hierarchy) return;
        if (fieldId is null || fieldId == hierarchy.ParentFieldId || fieldId == hierarchy.OrderFieldId)
            throw new NendoPreconditionException("hierarchy-field-in-use",
                $"{entity.DisplayName} declares a hierarchy on this {(fieldId is null ? "record type" : "field")}, so it cannot be {change}. Remove the hierarchy first.");
    }
}
