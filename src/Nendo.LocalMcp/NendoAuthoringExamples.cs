using System.Text.Json;

namespace Nendo.LocalMcp;

/// <summary>One operation of a worked example, in the shape the tool accepts.</summary>
public sealed record NendoAuthoringExampleOperation(string OperationType, JsonElement Payload);

/// <summary>One mutation of a worked example.</summary>
public sealed record NendoAuthoringExampleMutation(
    string Description,
    IReadOnlyList<NendoAuthoringExampleOperation> Operations);

/// <summary>
/// A complete change set that can be sent as it stands, plus the rule it exists to
/// convey. Most of the time an authoring session loses goes to rules one correct
/// example carries instantly: which operations must share a mutation, how the
/// definition revision advances, and that a command ID is a node ID.
/// </summary>
public sealed record NendoAuthoringExample(
    string Name,
    string Purpose,
    IReadOnlyList<string> Notes,
    IReadOnlyList<NendoAuthoringExampleMutation> Mutations);

public sealed record NendoAuthoringExampleSet(
    int ContractVersion,
    IReadOnlyList<NendoAuthoringExample> Examples);

/// <summary>
/// The worked examples published at <c>nendo://application/examples</c>. They are
/// exercised against the real authoring boundary by the test suite, so an example
/// that stopped validating fails the build rather than misleading an agent.
/// </summary>
internal static class NendoAuthoringExamples
{
    internal static NendoAuthoringExampleSet Description() => new(
        Nendo.Engine.NendoSemanticVocabulary.ContractVersion,
        [
            CreateEntityWithRequiredFields(),
            ConfigureAReference(),
            ABreakdownAndARing(),
            ATrendAndAnActivityGrid(),
            AMatrixAndARanking(),
            ABoardWithALanePerProject(),
            BuildADetailSurface(),
            DefineACommand(),
            TwoCommandsAndAFilteredList(),
            SeveralViewsTabsAndACalendar(),
            ATimelineOfSpans(),
            AGalleryAndARating(),
            AFrontPageForTheFile(),
            SayWhatTheFileIsFor(),
            CalculateAndActAutomatically(),
            ACustomGraphReference(),
        ]);

    private static NendoAuthoringExample ACustomGraphReference() => new(
        "pin-an-offline-custom-graph",
        "Define a custom dependency graph while keeping package installation and execution consent separate.",
        [
            "Use the existing ui.addNode and ui.setProperty operations. The extensionGraphSurface pins a package and binds stored fields; it contains no executable assets or consent.",
            "This example's all-zero archive digest deliberately names a missing package. Replace it with the SHA-256 of the exact reviewed offline archive before using the view. A valid definition does not imply an installed package.",
            "Both distinct edge References target the node record type. Graph limits are 500 nodes, 1000 edges and 1 MiB; oversized or incomplete graphs are refused as a whole.",
            "Protocol 1 and configuration version 1 use configuration JSON text containing an empty object. Future versions are preserved but disabled. This shape requires host 1.29.0.",
        ],
        [
            new("Create nodes and dependency records",
            [
                Operation("schema.createEntity", new { entityId = "graphNode", displayName = "Node" }),
                Field("graphNode", "graphLabel", "Label", "Text", true, "singleLine", []),
                Operation("schema.createEntity", new { entityId = "graphEdge", displayName = "Dependency" }),
                Field("graphEdge", "graphFrom", "From", "Reference", false, null, []),
                Field("graphEdge", "graphTo", "To", "Reference", false, null, []),
                Operation("schema.configureReference", new { entityId = "graphEdge", fieldId = "graphFrom", targetEntityId = "graphNode", labelFieldId = "graphLabel" }),
                Operation("schema.configureReference", new { entityId = "graphEdge", fieldId = "graphTo", targetEntityId = "graphNode", labelFieldId = "graphLabel" }),
            ]),
            new("Pin the custom graph package and disclosed fields",
            [
                InlineNode("dependencyGraph", null, "extensionGraphSurface", 0, new()
                {
                    ["definitionVersion"] = 3, ["entityId"] = "graphNode", ["title"] = "Dependencies",
                    ["packageId"] = "org.nendo.dependency-graph", ["packageVersion"] = "0.1.0",
                    ["packageDigest"] = new string('0', 64), ["protocolVersion"] = 1,
                    ["configurationVersion"] = 1, ["configuration"] = "{}",
                    ["labelFieldId"] = "graphLabel", ["edgeEntityId"] = "graphEdge",
                    ["sourceFieldId"] = "graphFrom", ["targetFieldId"] = "graphTo",
                }),
            ]),
        ]);

    /// <summary>
    /// The one value that belongs to the file and needs nothing else to exist — no record
    /// type, no screen, not even a front page. Written as its own example because an agent
    /// meeting a file for the first time reads this before it reads anything else.
    /// </summary>
    private static NendoAuthoringExample SayWhatTheFileIsFor() => new(
        "say-what-the-file-is-for",
        "Say what this file is for, so a person and an agent both read it before anything else.",
        [
            "application.setPurpose stores prose on the file itself. It needs no record type and no screen: an empty file can carry one, and it survives whatever is built later.",
            "nendo://application/describe leads with it, and nendo://application/manifest carries it, so the first thing a read says about a file is what it is for rather than how many revisions it has had.",
            "It is prose the person reads as written: not markup, not a template and never a field reference. At most 4000 characters, refused above that rather than cut.",
            "Send purpose as null to clear it. A blank is a clear, and a file nobody has told reads as empty rather than being given something derived from its file name.",
            "An overviewSurface's own description is a different thing: it belongs to that page and is drawn under its title. A file with no front page still has a purpose, which is why this is not a property of that node.",
        ],
        [
            new("Say what this file is for",
            [
                Operation("application.setPurpose", new
                {
                    purpose = "What this team is working on, and what is waiting. Every entry carries the person it belongs to and the date it is wanted by; nothing here is closed until somebody says so.",
                }),
            ]),
        ]);

    private static NendoAuthoringExample CreateEntityWithRequiredFields() => new(
        "create-entity-with-required-fields",
        "Create a record type and its fields.",
        [
            "A mutation is the materialization boundary for the definition lane: a record type exists physically from the end of the mutation that created it.",
            "So a required field must sit in the same mutation as its schema.createEntity. Adding one later refuses with NPROP004, which names the field and both remedies.",
            "The other remedy is to add the field with required false and then schema.setFieldRequired in a later mutation of the same change set.",
            "storageKind is Text, Integer, Decimal, Boolean, Date, DateTime, Uuid or Reference, matched case-insensitively and read back camelCase.",
        ],
        [
            new("Create the Task record type",
            [
                Operation("schema.createEntity", new { entityId = "task", displayName = "Task" }),
                Field("task", "taskTitle", "Title", "Text", true, "singleLine", []),
                Field("task", "taskNotes", "Notes", "Text", false, "longText", []),
                Field("task", "taskStatus", "Status", "Text", false, "singleChoice", ["Todo", "Doing", "Done"]),
                Field("task", "taskDue", "Due", "Date", false, "date", []),
                Field("task", "taskDone", "Done", "Boolean", false, null, []),
            ]),
        ]);

