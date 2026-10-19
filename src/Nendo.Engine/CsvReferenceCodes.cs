namespace Nendo.Engine;

/// <summary>
/// A reference column that names its targets by a unique field of the target record type
/// rather than by record ID (ADR-0020).
/// <para>
/// A spreadsheet names a parent by its code, "1.2", and a record ID is something only the
/// file knows. So a mapping may say which unique field of the target its cells hold, and
/// each cell is looked up among the rows of the same import first and the file's records
/// second. A code that names nothing, or names two things, is refused by its row. This is
/// matching by an identity the target has promised to keep unique, never by a label.
/// </para>
/// </summary>
public static class NendoCsvReferenceCodes
{
    /// <summary>
    /// The document with its rows reordered so that every row of a declared hierarchy comes
    /// after the row it names as its parent (ADR-0019: "ordered parents first within an
    /// import"). Rows keep their line numbers in the file, so every refusal still names the
    /// line a person sees. Returned unchanged when the parent column is not matched by a
    /// code this same import carries, since then no row can be another's parent.
    /// <para>
    /// A cell is read as the decode will read it under <paramref name="options"/>: a row whose
    /// code is empty or null has no code, so no row names it as a parent, and a row whose parent
    /// is empty or null is at the top level. Without options, External CSV is assumed,
    /// where an empty cell names nothing.
    /// </para>
    /// </summary>
    public static NendoCsvDocument OrderParentsFirst(
        NendoCsvDocument document,
        NendoEntitySnapshot entity,
        IReadOnlyList<NendoCsvMapping> mappings,
        NendoCsvOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(entity);
        ArgumentNullException.ThrowIfNull(mappings);
        if (entity.Hierarchy is not { } hierarchy) return document;
        var parent = mappings.SingleOrDefault(mapping => mapping.FieldId == hierarchy.ParentFieldId && mapping.MatchFieldId is not null);
        var code = parent is null ? null : mappings.SingleOrDefault(mapping => mapping.FieldId == parent.MatchFieldId);
        if (parent is null || code is null) return document;

        // A code in its exact case first, as the resolver matches it, then without regard to case.
        var rowOfExactCode = new Dictionary<string, int>(StringComparer.Ordinal);
        var rowOfCode = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < document.Rows.Count; index++)
        {
            if (CodeOf(document.Rows[index][code.Column], options) is not { } text) continue;
            rowOfExactCode.TryAdd(text, index);
            rowOfCode.TryAdd(text, index);
        }
        bool RowNamed(int row, out int above)
        {
            above = -1;
            return CodeOf(document.Rows[row][parent.Column], options) is { } named &&
                (rowOfExactCode.TryGetValue(named, out above) || rowOfCode.TryGetValue(named, out above));
        }

        var order = new List<int>(document.Rows.Count);
        var state = new byte[document.Rows.Count]; // 0 unseen, 1 on the path, 2 placed
        void Place(int start)
        {
            // Iterative, because a tree of 10,000 rows can be 10,000 deep.
            var path = new Stack<int>();
            var row = start;
            while (state[row] == 0)
            {
                state[row] = 1;
                path.Push(row);
                if (!RowNamed(row, out var above) || above == row) break;
                if (state[above] == 1)
                    throw new NendoValidationException(
                        $"CSV row {document.SourceRowNumber(row)}: its parent line leads back to itself through CSV row {document.SourceRowNumber(above)}, so the rows cannot be put parents first.");
                row = above;
            }
            while (path.Count > 0)
            {
                var next = path.Pop();
                state[next] = 2;
                order.Add(next);
            }
        }
        for (var index = 0; index < document.Rows.Count; index++)
            if (state[index] == 0) Place(index);

        if (order.Select((row, position) => row == position).All(same => same)) return document;
        return new NendoCsvDocument(document.Headers, order.Select(row => document.Rows[row]).ToArray())
        {
            SourceRowNumbers = order.Select(document.SourceRowNumber).ToArray(),
        };
    }

    /// <summary>
    /// The code a cell holds as the decode reads it, or null for none: an empty cell, the Nendo
    /// profile's null marker, or an empty cell External CSV reads as null. The Nendo profile's
    /// doubled leading backslash is one literal backslash, so "\\A1" is the code "\A1".
    /// </summary>
    internal static string? CodeOf(string cell, NendoCsvOptions? options)
    {
        if (cell.Length == 0) return null;
        if (options is { NendoProfile: true })
        {
            if (cell == "\\N") return null;
            if (cell.StartsWith("\\\\", StringComparison.Ordinal)) return cell[1..];
        }
        return cell;
    }
}

/// <summary>
/// Looks up the cells of one code-matched reference column. Built once per decode: the
/// target's existing records are read once, and the import's own rows are indexed once.
/// </summary>
internal sealed class CsvCodeResolver
{
    private readonly NendoFieldSnapshot _field;
    private readonly string _targetName;
    private readonly string _matchName;
    // Keyed without regard to case, each with every holder: SQLite's NOCASE folds only A to Z, so
    // "Ærø" and "ærø" can both be held, and a code is matched in its exact case first.
    private readonly IReadOnlyDictionary<string, List<(string Text, string RecordId, long Version)>> _existing;
    private readonly IReadOnlyDictionary<string, List<(string Text, int Row)>> _rows;

