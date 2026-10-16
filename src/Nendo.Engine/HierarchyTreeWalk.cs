namespace Nendo.Engine;

/// <summary>One child as a sibling seek returns it: its record ID, its order value and how many children it has.</summary>
internal readonly record struct NendoTreeChild(string RecordId, long? Order, int ChildCount);

/// <summary>One record of a tree window, in depth-first order.</summary>
internal readonly record struct NendoTreeStep(string RecordId, string? ParentRecordId, int Depth, int ChildCount);

/// <summary>
/// The depth-first walk of a declared hierarchy, resumed after the last record a page showed
/// (ADR-0019, 2026-10-16 amendment). A page asks only for the siblings it shows: at each level, the
/// children of one parent after a given sibling, in sibling order, a few at a time. So a page costs
/// its own records and the depth above it, never the records before it, and a whole read costs
/// what it returns. Until 2026-10-16 every page walked and sorted the whole subtree and cut itself
/// by position, so reading N records cost about N squared, and the walk refused past 10,000.
/// </summary>
internal static class NendoTreeWalk
{
    /// <summary>
    /// The children of <paramref name="parent"/> (null for the top level) that follow
    /// <paramref name="after"/> in sibling order, or from the first when it is null: at most
    /// <paramref name="limit"/>. Sibling order is the order field ascending, unordered last, then
    /// record ID.
    /// </summary>
    internal delegate Task<IReadOnlyList<NendoTreeChild>> SeekChildren(string? parent, NendoTreeChild? after, int limit, CancellationToken cancellationToken);

    /// <summary>The first batch a level asks for; it doubles while a level returns full batches.</summary>
    private const int FirstBatch = 16;

    /// <summary>
    /// Up to <paramref name="take"/> records of the window under <paramref name="root"/> (null for
    /// the whole tree), at most <paramref name="depth"/> levels deep. <paramref name="chain"/> is
    /// the record the previous page ended on and its ancestors below the root, top first; empty
    /// for the first page.
    /// </summary>
    internal static async Task<List<NendoTreeStep>> CollectAsync(string? root, int depth, int take,
        IReadOnlyList<NendoTreeChild> chain, SeekChildren seek, CancellationToken cancellationToken)
    {
        var steps = new List<NendoTreeStep>(take);
        var levels = new Stack<Level>();
        if (chain.Count == 0) levels.Push(new(root, 1, null));
        else
        {
            // Resuming: every level of the chain continues after its own record, the deepest first,
            // and the record the page ended on still has its children ahead of its next sibling.
            for (var index = 0; index < chain.Count; index++)
                levels.Push(new(index == 0 ? root : chain[index - 1].RecordId, index + 1, chain[index]));
            if (chain.Count < depth) levels.Push(new(chain[^1].RecordId, chain.Count + 1, null));
        }
        while (steps.Count < take && levels.Count > 0)
        {
            var level = levels.Peek();
            var want = Math.Min(take - steps.Count, level.Batch);
            var children = await seek(level.Parent, level.After, want, cancellationToken);
            var descended = false;
            foreach (var child in children)
            {
                steps.Add(new(child.RecordId, level.Parent, level.Depth, child.ChildCount));
                level.After = child;
                if (steps.Count == take) return steps;
                if (level.Depth < depth && child.ChildCount > 0)
                {
                    levels.Push(new(child.RecordId, level.Depth + 1, null));
                    descended = true;
                    break;
                }
            }
            if (descended) continue;
            if (children.Count < want) levels.Pop();
            else level.Batch = Math.Min(level.Batch * 2, 256);
        }
        return steps;
    }

    private sealed class Level(string? parent, int depth, NendoTreeChild? after)
    {
        public string? Parent { get; } = parent;
        public int Depth { get; } = depth;
        public NendoTreeChild? After { get; set; } = after;
        public int Batch { get; set; } = FirstBatch;
    }
}
