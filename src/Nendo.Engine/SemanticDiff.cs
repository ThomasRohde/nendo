using System.Text.Json;

namespace Nendo.Engine;

internal static class SemanticDiff
{
    /// <summary>
    /// Names resolved from the active definition plus anything this change set
    /// creates. The summary is the human accept gate, so an identifier that
    /// resolves to nothing is said to be unknown rather than rendered as a
    /// plausible display name.
    /// </summary>
    /// <param name="NodeLabels">
    /// The human name each node already carries, from the active definition plus
    /// anything this change set sets. Two roots may legitimately share a title,
    /// and a summary naming only the shared text would describe two different
    /// lines identically, so a collision is counted off against its namesakes —
    /// the second of two — rather than printing the stable ID at a reviewer who
    /// has no use for one.
    /// </param>
    /// <param name="Calculated">
    /// The calculated fields, by ID: the ones the active file already has and the ones
    /// this change set defines. A binding to one of these is a display of a
    /// calculation, and the summary says so rather than calling the field unknown —
    /// which is what a proposal's own calculated fields read as until this was kept.
    /// </param>
    private sealed record DiffNames(
        IReadOnlyDictionary<string, string> Fields,
        IReadOnlyDictionary<string, string> Entities,
        IReadOnlyDictionary<string, string> NodeKinds,
        IReadOnlyDictionary<string, string> NodeLabels,
        IReadOnlySet<string> Calculated,
        IReadOnlyDictionary<string, string> ReferenceTargets,
        IReadOnlyDictionary<(string FieldId, string ChoiceId), string> ChoiceNames,
        IReadOnlyDictionary<string, string> BindingFields,
        IReadOnlySet<string> AddedNodes,
        IReadOnlyList<string> NodeOrder,
        IReadOnlyDictionary<string, string> SurfaceRoots,
        IReadOnlyDictionary<string, FilterTerms> Filters,
        IReadOnlyDictionary<string, string> Opens,
        IReadOnlyDictionary<string, NendoStorageKind> FieldKinds,
        IReadOnlyDictionary<string, Ordering> Orderings,
        IReadOnlyDictionary<string, TileTerms> Tiles);

    /// <summary>The field and the direction an ordering is made of, gathered from the change set.</summary>
    private sealed record Ordering(string? FieldId, string? Direction);

    /// <summary>What a summary tile counts, over what, and for which record type, gathered from the change set.</summary>
    private sealed record TileTerms(string? Aggregate, string? Scope, string? EntityId);

    /// <summary>
    /// The three properties a filter clause is made of, gathered from the change set
    /// that adds it so the clause can be read as one statement.
    /// </summary>
    private sealed record FilterTerms(string? FieldId, string? Operator, JsonElement? Value);

