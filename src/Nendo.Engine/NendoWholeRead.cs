namespace Nendo.Engine;

/// <summary>
/// Every page of one query, read as one answer by an Engine step that needs the whole set: the
/// code resolver of a CSV import and the siblings of a move.
/// <para>
/// A page cursor binds the file's change sequence, so a commit between two pages — an automatic
/// action, a view saving its state, another client — makes the next page stale. A person never
/// paged here, so the stale page is not theirs to restart: the read starts again from the first
/// page, and what it returns comes from one change. A file that keeps changing under the read is
/// refused after <see cref="Attempts"/> starts with the paging message, as before.
/// </para>
/// </summary>
internal static class NendoWholeRead
{
    internal const int Attempts = 5;

    /// <summary>
    /// A test's own step between two pages, run only in the flow that set it, so a test can commit
    /// where somebody else would and measure that the read it drives starts again.
    /// </summary>
    internal static readonly AsyncLocal<Func<Task>?> BetweenPages = new();

    /// <param name="readPage">One page from the cursor, null for the first.</param>
    /// <param name="afterPage">Called with everything read so far after each page; it may refuse.</param>
    internal static async Task<List<T>> AllAsync<T>(
        Func<string?, Task<NendoPage<T>>> readPage,
        Action<List<T>>? afterPage = null)
    {
        ArgumentNullException.ThrowIfNull(readPage);
        for (var attempt = 1; ; attempt++)
        {
            var items = new List<T>();
            try
            {
                string? cursor = null;
                do
                {
                    var page = await readPage(cursor);
                    items.AddRange(page.Items);
                    afterPage?.Invoke(items);
                    cursor = page.NextCursor;
                    if (cursor is not null && BetweenPages.Value is { } between) await between();
                } while (cursor is not null);
                return items;
            }
            catch (NendoPreconditionException stale) when (stale.Code == "stale-cursor" && attempt < Attempts)
            {
                // Somebody committed between two pages: start again from the first.
            }
        }
    }
}
