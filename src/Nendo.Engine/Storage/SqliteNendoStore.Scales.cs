using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// The closed scale a rating field is drawn on, ADR-0004 2026-09-14 amendment (S2).
    /// Its own table rather than two columns on <c>__nendo_field</c>, for the reason the
    /// tone table gives: the protected layout is a fingerprint of verbatim DDL, so a fresh
    /// file and an older one that gains a scale must end with byte-identical schema text,
    /// which an ALTER TABLE rewrite does not promise. A row exists only for a rating field,
    /// and the span is checked here as well as in the operation, so a row nothing authored
    /// cannot be read back as a scale nobody could draw.
    /// </summary>
    private const string RatingScaleSchemaSql = """
        CREATE TABLE __nendo_field_scale (
            field_id TEXT NOT NULL PRIMARY KEY,
            minimum INTEGER NOT NULL,
            maximum INTEGER NOT NULL,
            CHECK (maximum > minimum AND maximum - minimum <= 9),
            FOREIGN KEY (field_id) REFERENCES __nendo_field(field_id)
        );
        """;

    /// <summary>Brings the protected layout up to the scale rung: the whole ladder, then the scale table.</summary>
    private async Task EnsureRatingScaleLayoutAsync(SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureChoiceToneLayoutAsync(transaction, ct);
        if (!await TableExistsAsync("__nendo_field_scale", transaction, ct)) await NonQueryAsync(RatingScaleSchemaSql, transaction, ct);
    }

    /// <summary>
    /// Reads each rating field's scale back onto its mapping. A file that has never rated
    /// anything carries no table, and reads as though no field had a scale.
    /// </summary>
    private async Task PopulateRatingScalesAsync(List<FieldMapping> fields, SqliteTransaction? transaction, CancellationToken ct)
    {
        if (!await TableExistsAsync("__nendo_field_scale", transaction, ct)) return;
        var scales = new Dictionary<string, NendoRatingScale>(StringComparer.Ordinal);
        await using (var query = Command("SELECT field_id,minimum,maximum FROM __nendo_field_scale;", transaction))
        await using (var rows = await query.ExecuteReaderAsync(ct))
            while (await rows.ReadAsync(ct))
                scales[rows.GetString(0)] = new(rows.GetInt64(1), rows.GetInt64(2));
        for (var index = 0; index < fields.Count; index++)
            if (scales.TryGetValue(fields[index].FieldId, out var scale))
                fields[index] = fields[index] with { Scale = scale };
    }

    private async Task WriteRatingScaleAsync(AddFieldOperation operation, SqliteTransaction transaction, CancellationToken ct)
    {
        await EnsureRatingScaleLayoutAsync(transaction, ct);
        await using var command = Command(
            "INSERT INTO __nendo_field_scale(field_id,minimum,maximum) VALUES($field,$minimum,$maximum);",
            transaction);
        command.Parameters.AddWithValue("$field", operation.FieldId);
        command.Parameters.AddWithValue("$minimum", operation.Min!.Value);
        command.Parameters.AddWithValue("$maximum", operation.Max!.Value);
        await command.ExecuteNonQueryAsync(ct);
    }

    /// <summary>
    /// A scale and the field carrying it must agree: a scale belongs to a rating Integer
    /// and is drawable, and a rating field has one. A rating whose scale went missing is
    /// drift rather than an unknown presentation, because the presentation is one this
    /// host knows and the drawing is what it has lost.
    /// </summary>
    private static bool RatingScaleMetadataIsValid(IReadOnlyList<EntityMapping> entities) => entities.SelectMany(entity => entity.Fields)
        .All(field => field.Presentation == "rating"
            ? field.Scale is { } scale && field.StorageKind == NendoStorageKind.Integer &&
              scale.Max > scale.Min && scale.Max - scale.Min <= AddFieldOperation.MaximumRatingSpan
            : field.Scale is null);
}