    private static NendoAuthoringExample ConfigureAReference() => new(
        "configure-a-reference",
        "Point one record type at another and label it.",
        [
            "A Reference field is added unbound and bound by schema.configureReference. The two may sit in the same mutation: only the physical column waits for the end of a mutation, and binding is metadata. This example splits them to keep each step readable, not because it has to.",
            "labelFieldId names the field of the target that is shown in place of the raw ID; reads then carry referenceLabels without a join.",
            "expectedDefinitionRevision is optional. Omit it and the host fills in the value for this operation's position in the change set. Send it and it is honoured exactly, and a mismatch names the value to use.",
            "A configured reference is also what makes relatedList possible: a related list is the inverse of a reference aimed at the surface's own record type.",
        ],
        [
            new("Create the Project and Task record types",
            [
                Operation("schema.createEntity", new { entityId = "project", displayName = "Project" }),
                Field("project", "projectName", "Name", "Text", true, "singleLine", []),
                Operation("schema.createEntity", new { entityId = "task", displayName = "Task" }),
                Field("task", "taskTitle", "Title", "Text", true, "singleLine", []),
                Field("task", "taskProject", "Project", "Reference", false, null, []),
            ]),
            new("Bind the Task to Project reference",
            [
                Operation("schema.configureReference", new
                {
                    entityId = "task",
                    fieldId = "taskProject",
                    targetEntityId = "project",
                    labelFieldId = "projectName",
                }),
            ]),
        ]);

    private static NendoAuthoringExample BuildADetailSurface() => new(
        "build-a-detail-surface",
        "A record page with a titled section, the inverse of a reference, and an exact rollup.",
        [
            "UI nodes are exempt from the materialization boundary: a root added in one mutation accepts children added in a later one, so surface work can be split across calls freely.",
            "Every contract version 3 root declares definitionVersion 3. Mixing contract versions across roots fails closed.",
            "relatedList is addressed by targetEntityId plus the viaFieldId pointing back at this record type, and needs at least one fieldBinding child.",
            "summaryTile states one exact number over its context. count needs no field; sum, min and max each read one integer or decimal field. avg is refused by name, with the reason, in nendo://application/vocabulary.",
            "Node IDs are unique across the whole file, not scoped to a surface.",
        ],
        [
            new("Create the Project and Task record types",
            [
                Operation("schema.createEntity", new { entityId = "project", displayName = "Project" }),
                Field("project", "projectName", "Name", "Text", true, "singleLine", []),
                Operation("schema.createEntity", new { entityId = "task", displayName = "Task" }),
                Field("task", "taskTitle", "Title", "Text", true, "singleLine", []),
                Field("task", "taskEstimate", "Estimate", "Decimal", false, null, []),
                Field("task", "taskProject", "Project", "Reference", false, null, []),
            ]),
            new("Bind the Task to Project reference",
            [
                Operation("schema.configureReference", new
                {
                    entityId = "task",
                    fieldId = "taskProject",
                    targetEntityId = "project",
                    labelFieldId = "projectName",
                }),
            ]),
            new("Build the Project record page",
            [
                Node("projectPage", null, "detailSurface", 0),
                Property("projectPage", "definitionVersion", 3),
                Property("projectPage", "entityId", "project"),
                Property("projectPage", "title", "Project"),
                Node("projectOverview", "projectPage", "section", 0),
                Property("projectOverview", "title", "Overview"),
                Node("projectNameBinding", "projectOverview", "fieldBinding", 0),
                Property("projectNameBinding", "fieldId", "projectName"),
                Node("projectTasks", "projectPage", "relatedList", 1),
                Property("projectTasks", "targetEntityId", "task"),
                Property("projectTasks", "viaFieldId", "taskProject"),
                Property("projectTasks", "title", "Tasks"),
                Property("projectTasks", "orderByFieldId", "taskTitle"),
                Property("projectTasks", "orderDirection", "ascending"),
                Node("projectTaskTitle", "projectTasks", "fieldBinding", 0),
                Property("projectTaskTitle", "fieldId", "taskTitle"),
            ]),
            new("Roll the estimates up",
            [
                Node("projectEstimate", "projectTasks", "summaryTile", 1),
                Property("projectEstimate", "aggregate", "sum"),
                Property("projectEstimate", "fieldId", "taskEstimate"),
                Property("projectEstimate", "title", "Estimated"),
            ]),
        ]);

    private static NendoAuthoringExample DefineACommand() => new(
        "define-a-command",
        "One button that sets several fields at once.",
        [
            "A recordCommand root takes commandStep children. There is no effectKind property in contract version 3; that was the version 2 shape.",
            "Each commandStep names one fieldId on the same record type and a valueKind of literal, today, now or null. literal carries value; today and now resolve when the button runs, not when the definition compiles.",
            "The commandId that nendo.data.execute_command takes is this root's node ID, and nendo://application/surfaces states it under applications[].surfaces as commandId.",
            "Every step of a command lands in one mutation against one expected record version, so the button applies whole or not at all.",
        ],
        [
            new("Create the Task record type",
            [
                Operation("schema.createEntity", new { entityId = "task", displayName = "Task" }),
                Field("task", "taskTitle", "Title", "Text", true, "singleLine", []),
                Field("task", "taskStatus", "Status", "Text", false, "singleChoice", ["Todo", "Doing", "Done"]),
                Field("task", "taskClosed", "Closed on", "Date", false, "date", []),
            ]),
            new("Add a Complete button",
            [
                Node("taskComplete", null, "recordCommand", 0),
                Property("taskComplete", "definitionVersion", 3),
                Property("taskComplete", "entityId", "task"),
                Property("taskComplete", "label", "Complete"),
                Node("taskCompleteStatus", "taskComplete", "commandStep", 0),
                Property("taskCompleteStatus", "fieldId", "taskStatus"),
                Property("taskCompleteStatus", "valueKind", "literal"),
                Property("taskCompleteStatus", "value", "Done"),
                Node("taskCompleteDate", "taskComplete", "commandStep", 1),
                Property("taskCompleteDate", "fieldId", "taskClosed"),
                Property("taskCompleteDate", "valueKind", "today"),
            ]),
        ]);

