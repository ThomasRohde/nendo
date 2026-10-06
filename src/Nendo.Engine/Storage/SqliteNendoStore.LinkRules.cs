using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// A link record type's rule, ADR-0026: the last rung of the protected layout ladder, added by
    /// the first declaration. One row per link record type, naming the ten fields and record type
    /// the rule reads; a file that never declared one carries no table and keeps its layout.
    /// </summary>
    private const string LinkRuleSchemaSql = """
        CREATE TABLE __nendo_link_rule (
            entity_id TEXT NOT NULL PRIMARY KEY,
            source_field_id TEXT NOT NULL,
            target_field_id TEXT NOT NULL,
            kind_field_id TEXT NOT NULL,
            source_kind_field_id TEXT NOT NULL,
            target_kind_field_id TEXT NOT NULL,
            table_entity_id TEXT NOT NULL,
            table_source_field_id TEXT NOT NULL,
            table_target_field_id TEXT NOT NULL,
            table_kind_field_id TEXT NOT NULL,
            CHECK (source_field_id != target_field_id AND source_field_id != kind_field_id AND target_field_id != kind_field_id),
            CHECK (table_source_field_id != table_target_field_id AND table_source_field_id != table_kind_field_id AND table_target_field_id != table_kind_field_id),
            CHECK (table_entity_id != entity_id),
            FOREIGN KEY (entity_id) REFERENCES __nendo_entity(entity_id),
            FOREIGN KEY (table_entity_id) REFERENCES __nendo_entity(entity_id),
            FOREIGN KEY (source_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (target_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (kind_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (source_kind_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (target_kind_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (table_source_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (table_target_field_id) REFERENCES __nendo_field(field_id),
            FOREIGN KEY (table_kind_field_id) REFERENCES __nendo_field(field_id)
        );
        """;

    /// <summary>Brings the protected layout up to the link-rule rung: the whole ladder, then the rule table.</summary>
    private async Task EnsureLinkRuleLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureExtensionKindLayoutAsync(transaction, ct);
        if (!await LinkRuleLayoutExistsAsync(transaction, ct)) await NonQueryAsync(LinkRuleSchemaSql, transaction, ct);
    }

    private Task<bool> LinkRuleLayoutExistsAsync(SqliteTransaction? transaction, CancellationToken ct) =>
        TableExistsAsync("__nendo_link_rule", transaction, ct);

    /// <summary>Every declared link rule by link record type. Empty for a file below the rung.</summary>
    private async Task<Dictionary<string, NendoLinkRule>> ReadLinkRulesAsync(SqliteTransaction? transaction, CancellationToken ct)
    {
        var rules = new Dictionary<string, NendoLinkRule>(StringComparer.Ordinal);
        if (!await LinkRuleLayoutExistsAsync(transaction, ct)) return rules;
        await using var query = Command("""
            SELECT entity_id, source_field_id, target_field_id, kind_field_id, source_kind_field_id, target_kind_field_id,
                   table_entity_id, table_source_field_id, table_target_field_id, table_kind_field_id
            FROM __nendo_link_rule ORDER BY entity_id;
            """, transaction);
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
            rules[rows.GetString(0)] = new(rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetString(4),
                rows.GetString(5), rows.GetString(6), rows.GetString(7), rows.GetString(8), rows.GetString(9));
        return rules;
    }

    /// <summary>The ten fields and three record types a rule reads, resolved against the definition.</summary>
    private sealed record ResolvedLinkRule(
        EntityMapping Link,
        FieldMapping Source,
        FieldMapping Target,
        FieldMapping Kind,
        EntityMapping SourceEntity,
        FieldMapping SourceKind,
        EntityMapping TargetEntity,
        FieldMapping TargetKind,
        EntityMapping Table,
        FieldMapping TableSource,
        FieldMapping TableTarget,
        FieldMapping TableKind)
    {
        internal IEnumerable<FieldMapping> Fields =>
            [Source, Target, Kind, SourceKind, TargetKind, TableSource, TableTarget, TableKind];

        internal bool ReadsEntity(string entityId) =>
            Link.EntityId == entityId || SourceEntity.EntityId == entityId || TargetEntity.EntityId == entityId || Table.EntityId == entityId;
    }

    /// <summary>
    /// A rule's shape (ADR-0026 item 2), or the reason it has none. Used by the declaration, which
    /// refuses with the reason, and at open, where a stored rule that no longer fits is drift.
    /// </summary>
    private static (ResolvedLinkRule? Rule, string? Problem) ResolveLinkRule(
        string entityId, NendoLinkRule rule, IReadOnlyList<EntityMapping> entities)
    {
        var byId = entities.ToDictionary(entity => entity.EntityId, StringComparer.Ordinal);
        if (!byId.TryGetValue(entityId, out var link)) return (null, $"Record type {entityId} does not exist.");
        if (link.Retired) return (null, $"{link.DisplayName} is retired.");
        FieldMapping? FieldOf(EntityMapping owner, string fieldId) => owner.Fields.SingleOrDefault(field => field.FieldId == fieldId);

        string? Reference(FieldMapping? field, string fieldId, string role, out EntityMapping? target)
        {
            target = null;
            if (field is null) return $"Field {fieldId} is not a field of {link.DisplayName}, so it cannot be the link's {role}.";
            if (field.Retired) return $"{field.DisplayName} is retired, so it cannot be the link's {role}.";
            if (field.StorageKind != NendoStorageKind.Reference || field.Reference is null)
                return $"{field.DisplayName} is not a configured reference, so it cannot be the link's {role}.";
            if (!byId.TryGetValue(field.Reference.TargetEntityId, out target) || target.Retired)
                return $"{field.DisplayName} points at a record type that is missing or retired.";
            return null;
        }

        var source = FieldOf(link, rule.SourceFieldId);
        var target = FieldOf(link, rule.TargetFieldId);
        if (Reference(source, rule.SourceFieldId, "source", out var sourceEntity) is { } sourceProblem) return (null, sourceProblem);
        if (Reference(target, rule.TargetFieldId, "target", out var targetEntity) is { } targetProblem) return (null, targetProblem);
        if (rule.SourceFieldId == rule.TargetFieldId) return (null, "The source and the target must be different fields.");
        var kind = FieldOf(link, rule.KindFieldId);
        if (kind is null) return (null, $"Field {rule.KindFieldId} is not a field of {link.DisplayName}, so it cannot be the link's kind.");
        if (rule.KindFieldId == rule.SourceFieldId || rule.KindFieldId == rule.TargetFieldId)
            return (null, "The kind must be a field other than the source and the target.");
        var sourceKind = FieldOf(sourceEntity!, rule.SourceKindFieldId);
        if (sourceKind is null)
            return (null, $"Field {rule.SourceKindFieldId} is not a field of {sourceEntity!.DisplayName}, which {source!.DisplayName} points at.");
        var targetKind = FieldOf(targetEntity!, rule.TargetKindFieldId);
        if (targetKind is null)
            return (null, $"Field {rule.TargetKindFieldId} is not a field of {targetEntity!.DisplayName}, which {target!.DisplayName} points at.");

        if (!byId.TryGetValue(rule.TableEntityId, out var table)) return (null, $"Record type {rule.TableEntityId} does not exist.");
        if (table.Retired) return (null, $"{table.DisplayName} is retired, so it cannot hold the allowed links.");
        if (table.EntityId == link.EntityId || table.EntityId == sourceEntity!.EntityId || table.EntityId == targetEntity!.EntityId)
            return (null, $"{table.DisplayName} holds links or their ends; the allowed links need a record type of their own.");
        var tableSource = FieldOf(table, rule.TableSourceFieldId);
        var tableTarget = FieldOf(table, rule.TableTargetFieldId);
        var tableKind = FieldOf(table, rule.TableKindFieldId);
        foreach (var (field, id) in new[] { (tableSource, rule.TableSourceFieldId), (tableTarget, rule.TableTargetFieldId), (tableKind, rule.TableKindFieldId) })
            if (field is null) return (null, $"Field {id} is not a field of {table.DisplayName}.");
        if (new[] { rule.TableSourceFieldId, rule.TableTargetFieldId, rule.TableKindFieldId }.Distinct(StringComparer.Ordinal).Count() != 3)
            return (null, $"The three fields of {table.DisplayName} must be different fields.");

        foreach (var (stands, matches) in new[] { (tableSource!, sourceKind), (tableTarget!, targetKind), (tableKind!, kind) })
        {
            if (matches.Retired || stands.Retired) return (null, $"{(matches.Retired ? matches : stands).DisplayName} is retired.");
            if (!CanBeLinkKind(matches))
                return (null, $"{matches.DisplayName} is {UniqueShape(matches)}. A kind is a configured reference or single-line Text.");
            if (!KindsMatch(stands, matches))
                return (null, $"{stands.DisplayName} of {table.DisplayName} must be the same kind of field as {matches.DisplayName}: " +
                    (matches.StorageKind == NendoStorageKind.Reference ? "a reference to the same record type." : "single-line Text."));
        }
        return (new(link, source!, target!, kind, sourceEntity!, sourceKind, targetEntity!, targetKind, table,
            tableSource!, tableTarget!, tableKind!), null);
    }

    /// <summary>What a kind may be: a configured reference, or single-line Text, compared exactly as stored.</summary>
    private static bool CanBeLinkKind(FieldMapping field) =>
        field.StorageKind == NendoStorageKind.Reference && field.Reference is not null ||
        field.StorageKind == NendoStorageKind.Text && field.Presentation is null or "singleLine";

    private static bool KindsMatch(FieldMapping table, FieldMapping kind) =>
        kind.StorageKind == NendoStorageKind.Reference
            ? table.StorageKind == NendoStorageKind.Reference && table.Reference?.TargetEntityId == kind.Reference!.TargetEntityId
            : table.StorageKind == NendoStorageKind.Text && table.Presentation is null or "singleLine";

    /// <summary>A stored rule must still have its shape; anything else is drift, reported at open.</summary>
    private async Task<bool> LinkRuleMetadataIsValidAsync(IReadOnlyList<EntityMapping> entities, CancellationToken ct)
    {
        foreach (var (entityId, rule) in await ReadLinkRulesAsync(null, ct))
            if (ResolveLinkRule(entityId, rule, entities).Rule is null) return false;
        return true;
    }

    private static string LinkIndexName(EntityMapping table) => $"nendo_link_{table.PhysicalTableName}";

    /// <summary>
    /// The index that makes each check one lookup: the table's three columns. Outside the protected
    /// namespace, as unique and reference indexes are. Created only once the columns exist; a table
    /// added in the same mutation gets it when the mutation materializes.
    /// </summary>
    private async Task EnsureLinkIndexAsync(ResolvedLinkRule rule, SqliteTransaction transaction, CancellationToken ct)
    {
        var table = rule.Table.PhysicalTableName;
        if (!await TableExistsAsync(table, transaction, ct)) return;
        foreach (var field in new[] { rule.TableSource, rule.TableTarget, rule.TableKind })
            if (!await ColumnExistsAsync(table, field.PhysicalColumnName, transaction, ct)) return;
        await NonQueryAsync(
            $"CREATE INDEX IF NOT EXISTS {Quote(LinkIndexName(rule.Table))} ON {Quote(table)}" +
            $"({Quote(rule.TableSource.PhysicalColumnName)}, {Quote(rule.TableTarget.PhysicalColumnName)}, {Quote(rule.TableKind.PhysicalColumnName)});",
            transaction, ct);
    }

    private async Task<OperationEvidence> ExecuteDeclareLinkRuleAsync(DeclareLinkRuleOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entities = await ReadEntityMappingsAsync(transaction, ct);
        var link = entities.SingleOrDefault(entity => entity.EntityId == operation.EntityId)
            ?? throw new NendoPreconditionException("entity-not-found", $"Entity {operation.EntityId} does not exist.");
        if (link.LinkRule is not null)
            throw new NendoPreconditionException("link-rule-already-declared",
                $"{link.DisplayName} already has a link rule. Remove it first to declare a different one.");
        var (resolved, problem) = ResolveLinkRule(operation.EntityId, operation.Rule, entities);
        if (resolved is null) throw new NendoPreconditionException("link-rule-invalid", problem!);

        await RequireAllowedLinksAsync(resolved, LinkScope.All, transaction, ct, declaring: true);
        await EnsureLinkRuleLayoutAsync(transaction, ct);
        await using (var insert = Command("""
            INSERT INTO __nendo_link_rule(entity_id, source_field_id, target_field_id, kind_field_id, source_kind_field_id,
                target_kind_field_id, table_entity_id, table_source_field_id, table_target_field_id, table_kind_field_id)
            VALUES (@entity, @source, @target, @kind, @sourceKind, @targetKind, @table, @tableSource, @tableTarget, @tableKind);
            """, transaction))
        {
            var rule = operation.Rule;
            insert.Parameters.AddWithValue("@entity", operation.EntityId);
            insert.Parameters.AddWithValue("@source", rule.SourceFieldId);
            insert.Parameters.AddWithValue("@target", rule.TargetFieldId);
            insert.Parameters.AddWithValue("@kind", rule.KindFieldId);
            insert.Parameters.AddWithValue("@sourceKind", rule.SourceKindFieldId);
            insert.Parameters.AddWithValue("@targetKind", rule.TargetKindFieldId);
            insert.Parameters.AddWithValue("@table", rule.TableEntityId);
            insert.Parameters.AddWithValue("@tableSource", rule.TableSourceFieldId);
            insert.Parameters.AddWithValue("@tableTarget", rule.TableTargetFieldId);
            insert.Parameters.AddWithValue("@tableKind", rule.TableKindFieldId);
            await insert.ExecuteNonQueryAsync(ct);
        }
        await EnsureLinkIndexAsync(resolved, transaction, ct);
        return new OperationEvidence(operation, Evidence(new { appliedDefinitionRevision = manifest.DefinitionRevision + 1 }))
        {
            RequiredHostVersion = NendoFormat.LinkRuleMinimumHostVersion,
        };
    }

    private async Task<OperationEvidence> ExecuteRemoveLinkRuleAsync(RemoveLinkRuleOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        var manifest = await ReadManifestAsync(transaction, ct);
        if (manifest.DefinitionRevision != operation.ExpectedDefinitionRevision)
            throw DefinitionVersionConflict(operation.ExpectedDefinitionRevision, manifest.DefinitionRevision);
        var entity = await GetEntityMappingAsync(operation.EntityId, transaction, ct);
        var removed = entity.LinkRule
            ?? throw new NendoPreconditionException("link-rule-not-declared", $"{entity.DisplayName} has no link rule to remove.");
        await using (var delete = Command("DELETE FROM __nendo_link_rule WHERE entity_id=@entity;", transaction))
        {
            delete.Parameters.AddWithValue("@entity", entity.EntityId);
            await delete.ExecuteNonQueryAsync(ct);
        }
        // The index serves the table, which another rule may still read.
        var table = await GetEntityMappingAsync(removed.TableEntityId, transaction, ct);
        if (!(await ReadLinkRulesAsync(transaction, ct)).Values.Any(rule => rule.TableEntityId == removed.TableEntityId))
            await NonQueryAsync($"DROP INDEX IF EXISTS {Quote(LinkIndexName(table))};", transaction, ct);
        return new OperationEvidence(operation, Evidence(new
        {
            previous = new
            {
                kindFieldId = removed.KindFieldId,
                sourceFieldId = removed.SourceFieldId,
                sourceKindFieldId = removed.SourceKindFieldId,
                tableEntityId = removed.TableEntityId,
                tableKindFieldId = removed.TableKindFieldId,
                tableSourceFieldId = removed.TableSourceFieldId,
                tableTargetFieldId = removed.TableTargetFieldId,
                targetFieldId = removed.TargetFieldId,
                targetKindFieldId = removed.TargetKindFieldId,
            },
            appliedDefinitionRevision = manifest.DefinitionRevision + 1,
        }))
        {
            RequiredHostVersion = NendoFormat.LinkRuleMinimumHostVersion,
        };
    }

    private static RemoveLinkRuleOperation CreateDeclareLinkRuleInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            canonical.RootElement.GetProperty("payload").GetProperty("entityId").GetString()!,
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    private static DeclareLinkRuleOperation CreateRemoveLinkRuleInverse(string canonicalJson, string evidenceJson, string key)
    {
        using var canonical = JsonDocument.Parse(canonicalJson);
        using var evidence = JsonDocument.Parse(evidenceJson);
        var previous = evidence.RootElement.GetProperty("previous");
        string Read(string name) => previous.GetProperty(name).GetString()!;
        return new(NendoCanonical.DeterministicId("operation", "studio.p5.compensation", key, 0),
            canonical.RootElement.GetProperty("payload").GetProperty("entityId").GetString()!,
            new(Read("sourceFieldId"), Read("targetFieldId"), Read("kindFieldId"), Read("sourceKindFieldId"), Read("targetKindFieldId"),
                Read("tableEntityId"), Read("tableSourceFieldId"), Read("tableTargetFieldId"), Read("tableKindFieldId")),
            evidence.RootElement.GetProperty("appliedDefinitionRevision").GetInt64());
    }

    /// <summary>
    /// While a rule is declared, the record types and fields it reads keep their shape (ADR-0026
    /// item 6): none is retired, and none changes presentation. Renaming is harmless.
    /// </summary>
    private async Task RequireNotLinkRuleFieldAsync(EntityMapping entity, string? fieldId, string change,
        SqliteTransaction transaction, CancellationToken ct)
    {
        var rules = await ReadLinkRulesAsync(transaction, ct);
        if (rules.Count == 0) return;
        var entities = await ReadEntityMappingsAsync(transaction, ct);
        foreach (var (linkId, rule) in rules)
        {
            if (ResolveLinkRule(linkId, rule, entities).Rule is not { } resolved) continue;
            var link = resolved.Link.DisplayName;
            if (fieldId is null && resolved.ReadsEntity(entity.EntityId))
                throw new NendoPreconditionException("link-rule-field-in-use",
                    $"The link rule of {link} reads {entity.DisplayName}, so it cannot be {change}. Remove the rule first.");
            if (fieldId is not null && resolved.Fields.Any(field => field.FieldId == fieldId))
                throw new NendoPreconditionException("link-rule-field-in-use",
                    $"The link rule of {link} reads this field, so it cannot be {change}. Remove the rule first.");
        }
    }

    /// <summary>Which links a check reads: all of them, or those named or ending at a named record.</summary>
    private sealed class LinkScope
    {
        internal static readonly LinkScope All = new() { Everything = true };
        internal bool Everything { get; set; }
        internal HashSet<string> Links { get; } = new(StringComparer.Ordinal);
        internal HashSet<string> Sources { get; } = new(StringComparer.Ordinal);
        internal HashSet<string> Targets { get; } = new(StringComparer.Ordinal);
        internal bool IsEmpty => !Everything && Links.Count == 0 && Sources.Count == 0 && Targets.Count == 0;
    }

    /// <summary>
    /// The rule at the end of a mutation (ADR-0026 item 5): after every operation and automatic
    /// action has run, before the revision is recorded, so a batch may pass through a state that
    /// is not allowed on its way to one that is. Reads only the links the mutation could have
    /// changed the standing of.
    /// </summary>
    private async Task RequireAllowedLinksAsync(IReadOnlyList<OperationEvidence> evidence, SqliteTransaction transaction, CancellationToken ct)
    {
        var rules = await ReadLinkRulesAsync(transaction, ct);
        if (rules.Count == 0) return;
        var entities = await ReadEntityMappingsAsync(transaction, ct);
        foreach (var (linkId, rule) in rules)
        {
            if (ResolveLinkRule(linkId, rule, entities).Rule is not { } resolved) continue;
            var scope = new LinkScope();
            foreach (var operation in evidence.Select(item => item.Operation))
            {
                switch (operation)
                {
                    case CreateRecordOperation create when create.EntityId == linkId:
                        scope.Links.Add(create.RecordId);
                        break;
                    case RestoreDeletedRecordOperation restore when restore.EntityId == linkId:
                        scope.Links.Add(restore.RecordId);
                        break;
                    case DeleteRecordOperation delete when delete.EntityId == resolved.Table.EntityId:
                        scope.Everything = true;
                        break;
                    case SetFieldOperation set:
                        if (set.EntityId == linkId && (set.FieldId == rule.SourceFieldId || set.FieldId == rule.TargetFieldId || set.FieldId == rule.KindFieldId))
                            scope.Links.Add(set.RecordId);
                        if (set.EntityId == resolved.SourceEntity.EntityId && set.FieldId == rule.SourceKindFieldId) scope.Sources.Add(set.RecordId);
                        if (set.EntityId == resolved.TargetEntity.EntityId && set.FieldId == rule.TargetKindFieldId) scope.Targets.Add(set.RecordId);
                        if (set.EntityId == resolved.Table.EntityId) scope.Everything = true;
                        break;
                }
                if (scope.Everything) break;
            }
            if (!scope.IsEmpty) await RequireAllowedLinksAsync(resolved, scope, transaction, ct, declaring: false);
        }
    }

    /// <summary>
    /// Every link a scope reads whose kinds no table record holds. One query with the table's index
    /// behind it; a scope of named records is sent in slices, so a large import stays bounded.
    /// </summary>
    private async Task RequireAllowedLinksAsync(ResolvedLinkRule rule, LinkScope scope, SqliteTransaction transaction,
        CancellationToken ct, bool declaring)
    {
        foreach (var (entity, fields) in new[]
                 {
                     (rule.Link, new[] { rule.Source, rule.Target, rule.Kind }),
                     (rule.SourceEntity, new[] { rule.SourceKind }),
                     (rule.TargetEntity, new[] { rule.TargetKind }),
                     (rule.Table, new[] { rule.TableSource, rule.TableTarget, rule.TableKind }),
                 })
        {
            // A record type whose table or columns are not there yet holds no records to check.
            if (!await TableExistsAsync(entity.PhysicalTableName, transaction, ct)) return;
            foreach (var field in fields)
                if (!await ColumnExistsAsync(entity.PhysicalTableName, field.PhysicalColumnName, transaction, ct)) return;
        }

        string Column(string alias, FieldMapping field) => $"{alias}.{Quote(field.PhysicalColumnName)}";
        var kindEmpty = rule.Kind.StorageKind == NendoStorageKind.Text ? $" AND {Column("l", rule.Kind)} <> ''" : string.Empty;
        var select = $"""
            FROM {Quote(rule.Link.PhysicalTableName)} l
            JOIN {Quote(rule.SourceEntity.PhysicalTableName)} s ON s.__nendo_record_id = {Column("l", rule.Source)}
            JOIN {Quote(rule.TargetEntity.PhysicalTableName)} t ON t.__nendo_record_id = {Column("l", rule.Target)}
            WHERE {Column("l", rule.Kind)} IS NOT NULL{kindEmpty}
              AND NOT EXISTS (SELECT 1 FROM {Quote(rule.Table.PhysicalTableName)} r
                  WHERE {Column("r", rule.TableSource)} = {Column("s", rule.SourceKind)}
                    AND {Column("r", rule.TableTarget)} = {Column("t", rule.TargetKind)}
                    AND {Column("r", rule.TableKind)} = {Column("l", rule.Kind)})
            """;

        var slices = new List<(string Filter, Action<SqliteCommand> Bind)>();
        if (scope.Everything) slices.Add((string.Empty, _ => { }));
        else
        {
            const int SliceSize = 400;
            void AddSlices(IEnumerable<string> ids, string column)
            {
                foreach (var chunk in ids.Order(StringComparer.Ordinal).Chunk(SliceSize))
                {
                    var names = chunk.Select((_, index) => $"@id{index.ToString(CultureInfo.InvariantCulture)}").ToArray();
                    slices.Add(($" AND {column} IN ({string.Join(", ", names)})", command =>
                    {
                        for (var index = 0; index < chunk.Length; index++) command.Parameters.AddWithValue(names[index], chunk[index]);
                    }));
                }
            }
            AddSlices(scope.Links, "l.__nendo_record_id");
            AddSlices(scope.Sources, "s.__nendo_record_id");
            AddSlices(scope.Targets, "t.__nendo_record_id");
        }

        var refused = new SortedSet<string>(StringComparer.Ordinal);
        (string Link, JsonElement Source, JsonElement Target, JsonElement Kind)? first = null;
        long total = 0;
        foreach (var (filter, bind) in slices)
        {
            await using (var query = Command(
                $"SELECT l.__nendo_record_id, {Column("s", rule.SourceKind)}, {Column("t", rule.TargetKind)}, {Column("l", rule.Kind)} " +
                $"{select}{filter} ORDER BY l.__nendo_record_id LIMIT {NendoLinkRule.MaximumLinksNamed + 1};", transaction))
            {
                bind(query);
                await using var rows = await query.ExecuteReaderAsync(ct);
                while (await rows.ReadAsync(ct))
                {
                    var id = rows.GetString(0);
                    if (!refused.Add(id)) continue;
                    var candidate = (id,
                        ToJsonElement(rows.IsDBNull(1) ? null : rows.GetValue(1), rule.SourceKind.StorageKind),
                        ToJsonElement(rows.IsDBNull(2) ? null : rows.GetValue(2), rule.TargetKind.StorageKind),
                        ToJsonElement(rows.IsDBNull(3) ? null : rows.GetValue(3), rule.Kind.StorageKind));
                    if (first is null || string.CompareOrdinal(id, first.Value.Link) < 0) first = candidate;
                }
            }
            // Only a whole-table check counts: the slices of a named scope can overlap, and a
            // mutation's own links are few enough to have been read in full.
            if (refused.Count == 0 || !scope.Everything) continue;
            await using var count = Command($"SELECT count(*) {select}{filter};", transaction);
            bind(count);
            total = Convert.ToInt64(await count.ExecuteScalarAsync(ct), CultureInfo.InvariantCulture);
        }
        if (first is null) return;
        total = Math.Max(total, refused.Count);

        var table = rule.Table.DisplayName;
        if (declaring)
        {
            var named = refused.Take(NendoLinkRule.MaximumLinksNamed).ToArray();
            var more = total > named.Length ? $", and {(total - named.Length).ToString("N0", CultureInfo.InvariantCulture)} more" : string.Empty;
            throw new NendoPreconditionException("links-not-allowed",
                $"{total.ToString("N0", CultureInfo.InvariantCulture)} {rule.Link.DisplayName} record{(total == 1 ? " is not an allowed link" : "s are not allowed links")} " +
                $"by {table}: {string.Join(", ", named)}{more}. Correct those links or add their combinations to {table} first; nothing was changed.");
        }
        var (link, sourceKind, targetKind, kind) = first.Value;
        var others = total > 1 ? $" {(total - 1).ToString("N0", CultureInfo.InvariantCulture)} other link{(total == 2 ? " is" : "s are")} not allowed either." : string.Empty;
        throw new NendoPreconditionException("link-not-allowed",
            $"{rule.Link.DisplayName} record {link} is not an allowed link: no {table} record holds its " +
            $"{rule.Source.DisplayName}'s {rule.SourceKind.DisplayName}{Named(rule.SourceKind, sourceKind)}, " +
            $"its {rule.Target.DisplayName}'s {rule.TargetKind.DisplayName}{Named(rule.TargetKind, targetKind)} " +
            $"and its {rule.Kind.DisplayName}{Named(rule.Kind, kind)}.{others} Change the link, or add the combination to {table}.");
    }

    /// <summary>
    /// A reference kind is named by the record ID it holds; a text kind is not named at all, since
    /// a refusal an agent reads carries no stored value.
    /// </summary>
    private static string Named(FieldMapping field, JsonElement value) =>
        field.StorageKind == NendoStorageKind.Reference && value.ValueKind == JsonValueKind.String
            ? $" ({value.GetString()})"
            : value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined ? " (none)" : string.Empty;
}