    internal static IReadOnlyList<NendoSemanticDiffEntry> From(NendoChangeSet changeSet, NendoSessionSnapshot active)
    {
        var names = Resolve(changeSet, active);
        var packages = new PackageState(active);
        var result = new List<NendoSemanticDiffEntry>();
        foreach (var operation in changeSet.Mutations.SelectMany(mutation => mutation.Operations))
        {
            // Adding a binding and saying what it binds is one change, and it used to cost
            // two lines of which the first said nothing: "Show a field on its surface." then
            // "Bind to Title." The node's own line now carries the field name, so this one is
            // dropped -- but only when the same change set adds the node. Re-pointing a
            // binding the person already has is a change to something they have, and keeps
            // its line.
            if (operation is SetUiPropertyOperation { PropertyName: "fieldId" } bound &&
                names.NodeKinds.GetValueOrDefault(bound.NodeId, string.Empty) == "fieldBinding" &&
                names.AddedNodes.Contains(bound.NodeId))
            {
                continue;
            }
            // A summary tile added and configured in one change set is one line: what it
            // counts, over what, and its label, said where the tile is added. Its
            // properties changed later on a tile the person has keep their lines (W-052).
            if (operation is SetUiPropertyOperation { PropertyName: "aggregate" or "fieldId" or "scope" or "entityId" } tiled &&
                names.NodeKinds.GetValueOrDefault(tiled.NodeId, string.Empty) == "summaryTile" &&
                names.AddedNodes.Contains(tiled.NodeId))
            {
                continue;
            }
            // An ordering is one instruction: the direction rides on the line naming the
            // field when both arrive with the node, and means nothing on its own.
            if (operation is SetUiPropertyOperation { PropertyName: "orderDirection" } directed &&
                names.AddedNodes.Contains(directed.NodeId) &&
                names.Orderings.GetValueOrDefault(directed.NodeId)?.FieldId is not null)
            {
                continue;
            }
            // The same for a node's name and its contract version. The name is in the line
            // that adds the node, and the contract version of a root being added now is the
            // one this host authors -- a sentence nobody can act on. Both still stand alone
            // when they change something the file already has.
            if (operation is SetUiPropertyOperation { PropertyName: "title" or "label" or "definitionVersion" } carried &&
                names.AddedNodes.Contains(carried.NodeId) &&
                (carried.PropertyName == "definitionVersion" || names.NodeKinds.GetValueOrDefault(carried.NodeId, string.Empty) != "fieldBinding"))
            {
                continue;
            }
            // A filter clause added and filled in one change set is one statement, said on
            // the line that adds it: the field, the comparison and the value together,
            // where four lines used to open with one that said nothing. A property changed
            // on a clause the person already has keeps its own line.
            if (operation is SetUiPropertyOperation { PropertyName: "fieldId" or "operator" or "value" } term &&
                names.NodeKinds.GetValueOrDefault(term.NodeId, string.Empty) == "filterClause" &&
                names.AddedNodes.Contains(term.NodeId))
            {
                continue;
            }
            // How a section starts rides on the line that adds it; changed later, it is a
            // line of its own.
            if (operation is SetUiPropertyOperation { PropertyName: "opens" } starts && names.AddedNodes.Contains(starts.NodeId))
            {
                continue;
            }
            result.Add(operation switch
            {
                SetBehaviourDefinitionOperation value => Entry("setBehaviourDefinition", BehaviourSummary(names, value), value.Reversibility,
                    value.Definition.OwningEntityId is { } owner ? [owner, value.Definition.DefinitionId] : [value.Definition.DefinitionId]),
                RemoveBehaviourDefinitionOperation value => Entry("removeBehaviourDefinition",
                    $"Remove the {value.DefinitionKind.ToString().ToLowerInvariant()} {HumanId(value.DefinitionId)}; retain its definition in history.",
                    value.Reversibility, value.DefinitionId),
                SetFieldRequiredOperation value => Entry("setFieldRequired", $"Make {FieldName(names, value.FieldId)} {(value.Required ? "required" : "optional")} after validating every retained record.", value.Reversibility, value.EntityId, value.FieldId),
                BackfillRetiredFieldOperation value => Entry("backfillRetiredField", "Fill the explicitly selected retained field value.", value.Reversibility, value.Edit.EntityId, value.Edit.RecordId, value.Edit.FieldId),
                SetRetiredOperation value => Entry("setRetired", $"{(value.Retired ? "Retire" : "Reactivate")} {(value.FieldId is null ? "record type" : "field")}; retain stored data.", value.Reversibility, value.EntityId, value.FieldId ?? value.EntityId),
                DeleteRecordOperation value => Entry("deleteRecord", $"Delete record {HumanId(value.RecordId)}; retain values for guarded restoration.", value.Reversibility, value.EntityId, value.RecordId),
                SetChoiceMetadataOperation value => Entry("setChoiceMetadata", $"Name choice {value.DisplayName}, mark it {(value.Retired ? "retired" : "available")} and {(value.Tone is null ? "give it no colour" : $"colour it {value.Tone}")}; preserve its stored ID.", value.Reversibility, value.EntityId, value.FieldId, value.ChoiceId),
                ConfigureReferenceOperation value => Entry("configureReference",
                    $"Point {FieldName(names, value.FieldId)} on {EntityName(names, value.EntityId)} at {EntityName(names, value.TargetEntityId)}, labelled by {FieldName(names, value.LabelFieldId)}.",
                    value.Reversibility, value.EntityId, value.FieldId, value.TargetEntityId, value.LabelFieldId),
                ConvertLegacyReferenceOperation value => Entry("convertLegacyReference", $"Convert {value.Records.Count} explicitly mapped legacy reference values; retain original values in history. This conversion cannot be undone automatically.",
                    value.Reversibility, new[] { value.EntityId, value.FieldId, value.TargetEntityId }.Concat(value.Records.Select(row => row.RecordId)).ToArray()),
                RenameEntityOperation value => Entry("renameEntity", $"Rename record type to {value.DisplayName}.", value.Reversibility, value.EntityId),
                RenameFieldOperation value => Entry("renameField", $"Rename field to {value.DisplayName}.", value.Reversibility, value.EntityId, value.FieldId),
                CreateEntityOperation value => Entry(
                    "addEntity",
                    $"Add {value.DisplayName} structure.",
                    value.Reversibility,
                    value.EntityId),
                AddFieldOperation value => Entry(
                    "addField",
                    FieldSummary(names, value),
                    value.Reversibility,
                    value.EntityId,
                    value.FieldId),
                AddUiNodeOperation value => Entry(
                    "addUiNode",
                    AddNodeSummary(value, names),
                    value.Reversibility,
                    value.SurfaceId,
                    value.NodeId),
                SetUiPropertyOperation value => Entry(
                    "setUiProperty",
                    SetPropertySummary(value, names),
                    value.Reversibility,
                    value.SurfaceId,
                    value.NodeId),
                MoveUiNodeOperation value => Entry(
                    "moveUiNode",
                    MoveSummary(value, names),
                    value.Reversibility,
                    value.SurfaceId,
                    value.NodeId),
                RemoveUiNodeOperation value => Entry(
                    "removeUiNode",
                    $"Remove {NodeDescription(names, value.NodeId)} from its surface.",
                    value.Reversibility,
                    value.SurfaceId,
                    value.NodeId),
                CreateRecordOperation value => Entry(
                    "createRecord",
                    $"Add {EntityName(names, value.EntityId)} record.",
                    value.Reversibility,
                    value.EntityId,
                    value.RecordId),
                SetFieldOperation value => Entry(
                    "setField",
                    $"Set {FieldName(names, value.FieldId)} for {HumanId(value.RecordId)}.",
                    value.Reversibility,
                    value.EntityId,
                    value.RecordId,
                    value.FieldId),
                // Two sentences rather than one with a value in it: clearing is a thing a
                // person does on purpose, and a review that reads "Say what this file is
                // for:" with nothing after it describes neither what was asked nor what
                // will happen.
                SetApplicationPurposeOperation value => Entry(
                    "setApplicationPurpose",
                    value.Purpose is null
                        ? "Clear what this file is for."
                        : $"Say what this file is for: {value.Purpose}",
                    value.Reversibility),
                SetExtensionPackageOperation value => Entry("setExtensionPackage", packages.Set(value), value.Reversibility, value.PackageId),
                PutExtensionFileOperation value => Entry("putExtensionFile", packages.Put(value), value.Reversibility, value.PackageId, value.Path),
                RemoveExtensionFileOperation value => Entry("removeExtensionFile", packages.RemoveFile(value), value.Reversibility, value.PackageId, value.Path),
                RemoveExtensionPackageOperation value => Entry("removeExtensionPackage", packages.Remove(value), value.Reversibility, value.PackageId),
                _ => throw new NendoValidationException(
                    $"Operation type {operation.OperationType} has no semantic diff mapping."),
            });
        }
        return result.AsReadOnly();
    }

    /// <summary>
    /// The packages as the change set leaves them, operation by operation, so each line is
    /// said against what the file holds at that point: a file put twice reads as added and
    /// then replaced, and a package named by the operation before is named by its title.
    /// </summary>
    private sealed class PackageState
    {
        private readonly Dictionary<string, string> _titles = new(StringComparer.Ordinal);
        private readonly Dictionary<(string Package, string Path), (string Sha256, long Bytes)> _files = new();

        internal PackageState(NendoSessionSnapshot active)
        {
            foreach (var package in active.ExtensionPackages)
            {
                _titles[package.PackageId] = package.Title;
                foreach (var file in package.Files) _files[(package.PackageId, file.Path)] = (file.Sha256, file.ByteLength);
            }
        }

        private string Title(string packageId) =>
            _titles.TryGetValue(packageId, out var title) ? $"the package {title}" : $"the package {packageId}";

        internal string Set(SetExtensionPackageOperation operation)
        {
            var existed = _titles.ContainsKey(operation.PackageId);
            _titles[operation.PackageId] = operation.Title;
            return existed
                ? $"Update the custom-view package {operation.Title} ({operation.PackageId}): it starts at {operation.EntryPoint}" +
                    (operation.Version is null ? "." : $" and is version {operation.Version}.")
                : $"Add the custom-view package {operation.Title} ({operation.PackageId}), starting at {operation.EntryPoint}. Its code is kept in this file.";
        }

        internal string Put(PutExtensionFileOperation operation)
        {
            var key = (operation.PackageId, operation.Path);
            var had = _files.TryGetValue(key, out var before);
            _files[key] = (operation.Sha256, operation.ByteLength);
            if (!had) return $"Add {operation.Path} to {Title(operation.PackageId)} ({operation.MediaType}, {Size(operation.ByteLength)}).";
            return before.Sha256 == operation.Sha256
                ? $"Keep {operation.Path} in {Title(operation.PackageId)} as it is; the content sent is identical."
                : $"Replace {operation.Path} in {Title(operation.PackageId)} ({Size(before.Bytes)} before, {Size(operation.ByteLength)} after); the old version stays in history.";
        }

