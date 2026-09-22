using System.Text.Json;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// A reduced contract version 3 CRM: three related record types, a record page
/// with a section, two related lists and an exact rollup tile, a filtered list,
/// a board and a two-step command. Modelled on the application the 2026-09-11
/// blackbox review built through MCP alone, which no fixture here could express —
/// <see cref="ReadingQueueAuthoringFixture"/> is contract version 1, and the
/// version 1 and 2 shapes are exactly the ones that hid the surfaces-resource and
/// preview-summary defects.
/// </summary>
internal static class CrmAuthoringFixture
{
    internal const string AccountEntityId = "account";
    internal const string AccountNameFieldId = "accountName";
    internal const string AccountTierFieldId = "accountTier";
    internal const string ContactEntityId = "contact";
    internal const string ContactNameFieldId = "contactName";
    internal const string ContactAccountFieldId = "contactAccount";
    internal const string DealEntityId = "deal";
    internal const string DealNameFieldId = "dealName";
    internal const string DealAmountFieldId = "dealAmount";
    internal const string DealStageFieldId = "dealStage";
    internal const string DealAccountFieldId = "dealAccount";
    internal const string DealClosedFieldId = "dealClosed";

    internal const string AccountPageNodeId = "accountPage";
    internal const string AccountDealsNodeId = "accountDeals";
    internal const string AccountDealTotalNodeId = "accountDealTotal";
    internal const string DealOpenListNodeId = "dealOpenList";
    internal const string DealBoardNodeId = "dealBoard";
    internal const string DealWinCommandId = "dealWin";
    internal const string SurfaceId = "crm";

    /// <summary>
    /// One mutation. Every required field is co-located with its
    /// <c>schema.createEntity</c>, because a mutation is the materialization
    /// boundary for the definition lane.
    /// </summary>
    internal static IReadOnlyList<NendoAgentOperationInput> SchemaOperations() =>
    [
        Operation("schema.createEntity", new { entityId = AccountEntityId, displayName = "Account" }),
        Field(AccountEntityId, AccountNameFieldId, "Account name", "Text", true, "singleLine", []),
        Field(AccountEntityId, AccountTierFieldId, "Tier", "Text", false, "singleChoice",
            ["Strategic", "Growth", "Standard"]),

        Operation("schema.createEntity", new { entityId = ContactEntityId, displayName = "Contact" }),
        Field(ContactEntityId, ContactNameFieldId, "Contact name", "Text", true, "singleLine", []),
        Field(ContactEntityId, ContactAccountFieldId, "Account", "Reference", false, null, []),

        Operation("schema.createEntity", new { entityId = DealEntityId, displayName = "Deal" }),
        Field(DealEntityId, DealNameFieldId, "Deal name", "Text", true, "singleLine", []),
        Field(DealEntityId, DealAmountFieldId, "Amount", "Decimal", false, null, []),
        Field(DealEntityId, DealStageFieldId, "Stage", "Text", false, "singleChoice",
            ["Qualification", "Proposal", "Negotiation", "Closed won"]),
        Field(DealEntityId, DealAccountFieldId, "Account", "Reference", false, null, []),
        Field(DealEntityId, DealClosedFieldId, "Closed", "Boolean", false, null, []),
    ];

    /// <summary>
    /// One definition-lane mutation. A null revision omits the property, which is
    /// the host-resolved form; a supplied value is sent verbatim so the strict
    /// form stays covered.
    /// </summary>
    internal static IReadOnlyList<NendoAgentOperationInput> ReferenceOperations(
        long? expectedDefinitionRevision = null) =>
    [
        Reference(ContactEntityId, ContactAccountFieldId, expectedDefinitionRevision),
        Reference(DealEntityId, DealAccountFieldId, expectedDefinitionRevision),
    ];

