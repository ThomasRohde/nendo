using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// A declared surface query must survive paging. The renderer used to send the
/// query only for its Studio window, so the second page of a Use surface arrived
/// with no filter and no sort: the host hashes the whole query into the cursor
/// scope, so such a continuation either refuses or answers a different question.
/// This is the request-level shape the renderer has to produce, page by page.
/// </summary>
[TestClass]
public sealed class WorkbenchDeclaredQueryPagingTests
{
    // Ordinal comparison against a single letter separates the two title sets
    // without needing a second field: every Matching title sorts below it and
    // every Other title above.
    private const string Boundary = "N";

    [TestMethod]
    public async Task PagingADeclaredQueryResendsTheSameArgumentsAndKeepsTheDeclaredOrder()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var initial = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");

        // Sixty matching records is more than one 50-record page, so page two is
        // where a dropped filter first changes the answer. The twenty
        // nonmatching records are the ones an unfiltered continuation lets in.
        for (var index = 0; index < 60; index++)
            await session.CreateIdeaRecordAsync($"match-{index:D3}", $"Matching {index:D3}", $"match-{index:D3}");
        for (var index = 0; index < 20; index++)
            await session.CreateIdeaRecordAsync($"other-{index:D3}", $"Other {index:D3}", $"other-{index:D3}");

        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null), _ => { });

        var first = await PageAsync(null);
        Assert.HasCount(50, first.Items);
        Assert.IsNotNull(first.NextCursor, "Sixty matching records do not fit one page.");
        AssertAllMatching(first);

        // The declared order is descending title, so page one holds the highest
        // titles and page two continues downward without repeating any.
        var second = await PageAsync(first.NextCursor);
        Assert.HasCount(10, second.Items, "Only the sixty matching records are in scope.");
        Assert.IsNull(second.NextCursor);
        AssertAllMatching(second);

        var paged = first.Items.Concat(second.Items).Select(Title).ToArray();
        var expected = Enumerable.Range(0, 60).Select(index => $"Matching {index:D3}")
            .OrderByDescending(title => title, StringComparer.Ordinal).ToArray();
        CollectionAssert.AreEqual(expected, paged, "Every matching record appears once, in the declared order.");

        // Previous is page one again with the same arguments and a null cursor.
        var back = await PageAsync(null);
        CollectionAssert.AreEqual(first.Items.Select(Title).ToArray(), back.Items.Select(Title).ToArray());

        async Task<NendoPage<NendoRecordSnapshot>> PageAsync(string? cursor)
        {
            var response = await handler.HandleAsync(Request(new
            {
                entityId = NendoApplicationService.IdeaEntityId,
                limit = 50,
                cursor,
                sortFieldId = NendoApplicationService.IdeaTitleFieldId,
                descending = true,
                filters = new[]
                {
                    new { fieldId = NendoApplicationService.IdeaTitleFieldId, @operator = "lt", value = Boundary },
                },
            }));
            Assert.IsTrue(response.Ok, response.Error?.Message);
            return (NendoPage<NendoRecordSnapshot>)response.Result!;
        }

        string Request(object payload) => JsonSerializer.Serialize(new
        {
            protocolVersion = 5,
            requestId = Guid.NewGuid().ToString("N"),
            method = WorkbenchMethods.DataQueryRecords,
            fileSessionId = initial.FileSessionId,
            boundedRead = true,
            payload,
        });
    }

    /// <summary>
    /// The host refusal, checked on its own: a continuation whose query moved is
    /// rejected rather than quietly answered over the wider set. That is why
    /// losing the filter between pages is not a cosmetic slip.
    /// </summary>
    [TestMethod]
    public async Task AContinuationThatDropsTheDeclaredQueryIsRefusedAsAnInvalidCursor()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        var initial = await session.CreateAsync(workspace.FilePath);
        await session.CreateIdeaSchemaAsync("schema");
        for (var index = 0; index < 60; index++)
            await session.CreateIdeaRecordAsync($"match-{index:D3}", $"Matching {index:D3}", $"match-{index:D3}");

        var handler = new WorkbenchProtocolHandler(session, () => Task.FromResult<string?>(null),
            () => Task.FromResult<string?>(null), _ => { });
        var filtered = await handler.HandleAsync(Request(new
        {
            entityId = NendoApplicationService.IdeaEntityId,
            limit = 50,
            sortFieldId = NendoApplicationService.IdeaTitleFieldId,
            descending = true,
            filters = new[]
            {
                new { fieldId = NendoApplicationService.IdeaTitleFieldId, @operator = "lt", value = Boundary },
            },
        }));
        Assert.IsTrue(filtered.Ok, filtered.Error?.Message);
        var page = (NendoPage<NendoRecordSnapshot>)filtered.Result!;
        Assert.IsNotNull(page.NextCursor);

        var dropped = await handler.HandleAsync(Request(new
        {
            entityId = NendoApplicationService.IdeaEntityId, limit = 50, cursor = page.NextCursor,
        }));
        Assert.IsFalse(dropped.Ok);
        Assert.AreEqual("invalid-cursor", dropped.Error!.Code,
            "An unfiltered continuation of a filtered query is refused, not widened.");

        // Only the declared order moving is equally a different query.
        var reordered = await handler.HandleAsync(Request(new
        {
            entityId = NendoApplicationService.IdeaEntityId,
            limit = 50,
            cursor = page.NextCursor,
            sortFieldId = NendoApplicationService.IdeaTitleFieldId,
            descending = false,
            filters = new[]
            {
                new { fieldId = NendoApplicationService.IdeaTitleFieldId, @operator = "lt", value = Boundary },
            },
        }));
        Assert.IsFalse(reordered.Ok);
        Assert.AreEqual("invalid-cursor", reordered.Error!.Code);

        string Request(object payload) => JsonSerializer.Serialize(new
        {
            protocolVersion = 5,
            requestId = Guid.NewGuid().ToString("N"),
            method = WorkbenchMethods.DataQueryRecords,
            fileSessionId = initial.FileSessionId,
            boundedRead = true,
            payload,
        });
    }

    private static string Title(NendoRecordSnapshot record) =>
        record.Values[NendoApplicationService.IdeaTitleFieldId].GetString()!;

    private static void AssertAllMatching(NendoPage<NendoRecordSnapshot> page)
    {
        foreach (var record in page.Items)
            StringAssert.StartsWith(Title(record), "Matching",
                "A nonmatching record reaching the page means the declared filter was lost.");
    }
}