        internal string RemoveFile(RemoveExtensionFileOperation operation)
        {
            _files.Remove((operation.PackageId, operation.Path));
            return $"Remove {operation.Path} from {Title(operation.PackageId)}; its content stays in history.";
        }

        internal string Remove(RemoveExtensionPackageOperation operation)
        {
            var title = Title(operation.PackageId);
            _titles.Remove(operation.PackageId);
            return $"Remove {title} from this file.";
        }

        // The review reads the same on every machine, whatever the Windows language.
        private static string Size(long bytes) => bytes switch
        {
            < 1024 => FormattableString.Invariant($"{bytes} bytes"),
            < 1024 * 1024 => FormattableString.Invariant($"{bytes / 1024.0:0.#} KB"),
            _ => FormattableString.Invariant($"{bytes / (1024.0 * 1024):0.##} MB"),
        };
    }

    private static DiffNames Resolve(NendoChangeSet changeSet, NendoSessionSnapshot active)
    {
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        var entities = new Dictionary<string, string>(StringComparer.Ordinal);
        var nodeKinds = new Dictionary<string, string>(StringComparer.Ordinal);
        var nodeLabels = new Dictionary<string, string>(StringComparer.Ordinal);
        var calculated = new HashSet<string>(StringComparer.Ordinal);
        // Which record type a reference points at, so a board grouped by one can be read
        // back in the person's terms -- a lane per client, not "group records by Client".
        var referenceTargets = new Dictionary<string, string>(StringComparer.Ordinal);
        // The name each choice option answers to, where the change set renames one. A
        // field's own options are on the operation that adds it, so the sentence naming
        // them does not depend on this; this only prefers the chosen word over the
        // stored one.
        var choiceNames = new Dictionary<(string FieldId, string ChoiceId), string>();
        // Which field each binding shows, and which nodes this change set is adding. A
        // binding added and bound in one change set says itself once;
        // a binding that already exists and is being re-pointed still has its own line,
        // because that is a change to something the person already has.
        var bindingFields = new Dictionary<string, string>(StringComparer.Ordinal);
        var addedNodes = new HashSet<string>(StringComparer.Ordinal);
        // Nodes in the order they are met, active file first. Two nodes of one kind may
        // legitimately carry the same name, and the sentence telling them apart counts
        // them rather than printing a stable ID at the person.
        var nodeOrder = new List<string>();
        // A surface ID is not a node ID. The root node of a surface is the parentless one
        // in it, and naming a surface by its own ID finds nothing -- which is how a binding
        // came to say it was on an unknown node.
        var surfaceRoots = new Dictionary<string, string>(StringComparer.Ordinal);
        // The terms of every clause this change set fills in, keyed by node, so a clause
        // added here reads as one statement rather than as its three properties.
        var filters = new Dictionary<string, FilterTerms>(StringComparer.Ordinal);
        // How each section this change set adds says it starts, for the line that adds it.
        var opens = new Dictionary<string, string>(StringComparer.Ordinal);
        // What kind of value each field holds, so a direction can be said in the field's
        // own terms: newest first for a date, largest first for a number.
        var fieldKinds = new Dictionary<string, NendoStorageKind>(StringComparer.Ordinal);
        // The field and direction of every ordering this change set sets, and the terms of
        // every summary tile, keyed by node, for the one line each is said in.
        var orderings = new Dictionary<string, Ordering>(StringComparer.Ordinal);
        var tiles = new Dictionary<string, TileTerms>(StringComparer.Ordinal);

        foreach (var entity in active.Entities)
        {
            entities[entity.EntityId] = entity.DisplayName;
            foreach (var field in entity.Fields)
            {
                fields[field.FieldId] = field.DisplayName;
                fieldKinds[field.FieldId] = field.StorageKind;
                if (field.Reference is { } reference) referenceTargets[field.FieldId] = reference.TargetEntityId;
            }
            foreach (var field in entity.DerivedFields)
            {
                fields[field.FieldId] = field.DisplayName;
                calculated.Add(field.FieldId);
            }
        }
        foreach (var node in active.UiNodes)
        {
            nodeKinds[node.NodeId] = node.Kind;
            nodeOrder.Add(node.NodeId);
            if (node.ParentNodeId is null) surfaceRoots[node.SurfaceId] = node.NodeId;
            foreach (var property in new[] { "title", "label" })
                if (node.Properties.TryGetValue(property, out var stored) && stored.ValueKind == JsonValueKind.String &&
                    stored.GetString() is { Length: > 0 } existing)
                    nodeLabels[node.NodeId] = existing;
        }

        // A proposal may name something it is creating in the same change set.
        foreach (var operation in changeSet.Mutations.SelectMany(mutation => mutation.Operations))
        {
            switch (operation)
            {
                case CreateEntityOperation value: entities[value.EntityId] = value.DisplayName; break;
                case AddFieldOperation value: fields[value.FieldId] = value.DisplayName; fieldKinds[value.FieldId] = value.StorageKind; break;
                case RenameEntityOperation value: entities[value.EntityId] = value.DisplayName; break;
                case RenameFieldOperation value: fields[value.FieldId] = value.DisplayName; break;
                case AddUiNodeOperation value:
                    nodeKinds[value.NodeId] = value.Kind;
                    addedNodes.Add(value.NodeId);
                    nodeOrder.Add(value.NodeId);
                    if (value.ParentNodeId is null) surfaceRoots[value.SurfaceId] = value.NodeId;
                    break;
                case SetUiPropertyOperation { PropertyName: "fieldId" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } bound:
                    bindingFields[value.NodeId] = bound;
                    filters[value.NodeId] = (filters.GetValueOrDefault(value.NodeId) ?? new FilterTerms(null, null, null)) with { FieldId = bound };
                    break;
                case SetUiPropertyOperation { PropertyName: "operator" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } comparison:
                    filters[value.NodeId] = (filters.GetValueOrDefault(value.NodeId) ?? new FilterTerms(null, null, null)) with { Operator = comparison };
                    break;
                case SetUiPropertyOperation { PropertyName: "value" } value:
                    filters[value.NodeId] = (filters.GetValueOrDefault(value.NodeId) ?? new FilterTerms(null, null, null)) with { Value = value.Value };
                    break;
                case SetUiPropertyOperation { PropertyName: "opens" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } starts:
                    opens[value.NodeId] = starts;
                    break;
                case SetUiPropertyOperation { PropertyName: "orderByFieldId" or "rankByFieldId" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } orderedBy:
                    orderings[value.NodeId] = (orderings.GetValueOrDefault(value.NodeId) ?? new Ordering(null, null)) with { FieldId = orderedBy };
                    break;
                case SetUiPropertyOperation { PropertyName: "orderDirection" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } direction:
                    orderings[value.NodeId] = (orderings.GetValueOrDefault(value.NodeId) ?? new Ordering(null, null)) with { Direction = direction };
                    break;
                case SetUiPropertyOperation { PropertyName: "aggregate" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } aggregate:
                    tiles[value.NodeId] = (tiles.GetValueOrDefault(value.NodeId) ?? new TileTerms(null, null, null)) with { Aggregate = aggregate };
                    break;
                case SetUiPropertyOperation { PropertyName: "scope" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } scope:
                    tiles[value.NodeId] = (tiles.GetValueOrDefault(value.NodeId) ?? new TileTerms(null, null, null)) with { Scope = scope };
                    break;
                case SetUiPropertyOperation { PropertyName: "entityId" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } reads:
                    tiles[value.NodeId] = (tiles.GetValueOrDefault(value.NodeId) ?? new TileTerms(null, null, null)) with { EntityId = reads };
                    break;
                case ConfigureReferenceOperation value: referenceTargets[value.FieldId] = value.TargetEntityId; break;
                case SetChoiceMetadataOperation value: choiceNames[(value.FieldId, value.ChoiceId)] = value.DisplayName; break;
                case SetUiPropertyOperation { PropertyName: "title" or "label" } value
                    when value.Value.ValueKind == JsonValueKind.String && value.Value.GetString() is { Length: > 0 } named:
                    nodeLabels[value.NodeId] = named;
                    break;
                case SetBehaviourDefinitionOperation { Definition: NendoCalculationDefinition value }:
                    fields[value.FieldId] = value.DisplayName;
                    calculated.Add(value.FieldId);
                    break;
            }
        }

        return new DiffNames(fields, entities, nodeKinds, nodeLabels, calculated, referenceTargets, choiceNames,
            bindingFields, addedNodes, nodeOrder, surfaceRoots, filters, opens, fieldKinds, orderings, tiles);
    }

