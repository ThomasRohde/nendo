using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nendo.Engine;

public sealed record NendoCsvDocument(IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<string>> Rows);
public sealed record NendoCsvMapping(int Column, string FieldId);
public sealed record NendoCsvOptions(bool NendoProfile, bool EmptyIsNull = false);
public sealed record NendoCsvRow(int SourceRow, IReadOnlyDictionary<string, object?> Values,
    IReadOnlyDictionary<string, long> ExpectedTargetVersions);
/// <summary>
/// What one page of a faithful CSV export wrote, and where the next page starts.
/// </summary>
/// <param name="ChangeSequence">
/// The file's change sequence when this page was read. A caller stitching pages together
/// compares it across them: a page read after somebody else committed does not belong in
/// the same export as the pages before it.
/// </param>
public sealed record NendoCsvExportPage(
    int RecordCount,
    string? NextCursor,
    long ChangeSequence,
    IReadOnlyList<string> FieldIds);

public sealed record NendoCsvBatchPreview(NendoProposalPreview Proposal, IReadOnlyList<NendoCsvRow> Rows);

/// <summary>Faithful CSV syntax and scalar conversion; no paths or write authority.</summary>
public static class NendoCsvProfile
{
    public const int MaximumBytes = 16 * 1024 * 1024;
    public const int MaximumRows = 10_000;
    public const int MaximumColumns = 100;
    public const int MaximumCellCharacters = 65_536;
    public const int BatchSize = 100;

    public static NendoCsvDocument Parse(ReadOnlySpan<byte> bytes, CancellationToken cancellationToken = default)
    {
        if (bytes.Length > MaximumBytes) throw new NendoValidationException("CSV exceeds the 16 MiB input limit.");
        string text;
        try { text = new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException) { throw new NendoValidationException("CSV must contain valid UTF-8."); }
        if (text.StartsWith('\uFEFF')) text = text[1..];
        var rows = new List<IReadOnlyList<string>>(); var row = new List<string>(); var cell = new StringBuilder();
        var quoted = false; var closedQuote = false; var started = false;
        void AddCell()
        {
            if (row.Count >= MaximumColumns) throw Error("more than 100 columns");
            row.Add(cell.ToString()); cell.Clear(); closedQuote = false; started = false;
        }
        void AddRow()
        {
            AddCell(); rows.Add(row.ToArray()); row.Clear();
            if (rows.Count > MaximumRows + 1) throw Error("more than 10,000 data rows");
        }
        NendoValidationException Error(string message) => new($"CSV row {rows.Count + 1}, column {row.Count + 1}: {message}.");
        for (var index = 0; index < text.Length; index++)
        {
            if ((index & 1023) == 0) cancellationToken.ThrowIfCancellationRequested();
            var character = text[index];
            if (quoted)
            {
                if (character == '"')
                {
                    if (index + 1 < text.Length && text[index + 1] == '"') { cell.Append('"'); index++; }
                    else { quoted = false; closedQuote = true; }
                }
                else cell.Append(character);
            }
            else if (character == ',') AddCell();
            else if (character is '\r' or '\n')
            {
                if (character == '\r' && index + 1 < text.Length && text[index + 1] == '\n') index++;
                AddRow();
            }
            else if (character == '"' && !started && !closedQuote && cell.Length == 0) { quoted = true; started = true; }
            else
            {
                if (closedQuote || character == '"') throw Error("malformed quoting");
                cell.Append(character); started = true;
            }
            if (cell.Length > MaximumCellCharacters) throw Error("cell exceeds 64 Ki characters");
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (quoted) throw Error("unterminated quoted cell");
        if (started || closedQuote || cell.Length != 0 || row.Count != 0) AddRow();
        if (rows.Count == 0) throw new NendoValidationException("CSV needs a header row.");
        var headers = rows[0];
        if (headers.Any(string.IsNullOrWhiteSpace) || headers.Distinct(StringComparer.Ordinal).Count() != headers.Count)
            throw new NendoValidationException("CSV headers must be nonblank and unique.");
        for (var index = 1; index < rows.Count; index++)
            if (rows[index].Count != headers.Count) throw new NendoValidationException($"CSV row {index + 1} has {rows[index].Count} cells; expected {headers.Count}.");
        return new(headers, rows.Skip(1).ToArray());
    }

    public static object? Decode(string cell, NendoFieldSnapshot field, NendoCsvOptions options)
    {
        var isNull = options.NendoProfile ? cell == "\\N" : options.EmptyIsNull && cell.Length == 0;
        if (isNull)
        {
            if (field.Required) throw new NendoValidationException("Required field cannot be null.");
            return null;
        }
        if (options.NendoProfile && cell.StartsWith("\\\\", StringComparison.Ordinal)) cell = cell[1..];
        else if (options.NendoProfile && cell.StartsWith('\\')) throw new NendoValidationException("Unescaped leading backslash in Nendo CSV text.");
        if (field.Presentation == "singleChoice" && (!field.Options.Contains(cell, StringComparer.Ordinal) || field.Choices.Any(choice => choice.Id == cell && choice.Retired)))
            throw new NendoValidationException("Value must be an active choice ID.");
        switch (field.StorageKind)
        {
            case NendoStorageKind.Text: return cell;
            case NendoStorageKind.Reference:
                if (string.IsNullOrWhiteSpace(cell) || field.Reference is null) throw new NendoValidationException("Reference needs a configured target and a record ID.");
                return cell;
            case NendoStorageKind.Integer:
                if (Regex.IsMatch(cell, "^-?(0|[1-9][0-9]*)$") && long.TryParse(cell, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var integer)) return integer;
                break;
            case NendoStorageKind.Decimal:
                if (!Regex.IsMatch(cell, @"^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$")) break;
                try { using var json = JsonDocument.Parse(cell); return ExactDecimal.Read(json.RootElement); }
                catch (JsonException) { break; }
            case NendoStorageKind.Boolean:
                if (cell == "true") return true; if (cell == "false") return false; break;
            case NendoStorageKind.Date:
                if (DateOnly.TryParseExact(cell, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return cell; break;
            case NendoStorageKind.DateTime:
                if (Regex.IsMatch(cell, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$") && DateTimeOffset.TryParse(cell, CultureInfo.InvariantCulture, DateTimeStyles.None, out _)) return cell; break;
            case NendoStorageKind.Uuid:
                if (Guid.TryParseExact(cell, "D", out _)) return cell; break;
        }
        throw new NendoValidationException($"Invalid {field.StorageKind} value; use the documented exact scalar format.");
    }

    public static string Encode(JsonElement value)
    {
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return Quote("\\N");
        var text = value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText();
        if (text.StartsWith('\\')) text = "\\" + text;
        return Quote(text);
    }
    public static string Quote(string value) => "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
}
