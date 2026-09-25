using Nendo.Engine;

namespace Nendo.LocalMcp;

/// <summary>
/// The closed authoring union: every canonical operation an agent may send, with
/// the payload fields each takes.
/// <para>
/// This table is both the published description and the enforced allowlist —
/// <see cref="NendoAgentAuthoringService"/> builds its accepted field sets from
/// it — so a payload field that is documented is a payload field that is
/// accepted, and one that is not documented is refused.
/// </para>
/// <para>
/// It exists as data because the same specification was previously prose inside
/// <c>nendo.change_set.add_operations</c>'s tool description, which grew long
/// enough to be truncated mid-token in a client's tool listing. A tool listing is
/// not a place to keep a schema; it is a place to point at one.
/// </para>
/// </summary>
internal static class NendoAuthoringOperations
{
    private static NendoOperationDescription Definition(
        string operationType,
        string summary,
        string[] required,
        params string[] optional) => new(operationType, "definition", required, optional, summary);

    private static NendoOperationDescription Data(
        string operationType,
        string summary,
        string[] required,
        params string[] optional) => new(operationType, "data", required, optional, summary);

    /// <summary>
    /// An operation that validates against the definition revision. Omit
    /// <c>expectedDefinitionRevision</c> and the host fills in the value for that
    /// operation's position in the change set; send it and it is honoured exactly.
    /// </summary>
    private const string RevisionScoped = "expectedDefinitionRevision";