    /// <summary>
    /// A field in the words a reviewer needs to judge it: what kind of value it holds,
    /// whether it has to be filled, and — for a choice — what the options are. The
    /// display name alone answers none of those, and a record type adding a dozen
    /// fields read as a dozen lines of "Add Pages field." until this said otherwise.
    /// Every fact here is on the operation being described; none of it is inferred.
    /// </summary>
    private static string FieldSummary(DiffNames names, AddFieldOperation operation) =>
        $"Add {operation.DisplayName}, {FieldKindPhrase(names, operation)}{(operation.Required ? ", required" : "")}.";

    /// <summary>
    /// Presentation decides the phrase where it has one, because a choice stored as text
    /// and a rating stored as a whole number are not what a reviewer is being asked
    /// about. Storage kind answers the rest.
    /// </summary>
    private static string FieldKindPhrase(DiffNames names, AddFieldOperation operation) => operation.Presentation switch
    {
        "singleChoice" => ChoicePhrase(names, operation),
        // A rating without both bounds is not a scale, so it is described as the number it is.
        "rating" when operation.Scale is { } scale => $"a rating from {scale.Min} to {scale.Max}",
        "longText" => "a paragraph of text",
        _ => operation.StorageKind switch
        {
            NendoStorageKind.Integer => "a whole number",
            NendoStorageKind.Decimal => "a decimal number",
            NendoStorageKind.Boolean => "a yes or no",
            NendoStorageKind.Date => "a date",
            NendoStorageKind.DateTime => "a date and time",
            NendoStorageKind.Uuid => "an identifier",
            // The target is resolved from a configureReference anywhere in this change set,
            // so the two operations describe one change even when they arrive apart. Said
            // without the target when nothing configures it, rather than guessed at.
            NendoStorageKind.Reference => names.ReferenceTargets.TryGetValue(operation.FieldId, out var target)
                ? $"a reference to {EntityName(names, target)}"
                : "a reference to another record type",
            _ => "a line of text",
        },
    };

    /// <summary>
    /// The options, named. They are on the addField operation itself, which is what makes
    /// a choice field with no tones describable: before this, its options appeared only as
    /// setChoiceMetadata lines, so a field whose options were never given colours went
    /// through review with nothing said about them at all.
    /// </summary>
    private static string ChoicePhrase(DiffNames names, AddFieldOperation operation)
    {
        if (operation.Options.Count == 0) return "a choice with no options";
        var named = operation.Options
            .Select(option => names.ChoiceNames.TryGetValue((operation.FieldId, option), out var display) ? display : option)
            .ToArray();
        return $"a choice of {JoinWithOr(named)}";
    }

    private static string JoinWithOr(IReadOnlyList<string> values) => values.Count switch
    {
        1 => values[0],
        2 => $"{values[0]} or {values[1]}",
        _ => $"{string.Join(", ", values.Take(values.Count - 1))} or {values[^1]}",
    };

    private static string FieldName(DiffNames names, string fieldId) =>
        names.Fields.TryGetValue(fieldId, out var display) ? display : $"unknown field \"{fieldId}\"";

    private static string EntityName(DiffNames names, string entityId) =>
        names.Entities.TryGetValue(entityId, out var display) ? display : $"unknown record type \"{entityId}\"";

    /// <summary>
    /// What a definition will do, in the words of the person accepting it. A trigger
    /// is the line that matters most here — it is the one that makes later edits write
    /// records nobody typed into — so it names its events and its action rather than
    /// being summarised as "behaviour".
    /// </summary>
    private static string BehaviourSummary(DiffNames names, SetBehaviourDefinitionOperation operation) =>
        operation.Definition switch
        {
            NendoCalculationDefinition value =>
                $"Calculate {value.DisplayName} on {EntityName(names, value.EntityId)} instead of storing it.",
            NendoFunctionDefinition value =>
                $"Define the reusable calculation {value.DisplayName}.",
            NendoActionDefinition value =>
                $"Define the action {value.DisplayName}: {StepSummary(value)}.",
            NendoTriggerDefinition value =>
                $"Run {HumanId(value.ActionId)} automatically when a {EntityName(names, value.EntityId)} record is {EventSummary(value.Events)}" +
                (value.RelevantFieldIds.Count == 0
                    ? ""
                    : $" (updates to {string.Join(", ", value.RelevantFieldIds.Select(field => FieldName(names, field)))})") +
                (value.ConditionExpression is null ? "." : ", while its condition holds."),
            _ => "Install a behaviour definition.",
        };

    private static string StepSummary(NendoActionDefinition action) =>
        string.Join(", ", action.Steps.Select(step => step.Kind switch
        {
            NendoActionStepKind.SetField => $"set {string.Join(" and ", step.Assignments.Select(assignment => HumanId(assignment.FieldId)))}",
            NendoActionStepKind.CreateRecord => $"add a {HumanId(step.EntityId ?? "record")} record",
            NendoActionStepKind.DeleteRecord => "delete the related record",
            _ => "change data",
        }));