    private CsvCodeResolver(
        NendoFieldSnapshot field,
        string targetName,
        string matchName,
        IReadOnlyDictionary<string, List<(string, string, long)>> existing,
        IReadOnlyDictionary<string, List<(string, int)>> rows)
    {
        _field = field;
        _targetName = targetName;
        _matchName = matchName;
        _existing = existing;
        _rows = rows;
    }

    /// <summary>The candidates in the code's exact case when there are several, else all of them.</summary>
    private static List<T> Closest<T>(List<T> candidates, Func<T, string> text, string code)
    {
        if (candidates.Count < 2) return candidates;
        var exact = candidates.Where(candidate => string.Equals(text(candidate), code, StringComparison.Ordinal)).ToList();
        return exact.Count >= 1 ? exact : candidates;
    }

    internal static async Task<CsvCodeResolver> CreateAsync(
        NendoApplicationService service,
        IReadOnlyList<NendoEntitySnapshot> entities,
        NendoEntitySnapshot importing,
        NendoFieldSnapshot field,
        NendoCsvMapping mapping,
        IReadOnlyList<NendoCsvMapping> mappings,
        NendoCsvDocument document,
        NendoCsvOptions options,
        CancellationToken cancellationToken)
    {
        var target = field.Reference is { } reference
            ? entities.SingleOrDefault(entity => entity.EntityId == reference.TargetEntityId && !entity.Retired)
            : null;
        if (field.StorageKind != NendoStorageKind.Reference || target is null)
            throw new NendoValidationException($"{field.DisplayName} is not a reference, so it cannot be matched by a code.");
        var match = target.Fields.SingleOrDefault(candidate => candidate.FieldId == mapping.MatchFieldId && !candidate.Retired);
        if (match is null || !match.Unique)
            throw new NendoValidationException(
                $"{field.DisplayName} can be matched only by a unique field of {target.DisplayName}; {mapping.MatchFieldId} is not one.");

        var existing = new Dictionary<string, List<(string, string, long)>>(StringComparer.OrdinalIgnoreCase);
        // Every record of the target from one change: a commit between pages starts the read again.
        var records = await NendoWholeRead.AllAsync(cursor =>
            service.QueryRecordsAsync(new NendoRecordQuery(target.EntityId, 100, cursor), cancellationToken));
        foreach (var record in records)
        {
            if (!record.Values.TryGetValue(match.FieldId, out var value)) continue;
            if (RecordQuerySemantics.Text(value) is not { Length: > 0 } text) continue;
            if (!existing.TryGetValue(text, out var holders)) existing[text] = holders = [];
            holders.Add((text, record.RecordId, record.RecordVersion));
        }

        // The import's own rows can be targets only when they are records of the target type
        // and the import carries the matched field.
        var rows = new Dictionary<string, List<(string, int)>>(StringComparer.OrdinalIgnoreCase);
        if (target.EntityId == importing.EntityId &&
            mappings.SingleOrDefault(candidate => candidate.FieldId == match.FieldId) is { } own)
        {
            for (var index = 0; index < document.Rows.Count; index++)
            {
                // Keyed by the code the decode reads, which Resolve is given.
                if (NendoCsvReferenceCodes.CodeOf(document.Rows[index][own.Column], options) is not { } text) continue;
                if (!rows.TryGetValue(text, out var at)) rows[text] = at = [];
                at.Add((text, index));
            }
        }
        return new CsvCodeResolver(field, target.DisplayName, match.DisplayName, existing, rows);
    }

    /// <summary>The record a code names, and the version the write should expect of it.</summary>
    internal (string RecordId, long Version) Resolve(
        string code,
        int row,
        NendoCsvDocument document,
        Func<int, string?>? recordIdOfRow)
    {
        var holders = _existing.TryGetValue(code, out var all) ? Closest(all, holder => holder.Text, code) : [];
        if (holders.Count > 1)
            throw new NendoValidationException(
                $"{_matchName} “{code}” is held by more than one {_targetName} when case is set aside, and by none in exactly that case. Write it in its exact case.");
        var known = holders.Count == 1;
        var record = known ? (holders[0].RecordId, holders[0].Version) : default;
        if (_rows.TryGetValue(code, out var rowsOfCode))
        {
            var rows = Closest(rowsOfCode, row => row.Text, code);
            if (rows.Count > 1)
                throw new NendoValidationException($"{_matchName} “{code}” is on more than one CSV row, so it does not say which {_targetName} it means.");
            var other = rows[0].Row;
            if (other == row)
                throw new NendoValidationException($"{_matchName} “{code}” is this row's own.");
            if (other > row)
                throw new NendoValidationException(
                    $"{_matchName} “{code}” is CSV row {document.SourceRowNumber(other)}, which comes later in the import. Put the row it names first.");
            var planned = recordIdOfRow?.Invoke(other);
            if (planned is not null)
            {
                if (known && record.RecordId != planned)
                    throw new NendoValidationException(
                        $"{_matchName} “{code}” names both CSV row {document.SourceRowNumber(other)} and a {_targetName} the file already holds.");
                // Created earlier in this import: at version 1 unless it is already committed.
                return known ? record : (planned, 1);
            }
            // A row an earlier batch committed is a record of the file by now.
            if (known) return record;
            throw new NendoValidationException(
                $"{_matchName} “{code}” is CSV row {document.SourceRowNumber(other)}, which has not been imported.");
        }
        if (known) return record;
        throw new NendoValidationException($"No {_targetName} has {_matchName} “{code}”.");
    }

    internal string FieldId => _field.FieldId;
}
