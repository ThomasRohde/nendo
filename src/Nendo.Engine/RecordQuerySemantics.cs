using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;

namespace Nendo.Engine;

internal static class RecordQuerySemantics
{
    internal static string Scope(NendoRecordQuery query) => "records/typed/" + Convert.ToHexString(
        SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new {
            query.EntityId, query.SortFieldId, query.Descending, query.RecordId,
            Filters = query.Filters.Select(f => new { f.FieldId, f.Operator,
                Value = f.Value.ValueKind == JsonValueKind.Undefined ? null : f.Value.GetRawText() })
        })));

    internal static void Validate(NendoRecordQuery query)
    {
        if (query.RecordId is not null && (string.IsNullOrWhiteSpace(query.RecordId) || query.RecordId.Length > 200))
            throw new NendoValidationException("A record lookup requires a stable ID of 1–200 characters.");
        // The published ceiling and the ceiling that refuses are one constant, so
        // a surface authored against the vocabulary cannot compose past it here.
        if (query.Filters is null || query.Filters.Count > NendoSemanticVocabulary.MaximumEffectiveFilters)
            throw new NendoValidationException(
                $"A query supports at most {NendoSemanticVocabulary.MaximumEffectiveFilters} filters.");
        foreach (var filter in query.Filters)
        {
            if (filter is null || string.IsNullOrWhiteSpace(filter.FieldId) ||
                filter.Operator is not ("eq" or "ne" or "lt" or "le" or "gt" or "ge" or "contains" or "isNull" or "isNotNull"))
                throw new NendoValidationException("The record filter is invalid.");
            if (filter.Value.ValueKind != JsonValueKind.Undefined && filter.Value.GetRawText().Length > 4096)
                throw new NendoValidationException("A filter value exceeds 4096 characters.");
            if (filter.Operator is "isNull" or "isNotNull")
            {
                if (filter.Value.ValueKind is not (JsonValueKind.Undefined or JsonValueKind.Null))
                    throw new NendoValidationException("Null checks do not accept a value.");
            }
            else if (filter.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
                throw new NendoValidationException("Use isNull or isNotNull to query missing values.");
        }
    }

    // Called for SQLite's storage-owned typed collation and read-only projections.
    internal static int Compare(NendoStorageKind kind, string? left, string? right)
    {
        if (left is null || right is null) return left is null ? right is null ? 0 : -1 : 1;
        return kind switch {
            NendoStorageKind.Integer or NendoStorageKind.Boolean =>
                long.Parse(left, CultureInfo.InvariantCulture).CompareTo(long.Parse(right, CultureInfo.InvariantCulture)),
            NendoStorageKind.Decimal => Decimal(left).CompareTo(Decimal(right)),
            NendoStorageKind.DateTime => DateTimeOffset.Parse(left, CultureInfo.InvariantCulture).CompareTo(
                DateTimeOffset.Parse(right, CultureInfo.InvariantCulture)),
            _ => StringComparer.Ordinal.Compare(left, right),
        };
    }

    private static decimal Decimal(string value) => decimal.Parse(
        value.StartsWith("nendo.decimal:", StringComparison.Ordinal) ? value[14..] : value,
        NumberStyles.Float, CultureInfo.InvariantCulture);

    internal static string? Text(JsonElement value) => value.ValueKind switch {
        JsonValueKind.Undefined or JsonValueKind.Null => null,
        JsonValueKind.String => value.GetString(),
        JsonValueKind.True => "1",
        JsonValueKind.False => "0",
        _ => value.GetRawText(),
    };

    internal static bool Matches(string op, NendoStorageKind kind, string? actual, string? expected)
    {
        if (op == "isNull") return actual is null;
        if (op == "isNotNull") return actual is not null;
        if (actual is null) return false;
        if (op == "contains") return actual.Contains(expected!, StringComparison.OrdinalIgnoreCase);
        var compare = Compare(kind, actual, expected);
        return op switch { "eq" => compare == 0, "ne" => compare != 0, "lt" => compare < 0,
            "le" => compare <= 0, "gt" => compare > 0, "ge" => compare >= 0, _ => false };
    }
}
