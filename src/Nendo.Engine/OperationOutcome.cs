namespace Nendo.Engine;

/// <summary>
/// Stable identity within an application's durable idempotency history. A
/// receipt lookup is read-only and grants no modifying authority. A missing
/// receipt is not proof that a delayed request cannot still arrive; retain and
/// retry the original identity/payload instead of generating a new key.
/// </summary>
public sealed record NendoOperationIdentity(string IdempotencyScope, string IdempotencyKey)
{
    internal void Validate()
    {
        if (string.IsNullOrWhiteSpace(IdempotencyScope) || IdempotencyScope.Length > 200 ||
            string.IsNullOrWhiteSpace(IdempotencyKey) || IdempotencyKey.Length > 200)
            throw new NendoValidationException("An operation identity needs a scope and key of 1-200 characters each.");
    }
}