    private static NendoAuthoringExample ATrendAndAnActivityGrid() => new(
        "a-trend-and-an-activity-grid",
        "A list with a trend of hours by month and an activity grid of a year of days, both grouped by a civil date the host resolves when it reads.",
        [
            "A trendChart states one exact number per bucket of a range, and an activityGrid one exact count per day of one. Their groups are the first in this vocabulary that are generated rather than declared: a choice field's options are written down, and a month is not.",
            "That is why a bucket with nothing in it is still a bucket. The host makes every bucket from the bounds before it reads, so a month with no records is drawn as a gap at zero and a quiet day as the lightest square. A chart that left them out would look exactly like a busy one.",
            "range is a closed word, never a date: last12Months, last6Months, last90Days or last30Days on a trendChart, and thisYear or lastTwelveMonths on an activityGrid. The host resolves it against today each time it reads, so a screen authored in January still means the last twelve months in December. There is no literal alternative.",
            "dateFieldId is a stored Date field. A DateTime is refused by name rather than truncated, because truncating one means choosing a time zone, which this contract version does not define.",
            "An activityGrid counts and takes no aggregate or fieldId: a square toned by a sum is a heat map of a number nobody can read back off the square.",
            "A trendChart carries at most six filterClause children rather than eight, because the host adds the two bounds of its range to the same budget. The refusal names the two it adds.",
            "Either kind moves the file to minimum host 1.25.0, which the review names as its own line.",
        ],
        [
            new("Create the Session record type",
            [
                Operation("schema.createEntity", new { entityId = "session", displayName = "Session" }),
                Field("session", "sessionTitle", "Title", "Text", true, "singleLine", []),
                Field("session", "sessionOn", "Held on", "Date", false, null, []),
                Field("session", "sessionHours", "Hours", "Decimal", false, null, []),
            ]),
            new("Build the list with its trend and its activity grid",
            [
                InlineNode("sessionList", null, "recordList", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "session",
                    ["title"] = "All sessions",
                }),
                InlineNode("sessionListTitle", "sessionList", "fieldBinding", 0, new() { ["fieldId"] = "sessionTitle" }),
                InlineNode("sessionListOn", "sessionList", "fieldBinding", 1, new() { ["fieldId"] = "sessionOn" }),
                // One exact sum per month, over the twelve months ending with this one.
                // Every month is drawn, including the ones with nothing in them.
                InlineNode("sessionHoursByMonth", "sessionList", "trendChart", 2, new()
                {
                    ["dateFieldId"] = "sessionOn",
                    ["bucket"] = "month",
                    ["range"] = "last12Months",
                    ["aggregate"] = "sum",
                    ["fieldId"] = "sessionHours",
                    ["title"] = "Hours by month",
                }),
                // A year of days, one square each, toned against the busiest.
                InlineNode("sessionActivity", "sessionList", "activityGrid", 3, new()
                {
                    ["dateFieldId"] = "sessionOn",
                    ["range"] = "thisYear",
                    ["title"] = "Sessions this year",
                }),
            ]),
        ]);

    private static NendoAuthoringExample ABoardWithALanePerProject() => new(
        "a-board-with-a-lane-per-project",
        "A board whose columns are records of another record type, not the options of a choice field.",
        [
            "boardSurface.groupByFieldId takes a single-choice field, whose options are its columns, or a bound Reference field, whose target records are. Nothing else about the board changes: the same kind, the same children, the same cards.",
            "The columns are every active record of the target type, ordered by the reference's label field. Not only the records something points at \u2014 a lane nobody has used yet is an answer, the same way an empty cell is a cell, and which records are pointed at could only be read from the board's own loaded page.",
            "The reference must be bound first. An unbound one has no target type to read columns from and no label to head them with, so it is refused when the board is authored rather than drawn empty.",
            "A board draws at most the number of reference columns that boards.maximumReferenceColumns in nendo://application/vocabulary states. Above that it draws none at all and states the record type, its count and the ceiling: a board missing its last lanes looks exactly like a board. The bound is checked when the board is read, not when it is authored, because a definition cannot know how many records a record type holds — which is the one way this differs from the grid ceiling.",
            "A reference column carries no tone. A tone is something an author put on an option, and a record has nowhere to hold one; the column takes the hue the renderer already derives for an option nobody coloured.",
            "Moving a card between columns writes the reference, and a reference write carries the target record's current version. The board holds it because it read the target type to draw the columns.",
            "A board grouped by a reference moves the file to minimum host 1.27.0. This is the one capability that is not visible in the node tree \u2014 the two kinds of board are the same shape \u2014 so the host reads the grouping field to decide it.",
        ],
        [
            new("Create the Client and Engagement record types",
            [
                Operation("schema.createEntity", new { entityId = "client", displayName = "Client" }),
                Field("client", "clientName", "Name", "Text", true, "singleLine", []),
                Operation("schema.createEntity", new { entityId = "engagement", displayName = "Engagement" }),
                Field("engagement", "engagementTitle", "Title", "Text", true, "singleLine", []),
                Field("engagement", "engagementValue", "Value", "Decimal", false, null, []),
                Field("engagement", "engagementClient", "Client", "Reference", false, null, []),
            ]),
            new("Bind the reference before any board groups by it",
            [
                Operation("schema.configureReference", new
                {
                    entityId = "engagement",
                    fieldId = "engagementClient",
                    targetEntityId = "client",
                    labelFieldId = "clientName",
                }),
            ]),
            new("A lane per client",
            [
                InlineNode("clientBoard", null, "boardSurface", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "engagement",
                    ["title"] = "Engagements by client",
                    ["groupByFieldId"] = "engagementClient",
                    ["orderByFieldId"] = "engagementTitle",
                    ["orderDirection"] = "ascending",
                }),
                // orderByFieldId orders the cards inside a lane. The lanes themselves are
                // always in label order, because a record type carries no arranged order
                // for an author to have chosen.
                InlineNode("clientBoardTitle", "clientBoard", "fieldBinding", 0, new() { ["fieldId"] = "engagementTitle" }),
                InlineNode("clientBoardValue", "clientBoard", "fieldBinding", 1, new() { ["fieldId"] = "engagementValue" }),
                // One exact number per lane, over everything the board covers rather than
                // over the page in view. This is unchanged by the grouping being a
                // reference: the column predicate is an eq on the reference field.
                InlineNode("clientBoardCount", "clientBoard", "summaryTile", 2, new()
                {
                    ["title"] = "Engagements",
                    ["aggregate"] = "count",
                    ["scope"] = "group",
                }),
            ]),
        ]);

    private static NendoAuthoringExample AMatrixAndARanking() => new(
        "a-matrix-and-a-ranking",
        "A matrix crossing two choice fields with an exact count in every cell, and a front-page ranking of the largest deals.",
        [
            "A matrixSurface is a root of its own, like a board with a second axis. rowByFieldId and columnByFieldId are single-choice or Boolean fields of the same record type, and they must be different fields: a field against itself is a diagonal with empty corners.",
            "The whole grid is one grouped read whatever its size. The host makes every cell key from the cross product of the two option sets before it reads a record, so a cell with nothing in it is stated as empty rather than left out \u2014 the same rule an empty month follows.",
            "That is why a cell can state two different quantities honestly: the number is exact over everything the surface covers, the cards in it are the surface's one loaded window, and where they differ the cell says how many it is not showing.",
            "Rows and columns are the field's options less the ones the surface's own eq and ne clauses exclude, as a board's columns are. The unset lane on each axis appears only when its own exact number is not zero. The cross product plus those two lanes must fit the published group ceiling, and a grid past it is refused rather than drawn in part.",
            "A rankedList lives on the front page, where a recentList lives. rankByFieldId is a stored Integer or Decimal; a Date is refused by name, because min and max over a Date are comparisons and a bar is arithmetic.",
            "A record with no value there is not ranked, and that isNotNull is a predicate the host adds \u2014 so a ranking carries seven filterClause children rather than eight, and the refusal names the one it adds. limit is one to fifty and is refused above that rather than narrowed.",
            "Either kind moves the file to minimum host 1.26.0, which the review names as its own line.",
        ],
        [
            new("Create the Deal record type with two toned choice fields",
            [
                Operation("schema.createEntity", new { entityId = "deal", displayName = "Deal" }),
                Field("deal", "dealTitle", "Title", "Text", true, "singleLine", []),
                Field("deal", "dealStage", "Stage", "Text", false, "singleChoice", ["Lead", "Bidding", "Won", "Lost"]),
                Field("deal", "dealSize", "Size", "Text", false, "singleChoice", ["Small", "Medium", "Large"]),
                Field("deal", "dealValue", "Value", "Decimal", false, null, []),
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Lead", displayName = "Lead", retired = false, tone = "grey" }),
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Bidding", displayName = "Bidding", retired = false, tone = "amber" }),
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Won", displayName = "Won", retired = false, tone = "green" }),
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Lost", displayName = "Lost", retired = false, tone = "red" }),
            ]),
            new("Cross stage against size",
            [
                InlineNode("dealGrid", null, "matrixSurface", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "deal",
                    ["title"] = "Stage against size",
                    ["rowByFieldId"] = "dealStage",
                    ["columnByFieldId"] = "dealSize",
                }),
                // The fields that make each card in a cell, as a board's cards are made.
                InlineNode("dealGridTitle", "dealGrid", "fieldBinding", 0, new() { ["fieldId"] = "dealTitle" }),
                InlineNode("dealGridValue", "dealGrid", "fieldBinding", 1, new() { ["fieldId"] = "dealValue" }),
                // A clause on an axis field removes its lane as well as its records: this
                // grid is three stages wide, not four.
                InlineNode("dealGridOpen", "dealGrid", "filterClause", 2, new()
                {
                    ["fieldId"] = "dealStage",
                    ["operator"] = "ne",
                    ["value"] = "Lost",
                }),
            ]),
            new("Put the largest deals on the front page",
            [
                InlineNode("dealFront", null, "overviewSurface", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["title"] = "Pipeline",
                }),
                InlineNode("dealTop", "dealFront", "rankedList", 0, new()
                {
                    ["entityId"] = "deal",
                    ["rankByFieldId"] = "dealValue",
                    ["orderDirection"] = "descending",
                    ["limit"] = 10,
                    ["title"] = "Largest deals",
                }),
                InlineNode("dealTopTitle", "dealTop", "fieldBinding", 0, new() { ["fieldId"] = "dealTitle" }),
                InlineNode("dealTopStage", "dealTop", "fieldBinding", 1, new() { ["fieldId"] = "dealStage" }),
            ]),
        ]);

    private static NendoAuthoringExample ABreakdownAndARing() => new(
        "a-breakdown-and-a-ring",
        "A list with a breakdown chart of hours by status and a progress ring of closed tickets, both read exactly over the whole filtered set.",
        [
            "A breakdownChart states one exact number per group of a closed grouping: a single-choice field's options in their configured order, or false and true for a Boolean, then the unset group. groupByFieldId is the grouping, not a filter; it spends none of the budget of eight.",
            "A chart takes the scope a summaryTile takes and is accepted where a tile is: on a recordList, a boardSurface, a detailSurface or a section. Its own filterClause children intersect the surface's, as a tile's do.",
            "A progressTile shows the records matching its own filterClause children over everything its surface shows, and needs at least one clause: a ring that narrows nothing would always be full.",
            "Both show their numbers beside the shape and a table of them behind one toggle. Clicking a segment opens the record type's first list narrowed to that group, which is renderer state and never stored.",
            "Either kind moves the file to minimum host 1.20.0, which the review names as its own line.",
        ],
        [
            new("Create the Ticket record type with toned statuses",
            [
                Operation("schema.createEntity", new { entityId = "ticket", displayName = "Ticket" }),
                Field("ticket", "ticketTitle", "Title", "Text", true, "singleLine", []),
                Field("ticket", "ticketStatus", "Status", "Text", false, "singleChoice", ["Open", "In progress", "Closed"]),
                Field("ticket", "ticketHours", "Hours", "Decimal", false, null, []),
                Operation("schema.setChoiceMetadata", new { entityId = "ticket", fieldId = "ticketStatus", choiceId = "Open", displayName = "Open", retired = false, tone = "blue" }),
                Operation("schema.setChoiceMetadata", new { entityId = "ticket", fieldId = "ticketStatus", choiceId = "In progress", displayName = "In progress", retired = false, tone = "amber" }),
                Operation("schema.setChoiceMetadata", new { entityId = "ticket", fieldId = "ticketStatus", choiceId = "Closed", displayName = "Closed", retired = false, tone = "green" }),
            ]),
            new("Build the list with its chart and its ring",
            [
                InlineNode("ticketList", null, "recordList", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "ticket",
                    ["title"] = "All tickets",
                }),
                InlineNode("ticketListTitle", "ticketList", "fieldBinding", 0, new() { ["fieldId"] = "ticketTitle" }),
                InlineNode("ticketListStatus", "ticketList", "fieldBinding", 1, new() { ["fieldId"] = "ticketStatus" }),
                // One exact sum per status, over every ticket the list shows.
                InlineNode("ticketHoursByStatus", "ticketList", "breakdownChart", 2, new()
                {
                    ["groupByFieldId"] = "ticketStatus",
                    ["aggregate"] = "sum",
                    ["fieldId"] = "ticketHours",
                    ["title"] = "Hours by status",
                }),
                // Closed tickets over all tickets, as a ring of two exact counts.
                InlineNode("ticketClosed", "ticketList", "progressTile", 3, new() { ["title"] = "Closed" }),
                InlineNode("ticketClosedClause", "ticketClosed", "filterClause", 0, new()
                {
                    ["fieldId"] = "ticketStatus",
                    ["operator"] = "eq",
                    ["value"] = "Closed",
                }),
            ]),
        ]);

    /// <summary>
    /// The timeline, ADR-0004 2026-09-14 amendment (S3): records on a spine by a
    /// Date field, with an end date that turns each entry into a span.
    /// </summary>
    private static NendoAuthoringExample ATimelineOfSpans() => new(
        "a-timeline-of-spans",
        "A timeline of projects by start date, each drawn as a span to its end date, titled by name and toned by stage.",
        [
            "A timelineSurface places records on a spine by one Date field, one civil year at a time under a heading for every month, with its own Undated view. dateFieldId is required; a DateTime is refused by name, as a calendarSurface refuses it.",
            "endDateFieldId names a second Date field that turns an entry into a span drawn from its start date. Placement stays by dateFieldId: a span that began in an earlier year is on that year's spine, because an overlap query would need an OR the closed filter set has not got. An end before its start is stated on the entry as a data issue, never refused and never drawn backwards.",
            "titleFieldId and accentFieldId follow the record-page header's rules: a stored Text field that is not a single choice titles each entry, and a single-choice field's tone colours its dot. Both are optional; without a title the first bound field is used.",
            "A year is two date bounds the host adds, so a timeline carries at most six declared filterClause children; effectiveFilters in nendo://application/vocabulary states the composition.",
            "A timelineSurface moves the file to minimum host 1.21.0, which the review names as its own raiseMinimumHostVersion line.",
        ],
        [
            new("Create the Project record type with toned stages",
            [
                Operation("schema.createEntity", new { entityId = "project", displayName = "Project" }),
                Field("project", "projectName", "Name", "Text", true, "singleLine", []),
                Field("project", "projectStage", "Stage", "Text", false, "singleChoice", ["Planned", "Running", "Done"]),
                Field("project", "projectStart", "Start", "Date", false, "date", []),
                Field("project", "projectEnd", "End", "Date", false, "date", []),
                Field("project", "projectOwner", "Owner", "Text", false, "singleLine", []),
                Operation("schema.setChoiceMetadata", new { entityId = "project", fieldId = "projectStage", choiceId = "Planned", displayName = "Planned", retired = false, tone = "blue" }),
                Operation("schema.setChoiceMetadata", new { entityId = "project", fieldId = "projectStage", choiceId = "Running", displayName = "Running", retired = false, tone = "teal" }),
                Operation("schema.setChoiceMetadata", new { entityId = "project", fieldId = "projectStage", choiceId = "Done", displayName = "Done", retired = false, tone = "green" }),
            ]),
            new("Build the timeline of spans",
            [
                InlineNode("projectTimeline", null, "timelineSurface", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "project",
                    ["title"] = "Projects over time",
                    ["dateFieldId"] = "projectStart",
                    ["endDateFieldId"] = "projectEnd",
                    ["titleFieldId"] = "projectName",
                    ["accentFieldId"] = "projectStage",
                }),
                InlineNode("projectTimelineStage", "projectTimeline", "fieldBinding", 0, new() { ["fieldId"] = "projectStage" }),
                InlineNode("projectTimelineOwner", "projectTimeline", "fieldBinding", 1, new() { ["fieldId"] = "projectOwner" }),
                // Finished projects stay off the spine. The year's two bounds leave
                // room for five more clauses.
                InlineNode("projectTimelineOpen", "projectTimeline", "filterClause", 2, new()
                {
                    ["fieldId"] = "projectStage",
                    ["operator"] = "ne",
                    ["value"] = "Done",
                }),
            ]),
        ]);

    /// <summary>
    /// The gallery and the rating scale, ADR-0004 2026-09-14 amendment (S2): cards over a
    /// list's window, and a whole number drawn on a closed scale.
    /// </summary>
    private static NendoAuthoringExample AGalleryAndARating() => new(
        "a-gallery-and-a-rating",
        "A shelf of book cards titled by name and toned by status, each showing a rating drawn as dots on a scale of one to five.",
        [
            "A gallerySurface draws one card per record over exactly the window a recordList reads: the same bounded page, the same Previous and Next, and the same summaryTile, breakdownChart and progressTile children above it. It adds no predicate of its own, so it carries the full eight filterClause children a list carries.",
            "titleFieldId and accentFieldId follow the record-page header's rules with card wording: a stored Text field that is not a single choice titles each card, and a single-choice field's tone colours its edge. Both are optional; without a title the first bound field leads, as it does on a board card.",
            "presentation rating draws an Integer field as dots. min and max are required together on a rating, refused on every other presentation, and set once with the field: a scale is part of how a field is drawn, as a presentation is, and neither changes afterwards.",
            "The scale carries at most ten values counting both ends. It bounds the drawing, not the column: a stored number outside it is written, read back exactly, and stated as a data issue, so declaring a scale over values that already exist never rewrites one of them.",
            "Either moves the file to minimum host 1.22.0, which the review names as its own raiseMinimumHostVersion line.",
        ],
        [
            new("Create the Book record type with toned statuses and a rating",
            [
                Operation("schema.createEntity", new { entityId = "book", displayName = "Book" }),
                Field("book", "bookTitle", "Title", "Text", true, "singleLine", []),
                Field("book", "bookAuthor", "Author", "Text", false, "singleLine", []),
                Field("book", "bookStatus", "Status", "Text", false, "singleChoice", ["Wishlist", "Reading", "Finished"]),
                // A rating is an Integer with both bounds; min and max travel with the
                // field because a scale cannot be added to one later.
                Operation("schema.addField", new
                {
                    entityId = "book",
                    fieldId = "bookRating",
                    displayName = "Rating",
                    storageKind = "Integer",
                    required = false,
                    presentation = "rating",
                    options = Array.Empty<string>(),
                    min = 1,
                    max = 5,
                }),
                Operation("schema.setChoiceMetadata", new { entityId = "book", fieldId = "bookStatus", choiceId = "Wishlist", displayName = "Wishlist", retired = false, tone = "grey" }),
                Operation("schema.setChoiceMetadata", new { entityId = "book", fieldId = "bookStatus", choiceId = "Reading", displayName = "Reading", retired = false, tone = "teal" }),
                Operation("schema.setChoiceMetadata", new { entityId = "book", fieldId = "bookStatus", choiceId = "Finished", displayName = "Finished", retired = false, tone = "green" }),
            ]),
            new("Build the shelf of cards",
            [
                InlineNode("bookShelf", null, "gallerySurface", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "book",
                    ["title"] = "Shelf",
                    ["titleFieldId"] = "bookTitle",
                    ["accentFieldId"] = "bookStatus",
                }),
                InlineNode("bookShelfAuthor", "bookShelf", "fieldBinding", 0, new() { ["fieldId"] = "bookAuthor" }),
                InlineNode("bookShelfRating", "bookShelf", "fieldBinding", 1, new() { ["fieldId"] = "bookRating" }),
                InlineNode("bookShelfOpen", "bookShelf", "filterClause", 2, new()
                {
                    ["fieldId"] = "bookStatus",
                    ["operator"] = "ne",
                    ["value"] = "Wishlist",
                }),
                // A gallery takes a list's totals, over every matching record rather
                // than the page of cards on screen.
                InlineNode("bookShelfCount", "bookShelf", "summaryTile", 3, new()
                {
                    ["aggregate"] = "count",
                    ["title"] = "Books on the shelf",
                }),
            ]),
        ]);

    private static NendoAuthoringExample TwoCommandsAndAFilteredList() => new(
        "two-commands-and-a-filtered-list",
        "A record page with two buttons, and a list narrowed by two conditions with its own total, authored with inline properties.",
        [
            "ui.addNode takes a properties map, so a node and its configuration are one operation rather than one plus one per property. The whole page below is fifteen operations; one property at a time it would be forty.",
            "A choice option's colour is its tone on schema.setChoiceMetadata — one of choiceTones in the vocabulary, never a hex value — and it rides in the same mutation as the field. A detailSurface names titleFieldId and accentFieldId to head and colour the record page; both are optional, and a page without them is unchanged.",
            "Each inline property still expands to one canonical ui.setProperty, counted against canonicalOperationLimit; add_operations echoes both counts.",
            "An entity owns up to eight recordCommand roots, so Mark won and Mark lost are two roots on the same entity and each carries the commandId nendo.data.execute_command takes. A command nested inside a record page is still accepted and still gets a commandId. maxRootsPerEntity in nendo://application/vocabulary states the ceiling for every kind.",
            "Sibling filterClause children are ANDed: a record must satisfy every one of them to appear. There is no OR and no grouping in contract version 3.",
            "A summaryTile on a recordList counts every matching record, on every page, not the fifty a page loads. Its own filterClause children intersect the list's. effectiveFilters in the vocabulary states how many clauses one query may compose.",
            "A command advances the record by one version per commandStep, and execute_command returns the resulting recordVersion; both buttons here are two steps, so a version 1 deal lands on version 3.",
        ],
        [
            new("Create the Deal record type",
            [
                Operation("schema.createEntity", new { entityId = "deal", displayName = "Deal" }),
                Field("deal", "dealName", "Deal name", "Text", true, "singleLine", []),
                Field("deal", "dealStage", "Stage", "Text", false, "singleChoice",
                    ["Qualification", "Proposal", "Closed won", "Closed lost"]),
                Field("deal", "dealClosed", "Closed", "Boolean", false, null, []),
                // The stages carry tones, so the board columns and chips read at a glance.
                // A tone is part of the option's metadata; the label and availability
                // travel with it.
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Qualification", displayName = "Qualification", retired = false, tone = "blue" }),
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Proposal", displayName = "Proposal", retired = false, tone = "amber" }),
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Closed won", displayName = "Closed won", retired = false, tone = "green" }),
                Operation("schema.setChoiceMetadata", new { entityId = "deal", fieldId = "dealStage", choiceId = "Closed lost", displayName = "Closed lost", retired = false, tone = "red" }),
            ]),
            new("Build the Deal page, both buttons and the open list",
            [
                InlineNode("dealPage", null, "detailSurface", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "deal",
                    ["title"] = "Deal",
                    // The page header: the deal's name heads the page and the stage's
                    // tone colours it. Both are optional.
                    ["titleFieldId"] = "dealName",
                    ["accentFieldId"] = "dealStage",
                }),
                InlineNode("dealNameBinding", "dealPage", "fieldBinding", 0, new() { ["fieldId"] = "dealName" }),

                InlineNode("dealWon", null, "recordCommand", 1, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "deal",
                    ["label"] = "Mark won",
                }),
                InlineNode("dealWonStage", "dealWon", "commandStep", 0, new()
                {
                    ["fieldId"] = "dealStage",
                    ["valueKind"] = "literal",
                    ["value"] = "Closed won",
                }),
                InlineNode("dealWonClosed", "dealWon", "commandStep", 1, new()
                {
                    ["fieldId"] = "dealClosed",
                    ["valueKind"] = "literal",
                    ["value"] = true,
                }),

                // The second command is a second root, which the widened ceiling
                // accepts. Nesting it inside the page is still valid and still
                // produces a commandId; it is no longer the only way.
                InlineNode("dealLost", null, "recordCommand", 2, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "deal",
                    ["label"] = "Mark lost",
                }),
                InlineNode("dealLostStage", "dealLost", "commandStep", 0, new()
                {
                    ["fieldId"] = "dealStage",
                    ["valueKind"] = "literal",
                    ["value"] = "Closed lost",
                }),
                InlineNode("dealLostClosed", "dealLost", "commandStep", 1, new()
                {
                    ["fieldId"] = "dealClosed",
                    ["valueKind"] = "literal",
                    ["value"] = true,
                }),

                InlineNode("dealOpen", null, "recordList", 3, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "deal",
                    ["title"] = "Open deals",
                    ["orderByFieldId"] = "dealName",
                    ["orderDirection"] = "ascending",
                }),
                InlineNode("dealOpenName", "dealOpen", "fieldBinding", 0, new() { ["fieldId"] = "dealName" }),
                InlineNode("dealOpenStage", "dealOpen", "fieldBinding", 1, new() { ["fieldId"] = "dealStage" }),
                InlineNode("dealOpenNotWon", "dealOpen", "filterClause", 2, new()
                {
                    ["fieldId"] = "dealStage",
                    ["operator"] = "ne",
                    ["value"] = "Closed won",
                }),
                InlineNode("dealOpenNotLost", "dealOpen", "filterClause", 3, new()
                {
                    ["fieldId"] = "dealStage",
                    ["operator"] = "ne",
                    ["value"] = "Closed lost",
                }),
                // The total covers every open deal, not the fifty the first page
                // loads. Its scope defaults to surface; group is for a board column.
                InlineNode("dealOpenCount", "dealOpen", "summaryTile", 4, new()
                {
                    ["aggregate"] = "count",
                    ["title"] = "Open deals",
                }),
            ]),
        ]);

    /// <summary>
    /// The 2026-09-12 widening in one application: several list and board roots on
    /// one record type, per-column and per-surface totals, a tabbed record page,
    /// and a Date calendar with its own undated view.
    /// </summary>
    private static NendoAuthoringExample SeveralViewsTabsAndACalendar() => new(
        "several-views-tabs-and-a-calendar",
        "Two lists, a board with totals, a tabbed record page and a month calendar on one record type.",
        [
            "An entity owns up to eight recordList, boardSurface, calendarSurface and recordCommand roots. Each root is one view Use offers by its own title, so a list and a board are no longer a mode to switch between. maxRootsPerEntity in nendo://application/vocabulary states the ceiling for every kind.",
            "A summaryTile on a recordList or boardSurface counts every matching record, on every page. scope group narrows it to one board column and is accepted only on a direct child of a boardSurface; summaryScopes in the vocabulary states the values, the default and that restriction.",
            "effectiveFilters states how many filters one query may compose, counting the ones the host adds: a board column tile pays for the board clauses, its own, and the column predicate, and a calendar month reserves two date bounds so it carries at most six declared clauses.",
            "A tabGroup contains sections and nothing else: each section is one tab, named by its existing required title. Nested tab groups are refused, including through an intervening section.",
            "A calendarSurface places records by one Date field. A DateTime is refused by name, because putting one on a month grid means choosing a time zone to group by, which this contract version does not define.",
            "Raising these shapes raises the file minimumHostVersion, which is an irreversible compatibility change and appears as its own raiseMinimumHostVersion line in the proposal diff.",
        ],
        [
            new("Create the Job record type",
            [
                Operation("schema.createEntity", new { entityId = "job", displayName = "Job" }),
                Field("job", "jobName", "Job name", "Text", true, "singleLine", []),
                Field("job", "jobStage", "Stage", "Text", false, "singleChoice", ["Booked", "In progress", "Done"]),
                Field("job", "jobFee", "Fee", "Decimal", false, null, []),
                Field("job", "jobDue", "Due", "Date", false, "date", []),
                Field("job", "jobNotes", "Notes", "Text", false, "longText", []),
            ]),
            new("Two lists and a board with totals",
            [
                InlineNode("jobOpen", null, "recordList", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "job",
                    ["title"] = "Open jobs",
                    ["orderByFieldId"] = "jobDue",
                    ["orderDirection"] = "ascending",
                }),
                InlineNode("jobOpenName", "jobOpen", "fieldBinding", 0, new() { ["fieldId"] = "jobName" }),
                InlineNode("jobOpenDue", "jobOpen", "fieldBinding", 1, new() { ["fieldId"] = "jobDue" }),
                InlineNode("jobOpenNotDone", "jobOpen", "filterClause", 2, new()
                {
                    ["fieldId"] = "jobStage",
                    ["operator"] = "ne",
                    ["value"] = "Done",
                }),
                // The total covers every open job, not the fifty a page loads.
                InlineNode("jobOpenCount", "jobOpen", "summaryTile", 3, new()
                {
                    ["aggregate"] = "count",
                    ["title"] = "Open jobs",
                }),

                // A second list on the same record type, which used to refuse.
                InlineNode("jobDone", null, "recordList", 1, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "job",
                    ["title"] = "Completed jobs",
                    ["orderByFieldId"] = "jobName",
                    ["orderDirection"] = "ascending",
                }),
                InlineNode("jobDoneName", "jobDone", "fieldBinding", 0, new() { ["fieldId"] = "jobName" }),
                InlineNode("jobDoneFee", "jobDone", "fieldBinding", 1, new() { ["fieldId"] = "jobFee" }),
                InlineNode("jobDoneOnly", "jobDone", "filterClause", 2, new()
                {
                    ["fieldId"] = "jobStage",
                    ["operator"] = "eq",
                    ["value"] = "Done",
                }),

                InlineNode("jobBoard", null, "boardSurface", 2, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "job",
                    ["title"] = "Jobs by stage",
                    ["groupByFieldId"] = "jobStage",
                }),
                InlineNode("jobBoardName", "jobBoard", "fieldBinding", 0, new() { ["fieldId"] = "jobName" }),
                // Two totals on one board: the whole surface, and each column.
                InlineNode("jobBoardTotal", "jobBoard", "summaryTile", 1, new()
                {
                    ["aggregate"] = "sum",
                    ["fieldId"] = "jobFee",
                    ["title"] = "Total fees",
                }),
                InlineNode("jobBoardColumn", "jobBoard", "summaryTile", 2, new()
                {
                    ["aggregate"] = "sum",
                    ["fieldId"] = "jobFee",
                    ["title"] = "Column fees",
                    ["scope"] = "group",
                }),
            ]),
            new("A tabbed record page and a due-date calendar",
            [
                InlineNode("jobPage", null, "detailSurface", 3, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "job",
                    ["title"] = "Job",
                }),
                InlineNode("jobTabs", "jobPage", "tabGroup", 0, new() { ["title"] = "Job details" }),
                // Each section of the group is one tab, named by its title.
                InlineNode("jobTabIdentity", "jobTabs", "section", 0, new() { ["title"] = "Identity" }),
                InlineNode("jobTabName", "jobTabIdentity", "fieldBinding", 0, new() { ["fieldId"] = "jobName" }),
                InlineNode("jobTabStage", "jobTabIdentity", "fieldBinding", 1, new() { ["fieldId"] = "jobStage" }),
                InlineNode("jobTabMoney", "jobTabs", "section", 1, new() { ["title"] = "Money" }),
                InlineNode("jobTabFee", "jobTabMoney", "fieldBinding", 0, new() { ["fieldId"] = "jobFee" }),
                InlineNode("jobTabSchedule", "jobTabs", "section", 2, new() { ["title"] = "Schedule" }),
                InlineNode("jobTabDue", "jobTabSchedule", "fieldBinding", 0, new() { ["fieldId"] = "jobDue" }),
                InlineNode("jobTabNotes", "jobTabSchedule", "fieldBinding", 1, new() { ["fieldId"] = "jobNotes" }),

                InlineNode("jobCalendar", null, "calendarSurface", 4, new()
                {
                    ["definitionVersion"] = 3,
                    ["entityId"] = "job",
                    ["title"] = "Due dates",
                    ["dateFieldId"] = "jobDue",
                }),
                InlineNode("jobCalendarName", "jobCalendar", "fieldBinding", 0, new() { ["fieldId"] = "jobName" }),
                InlineNode("jobCalendarStage", "jobCalendar", "fieldBinding", 1, new() { ["fieldId"] = "jobStage" }),
                // A calendar month reserves two date bounds, so at most six
                // declared clauses fit beside them.
                InlineNode("jobCalendarOpen", "jobCalendar", "filterClause", 2, new()
                {
                    ["fieldId"] = "jobStage",
                    ["operator"] = "ne",
                    ["value"] = "Done",
                }),
            ]),
        ]);

    private const string SurfaceId = "example";

    private static NendoAuthoringExampleOperation Field(
        string entityId,
        string fieldId,
        string displayName,
        string storageKind,
        bool required,
        string? presentation,
        string[] options) => Operation("schema.addField", new
        {
            entityId,
            fieldId,
            displayName,
            storageKind,
            required,
            presentation,
            options,
        });

    private static NendoAuthoringExampleOperation Node(
        string nodeId,
        string? parentNodeId,
        string kind,
        int position) => Operation("ui.addNode", new
        {
            surfaceId = SurfaceId,
            nodeId,
            parentNodeId,
            kind,
            position,
        });

    /// <summary>A node and everything that configures it, as one operation.</summary>
    private static NendoAuthoringExampleOperation InlineNode(
        string nodeId,
        string? parentNodeId,
        string kind,
        int position,
        Dictionary<string, object?> properties) => Operation("ui.addNode", new
        {
            surfaceId = SurfaceId,
            nodeId,
            parentNodeId,
            kind,
            position,
            properties,
        });

    private static NendoAuthoringExampleOperation Property(
        string nodeId,
        string propertyName,
        object? value) => Operation("ui.setProperty", new
        {
            surfaceId = SurfaceId,
            nodeId,
            propertyName,
            value,
        });

    /// <summary>
    /// The one root that belongs to the file, and the two kinds only it can hold.
    /// Written over two record types on purpose: the point of a front page is that
    /// it says something about the file, and a front page over one record type
    /// would be a list with its totals on top.
    /// </summary>
    private static NendoAuthoringExample AFrontPageForTheFile() => new(
        "a-front-page-for-the-file",
        "A front page saying what this file is for, with a count and a progress ring of tasks, the range of their due dates, and the five most recent notes.",
        [
            "An overviewSurface is the file's front page and the one root with no entityId: it belongs to the file rather than to a record type. One per file, and Use opens it first when it exists.",
            "Because there is no record type in context, every summaryTile, breakdownChart, progressTile, rangeTile and recentList under it names its own entityId. That property is required there and refused on a tile anywhere else, where the tile takes its record type from the surface it sits on.",
            "It composes nothing across record types. Each child reads the one type it names, spending its own filter budget, and the overview adds no predicate of its own — there is no join and no number made from two types.",
            "A fieldBinding, a relatedList and a visibleWhen calculation all need a record in hand, so they are refused here rather than drawn empty. Use a recentList to put records of one type on the front page.",
            "A recentList shows at most ten records in a declared order, refused above that rather than narrowed. A rangeTile is not a chart: it has no grouping, and it states the smallest and largest value of one Integer, Decimal or Date field — the one place min and max read a date.",
            "The description is prose the author writes, drawn under the title. Any of these moves the file to minimum host 1.23.0, which the review names as its own raiseMinimumHostVersion line.",
        ],
        [
            new("Create the two record types the front page reads",
            [
                Operation("schema.createEntity", new { entityId = "task", displayName = "Task" }),
                Field("task", "taskTitle", "Title", "Text", true, "singleLine", []),
                Field("task", "taskStage", "Stage", "Text", false, "singleChoice", ["Open", "Done"]),
                Field("task", "taskDue", "Due", "Date", false, "date", []),
                Operation("schema.createEntity", new { entityId = "note", displayName = "Note" }),
                Field("note", "noteTitle", "Title", "Text", true, "singleLine", []),
                Field("note", "noteWritten", "Written", "Date", false, "date", []),
            ]),
            new("Build the front page",
            [
                InlineNode("front", null, "overviewSurface", 0, new()
                {
                    ["definitionVersion"] = 3,
                    ["title"] = "Everything",
                    ["description"] = "What is open, when it is due, and what was written lately.",
                }),
                // Each tile names the record type it reads. There is no surface
                // entity here to inherit one from, which is the whole point.
                InlineNode("frontTaskCount", "front", "summaryTile", 0, new()
                {
                    ["entityId"] = "task",
                    ["aggregate"] = "count",
                    ["title"] = "Tasks",
                }),
                InlineNode("frontTaskDone", "front", "progressTile", 1, new()
                {
                    ["entityId"] = "task",
                    ["title"] = "Done",
                }),
                InlineNode("frontTaskDoneClause", "frontTaskDone", "filterClause", 0, new()
                {
                    ["fieldId"] = "taskStage",
                    ["operator"] = "eq",
                    ["value"] = "Done",
                }),
                InlineNode("frontTaskStage", "front", "breakdownChart", 2, new()
                {
                    ["entityId"] = "task",
                    ["aggregate"] = "count",
                    ["groupByFieldId"] = "taskStage",
                    ["title"] = "By stage",
                }),
                // A range over a Date: the two exact aggregates, ordered by
                // comparison rather than by arithmetic.
                InlineNode("frontTaskDue", "front", "rangeTile", 3, new()
                {
                    ["entityId"] = "task",
                    ["fieldId"] = "taskDue",
                    ["title"] = "Due between",
                }),
                InlineNode("frontNotes", "front", "recentList", 4, new()
                {
                    ["entityId"] = "note",
                    ["title"] = "Lately",
                    ["limit"] = 5,
                    ["orderByFieldId"] = "noteWritten",
                    ["orderDirection"] = "descending",
                }),
                InlineNode("frontNotesTitle", "frontNotes", "fieldBinding", 0, new() { ["fieldId"] = "noteTitle" }),
                InlineNode("frontNotesWritten", "frontNotes", "fieldBinding", 1, new() { ["fieldId"] = "noteWritten" }),
            ]),
        ]);

    private static NendoAuthoringExample CalculateAndActAutomatically() => new(
        "calculate-and-act-automatically",
        "Two dependent calculated fields, one reusable function, and an action a trigger runs.",
        [
            "nendo://application/vocabulary carries a behaviour section: the closed function set with each one's argument and result types, the operators, the scalar domain, the four binding kinds, what each aggregate does with an empty collection and with a value it cannot read, and the ceilings. A formula may say what is in that section and nothing else.",
            "A calculated field is not a field. It has no column, nothing writes to it, and it appears under derivedFields on the record type's schema rather than under fields.",
            "definitionKind is Calculation, Function, Action or Trigger, and body is the typed definition for that kind. A binding names where a value comes from: SameRecordField, SameRecordCalculation, ReferenceTraversal or RelatedAggregate. Identifiers in a formula are binding IDs, never display names.",
            "A RelatedAggregate names the field it works over with a key of its own: predicateFieldId for FilteredCount, valueFieldId for Sum, and none for Count. The vocabulary's behaviour.bindings lists every key each shape takes; a key outside that list is refused by name where the operation is sent, before it can cost the draft. A Sum totals a required field, because a member with no value is an error rather than a zero.",
            "A calculation reads another calculation with a SameRecordCalculation binding rather than repeating its work. Cycles are refused before installation.",
            "An action step writes through the same typed record operations a person's edit uses. target ReferencedRecord follows one declared reference from the record that raised the event; EventRecord writes to that record itself.",
            "An assignment's bindings resolve against the record the step WRITES TO, not the record that raised the event. A step targeting ReferencedRecord can read the referenced record and can assign a literal; it cannot read the event record's fields. Binding the event record's entity there refuses nothing at install and then fails on the first save that fires it.",
            "Installing an action is authoring. Running it is consent: a file whose actions run automatically cannot be edited at all until the person at this device approves it. Below Unattended access there is no MCP route to that approval; at Unattended, nendo.change_set.accept records it for the actions that the accepted proposal installs.",
        ],
        [
            new("Create the Project and Task record types",
            [
                Operation("schema.createEntity", new { entityId = "project", displayName = "Project" }),
                Field("project", "projectName", "Name", "Text", true, "singleLine", []),
                Field("project", "projectStatus", "Status", "Text", false, "singleChoice", ["Idle", "Active"]),
                Operation("schema.createEntity", new { entityId = "task", displayName = "Task" }),
                Field("task", "taskTitle", "Title", "Text", true, "singleLine", []),
                Field("task", "taskDone", "Done", "Boolean", true, null, []),
                Field("task", "taskHours", "Hours", "Integer", true, null, []),
                Field("task", "taskProject", "Project", "Reference", false, null, []),
            ]),
            new("Bind the Task to Project reference",
            [
                Operation("schema.configureReference", new
                {
                    entityId = "task",
                    fieldId = "taskProject",
                    targetEntityId = "project",
                    labelFieldId = "projectName",
                }),
            ]),
            new("Calculate task counts and completion",
            [
                Operation("behaviour.setDefinition", new
                {
                    definitionId = "fn.percent",
                    definitionKind = "Function",
                    body = new
                    {
                        displayName = "Percent",
                        parameters = new[]
                        {
                            new { parameterId = "part", displayName = "Part", parameterType = "Decimal", nullable = false },
                            new { parameterId = "whole", displayName = "Whole", parameterType = "Decimal", nullable = false },
                        },
                        resultType = "Decimal",
                        resultNullable = false,
                        expression = "RoundEven(part / whole * 100, 2)",
                        callAliases = Array.Empty<object>(),
                    },
                }),
                Operation("behaviour.setDefinition", new
                {
                    definitionId = "project.taskCount",
                    definitionKind = "Calculation",
                    body = new
                    {
                        entityId = "project",
                        fieldId = "taskCount",
                        displayName = "Tasks",
                        resultType = "Integer",
                        resultNullable = false,
                        expression = "count",
                        bindings = new[]
                        {
                            new
                            {
                                bindingId = "count", kind = "RelatedAggregate", aggregate = "Count",
                                entityId = "project", relatedEntityId = "task", relatedReferenceFieldId = "taskProject",
                                resultType = "Integer", nullable = false,
                            },
                        },
                        callAliases = Array.Empty<object>(),
                    },
                }),
                Operation("behaviour.setDefinition", new
                {
                    definitionId = "project.doneCount",
                    definitionKind = "Calculation",
                    body = new
                    {
                        entityId = "project",
                        fieldId = "doneCount",
                        displayName = "Done",
                        resultType = "Integer",
                        resultNullable = false,
                        expression = "done",
                        bindings = new[]
                        {
                            new
                            {
                                bindingId = "done", kind = "RelatedAggregate", aggregate = "FilteredCount",
                                entityId = "project", relatedEntityId = "task", relatedReferenceFieldId = "taskProject",
                                predicateFieldId = "taskDone", resultType = "Integer", nullable = false,
                            },
                        },
                        callAliases = Array.Empty<object>(),
                    },
                }),
                Operation("behaviour.setDefinition", new
                {
                    definitionId = "project.totalHours",
                    definitionKind = "Calculation",
                    body = new
                    {
                        entityId = "project",
                        fieldId = "totalHours",
                        displayName = "Hours",
                        resultType = "Integer",
                        resultNullable = false,
                        expression = "hours",
                        bindings = new[]
                        {
                            new
                            {
                                bindingId = "hours", kind = "RelatedAggregate", aggregate = "Sum",
                                entityId = "project", relatedEntityId = "task", relatedReferenceFieldId = "taskProject",
                                valueFieldId = "taskHours", resultType = "Integer", nullable = false,
                            },
                        },
                        callAliases = Array.Empty<object>(),
                    },
                }),
                Operation("behaviour.setDefinition", new
                {
                    definitionId = "project.completion",
                    definitionKind = "Calculation",
                    body = new
                    {
                        entityId = "project",
                        fieldId = "completion",
                        displayName = "Completion",
                        resultType = "Decimal",
                        resultNullable = false,
                        expression = "Percent(done, total)",
                        bindings = new[]
                        {
                            new
                            {
                                bindingId = "total", kind = "SameRecordCalculation", entityId = "project",
                                calculationId = "project.taskCount", resultType = "Integer", nullable = false,
                            },
                            new
                            {
                                bindingId = "done", kind = "SameRecordCalculation", entityId = "project",
                                calculationId = "project.doneCount", resultType = "Integer", nullable = false,
                            },
                        },
                        callAliases = new[] { new { alias = "Percent", functionId = "fn.percent" } },
                    },
                }),
            ]),
            new("Mark a project active when it has work",
            [
                Operation("behaviour.setDefinition", new
                {
                    definitionId = "project.markActive",
                    definitionKind = "Action",
                    body = new
                    {
                        displayName = "Mark the project active",
                        steps = new[]
                        {
                            new
                            {
                                stepId = "10-status",
                                kind = "SetField",
                                target = new { kind = "ReferencedRecord", referenceFieldId = "taskProject" },
                                assignments = new[]
                                {
                                    new
                                    {
                                        fieldId = "projectStatus",
                                        // A literal. The bindings of a step targeting the
                                        // referenced record would read that record, not the
                                        // task that raised the event.
                                        expression = "'Active'",
                                        bindings = Array.Empty<object>(),
                                        callAliases = Array.Empty<object>(),
                                    },
                                },
                            },
                        },
                    },
                }),
                Operation("behaviour.setDefinition", new
                {
                    definitionId = "task.onCreated",
                    definitionKind = "Trigger",
                    body = new
                    {
                        entityId = "task",
                        displayName = "Mark the project active when a task arrives",
                        events = "Created",
                        actionId = "project.markActive",
                        relevantFieldIds = Array.Empty<string>(),
                        conditionBindings = Array.Empty<object>(),
                        callAliases = Array.Empty<object>(),
                    },
                }),
            ]),
        ]);

    private static NendoAuthoringExampleOperation Operation(string operationType, object payload) =>
        new(operationType, JsonSerializer.SerializeToElement(payload, NendoMcpJson.Options));
}
