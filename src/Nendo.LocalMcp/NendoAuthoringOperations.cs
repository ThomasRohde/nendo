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
            "Add a field. storageKind (not type) is text, integer, decimal, boolean, date, dateTime, uuid or reference, matched case-insensitively and read back camelCase. presentation is null, singleLine, longText, markdown (text a page shows formatted: headings, lists, tables, code, emphasis; links are not followed), singleChoice, date or rating; options is empty unless singleChoice, and min and max are set only on rating. A reference field arrives unbound and there is no target to state here: schema.configureReference points it at one, and it may sit in the same mutation as this operation.",
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
        Definition("schema.declareHierarchy",
            "Declare one optional self-reference of a record type as its hierarchy (ADR-0019), with orderFieldId optionally naming an Integer field of the same type that orders siblings. From then on the host refuses, for every client, any write that would put a record under itself or one of its own descendants, or deeper than hierarchy.maximumDepth levels in nendo://application/vocabulary. Declaring on records that already break either rule is refused, naming them; nothing is repaired. One hierarchy per record type; its parent field cannot then be made required or retired. Move records with nendo.data.move_record.",
            ["entityId", "parentFieldId"], RevisionScoped, "orderFieldId"),
        Definition("schema.setFieldPresentation",
            "Change how a text field is shown, between singleLine, longText and markdown; no value changes. This is how a long text field written before markdown existed is shown formatted. A unique field stays singleLine.",
            ["entityId", "fieldId", "presentation"], RevisionScoped),
        Definition("schema.setFieldUnique",
            "Declare a field unique, or stop (ADR-0020): no two records of the type may hold equal values in it, and the host refuses a duplicate from every client, naming the record that holds it. Only a single-line Text field (not a single choice, not long text) or a plain Integer field can be unique. Text compares case-insensitively for ASCII letters, and an empty value never collides. Declaring over values that already collide is refused, listing them; resolve them first, nothing is renumbered.",
            ["entityId", "fieldId", "unique"], RevisionScoped),
        Definition("schema.setFieldSequence",
            "Number a unique Text field automatically, or stop (ADR-0020): on a create that leaves the field empty the host writes prefix followed by the next number, zero-padded to width digits (W- and 3 give W-001), inside the same write, so two clients never get the same code; the result's assigned list says which code each new record got. The next number is one past the highest ever seen — existing values of that shape count, a code a client writes explicitly raises it, and a number is never reused, even after its record is deleted. prefix is 1 to 16 characters, no spaces, not ending in a digit; width is 1 to 9. Declare the field unique first (schema.setFieldUnique); a numbered field may be required. prefix and width null together remove the sequence and leave every value.",
            ["entityId", "fieldId", "prefix", "width"], RevisionScoped),
        Definition("schema.removeHierarchy",
            "Stop keeping a record type a tree. Its parent and order fields stay ordinary fields with every value they hold.",
            ["entityId"], RevisionScoped),
        Definition("schema.declareLinkRule",
            "Declare which links a record type allows (ADR-0026). entityId is the link type; sourceFieldId and targetFieldId are its configured references to the records it joins, and kindFieldId its own kind. sourceKindFieldId and targetKindFieldId are the kind fields of the record types those references point at. tableEntityId is another record type whose records are the allowed combinations: tableSourceFieldId, tableTargetFieldId and tableKindFieldId hold a source kind, a target kind and a link kind, each the same kind of field as the one it stands for (a reference to the same record type, or single-line Text). From then on the host refuses, at the end of any mutation from any client, a link whose source, target and kind are all set and whose three kinds no table record holds, compared exactly as stored; a link missing any of the three is not checked. Declaring over links that are already not allowed is refused, naming them. One rule per link type; while it is declared, none of its record types or fields can be retired or shown another way.",
            ["entityId", "sourceFieldId", "targetFieldId", "kindFieldId", "sourceKindFieldId", "targetKindFieldId",
             "tableEntityId", "tableSourceFieldId", "tableTargetFieldId", "tableKindFieldId"], RevisionScoped),
        Definition("schema.removeLinkRule",
            "Stop checking a link record type against its allowed links. Every link and every table record stays as it is.",
            ["entityId"], RevisionScoped),
        Definition("application.setPurpose",
            "Say what this file is for, in the author's words, or send purpose as null to clear it. The file carries this itself, whether or not it has a front page, and nendo://application/describe leads with it. Plain prose the person reads as written: not markup, not a template and never a field reference. A blank is a clear, not a stored empty value, and a file nobody has told stays empty rather than being given something derived from its file name. An overviewSurface's own description is a different thing: it is that page's, drawn under its title.",
            ["purpose"], RevisionScoped),
        Definition("application.setLook",
            "Give this file its own look, or return a part to its default: tone is one of choiceTones, letter one letter or digit; null for either keeps that part's default. The look is how a person tells this file from others open beside it: a badge in that tone with that letter on the Nendo mark, on the window, the taskbar, the notification area and notifications. Every file has one without choosing: the tone comes from the application ID and the letter from the file's name. nendo://application/manifest carries look, as chosen and as drawn.",
            ["tone", "letter"], RevisionScoped),
        Definition("schema.setKeptInNewFiles",
            "Say whether a new file of this application keeps this record type's records (ADR-0022): kept true for what the application ships with, such as a lookup of kinds; false, the default, for the person's work. A record may say otherwise with nendo.data.set_kept_in_new_files or keptInNewFiles on create, which suits a type holding both, such as folders whose top level ships with the application. Only the person makes a new file, from Nendo's File menu; nendo://application/describe shows what it would keep under newFile.",
            ["entityId", "kept"], RevisionScoped),
        Definition("application.setNewFileLabel",
            "Name one new file of this application, 1 to 40 characters on one line, such as Archi model: the File menu then offers New Archi model… for a file with the definition and only the records kept in new files. null clears it, and the menu offers New empty copy….",
            ["label"], RevisionScoped),
        Definition("ui.addNode",
            "Add one node to a surface. parentNodeId is null for a root. Place it with exactly one of: position, a sort key of 0 or more among its siblings (they show in position order, then by ID; nendo://application/surfaces gives every node's position and parentNodeId), or beforeNodeId or afterNodeId naming a sibling, from which it also takes its parent; where no free key lies there, the siblings after it move up by ui.moveNode operations added to the change set. properties sets the node's properties in the same operation, which is how a node and its configuration arrive together instead of as one operation per property.",
            ["surfaceId", "nodeId", "kind"], "position", "beforeNodeId", "afterNodeId", "parentNodeId", "properties"),
        Definition("ui.setProperty", "Set one property on one node. Prefer the properties map on ui.addNode when the node is new.",
            ["surfaceId", "nodeId", "propertyName", "value"]),
        Definition("ui.moveNode", "Move a node to another parent or place on the same surface: position as on ui.addNode, or beforeNodeId or afterNodeId naming the sibling to put it beside. Moving a screen this way keeps it where a person expects it when you replace another.",
            ["surfaceId", "nodeId"], "position", "beforeNodeId", "afterNodeId", "parentNodeId"),
        Definition("ui.removeNode", "Remove a node, and with it everything under it.",
            ["surfaceId", "nodeId"]),
        Definition("extension.setPackage",
            "Create a custom-view package in the file, or change its title, entryPoint (default index.html), version (semver) or description. packageId is lowercase and dotted, such as org.example.map, 3-80 characters; it is the package's stable name. The package's code lives in the file and a person reviews it as code, line by line, before accepting it. Once accepted, it runs in the Workbench whenever a view that names the package is shown, and reaches the file only through window.nendo from /_nendo/api.js. Before writing that code, read nendo://application/view-api. kind \"skill\" makes an agent skill instead (ADR-0024): no entryPoint, a SKILL.md at its root whose frontmatter has name (the packageId's last segment) and description, never run, listed by skills/list. A package keeps its kind.",
            ["packageId", "title"], "entryPoint", "version", "description", "kind"),
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
        Data("data.setKeptInNewFiles",
            "Keep one record in a new file of this application (kept true), leave it out (false), or let it follow its record type (null). The same as nendo.data.set_kept_in_new_files, inside a change set.",
            ["entityId", "recordId", "kept"]),
        Data("data.backfillRetiredField", "Fill one explicitly selected retained value on a retired field, so a field can be made required.",
            ["entityId", "recordId", "fieldId", "expectedRecordVersion", "value"], "expectedTargetRecordVersion"),
        Data("data.convertLegacyReference",
            "Convert an unbound legacy Reference field's stored text into reference values. This does not convert an ordinary text field. records maps every source record, including nulls, to an explicit {recordId, expectedRecordVersion, targetRecordId, expectedTargetRecordVersion}; targetRecordId null clears an optional value and no target is inferred. Pair it with schema.configureReference in a second mutation. Original values remain in history; the conversion is irreversible-declared.",
            ["entityId", "fieldId", "targetEntityId", "labelFieldId", "records"], RevisionScoped),
    ];

    /// <summary>
    /// The rules that are easy to break and expensive to discover, published in the
    /// vocabulary as <c>authoringRules</c>. They were the second half of
    /// <c>nendo.change_set.add_operations</c>'s description until a client's 2,048-character
    /// cut took its last two sentences; the description now names this list instead.
    /// </summary>
    internal static IReadOnlyList<string> Rules { get; } =
    [
        "Identifiers are global to the file for entityId, fieldId and nodeId. A record is identified by entityId plus recordId; recordId is unique within its record type. Prefix IDs with their owner (task, taskTitle) to keep them readable.",
        "A mutation is the materialization boundary for definitions: a required field sits in the same mutation as its schema.createEntity, or is added optional and made required later. UI nodes are exempt.",
        "expectedDefinitionRevision may be omitted wherever an operation lists it: the host fills in the value for that operation's position. Sent, it is honoured exactly.",
        "ui.addNode takes an inline properties map, so a node and its configuration cost one operation. Each property still expands to one canonical ui.setProperty, counted against the canonicalOperationLimit that every response echoes beside the submitted count.",
        "Contract version 3 declares definitionVersion=3 on every root; mixing versions across roots fails closed.",
        "A payload the host cannot bind is refused by add_operations itself, naming the mutation, the operation and the key, and nothing enters the draft.",
        "A failed validate leaves the draft open and names every independent refusal, up to five, each by operationId: correct them together with nendo.change_set.amend rather than starting again.",
        "Nothing in a change set touches the file until the person accepts the validated proposal in Nendo, or, at Unattended only, nendo.change_set.accept applies it.",
        "What a new file of the application keeps is data too (ADR-0022): when you seed records the application ships with, such as lookups or top-level folders, keep them (schema.setKeptInNewFiles for a whole type, keptInNewFiles on create for single records) and leave the work out, so the person can start a new file without deleting anything.",
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
