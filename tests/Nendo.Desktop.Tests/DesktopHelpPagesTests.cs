using System.Text;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// A file's own help pages (ADR-0027): the Markdown under <c>help/</c> in the packages the file
/// carries, read by Help as text. Packages come by title and pages by path; a file outside the
/// folder, a file that is not Markdown and a page that is not UTF-8 are not pages.
/// </summary>
[TestClass]
public sealed class DesktopHelpPagesTests
{
    [TestMethod]
    public async Task HelpReadsEveryMarkdownPageUnderHelpByPackageTitleThenPath()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "help-test"))
        {
            await coordinator.ApplyAsync(new NendoMutation("test", "packages", "test", "Packages with help", [
                new SetExtensionPackageOperation("zeta-package", "org.example.zeta", "Zeta", "index.html", "1.0.0"),
                Put("zeta-index", "org.example.zeta", "index.html", "<!doctype html><title>Zeta</title>"),
                Put("zeta-two", "org.example.zeta", "help/02-second.md", "# Second\n\nThe second page."),
                Put("zeta-one", "org.example.zeta", "help/01-first.md", "﻿# First\n\nThe first page."),
                Put("zeta-text", "org.example.zeta", "help/notes.txt", "Not a page: not Markdown."),
                Put("zeta-outside", "org.example.zeta", "README.md", "# Not a page: outside help/"),
                PutExtensionFileOperation.FromContent("zeta-latin", "org.example.zeta", "help/03-latin.md", "text/markdown", [0x23, 0x20, 0xE6, 0xF8, 0xE5]),
                new SetExtensionPackageOperation("alpha-package", "org.example.alpha", "Alpha", "index.html", "1.0.0"),
                Put("alpha-index", "org.example.alpha", "index.html", "<!doctype html><title>Alpha</title>"),
                Put("alpha-page", "org.example.alpha", "help/guide.md", "# Alpha guide"),
            ]));
        }
        var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await using var _ = session;
        await session.OpenAsync(workspace.FilePath);
        var handler = new WorkbenchProtocolHandler(session, _ => { });
        var fileSessionId = (await session.GetViewAsync()).FileSessionId!;

        var answer = await handler.HandleAsync(JsonSerializer.Serialize(new
        {
            protocolVersion = DesktopShellContract.BridgeProtocolVersion,
            requestId = "help-test-" + Guid.NewGuid().ToString("N"),
            method = WorkbenchMethods.HelpReadPages,
            fileSessionId,
            payload = new { },
        }));
        Assert.IsTrue(answer.Ok, answer.Error?.Message);
        var view = (DesktopHelpPagesView)answer.Result!;
        CollectionAssert.AreEqual(
            new[] { "org.example.alpha help/guide.md", "org.example.zeta help/01-first.md", "org.example.zeta help/02-second.md" },
            view.Pages.Select(page => $"{page.PackageId} {page.Path}").ToArray(),
            "Help's pages are every .md under help/, packages by title and pages by path.");
        Assert.AreEqual(1, view.Omitted, "The page that is not UTF-8 is left out and counted.");
        Assert.AreEqual("Zeta", view.Pages[1].PackageTitle);
        Assert.AreEqual("# First\n\nThe first page.", view.Pages[1].Markdown, "A page arrives as its text, without a byte-order mark.");
    }

    [TestMethod]
    public async Task AFileWithoutPackagesHasNoHelpPages()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "help-test")) { }
        var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot, deviceStateRoot: workspace.FileHistoryRoot);
        await using var _ = session;
        await session.OpenAsync(workspace.FilePath);
        var view = await session.ReadHelpPagesAsync();
        Assert.IsEmpty(view.Pages);
        Assert.AreEqual(0, view.Omitted);
    }

    private static PutExtensionFileOperation Put(string operationId, string packageId, string path, string text) =>
        PutExtensionFileOperation.FromContent(operationId, packageId, path, null, Encoding.UTF8.GetBytes(text));
}