    private static string EventSummary(NendoTriggerEvents events) =>
        string.Join(" or ", new[]
        {
            events.HasFlag(NendoTriggerEvents.Created) ? "added" : null,
            events.HasFlag(NendoTriggerEvents.Updated) ? "changed" : null,
            events.HasFlag(NendoTriggerEvents.Deleted) ? "deleted" : null,
        }.OfType<string>());

    /// <summary>
    /// A node in owner-facing words. Several roots of a kind are now ordinary, so
    /// the noun alone stops identifying one: a named node is described by its
    /// name, and a name shared with another node keeps its stable ID so two lines
    /// of the same summary cannot be confused.
    /// </summary>
    private static string NodeDescription(DiffNames names, string nodeId)
    {
        if (!names.NodeKinds.TryGetValue(nodeId, out var kind)) return "an unknown node";
        // An unnamed node is described by what it is. It used to be described by its
        // identifier prettified into words, which reads as a name the author chose and
        // is not one.
        if (!names.NodeLabels.TryGetValue(nodeId, out var label)) return KindNoun(kind);
        return $"{KindNoun(kind)} \"{label}\"{Position(names, nodeId, kind, label)}";
    }

    /// <summary>
    /// A surface named through its root node, or null when this change set and the active
    /// file between them do not have one. The surface ID is not itself a node, so it can
    /// never be described directly.
    /// </summary>
    private static string? SurfaceName(DiffNames names, string surfaceId, string nodeId)
    {
        if (!names.SurfaceRoots.TryGetValue(surfaceId, out var rootId)) return null;
        // A parentless node registers as its own surface root. Describing a binding as
        // sitting on itself is worse than not naming the surface at all.
        if (string.Equals(rootId, nodeId, StringComparison.Ordinal)) return null;
        if (!names.NodeKinds.TryGetValue(rootId, out var kind)) return null;
        return names.NodeLabels.TryGetValue(rootId, out var label)
            ? $"{KindNoun(kind)} \"{label}\"{Position(names, rootId, kind, label)}"
            : KindNoun(kind);
    }

    /// <summary>
    /// Which of several identically named nodes this one is. Two roots of a kind may
    /// legitimately carry the same title, and the summary used to tell them apart by
    /// printing the stable ID — an identifier in front of a person who has no use for
    /// one. Counting them says the same thing in their terms, and says nothing at all
    /// when the name is unambiguous.
    /// </summary>
    private static string Position(DiffNames names, string nodeId, string kind, string label)
    {
        var peers = names.NodeOrder
            .Where(id => string.Equals(names.NodeKinds.GetValueOrDefault(id, string.Empty), kind, StringComparison.Ordinal) &&
                         string.Equals(names.NodeLabels.GetValueOrDefault(id, string.Empty), label, StringComparison.Ordinal))
            .ToArray();
        if (peers.Length < 2) return string.Empty;
        var index = Array.IndexOf(peers, nodeId);
        return index < 0 ? string.Empty : $" ({Ordinal(index + 1)} of {Cardinal(peers.Length)})";
    }

    private static string Ordinal(int position) => position switch
    {
        1 => "the first",
        2 => "the second",
        3 => "the third",
        4 => "the fourth",
        5 => "the fifth",
        _ => $"number {position}",
    };

    private static string Cardinal(int count) => count switch
    {
        2 => "two",
        3 => "three",
        4 => "four",
        5 => "five",
        _ => count.ToString(),
    };

    private static string KindNoun(string kind) => kind switch
    {
        "recordForm" => "the record form",
        "recordList" => "the record list",
        "boardSurface" => "the grouped board",
        "calendarSurface" => "the calendar",
        "timelineSurface" => "the timeline",
        "extensionGraphSurface" => "the custom graph view",
        "extensionRecordsSurface" => "the custom record view",
        "extensionRecordPanel" => "the custom view on the record page",
        "gallerySurface" => "the gallery",
        "detailSurface" => "the record page",
        "recordCommand" => "the record command",
        "tabGroup" => "the tab group",
        "section" => "the section",
        "relatedList" => "the related records",
        "summaryTile" => "the summary",
        "breakdownChart" => "the breakdown chart",
        "progressTile" => "the progress ring",
        "overviewSurface" => "the front page",
        "recentList" => "the recent records",
        "rangeTile" => "the range",
        "trendChart" => "the trend",
        "activityGrid" => "the activity grid",
        "matrixSurface" => "the matrix",
        "rankedList" => "the ranking",
        "filterClause" => "the condition",
        "commandStep" => "the command step",
        "fieldBinding" => "the field",
        _ => "the node",
    };

    private static NendoSemanticDiffEntry Entry(
        string kind,
        string summary,
        NendoReversibilityClass reversibility,
        params string[] semanticIds) => new(
            kind,
            summary,
            semanticIds.ToList().AsReadOnly(),
            reversibility);

    /// <summary>
    /// What this node is, named. A node the same change set gives a title to is announced
    /// by that title, and the line that would have set it separately is dropped: "Add
    /// grouped board." followed six lines later by "Name the surface Open work by client."
    /// is the same complaint the binding pair carried — a first line that says nothing —
    /// and it reads worse on a root, where the five configuration lines in between belong
    /// to a screen the reviewer cannot yet name.
    /// </summary>
    private static string AddNodeSummary(AddUiNodeOperation operation, DiffNames names)
    {
        if (operation.Kind == "summaryTile") return TileSentence(operation, names);
        if (operation.Kind != "fieldBinding" && names.NodeLabels.TryGetValue(operation.NodeId, out var label))
        {
            return $"Add {KindNoun(operation.Kind)} \"{label}\"{Position(names, operation.NodeId, operation.Kind, label)}{Starting(operation, names)}.";
        }
        return UnnamedNodeSummary(operation, names);
    }

    /// <summary>
    /// A summary tile as a reviewer would state it: what it counts, over what, and its
    /// label, in one sentence. "Add the summary "Delivered"." followed by "Count the
    /// records covered." and "Count one board column rather than the whole surface." was
    /// three lines for one number (W-052).
    /// </summary>
    private static string TileSentence(AddUiNodeOperation operation, DiffNames names)
    {
        var terms = names.Tiles.GetValueOrDefault(operation.NodeId) ?? new TileTerms(null, null, null);
        var field = names.BindingFields.TryGetValue(operation.NodeId, out var fieldId) ? FieldName(names, fieldId) : "the field";
        var measure = (terms.Aggregate ?? "count") switch
        {
            "count" => "Count the records",
            "sum" => $"Total {field}",
            "min" => $"Show the smallest {field}",
            "max" => $"Show the largest {field}",
            var other => $"Summarise {field} by {other}",
        };
        var parentKind = operation.ParentNodeId is { } parent ? names.NodeKinds.GetValueOrDefault(parent, string.Empty) : string.Empty;
        var coverage = terms.Scope == "group" ? "in each column"
            : parentKind == "relatedList" ? "over every related record"
            : terms.EntityId is { } entityId ? $"over every {EntityName(names, entityId)} record"
            : "over every record shown";
        var label = names.NodeLabels.TryGetValue(operation.NodeId, out var title)
            ? $" as \"{title}\"{Position(names, operation.NodeId, operation.Kind, title)}"
            : string.Empty;
        return $"{measure} {coverage}{label}.";
    }

