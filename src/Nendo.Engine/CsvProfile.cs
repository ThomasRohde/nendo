using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nendo.Engine;

public sealed record NendoCsvDocument(IReadOnlyList<string> Headers, IReadOnlyList<IReadOnlyList<string>> Rows)
{
    /// <summary>
    /// The line each row has in the file a person opened, when the rows were reordered
    /// (parents first). Null means the rows are in file order.
    /// </summary>
    public IReadOnlyList<int>? SourceRowNumbers { get; init; }

    /// <summary>The line a person counts to in their own file: one-based, past the header.</summary>
    public int SourceRowNumber(int index) => SourceRowNumbers?[index] ?? index + 2;
}

public sealed record NendoCsvMapping(int Column, string FieldId)
{
    /// <summary>
    /// For a reference column, the unique field of the target record type its cells hold,
    /// such as a code, in place of record IDs. Null means record IDs.
    /// </summary>
    public string? MatchFieldId { get; init; }
}
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

    /// <summary>
    /// The encoding an export file is written in: UTF-8 with its byte-order mark, so a
    /// spreadsheet opened on the file by a double-click reads æ, ø and å rather than the
    /// ANSI code page's guess at them. <see cref="Parse"/> drops the mark again.
    /// </summary>
    public static Encoding FileEncoding { get; } = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true);

    public static NendoCsvDocument Parse(ReadOnlySpan<byte> bytes, CancellationToken cancellationToken = default)
    {
        if (bytes.Length > MaximumBytes) throw new NendoValidationException("CSV exceeds the 16 MiB input limit.");
        string text;
        try { text = new UTF8Encoding(false, true).GetString(bytes); }
        catch (DecoderFallbackException) { throw new NendoValidationException("CSV must contain valid UTF-8."); }
        if (text.StartsWith('\uFEFF')) text = text[1..];
        var rows = new List<IReadOnlyList<string>>(); var row = new List<string>(); var cell = new StringBuilder();
        var quoted = false; var closedQuote = false; var started = false;
        // The record each row is in the file, blank lines counted, so a refusal names the row a
        // person counts to although a blank line is not a row.
        var record = 1; var numbers = new List<int>();
        void AddCell()
        {
            if (row.Count >= MaximumColumns) throw Error("more than 100 columns");
            row.Add(cell.ToString()); cell.Clear(); closedQuote = false; started = false;
        }
        void AddRow()
        {
            AddCell(); rows.Add(row.ToArray()); row.Clear(); numbers.Add(record);
            if (rows.Count > MaximumRows + 1) throw Error("more than 10,000 data rows");
        }
        NendoValidationException Error(string message) => new($"CSV row {record}, column {row.Count + 1}: {message}.");
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
                // A line on which nothing was read, not even a quote, is a blank line rather than
                // a row of one empty cell. A quoted empty cell, "", is still a row.
                if (started || closedQuote || cell.Length != 0 || row.Count != 0) AddRow();
                record++;
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
        // A spreadsheet that once formatted a column past the data writes it on every line: a
        // trailing column with no header and nothing in it is dropped, not refused.
        var width = rows[0].Count;
        while (width > 1 && string.IsNullOrWhiteSpace(rows[0][width - 1]) &&
            rows.Skip(1).All(line => line.Count < width || line[width - 1].Length == 0))
            width--;
        if (width < rows[0].Count)
            for (var index = 0; index < rows.Count; index++)
                if (rows[index].Count > width) rows[index] = rows[index].Take(width).ToArray();
        var headers = rows[0];
        for (var column = 0; column < headers.Count; column++)
        {
            if (string.IsNullOrWhiteSpace(headers[column]))
                throw new NendoValidationException($"CSV column {column + 1} has no header. Give it one, or remove the column.");
            var first = headers.Take(column).ToList().IndexOf(headers[column]);
            if (first >= 0)
                throw new NendoValidationException(
                    $"CSV columns {first + 1} and {column + 1} are both “{headers[column]}”. Give each column its own header.");
        }
        for (var index = 1; index < rows.Count; index++)
            if (rows[index].Count != headers.Count) throw new NendoValidationException($"CSV row {numbers[index]} has {rows[index].Count} cells; expected {headers.Count}.");
        var data = numbers.Skip(1).ToArray();
        return new(headers, rows.Skip(1).ToArray())
        {
            SourceRowNumbers = data.Select((number, index) => number == index + 2).All(same => same) ? null : data,
        };
    }

    public static object? Decode(string cell, NendoFieldSnapshot field, NendoCsvOptions options)
    {
        var isNull = options.NendoProfile ? cell == "\\N" : options.EmptyIsNull && cell.Length == 0;
        if (isNull)
        {
            // A sequence field is filled by the host when the record is written, so a null
            // cell is a request for the next code, not a missing required value.
            if (field.Required && field.Sequence is null) throw new NendoValidationException("Required field cannot be null.");
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
        throw new NendoValidationException($"Invalid {field.StorageKind} value: {Expected(field.StorageKind)}, got “{Shown(cell)}”.");
    }

    /// <summary>The exact form a kind takes in a cell (scalars.md), as a person can act on it.</summary>
    private static string Expected(NendoStorageKind kind) => kind switch
    {
        NendoStorageKind.Integer => "expects a whole number such as 42, without spaces or separators",
        NendoStorageKind.Decimal => "expects a number such as 12.5, with a dot for decimals and without spaces or separators",
        NendoStorageKind.Boolean => "expects true or false, in lower case",
        NendoStorageKind.Date => "expects a date as yyyy-MM-dd, such as 2026-10-25",
        NendoStorageKind.DateTime => "expects a date and time as yyyy-MM-ddTHH:mm:ss with Z or an offset, such as 2026-10-25T14:30:00+02:00",
        NendoStorageKind.Uuid => "expects a UUID in its hyphenated form, such as 95e7a1b4-c54a-41bb-83cc-9eae7adf61bb",
        _ => "expects its documented exact form",
    };

    private static string Shown(string cell) => cell.Length <= 40 ? cell : cell[..40] + "…";

    public static string Encode(JsonElement value)
    {
        if (value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return Quote("\\N");
        var text = value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText();
        if (text.StartsWith('\\')) text = "\\" + text;
        return Quote(text);
    }
    public static string Quote(string value) => "\"" + value.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
}