    internal static IReadOnlyList<NendoOperationDescription> All { get; } =
    [
        Definition("schema.createEntity",
            "Create a record type. A record type exists physically from the end of the mutation that creates it, so a required field must sit in the same mutation or be added optional and made required later.",
            ["entityId", "displayName"]),
        Definition("schema.addField",
            "Add a field. storageKind (not type) is text, integer, decimal, boolean, date, dateTime, uuid or reference, matched case-insensitively and read back camelCase. presentation is null, singleLine, longText, singleChoice, date or rating; options is empty unless singleChoice, and min and max are set only on rating. A reference field arrives unbound and there is no target to state here: schema.configureReference points it at one, and it may sit in the same mutation as this operation.",
            ["entityId", "fieldId", "displayName", "storageKind", "required"],
            "presentation", "options", "min", "max"),
        Definition("schema.renameEntity", "Change a record type's display name; its stable ID does not move.",
            ["entityId", "displayName"], RevisionScoped),
        Definition("schema.renameField", "Change a field's display name; its stable ID does not move.",
            ["entityId", "fieldId", "displayName"], RevisionScoped),
        Definition("schema.configureReference",
            "Point a reference field at its target record type and the field that labels it. It may sit in the same mutation as the schema.addField that creates the field, because binding is metadata and only the physical column waits for the end of a mutation. Only an unbound reference field can be configured, and the label must be a text field on the target record type. A field that already holds values needs an explicit reviewed conversion instead; nothing is guessed. reviewedRecords repeats a conversion's mapping with source versions incremented by one.",
            ["entityId", "fieldId", "targetEntityId", "labelFieldId"], RevisionScoped, "reviewedRecords"),
        Definition("schema.setFieldRequired", "Make a field required or optional. Making one required validates every retained record first.",
            ["entityId", "fieldId", "required"], RevisionScoped),
        Definition("schema.setRetired", "Retire or reactivate a record type, or one field of it; stored data is retained either way. fieldId is null for the record type itself.",
            ["entityId", "retired"], "fieldId", RevisionScoped),
        Definition("schema.setChoiceMetadata",
            "Name one choice of a singleChoice field, mark it available or retired and give it a tone; the stored choice ID is preserved. tone is one of choiceTones in nendo://application/vocabulary, or null for no colour — never a hex value. The operation sets the whole of the option's metadata, so read the schema first: a rename that omits tone clears the colour, and the review line says so.",
            ["entityId", "fieldId", "choiceId", "displayName", "retired"], RevisionScoped, "tone"),
        Definition("behaviour.setDefinition",
            "Install or replace one calculation, reusable function, action or trigger at its stable ID. definitionKind is Calculation, Function, Action or Trigger. body is the typed definition for that kind; nendo://application/vocabulary carries the behaviour catalogue it must be written against — the closed function set, the operators, the scalar domain, the binding kinds, the aggregate rules and the limits. contractVersion defaults to the one this host implements. Installing a definition does not grant permission to run it: a file whose actions run automatically is not editable until the person at this device approves it, which is a host action with no MCP equivalent.",
            ["definitionId", "definitionKind", "body"], RevisionScoped, "contractVersion"),
        Definition("behaviour.removeDefinition",
            "Remove one behaviour definition by stable ID. definitionKind is stated so a removal cannot silently hit a different kind. Removing something still referenced is refused unless the same ordered change set also removes or rewires the reference.",
            ["definitionId", "definitionKind"], RevisionScoped),
        Definition("application.setPurpose",
            "Say what this file is for, in the author's words, or send purpose as null to clear it. The file carries this itself, whether or not it has a front page, and nendo://application/describe leads with it. Plain prose the person reads as written: not markup, not a template and never a field reference. A blank is a clear, not a stored empty value, and a file nobody has told stays empty rather than being given something derived from its file name. An overviewSurface's own description is a different thing: it is that page's, drawn under its title.",
            ["purpose"], RevisionScoped),
        Definition("ui.addNode",
            "Add one node to a surface. parentNodeId is null for a root; position is a zero-based integer. properties sets the node's properties in the same operation, which is how a node and its configuration arrive together instead of as one operation per property.",
            ["surfaceId", "nodeId", "kind", "position"], "parentNodeId", "properties"),
        Definition("ui.setProperty", "Set one property on one node. Prefer the properties map on ui.addNode when the node is new.",
            ["surfaceId", "nodeId", "propertyName", "value"]),
        Definition("ui.moveNode", "Move a node to another parent or position on the same surface.",
            ["surfaceId", "nodeId", "position"], "parentNodeId"),
        Definition("ui.removeNode", "Remove a node, and with it everything under it.",
            ["surfaceId", "nodeId"]),
        Definition("extension.setPackage",
            "Create a custom-view package in the file, or change its title, entryPoint (default index.html), version (semver) or description. packageId is lowercase and dotted, such as org.example.map, 3-80 characters; it is the package's stable name. The package's code lives in the file and a person reviews it as code, line by line, before accepting it. This host stores and reviews package code; it does not run it yet.",
            ["packageId", "title"], "entryPoint", "version", "description"),
        Definition("extension.putFile",
            "Put one file into a package, adding it or replacing what the path held. Send the content as text (stored as UTF-8 exactly as written) or base64 (any bytes), or name content the file already holds by sha256 with byteLength. path is relative, of letters, digits, _ - . ~ and /, and never under _nendo/. mediaType defaults from the extension. One operation's payload is at most extensions.putFilePayloadBytes in nendo://application/vocabulary; a larger file is a first putFile followed by putFile operations for the same package and path with append true, anywhere later in the same change set, which the host joins in order. expectedSha256 makes the put conditional: a hash, or \"absent\" for a new file. A file is at most extensions.fileBytes and a change set carries at most extensions.contentBytesPerChangeSet of new content.",
            ["packageId", "path"], "text", "base64", "sha256", "byteLength", "mediaType", "expectedSha256", "append"),
        Definition("extension.removeFile",
            "Remove one file from a package. Its content stays in history, so the removal can be reversed. expectedSha256 makes it conditional on the file holding exactly that content.",
            ["packageId", "path"], "expectedSha256"),
        Definition("extension.removePackage",
            "Remove an empty package. A package that still holds files is refused; remove them with extension.removeFile first, in the same change set if you like.",
            ["packageId"]),
        Data("data.createRecord", "Create one record. expectedTargetVersions carries the current version of each non-null reference target, keyed by field ID.",
            ["entityId", "recordId", "values"], "expectedTargetVersions"),
        Data("data.setField", "Set one field at an exact expected record version.",
            ["entityId", "recordId", "fieldId", "expectedRecordVersion", "value"], "expectedTargetRecordVersion"),
        Data("data.deleteRecord", "Delete one record at its exact current version. Incoming references block the delete; values are retained for guarded restoration.",
            ["entityId", "recordId", "expectedRecordVersion"]),
        Data("data.backfillRetiredField", "Fill one explicitly selected retained value on a retired field, so a field can be made required.",
            ["entityId", "recordId", "fieldId", "expectedRecordVersion", "value"], "expectedTargetRecordVersion"),
        Data("data.convertLegacyReference",
            "Convert an unbound legacy Reference field's stored text into reference values. This does not convert an ordinary text field. records maps every source record, including nulls, to an explicit {recordId, expectedRecordVersion, targetRecordId, expectedTargetRecordVersion}; targetRecordId null clears an optional value and no target is inferred. Pair it with schema.configureReference in a second mutation. Original values remain in history; the conversion is irreversible-declared.",
            ["entityId", "fieldId", "targetEntityId", "labelFieldId", "records"], RevisionScoped),
    ];

    /// <summary>The accepted payload field names per operation type, taken from the published table.</summary>
    internal static IReadOnlyDictionary<string, IReadOnlySet<string>> AllowedPayloads { get; } =
        All.ToDictionary(
            operation => operation.OperationType,
            operation => (IReadOnlySet<string>)new HashSet<string>(
                operation.RequiredPayload.Concat(operation.OptionalPayload),
                StringComparer.Ordinal),
            StringComparer.Ordinal);
}