    /// <summary>
    /// The direction of an ordering in the field's own terms, for the line that names the
    /// field when both arrive with the node: newest first for a date, largest first for a
    /// number, A to Z for text. Nothing when the direction is not in this change set.
    /// </summary>
    private static string DirectionClause(SetUiPropertyOperation operation, DiffNames names)
    {
        if (!names.AddedNodes.Contains(operation.NodeId)) return string.Empty;
        var ordering = names.Orderings.GetValueOrDefault(operation.NodeId);
        if (ordering?.Direction is not { } direction) return string.Empty;
        var descending = direction == "descending";
        var kind = ordering.FieldId is { } fieldId && names.FieldKinds.TryGetValue(fieldId, out var known) ? known : NendoStorageKind.Unsupported;
        return kind switch
        {
            NendoStorageKind.Date or NendoStorageKind.DateTime => descending ? ", newest first" : ", oldest first",
            NendoStorageKind.Integer or NendoStorageKind.Decimal => descending ? ", largest first" : ", smallest first",
            NendoStorageKind.Text => descending ? ", Z to A" : ", A to Z",
            _ => descending ? ", descending" : ", ascending",
        };
    }

    /// <summary>How a section added here says it starts, on the line that adds it.</summary>
    private static string Starting(AddUiNodeOperation operation, DiffNames names) =>
        operation.Kind == "section" && names.Opens.TryGetValue(operation.NodeId, out var starts)
            ? $", starting {starts}"
            : string.Empty;

    private static string UnnamedNodeSummary(AddUiNodeOperation operation, DiffNames names) => operation.Kind switch
    {
        // The field this binding shows, on the surface it shows it on, in one sentence.
        // A binding whose field is set later in a change set this does not see says the
        // general thing instead, which is true rather than invented.
        // A custom view's own binding is a field the view receives, not one shown on the page
        // or screen around it; the old sentence said a record page would show it.
        "fieldBinding" when names.BindingFields.TryGetValue(operation.NodeId, out var viewed) &&
            operation.ParentNodeId is { } parent && NendoExtensionViewDefinition.IsViewKind(names.NodeKinds.GetValueOrDefault(parent)) =>
            names.NodeLabels.TryGetValue(parent, out var view)
                ? $"Let the custom view \"{view}\" read {FieldName(names, viewed)}."
                : $"Let the custom view read {FieldName(names, viewed)}.",
        "fieldBinding" when names.BindingFields.TryGetValue(operation.NodeId, out var fieldId) =>
            SurfaceName(names, operation.SurfaceId, operation.NodeId) is { } surface
                ? $"Show {FieldName(names, fieldId)} on {surface}."
                : $"Show {FieldName(names, fieldId)}.",
        "recordForm" => "Add record form.",
        "recordList" => "Add record list.",
        "boardSurface" => "Add grouped board.",
        "calendarSurface" => "Add a month calendar of a date field, with its own undated view.",
        "timelineSurface" => "Add a timeline of a date field, with its own undated view.",
        "extensionGraphSurface" => "Add an isolated custom graph view. Its pinned package needs separate installation and device consent; records remain available in Studio.",
        "extensionRecordsSurface" => "Add an isolated custom view of these records as typed columns. Its pinned package needs separate installation and device consent; records remain available in Studio.",
        "extensionRecordPanel" => "Add an isolated custom view of each record to its page. It starts only when asked; its pinned package needs separate installation and device consent, and the page stays editable.",
        "gallerySurface" => "Add a gallery of cards, one per record.",
        "detailSurface" => "Add a record page.",
        "recordCommand" => "Add record command.",
        "tabGroup" => "Add a tab group whose sections become the named tabs.",
        "section" => "Add a section to group fields on its surface.",
        "relatedList" => "Show related records of another record type.",
        "fieldBinding" => "Show a field on its surface.",
        "commandStep" => "Add a field this command sets.",
        "filterClause" when names.Filters.TryGetValue(operation.NodeId, out var terms) => FilterSentence(operation, names, terms),
        "filterClause" => "Add a condition that narrows what this surface shows.",
        "summaryTile" => "Add a summary of the records this surface covers.",
        "breakdownChart" => "Add a breakdown chart of the records this surface covers, one exact number per group.",
        "progressTile" => "Add a progress ring of the records matching its conditions over everything this surface covers.",
        "overviewSurface" => "Add a front page for this file, whose tiles each name the record type they read.",
        "recentList" => "Show the most recent records of one record type on the front page.",
        "rangeTile" => "Add a range stating the smallest and largest value of one field.",
        "trendChart" => "Add a trend chart, one exact number per month or week over a stretch of time.",
        "activityGrid" => "Add an activity grid, one square per day of a year toned by how much happened on it.",
        "matrixSurface" => "Add a matrix crossing two choice fields, with an exact count in every cell.",
        "rankedList" => "Rank the records of one record type by a number, largest first, each with a bar.",
        // A kind with no summary of its own would be described by prettifying its
        // identifier, which is how a review comes to name things that do not exist.
        _ => $"Add a {operation.Kind} node.",
    };

    /// <summary>
    /// A filter clause as a reviewer would state it: what it keeps, named by the field,
    /// the comparison and the value in one sentence. On a progress ring the clause
    /// decides what is counted rather than what is shown, and the sentence says so.
    /// </summary>
    private static string FilterSentence(AddUiNodeOperation operation, DiffNames names, FilterTerms terms)
    {
        var field = terms.FieldId is { } fieldId ? FieldName(names, fieldId) : "a field";
        var value = terms.Value is { } given ? Text(given, "blank") : "the value";
        var condition = (terms.Operator ?? "eq") switch
        {
            "eq" => $"{field} is {value}",
            "ne" => $"{field} is not {value}",
            "lt" => $"{field} is less than {value}",
            "lte" => $"{field} is at most {value}",
            "gt" => $"{field} is greater than {value}",
            "gte" => $"{field} is at least {value}",
            "isNull" => $"{field} is empty",
            "isNotNull" => $"{field} is set",
            var other => $"{field} is {other} {value}",
        };
        var counted = operation.ParentNodeId is { } parent &&
            names.NodeKinds.GetValueOrDefault(parent, string.Empty) == "progressTile";
        return counted ? $"Count only records where {condition}." : $"Show only records where {condition}.";
    }

