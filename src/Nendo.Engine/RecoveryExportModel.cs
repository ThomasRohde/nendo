using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Nendo.Engine;

public sealed record NendoRecoveryExportPlan(
    string PlanId, string EntityId, string EntityName, string DestinationFileName,
    long ChangeSequence, int SourceRecordCount, int ExportedRecordCount,
    int OmittedRecordCount, IReadOnlyList<string> OmittedFieldIds,
    int SpreadsheetEscapedCells, int ByteCount, bool IsPartial,
    IReadOnlyList<NendoOpenFinding> Findings);

public sealed record NendoRecoveryExportResult(NendoRecoveryExportPlan Export, bool IsIdempotentReplay);

internal sealed record RecoveryCsv(byte[] Bytes, int SourceRows, int ExportedRows,
    IReadOnlyList<string> OmittedFields, int EscapedCells, IReadOnlyList<NendoOpenFinding> Findings)
{
    internal bool IsPartial => ExportedRows != SourceRows || OmittedFields.Count != 0;
}

internal static class RecoveryCsvWriter
{
    internal const int MaximumBytes = 4 * 1024 * 1024;
    internal const int MaximumRows = 10_000;
    internal const int MaximumFields = 128;
    private const int MaximumCellCharacters = 100_000;

    internal static RecoveryCsv Create(NendoEntitySnapshot entity, IReadOnlyList<NendoRecordSnapshot> records,
        CancellationToken cancellationToken, int maximumBytes = MaximumBytes, int maximumRows = MaximumRows)
    {
        var fields = entity.Fields.Where(field => field.StorageKind is >= NendoStorageKind.Text and <= NendoStorageKind.Uuid)
            .OrderBy(field => field.FieldId, StringComparer.Ordinal).Take(MaximumFields).ToArray();
        var selectedIds = fields.Select(field => field.FieldId).ToHashSet(StringComparer.Ordinal);
        var omitted = entity.Fields.Where(field => !selectedIds.Contains(field.FieldId)).Select(field => field.FieldId)
            .Order(StringComparer.Ordinal).ToArray();
        var rows = records.Where(record => record.EntityId == entity.EntityId).OrderBy(record => record.RecordId, StringComparer.Ordinal).ToArray();
        using var output = new MemoryStream();
        output.Write([0xEF, 0xBB, 0xBF]);
        var escaped = 0;
        var header = Row(new[] { "__nendo_record_id", "__nendo_record_version" }.Concat(fields.Select(field => "field/" + field.FieldId))
            .Select(value => Protect(value, ref escaped)));
        if (output.Length + header.Length > maximumBytes)
            throw new NendoPreconditionException("export-header-too-large", "The table's field identifiers exceed the recovery export limit. No file was created.");
        output.Write(header);
        var exported = 0;
        var unsupported = 0;
        var limitReached = false;
        foreach (var record in rows)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (exported >= maximumRows) { limitReached = true; break; }
            var escapedInRow = 0;
            var cells = new List<string> { Protect(record.RecordId, ref escapedInRow), record.RecordVersion.ToString(CultureInfo.InvariantCulture) };
            var valid = !string.IsNullOrWhiteSpace(record.RecordId) && record.RecordId.Length <= MaximumCellCharacters && record.RecordId.IndexOf('\0') < 0 && record.RecordVersion > 0;
            foreach (var field in fields)
            {
                if (!record.Values.TryGetValue(field.FieldId, out var value) || !TryCell(field.StorageKind, value, out var cell, out var isText))
                {
                    valid = false;
                    break;
                }
                cells.Add(isText ? Protect(cell, ref escapedInRow) : cell);
            }
            if (!valid) { unsupported++; continue; }
            var bytes = Row(cells);
            if (output.Length + bytes.Length > maximumBytes) { limitReached = true; break; }
            output.Write(bytes);
            escaped += escapedInRow;
            exported++;
        }
        var findings = new List<NendoOpenFinding>
        {
            new("csv-not-backup", "This CSV contains one table's readable scalar values and record identifiers/versions, not application definitions or history. The field/ column prefix identifies stable field IDs. It is not a backup or a round-trip format. Nulls are empty cells."),
        };
        if (omitted.Length != 0) findings.Add(new("csv-omitted-fields", $"{omitted.Length} unsupported or over-limit field(s) were excluded. Their stable field identifiers are listed in the export review."));
        if (unsupported != 0) findings.Add(new("csv-unsupported-rows", $"{unsupported} record(s) with unsupported values or invalid record metadata were omitted; values were not silently truncated."));
        if (limitReached) findings.Add(new("csv-limit", "The recovery export reached its row or byte limit. Remaining records were not exported."));
        if (escaped != 0) findings.Add(new("csv-spreadsheet-protection", $"{escaped} text cell(s) were prefixed with an apostrophe to prevent spreadsheet formula interpretation. That prefix is part of the exported value."));
        return new(output.ToArray(), rows.Length, exported, omitted, escaped, findings.AsReadOnly());
    }

    private static bool TryCell(NendoStorageKind kind, JsonElement value, out string cell, out bool isText)
    {
        cell = string.Empty;
        isText = false;
        if (value.ValueKind == JsonValueKind.Null) return true;
        if (kind == NendoStorageKind.Integer && value.TryGetInt64Safely(out var integer))
        { cell = integer.ToString(CultureInfo.InvariantCulture); return true; }
        if (kind == NendoStorageKind.Decimal && value.ValueKind == JsonValueKind.Number && value.TryGetDecimal(out var number))
        { cell = number.ToString(CultureInfo.InvariantCulture); return true; }
        if (kind == NendoStorageKind.Boolean && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
        { cell = value.GetBoolean() ? "true" : "false"; return true; }
        if (kind is not (NendoStorageKind.Text or NendoStorageKind.Date or NendoStorageKind.DateTime or NendoStorageKind.Uuid) || value.ValueKind != JsonValueKind.String) return false;
        cell = value.GetString()!;
        isText = true;
        if (cell.Length > MaximumCellCharacters || cell.IndexOf('\0') >= 0) return false;
        return kind switch
        {
            NendoStorageKind.Date => DateOnly.TryParseExact(cell, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _),
            NendoStorageKind.DateTime => DateTimeOffset.TryParse(cell, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out _),
            NendoStorageKind.Uuid => Guid.TryParse(cell, out _),
            _ => true,
        };
    }

    private static bool TryGetInt64Safely(this JsonElement value, out long number)
    {
        number = 0;
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out number);
    }

    private static string Protect(string text, ref int escaped)
    {
        var trimmed = text.TrimStart();
        if (text.StartsWith('\t') || text.StartsWith('\r') || text.StartsWith('\n') ||
            trimmed.Length != 0 && (trimmed[0] is '=' or '+' or '-' or '@' ||
                char.IsControl(trimmed[0]) || char.GetUnicodeCategory(trimmed[0]) == UnicodeCategory.Format))
        { escaped++; return "'" + text; }
        return text;
    }

    private static byte[] Row(IEnumerable<string> values) => Encoding.UTF8.GetBytes(
        string.Join(',', values.Select(value => "\"" + value.Replace("\"", "\"\"") + "\"")) + "\r\n");
}