    /// <summary>
    /// The UI lane. Nodes may be split across mutations; only the definition lane
    /// materializes per mutation.
    /// </summary>
    internal static IReadOnlyList<NendoAgentOperationInput> SurfaceOperations()
    {
        var operations = new List<NendoAgentOperationInput>();

        Node(operations, AccountPageNodeId, null, "detailSurface", 0);
        Property(operations, AccountPageNodeId, "definitionVersion", 3);
        Property(operations, AccountPageNodeId, "entityId", AccountEntityId);
        Property(operations, AccountPageNodeId, "title", "Account");
        Node(operations, "accountProfile", AccountPageNodeId, "section", 0);
        Property(operations, "accountProfile", "title", "Profile");
        Binding(operations, "accountNameBinding", "accountProfile", 0, AccountNameFieldId);
        Binding(operations, "accountTierBinding", "accountProfile", 1, AccountTierFieldId);

        Node(operations, AccountDealsNodeId, AccountPageNodeId, "relatedList", 1);
        Property(operations, AccountDealsNodeId, "targetEntityId", DealEntityId);
        Property(operations, AccountDealsNodeId, "viaFieldId", DealAccountFieldId);
        Property(operations, AccountDealsNodeId, "title", "Deals");
        Property(operations, AccountDealsNodeId, "orderByFieldId", DealNameFieldId);
        Property(operations, AccountDealsNodeId, "orderDirection", "ascending");
        Binding(operations, "accountDealName", AccountDealsNodeId, 0, DealNameFieldId);
        Binding(operations, "accountDealAmount", AccountDealsNodeId, 1, DealAmountFieldId);
        Node(operations, AccountDealTotalNodeId, AccountDealsNodeId, "summaryTile", 2);
        Property(operations, AccountDealTotalNodeId, "aggregate", "sum");
        Property(operations, AccountDealTotalNodeId, "fieldId", DealAmountFieldId);
        Property(operations, AccountDealTotalNodeId, "title", "Pipeline");

        Node(operations, "accountContacts", AccountPageNodeId, "relatedList", 2);
        Property(operations, "accountContacts", "targetEntityId", ContactEntityId);
        Property(operations, "accountContacts", "viaFieldId", ContactAccountFieldId);
        Property(operations, "accountContacts", "title", "Contacts");
        Binding(operations, "accountContactName", "accountContacts", 0, ContactNameFieldId);

        Node(operations, "contactPage", null, "detailSurface", 1);
        Property(operations, "contactPage", "definitionVersion", 3);
        Property(operations, "contactPage", "entityId", ContactEntityId);
        Property(operations, "contactPage", "title", "Contact");
        Binding(operations, "contactNameBinding", "contactPage", 0, ContactNameFieldId);

        Node(operations, DealOpenListNodeId, null, "recordList", 2);
        Property(operations, DealOpenListNodeId, "definitionVersion", 3);
        Property(operations, DealOpenListNodeId, "entityId", DealEntityId);
        Property(operations, DealOpenListNodeId, "title", "Open deals");
        Property(operations, DealOpenListNodeId, "orderByFieldId", DealNameFieldId);
        Property(operations, DealOpenListNodeId, "orderDirection", "ascending");
        Binding(operations, "dealOpenName", DealOpenListNodeId, 0, DealNameFieldId);
        Binding(operations, "dealOpenStage", DealOpenListNodeId, 1, DealStageFieldId);
        Node(operations, "dealOpenFilter", DealOpenListNodeId, "filterClause", 2);
        Property(operations, "dealOpenFilter", "fieldId", DealClosedFieldId);
        Property(operations, "dealOpenFilter", "operator", "eq");
        Property(operations, "dealOpenFilter", "value", false);

        Node(operations, DealBoardNodeId, null, "boardSurface", 3);
        Property(operations, DealBoardNodeId, "definitionVersion", 3);
        Property(operations, DealBoardNodeId, "entityId", DealEntityId);
        Property(operations, DealBoardNodeId, "title", "Pipeline");
        Property(operations, DealBoardNodeId, "groupByFieldId", DealStageFieldId);
        Binding(operations, "dealBoardName", DealBoardNodeId, 0, DealNameFieldId);
        Binding(operations, "dealBoardAmount", DealBoardNodeId, 1, DealAmountFieldId);

        Node(operations, DealWinCommandId, null, "recordCommand", 4);
        Property(operations, DealWinCommandId, "definitionVersion", 3);
        Property(operations, DealWinCommandId, "entityId", DealEntityId);
        Property(operations, DealWinCommandId, "label", "Mark won");
        Node(operations, "dealWinStage", DealWinCommandId, "commandStep", 0);
        Property(operations, "dealWinStage", "fieldId", DealStageFieldId);
        Property(operations, "dealWinStage", "valueKind", "literal");
        Property(operations, "dealWinStage", "value", "Closed won");
        Node(operations, "dealWinClosed", DealWinCommandId, "commandStep", 1);
        Property(operations, "dealWinClosed", "fieldId", DealClosedFieldId);
        Property(operations, "dealWinClosed", "valueKind", "literal");
        Property(operations, "dealWinClosed", "value", true);

        return operations;
    }

    /// <summary>
    /// One definition-lane operation with no explicit revision, for exercising the
    /// host-resolved form of expectedDefinitionRevision on its own.
    /// </summary>
    internal static IReadOnlyList<NendoAgentOperationInput> RenameAccountOperations() =>
    [
        Operation("schema.renameEntity", new { entityId = AccountEntityId, displayName = "Client" }),
    ];