    /// <summary>
    /// A move is where tab membership changes: putting a section into a tab group
    /// makes it a tab, and taking it out returns it to the page, so both
    /// directions are stated rather than summarised as a position change.
    /// </summary>
    private static string MoveSummary(MoveUiNodeOperation operation, DiffNames names)
    {
        var node = NodeDescription(names, operation.NodeId);
        if (operation.ParentNodeId is null)
            return names.NodeKinds.GetValueOrDefault(operation.NodeId, string.Empty) == "section"
                ? $"Move {node} out of its container to position {operation.Position} of its surface, where it is no longer a tab."
                : $"Move {node} to position {operation.Position} of its surface.";
        var parentKind = names.NodeKinds.GetValueOrDefault(operation.ParentNodeId, string.Empty);
        var parent = NodeDescription(names, operation.ParentNodeId);
        return parentKind == "tabGroup"
            ? $"Make {node} tab {operation.Position + 1} of {parent}."
            : $"Move {node} into {parent} at position {operation.Position}.";
    }

    private static string SetPropertySummary(SetUiPropertyOperation operation, DiffNames names)
    {
        // What a property means depends on the node carrying it: a title names a
        // section, a relation or a surface, and a value is assigned by a command
        // step or compared by a filter.
        var kind = names.NodeKinds.GetValueOrDefault(operation.NodeId, string.Empty);
        return operation.PropertyName switch
        {
            "packageId" => $"Use custom-view package {Text(operation.Value, "package")}; installation and consent are separate.",
            "packageVersion" => $"Pin package version {Text(operation.Value, "version")} without automatic updates.",
            "packageDigest" => $"Pin the exact package archive {Text(operation.Value, "digest")}; a different digest needs fresh device consent.",
            "protocolVersion" => $"Require custom-view protocol {Text(operation.Value, "version")}.",
            "configurationVersion" => $"Use custom-view configuration version {Text(operation.Value, "version")}.",
            "configuration" => "Retain the bounded custom-view configuration; unsupported versions stay disabled.",
            "edgeEntityId" => $"Read graph relationships from {EntityName(names, Text(operation.Value, "entity"))}.",
            "labelFieldId" => kind == NendoExtensionViewDefinition.NodeKind
                ? $"Disclose {FieldName(names, Text(operation.Value, "field"))} as the graph node label."
                : $"Disclose {FieldName(names, Text(operation.Value, "field"))} as each record's label.",
            "statusFieldId" => $"Disclose {FieldName(names, Text(operation.Value, "field"))} as exact graph status text.",
            "sourceFieldId" => $"Follow {FieldName(names, Text(operation.Value, "field"))} to each edge's source node.",
            "targetFieldId" => $"Follow {FieldName(names, Text(operation.Value, "field"))} to each edge's target node.",
            // A board grouped by a reference has columns that are records rather than
            // options, and a reviewer reading "group records by Client" would not learn
            // that the lanes now come from another record type and can outgrow the board.
            "groupByFieldId" => kind == "breakdownChart"
                ? $"Break the numbers down by {FieldName(names, Text(operation.Value, "field"))}."
                : names.ReferenceTargets.TryGetValue(Text(operation.Value, "field"), out var target)
                    ? $"Give the board one column per {EntityName(names, target)} record, from {FieldName(names, Text(operation.Value, "field"))}, " +
                      $"and draw nothing above {NendoSemanticVocabulary.MaximumReferenceBoardColumns} of them."
                    : $"Group records by {FieldName(names, Text(operation.Value, "field"))}.",
            "dateFieldId" => kind switch
            {
                "timelineSurface" => $"Place each record on the timeline by {FieldName(names, Text(operation.Value, "field"))}.",
                "trendChart" or "activityGrid" => $"Count each record in the period of its {FieldName(names, Text(operation.Value, "field"))}.",
                _ => $"Place each record on the calendar by {FieldName(names, Text(operation.Value, "field"))}.",
            },
            "endDateFieldId" => $"End each span at {FieldName(names, Text(operation.Value, "field"))}.",
            "rowByFieldId" => $"Make one row per {FieldName(names, Text(operation.Value, "field"))}.",
            "columnByFieldId" => $"Make one column per {FieldName(names, Text(operation.Value, "field"))}.",
            "rankByFieldId" => $"Rank the records by {FieldName(names, Text(operation.Value, "field"))}{RankClause(operation, names)}.",
            "title" => kind switch
            {
                "section" => $"Name the section {Named(names, operation)}.",
                "tabGroup" => $"Name the tab group {Named(names, operation)}.",
                "relatedList" => $"Name the related records {Named(names, operation)}.",
                "summaryTile" => $"Label the summary {Named(names, operation)}.",
                "breakdownChart" => $"Label the chart {Named(names, operation)}.",
                "progressTile" => $"Label the ring {Named(names, operation)}.",
                "trendChart" => $"Label the trend {Named(names, operation)}.",
                "activityGrid" => $"Label the activity grid {Named(names, operation)}.",
                "rankedList" => $"Label the ranking {Named(names, operation)}.",
                _ => $"Name the surface {Named(names, operation)}.",
            },
            "label" => $"Name the command {Named(names, operation)}.",
            // A bucket and a range are closed words, so the sentence says what a person
            // will see rather than echoing the word back at them.
            "bucket" => Text(operation.Value, "month") switch
            {
                "week" => "Draw one column per week.",
                "month" => "Draw one column per month.",
                var other => $"Draw one column per {other}.",
            },
            "range" => Text(operation.Value, "last12Months") switch
            {
                "last12Months" => "Cover the last twelve months, ending with this one.",
                "last6Months" => "Cover the last six months, ending with this one.",
                "last90Days" => "Cover the last ninety days, ending today.",
                "last30Days" => "Cover the last thirty days, ending today.",
                "thisYear" => "Cover this calendar year, from January to December.",
                "lastTwelveMonths" => "Cover the twelve months ending today.",
                var other => $"Cover {other}.",
            },
            "scope" => Text(operation.Value, NendoSemanticVocabulary.DefaultSummaryScope) switch
            {
                "group" => "Count one board column rather than the whole surface.",
                "surface" => "Count every record this surface shows, on every page.",
                var other => $"Count records at {other} scope.",
            },
            "effectKind" => "Use the bounded record update command.",
            "value" => kind switch
            {
                "filterClause" => $"Compare against {Text(operation.Value, "blank")}.",
                _ => $"Set the command value to {Text(operation.Value, "blank")}.",
            },
            "valueKind" => Text(operation.Value, "literal") switch
            {
                "today" => "Use the date the command runs.",
                "now" => "Use the time the command runs.",
                "null" => "Clear the field.",
                var other => $"Use a {other} value.",
            },
            "fieldId" => kind switch
            {
                "commandStep" => $"Set {FieldName(names, Text(operation.Value, "field"))} when the command runs.",
                "filterClause" => $"Filter on {FieldName(names, Text(operation.Value, "field"))}.",
                "summaryTile" => $"Summarise {FieldName(names, Text(operation.Value, "field"))}.",
                "rangeTile" => $"State the smallest and largest {FieldName(names, Text(operation.Value, "field"))}.",
                "trendChart" => $"Total {FieldName(names, Text(operation.Value, "field"))} in each period.",
                _ when names.Calculated.Contains(Text(operation.Value, "field")) =>
                    $"Show the calculated field {FieldName(names, Text(operation.Value, "field"))}.",
                _ => $"Bind to {FieldName(names, Text(operation.Value, "field"))}.",
            },
            // The record-page header: what heads the page, what sits under it, and which
            // choice colours it. Named so a reviewer sees the page as a person will. On a
            // timeline the same two roles title and tone each entry instead.
            "titleFieldId" => kind switch
            {
                "timelineSurface" => $"Title each entry with {FieldName(names, Text(operation.Value, "field"))}.",
                "gallerySurface" => $"Title each card with {FieldName(names, Text(operation.Value, "field"))}.",
                _ => $"Head the page with {FieldName(names, Text(operation.Value, "field"))}.",
            },
            "subtitleFieldId" => $"Show {FieldName(names, Text(operation.Value, "field"))} under the page title.",
            "accentFieldId" => kind switch
            {
                "timelineSurface" => $"Colour each entry by {FieldName(names, Text(operation.Value, "field"))}.",
                "gallerySurface" => $"Colour each card by {FieldName(names, Text(operation.Value, "field"))}.",
                _ => $"Colour the page by {FieldName(names, Text(operation.Value, "field"))}.",
            },
            // Visibility reads a calculation; the line names it so the reviewer can see
            // which yes-or-no answer decides what is on screen.
            "visibleWhen" => $"Show this only when {FieldName(names, Text(operation.Value, "field"))} is yes.",
            "opens" => Text(operation.Value, NendoSemanticVocabulary.DefaultSectionOpens) == "closed"
                ? "Start the section closed."
                : "Start the section open.",
            // On the front page a tile names the record type it reads, because the
            // surface it sits on has none to lend it.
            "entityId" => kind is "summaryTile" or "breakdownChart" or "progressTile" or "rangeTile" or "trendChart" or "activityGrid" or "recentList" or "rankedList"
                ? $"Read {EntityName(names, Text(operation.Value, "entity"))} for this number."
                : $"Bind the surface to {EntityName(names, Text(operation.Value, "entity"))}.",
            // Clearing it is a sentence of its own. Falling through to Text() would print
            // its fallback — "Say what this file is for: a description" — which reads as a
            // value the author typed rather than as the removal they asked for.
            // Clearing it is a sentence of its own. Falling through to Text() would print
            // its fallback — "Say what this file is for: a description" — which reads as a
            // value the author typed rather than as the removal they asked for.
            "description" => operation.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
                ? "Stop saying what this front page is for."
                : $"Say what this file is for: {Text(operation.Value, "a description")}",
            "limit" => kind == "rankedList"
                ? $"Rank at most {Text(operation.Value, "fifty")} of them."
                : $"Show at most {Text(operation.Value, "ten")} of them.",
            "targetEntityId" => $"Show records of {EntityName(names, Text(operation.Value, "entity"))}.",
            "viaFieldId" => $"Follow the {FieldName(names, Text(operation.Value, "field"))} reference back to this record.",
            "aggregate" => Text(operation.Value, "count") switch
            {
                "count" => "Count the records covered.",
                "sum" => "Total the field exactly.",
                "min" => "Show the smallest value of the field.",
                "max" => "Show the largest value of the field.",
                var other => $"Summarise using {other}.",
            },
            "operator" => $"Match records where the field is {OperatorPhrase(Text(operation.Value, "eq"))}.",
            "orderByFieldId" => $"Order by {FieldName(names, Text(operation.Value, "field"))}{DirectionClause(operation, names)}.",
            "orderDirection" => kind == "rankedList"
                ? Text(operation.Value, "descending") == "ascending" ? "Rank smallest first." : "Rank largest first."
                : $"Order {Text(operation.Value, "ascending")}.",
            "definitionVersion" => $"Use semantic contract version {operation.Value.GetRawText()}.",
            _ => $"Set {HumanId(operation.PropertyName)}.",
        };
    }

