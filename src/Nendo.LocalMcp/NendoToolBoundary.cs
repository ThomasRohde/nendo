using ModelContextProtocol;
using ModelContextProtocol.Protocol;

namespace Nendo.LocalMcp;

internal static class NendoToolBoundary
{
    private static readonly IReadOnlyDictionary<string, IReadOnlySet<string>> AllowedArguments =
        new Dictionary<string, IReadOnlySet<string>>(StringComparer.Ordinal)
        {
            ["nendo.lease.acquire"] = Allowed(),
            ["nendo.lease.status"] = Allowed("applicationHandle"),
            ["nendo.lease.renew"] = Allowed("applicationHandle", "leaseId"),
            ["nendo.lease.release"] = Allowed("applicationHandle", "leaseId"),
            ["nendo.data.get_receipt"] = Allowed("receiptContext", "idempotencyKey"),
            ["nendo.health.verify_integrity"] = Allowed(),
            ["nendo.data.delete_record"] = Allowed("applicationHandle", "leaseId", "entityId", "recordId", "expectedRecordVersion", "idempotencyKey"),
            ["nendo.data.create_record"] = Allowed(
                "applicationHandle", "leaseId",
                "entityId",
                "recordId",
                "values",
                "expectedTargetVersions",
                "idempotencyKey"),
            ["nendo.data.create_records"] = Allowed(
                "applicationHandle", "leaseId", "entityId", "records", "idempotencyKey"),
            ["nendo.data.set_field"] = Allowed(
                "applicationHandle", "leaseId",
                "entityId",
                "recordId",
                "fieldId",
                "expectedRecordVersion",
                "value",
                "expectedTargetRecordVersion",
                "idempotencyKey"),
            ["nendo.data.execute_command"] = Allowed(
                "applicationHandle", "leaseId",
                "commandId",
                "recordId",
                "expectedRecordVersion",
                "idempotencyKey"),
            ["nendo.change_set.begin"] = Allowed("applicationHandle", "leaseId", "title", "idempotencyKey"),
            ["nendo.change_set.add_operations"] = Allowed(
                "applicationHandle", "leaseId", "changeSetId", "mutations", "idempotencyKey"),
            ["nendo.change_set.amend"] = Allowed(
                "applicationHandle", "leaseId", "changeSetId", "dropFromMutationOrdinal", "mutations", "idempotencyKey"),
            ["nendo.change_set.validate"] = Allowed(
                "applicationHandle", "leaseId", "changeSetId", "idempotencyKey"),
            ["nendo.change_set.preview"] = Allowed("applicationHandle", "leaseId", "changeSetId"),
            ["nendo.change_set.reject"] = Allowed(
                "applicationHandle", "leaseId", "changeSetId", "idempotencyKey"),
            // Served only at Unattended. Listed here regardless: this table says what an
            // argument may be called, and the mode says whether the tool exists at all.
            ["nendo.change_set.accept"] = Allowed(
                "applicationHandle", "leaseId", "changeSetId", "idempotencyKey"),
            ["nendo.data.import_records"] = Allowed(
                "applicationHandle", "leaseId",
                "entityId",
                "format",
                "csv",
                "columnMappings",
                "csvProfile",
                "emptyIsNull",
                "records",
                "idempotencyKey"),
        };

    internal static void Validate(CallToolRequestParams request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!AllowedArguments.TryGetValue(request.Name, out var allowed))
        {
            throw new McpException("NENDO_TOOL_UNAVAILABLE: The requested tool is not available.");
        }
        if (request.Arguments?.Keys.Any(argument => !allowed.Contains(argument)) is true)
        {
            throw new McpException("NENDO_INVALID_REQUEST: The request contains an unknown field.");
        }
    }

    private static IReadOnlySet<string> Allowed(params string[] names) =>
        new HashSet<string>(names, StringComparer.Ordinal);
}
