using System.Text.Json;

namespace Nendo.Engine;

/// <summary>
/// One streamed fold of a grid: a bucket per cell of two crossed closed groupings
/// (ADR-0004, 2026-09-17 amendment, S6). Every cell key is produced from the cross
/// product of the two option sets before a single row is read, each axis carrying
/// its own unset lane, so a cell with nothing in it is a cell rather than a gap the
/// data left behind.
/// <para>
/// A matrix therefore costs one read whether it has four cells or two hundred, and
/// every number it states is exact over everything the surface's clauses cover
/// rather than over the page of records in view. Shared by the SQLite read and the
/// safe-mode snapshot read so the two cannot disagree about which cell a pair of
/// stored values lands in. Memory is bounded by the number of cells, never by the
/// number of records.
/// </para>
/// </summary>
internal sealed class CellAggregateFold
{
    private sealed class Bucket(string aggregate, bool integral)
    {
        internal long Count;
        internal readonly ExactAggregate Fold = new(aggregate, integral);
    }

    private readonly IReadOnlyList<string> _rowKeys;
    private readonly IReadOnlyList<string> _columnKeys;
    private readonly Dictionary<string, int> _rowIndex;
    private readonly Dictionary<string, int> _columnIndex;
    private readonly Bucket[,] _cells;
    private readonly string _aggregate;
    private long _unrecognised;

    internal CellAggregateFold(
        IReadOnlyList<string> rowKeys, IReadOnlyList<string> columnKeys, string aggregate, bool integral)
    {
        EnsureCellsFit(rowKeys.Count, columnKeys.Count);
        _rowKeys = rowKeys;
        _columnKeys = columnKeys;
        _aggregate = aggregate;
        _rowIndex = Index(rowKeys);
        _columnIndex = Index(columnKeys);
        // One lane past each axis is the unset lane: a record with no value there is
        // somewhere rather than nowhere, so every record is in exactly one cell.
        _cells = new Bucket[rowKeys.Count + 1, columnKeys.Count + 1];
        for (var row = 0; row <= rowKeys.Count; row++)
            for (var column = 0; column <= columnKeys.Count; column++)
                _cells[row, column] = new Bucket(aggregate, integral);
    }

    private static Dictionary<string, int> Index(IReadOnlyList<string> keys)
    {
        var index = new Dictionary<string, int>(keys.Count, StringComparer.Ordinal);
        for (var position = 0; position < keys.Count; position++) index[keys[position]] = position;
        return index;
    }

    /// <summary>
    /// The published ceiling, spent on the cross product rather than on one axis. A grid
    /// whose two option sets multiply past it cannot be drawn at all: drawing the cells
    /// that fit would look exactly like a whole grid, which is the one wrong answer.
    /// </summary>
    internal static void EnsureCellsFit(int rows, int columns)
    {
        var cells = (long)(rows + 1) * (columns + 1);
        if (cells > NendoSemanticVocabulary.MaximumAggregateGroups)
            throw new NendoValidationException(
                $"A grid of {rows + 1} rows and {columns + 1} columns is {cells} cells, and a grouped read answers " +
                $"at most {NendoSemanticVocabulary.MaximumAggregateGroups}. The unset lane on each axis is one of them.");
    }

    internal void Add(string? rowKey, string? columnKey, decimal? value)
    {
        if (!Lane(rowKey, _rowIndex, _rowKeys.Count, out var row) ||
            !Lane(columnKey, _columnIndex, _columnKeys.Count, out var column))
        {
            // A stored value that is none of the field's options is a data issue the
            // renderer states, never a cell nobody configured.
            _unrecognised++;
            return;
        }
        var bucket = _cells[row, column];
        bucket.Count++;
        if (value is { } contributing) bucket.Fold.Add(contributing);
    }

    private static bool Lane(string? key, Dictionary<string, int> index, int unsetLane, out int lane)
    {
        if (key is null) { lane = unsetLane; return true; }
        return index.TryGetValue(key, out lane);
    }

    /// <summary>
    /// The cells in row-major order: each configured row in the field's order and then the
    /// unset row, and within a row each configured column and then the unset column. A
    /// caller draws the grid from <see cref="NendoRecordCellAggregate.RowKeys"/> and
    /// <see cref="NendoRecordCellAggregate.ColumnKeys"/> and never has to infer the shape
    /// from which cells happen to carry a number.
    /// </summary>
    internal NendoRecordCellAggregate Result(NendoRecordCellAggregateQuery query, long changeSequence)
    {
        var cells = new List<NendoRecordAggregateCell>((_rowKeys.Count + 1) * (_columnKeys.Count + 1));
        for (var row = 0; row <= _rowKeys.Count; row++)
        {
            var rowKey = row == _rowKeys.Count ? null : _rowKeys[row];
            for (var column = 0; column <= _columnKeys.Count; column++)
            {
                var columnKey = column == _columnKeys.Count ? null : _columnKeys[column];
                cells.Add(Cell(rowKey, columnKey, _cells[row, column]));
            }
        }
        return new(query.EntityId, query.RowByFieldId, query.ColumnByFieldId, query.Aggregate, query.FieldId,
            _rowKeys, _columnKeys, cells, _unrecognised, changeSequence);
    }

    private NendoRecordAggregateCell Cell(string? rowKey, string? columnKey, Bucket bucket) => _aggregate == "count"
        ? new(rowKey, columnKey, JsonSerializer.SerializeToElement(bucket.Count), bucket.Count)
        : new(rowKey, columnKey, bucket.Fold.Value(), bucket.Fold.ContributingRecords);
}