    /// <summary>
    /// The name a node is being given, with its stable ID when another node in
    /// scope already answers to the same words. Two lists both titled Open deals
    /// otherwise produce two identical review lines.
    /// </summary>
    private static string Named(DiffNames names, SetUiPropertyOperation operation)
    {
        var value = Text(operation.Value, "Untitled");
        var kind = names.NodeKinds.GetValueOrDefault(operation.NodeId, string.Empty);
        return $"{value}{Position(names, operation.NodeId, kind, value)}";
    }

    /// <summary>A ranking's direction on the line that names what it ranks by, when both arrive with the node.</summary>
    private static string RankClause(SetUiPropertyOperation operation, DiffNames names)
    {
        if (!names.AddedNodes.Contains(operation.NodeId)) return string.Empty;
        return names.Orderings.GetValueOrDefault(operation.NodeId)?.Direction switch
        {
            "ascending" => ", smallest first",
            "descending" => ", largest first",
            _ => string.Empty,
        };
    }

    private static string OperatorPhrase(string comparison) => comparison switch
    {
        "eq" => "equal to the value",
        "ne" => "not equal to the value",
        "lt" => "less than the value",
        "lte" => "at most the value",
        "gt" => "greater than the value",
        "gte" => "at least the value",
        "isNull" => "empty",
        "isNotNull" => "set",
        _ => comparison,
    };

    // Property values are agent-supplied JSON of any kind. GetString throws on numbers and booleans, and
    // this summary is built before proposal validation can turn a bad value into a diagnostic.
    private static string Text(JsonElement value, string fallback) => value.ValueKind switch
    {
        JsonValueKind.String => value.GetString() ?? fallback,
        JsonValueKind.Null or JsonValueKind.Undefined => fallback,
        _ => value.GetRawText(),
    };

    private static string HumanId(string value)
    {
        var segment = value.Split('.', StringSplitOptions.RemoveEmptyEntries).LastOrDefault() ?? value;
        var words = new List<string>();
        var current = new List<char>();
        foreach (var character in segment)
        {
            if (character is '-' or '_')
            {
                Flush(words, current);
            }
            else if (char.IsUpper(character) && current.Count > 0)
            {
                Flush(words, current);
                current.Add(char.ToLowerInvariant(character));
            }
            else
            {
                current.Add(character);
            }
        }
        Flush(words, current);
        var text = string.Join(' ', words);
        return text.Length == 0 ? "item" : char.ToUpperInvariant(text[0]) + text[1..];
    }

    private static void Flush(ICollection<string> words, ICollection<char> current)
    {
        if (current.Count == 0)
        {
            return;
        }
        words.Add(new string(current.ToArray()));
        current.Clear();
    }
}
