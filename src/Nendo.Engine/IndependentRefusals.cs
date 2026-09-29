using System.Text.Json;
using Nendo.Engine.Storage;

namespace Nendo.Engine;

/// <summary>
/// Where in a change set a refusal happened: the mutation, and the operation inside it,
/// or <see cref="WholeMutation"/> when the refusal came from the mutation's own work after
/// its operations ran (materializing schema, the automatic actions, the revision).
/// </summary>
internal sealed class ChangeSetFailureLocation
{
    internal const int WholeMutation = -1;

    internal int? MutationIndex { get; private set; }

    internal int OperationIndex { get; private set; } = WholeMutation;

    /// <summary>Records the first place only, and answers false so it can sit in an exception filter.</summary>
    internal bool Record(int mutationIndex, int operationIndex)
    {
        if (MutationIndex is null)
        {
            MutationIndex = mutationIndex;
            OperationIndex = operationIndex;
        }
        return false;
    }
}

/// <summary>
/// Which refusals in one change set are independent of each other (W-010).
/// <para>
/// A clone validation stops at the first refusal, because the transaction it ran in is
/// no longer usable. So the only way to learn about a second problem is to run again
/// without the first. That is the easy part. The judgement is what else to leave out:
/// a field added to a record type whose creation was refused fails for the same reason,
/// and reporting it would send somebody after a problem that does not exist.
/// </para>
/// <para>
/// So an operation is left out with the refused one when it names anything the refused
/// one introduced, or any record the refused one wrote, directly or through another
/// operation left out. Identifiers the file already held before the change set do not
/// count: two fields added to one existing record type are independent. Removing an
/// operation also moves the versions the later ones expected, so a version conflict in a
/// later pass is a consequence of this method, never reported, and it ends the search.
/// </para>
/// </summary>
internal static class IndependentRefusals
{
    /// <summary>At most this many refusals are reported for one validation, the first included.</summary>
    internal const int MaximumReported = 5;

    private static readonly HashSet<string> CascadeCodes =
        new(StringComparer.Ordinal) { "definition-version-conflict", "record-version-conflict" };

    internal static bool IsCascade(NendoException exception) =>
        exception is NendoPreconditionException precondition && CascadeCodes.Contains(precondition.Code);

    /// <summary>
    /// The change set without the refused operation and everything that depends on it, or
    /// null when nothing independent is left to try or the dependency cannot be judged.
    /// </summary>
    internal static NendoChangeSet? Without(
        NendoChangeSet changeSet,
        ChangeSetFailureLocation location,
        IReadOnlySet<string> existingDefinitionIds)
    {
        if (location.MutationIndex is not { } failedMutation) return null;
        var failedFrom = location.OperationIndex == ChangeSetFailureLocation.WholeMutation ? 0 : location.OperationIndex;
        bool After(int mutation, int operation) =>
            mutation > failedMutation || (mutation == failedMutation && operation >= failedFrom);

        // What the file held, and what the operations that ran cleanly before the refusal
        // named, is established: a later operation naming it depends on nothing refused.
        var established = new HashSet<string>(existingDefinitionIds, StringComparer.Ordinal);
        for (var mutation = 0; mutation <= failedMutation; mutation++)
            for (var operation = 0; operation < changeSet.Mutations[mutation].Operations.Count; operation++)
                if (!After(mutation, operation))
                    established.UnionWith(IdentifiersOf(changeSet.Mutations[mutation].Operations[operation]));

        var removed = new HashSet<(int Mutation, int Operation)>();
        var introduced = new HashSet<string>(StringComparer.Ordinal);
        void Remove(int mutation, int operation)
        {
            removed.Add((mutation, operation));
            foreach (var id in IdentifiersOf(changeSet.Mutations[mutation].Operations[operation]))
                if (!established.Contains(id)) introduced.Add(id);
        }
        var failedOperations = location.OperationIndex == ChangeSetFailureLocation.WholeMutation
            ? Enumerable.Range(0, changeSet.Mutations[failedMutation].Operations.Count)
            : [location.OperationIndex];
        foreach (var operation in failedOperations) Remove(failedMutation, operation);

        // Every later operation that names something a left-out one introduced is left out
        // too, and what it introduced joins the set, so a chain is followed to its end.
        for (var mutation = failedMutation; mutation < changeSet.Mutations.Count; mutation++)
        {
            var operations = changeSet.Mutations[mutation].Operations;
            for (var operation = 0; operation < operations.Count; operation++)
            {
                if (!After(mutation, operation) || removed.Contains((mutation, operation))) continue;
                if (IdentifiersOf(operations[operation]).Any(introduced.Contains)) Remove(mutation, operation);
            }
        }

        var mutations = new List<NendoMutation>();
        for (var mutation = 0; mutation < changeSet.Mutations.Count; mutation++)
        {
            var kept = changeSet.Mutations[mutation].Operations
                .Where((_, operation) => !removed.Contains((mutation, operation)))
                .ToArray();
            if (kept.Length > 0) mutations.Add(changeSet.Mutations[mutation] with { Operations = kept });
        }
        if (mutations.Count == 0) return null;
        try
        {
            return new NendoChangeSet(mutations).Validate();
        }
        catch (NendoException)
        {
            // A shape that is only valid whole, such as a legacy reference conversion,
            // cannot be tried in part, and trying it would report the shape rather than
            // a second problem.
            return null;
        }
    }

    /// <summary>
    /// The identifiers an operation names: every string under a property whose name ends
    /// in Id or Ids, anywhere in its canonical payload. Record IDs are among them, which
    /// is what ties two writes to the same record together.
    /// </summary>
    internal static IReadOnlySet<string> IdentifiersOf(NendoOperation operation)
    {
        var found = new HashSet<string>(StringComparer.Ordinal);
        using var document = JsonDocument.Parse(operation.CanonicalJson());
        Walk(document.RootElement, null, found);
        found.Remove(operation.OperationId);
        return found;
    }

    private static void Walk(JsonElement element, string? name, HashSet<string> found)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var property in element.EnumerateObject()) Walk(property.Value, property.Name, found);
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray()) Walk(item, name, found);
                break;
            case JsonValueKind.String when name is not null && name != "operationId" &&
                (name.EndsWith("Id", StringComparison.Ordinal) || name.EndsWith("Ids", StringComparison.Ordinal)):
                found.Add(element.GetString()!);
                break;
        }
    }
}