    /// <summary>
    /// The same screens, authored with inline properties: every
    /// <c>ui.setProperty</c> folds into the <c>ui.addNode</c> that created its
    /// node. Derived from <see cref="SurfaceOperations"/> rather than written
    /// again, so the two forms cannot describe different screens — which is the
    /// whole claim being tested.
    /// </summary>
    internal static IReadOnlyList<NendoAgentOperationInput> InlineSurfaceOperations()
    {
        var order = new List<string>();
        var nodes = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var properties = new Dictionary<string, Dictionary<string, JsonElement>>(StringComparer.Ordinal);
        foreach (var operation in SurfaceOperations())
        {
            var nodeId = operation.Payload.Element.GetProperty("nodeId").GetString()!;
            if (operation.OperationType == "ui.addNode")
            {
                order.Add(nodeId);
                nodes[nodeId] = operation.Payload.Element;
                properties[nodeId] = new(StringComparer.Ordinal);
                continue;
            }
            properties[nodeId][operation.Payload.Element.GetProperty("propertyName").GetString()!] =
                operation.Payload.Element.GetProperty("value");
        }
        return order.Select(nodeId =>
        {
            var payload = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var property in nodes[nodeId].EnumerateObject()) payload[property.Name] = property.Value;
            payload["properties"] = properties[nodeId];
            return new NendoAgentOperationInput("ui.addNode", JsonSerializer.SerializeToElement(payload, NendoMcpJson.Options));
        }).ToArray();
    }

    /// <summary>
    /// Two roots whose size a reviewer cannot infer from a kind and a title: a matrix
    /// crossing Stage by Closed, and a board whose columns are Account records when no
    /// Account record exists. Kept apart from <see cref="SurfaceOperations"/> so the
    /// suites that count the CRM's screens keep counting the same ones.
    /// </summary>
    internal static IReadOnlyList<NendoAgentOperationInput> ShapeProbeSurfaceOperations()
    {
        var operations = new List<NendoAgentOperationInput>();
        Node(operations, "dealGrid", null, "matrixSurface", 5);
        Property(operations, "dealGrid", "definitionVersion", 3);
        Property(operations, "dealGrid", "entityId", DealEntityId);
        Property(operations, "dealGrid", "title", "Stage against closed");
        Property(operations, "dealGrid", "rowByFieldId", DealStageFieldId);
        Property(operations, "dealGrid", "columnByFieldId", DealClosedFieldId);
        Binding(operations, "dealGridName", "dealGrid", 0, DealNameFieldId);

        Node(operations, "dealByAccount", null, "boardSurface", 6);
        Property(operations, "dealByAccount", "definitionVersion", 3);
        Property(operations, "dealByAccount", "entityId", DealEntityId);
        Property(operations, "dealByAccount", "title", "Deals by account");
        Property(operations, "dealByAccount", "groupByFieldId", DealAccountFieldId);
        Binding(operations, "dealByAccountName", "dealByAccount", 0, DealNameFieldId);
        return operations;
    }

    private static NendoAgentOperationInput Field(
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

    private static NendoAgentOperationInput Reference(
        string entityId,
        string fieldId,
        long? expectedDefinitionRevision) => expectedDefinitionRevision is { } revision
        ? Operation("schema.configureReference", new
        {
            entityId,
            fieldId,
            targetEntityId = AccountEntityId,
            labelFieldId = AccountNameFieldId,
            expectedDefinitionRevision = revision,
        })
        : Operation("schema.configureReference", new
        {
            entityId,
            fieldId,
            targetEntityId = AccountEntityId,
            labelFieldId = AccountNameFieldId,
        });

    private static void Node(
        ICollection<NendoAgentOperationInput> operations,
        string nodeId,
        string? parentNodeId,
        string kind,
        int position) => operations.Add(Operation("ui.addNode", new
        {
            surfaceId = SurfaceId,
            nodeId,
            parentNodeId,
            kind,
            position,
        }));

    private static void Property(
        ICollection<NendoAgentOperationInput> operations,
        string nodeId,
        string propertyName,
        object? value) => operations.Add(Operation("ui.setProperty", new
        {
            surfaceId = SurfaceId,
            nodeId,
            propertyName,
            value,
        }));

    private static void Binding(
        ICollection<NendoAgentOperationInput> operations,
        string nodeId,
        string parentNodeId,
        int position,
        string fieldId)
    {
        Node(operations, nodeId, parentNodeId, "fieldBinding", position);
        Property(operations, nodeId, "fieldId", fieldId);
    }

    private static NendoAgentOperationInput Operation(string type, object payload) =>
        new(type, JsonSerializer.SerializeToElement(payload, NendoMcpJson.Options));
}
