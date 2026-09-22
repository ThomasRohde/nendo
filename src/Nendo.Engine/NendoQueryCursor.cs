using System.Security.Cryptography;
using System.Text.Json;

namespace Nendo.Engine;

internal sealed class NendoQueryCursor
{
    private readonly byte[] _key = RandomNumberGenerator.GetBytes(32);

    internal string Encode(NendoManifestSnapshot manifest, string scope, string after)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(new Position(
            manifest.ApplicationId, manifest.InstanceId, manifest.ChangeSequence, scope, after));
        return $"{Convert.ToBase64String(payload)}.{Convert.ToBase64String(HMACSHA256.HashData(_key, payload))}";
    }

    internal string? Decode(string? cursor, NendoManifestSnapshot manifest, string scope)
    {
        if (cursor is null) return null;
        if (cursor.Length is 0 or > 4096) throw Invalid();
        try
        {
            var parts = cursor.Split('.');
            if (parts.Length != 2) throw Invalid();
            var payload = Convert.FromBase64String(parts[0]);
            var signature = Convert.FromBase64String(parts[1]);
            if (!CryptographicOperations.FixedTimeEquals(signature, HMACSHA256.HashData(_key, payload))) throw Invalid();
            var position = JsonSerializer.Deserialize<Position>(payload);
            if (position is null || position.ApplicationId != manifest.ApplicationId ||
                position.InstanceId != manifest.InstanceId || position.Scope != scope || position.After is null)
                throw Invalid();
            if (position.ChangeSequence != manifest.ChangeSequence)
                throw new NendoPreconditionException("stale-cursor", "The file changed during paging. Restart from the first page.");
            return position.After;
        }
        catch (Exception error) when (error is FormatException or JsonException)
        {
            throw Invalid();
        }
    }

    internal static void RequireLimit(int limit)
    {
        if (limit is < 1 or > 200)
            throw new NendoPreconditionException("invalid-limit", "A page must request between 1 and 200 items.");
    }

    private static NendoPreconditionException Invalid() => new("invalid-cursor", "The continuation does not belong to this open file and query.");
    private sealed record Position(string ApplicationId, string InstanceId, long ChangeSequence, string Scope, string After);
}
