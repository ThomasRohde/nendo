using System.IO.Compression;
using System.Text.RegularExpressions;
using Nendo.Engine;

namespace Nendo.Session.Tests;

/// <summary>Export → Web page (ADR-0035): the runtime page with a Duplicate of the file carried in it.</summary>
[TestClass]
public sealed class WebPageExportTests
{
    private const string Runtime = "<!doctype html><html><head><script type=\"application/json\" id=\"nendo-runtime\">{}</script></head><body><script type=\"module\">start()</script></body></html>";

    [TestMethod]
    public async Task ThePageCarriesADuplicateOfTheFileBeforeItsModuleScript()
    {
        await using var workspace = new Workspace();
        await using var source = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "export-test");
        var template = Path.Combine(workspace.Root, "Nendo.html");
        await File.WriteAllTextAsync(template, Runtime);
        var destination = Path.Combine(workspace.Root, "page.html");

        await NendoWebPageExport.ExportAsync(new NendoApplicationService(source), "Tom & Jerry.nendo", template, destination);

        var page = await File.ReadAllTextAsync(destination);
        var tone = NendoLook.DefaultTone((await source.GetSnapshotAsync()).Manifest.ApplicationId);
        var carried = Regex.Match(page, $"<script type=\"application/octet-stream\" id=\"nendo-file\" data-name=\"Tom &amp; Jerry.nendo\" data-tone=\"{tone}\" data-letter=\"T\">([A-Za-z0-9+/=]+)</script>\n<script type=\"module\">");
        Assert.IsTrue(carried.Success, page[..Math.Min(400, page.Length)]);
        var file = Path.Combine(workspace.Root, "carried.nendo");
        await using (var gzip = new GZipStream(new MemoryStream(Convert.FromBase64String(carried.Groups[1].Value)), CompressionMode.Decompress))
        await using (var output = File.Create(file))
            await gzip.CopyToAsync(output);
        await using var copy = await NendoWriteCoordinator.OpenReadOnlyAsync(file);
        var history = await copy.GetHistoryAsync();
        Assert.AreEqual("identity.transition", history[^1].Operations.SingleOrDefault()?.OperationType, "The carried file is not a Duplicate.");
        using var transition = System.Text.Json.JsonDocument.Parse(history[^1].Operations[0].CanonicalJson);
        var payload = transition.RootElement.GetProperty("payload");
        var manifest = (await source.GetSnapshotAsync()).Manifest;
        Assert.AreEqual("Duplicate", payload.GetProperty("kind").GetString());
        Assert.AreEqual(manifest.InstanceId, payload.GetProperty("source").GetProperty("instanceId").GetString());
        Assert.AreEqual(manifest.ChangeSequence, payload.GetProperty("source").GetProperty("changeSequence").GetInt64());
        Assert.IsFalse(Directory.EnumerateFiles(workspace.Root, "*.partial").Any());
    }

    [TestMethod]
    public void ThePageCarriesTheFilesPictureForItsOpeningCardOnlyAsAPngWithinItsLimit()
    {
        var look = new NendoResolvedLook("teal", "E", ToneChosen: true, LetterChosen: false, Icon: "media:example");
        byte[] png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];

        var page = NendoWebPageExport.Carry(Runtime, [1, 2, 3], "Envelope.nendo", look, png);
        StringAssert.Contains(page, $"data-name=\"Envelope.nendo\" data-tone=\"teal\" data-letter=\"E\" data-icon=\"data:image/png;base64,{Convert.ToBase64String(png)}\">");

        Assert.DoesNotContain("data-icon", NendoWebPageExport.Carry(Runtime, [1], "Envelope.nendo", look, [0xFF, 0xD8, 0xFF]), "A picture that is not a PNG was carried.");
        var large = new byte[NendoWebPageExport.MaximumIconBytes + 1];
        png[..8].CopyTo(large, 0);
        Assert.DoesNotContain("data-icon", NendoWebPageExport.Carry(Runtime, [1], "Envelope.nendo", look, large), "A picture over the limit was carried.");
    }

    [TestMethod]
    public async Task AFileLargerThanAPageOpensIsRefusedWithItsSize()
    {
        await using var workspace = new Workspace();
        await using var source = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "export-test");
        var template = Path.Combine(workspace.Root, "Nendo.html");
        await File.WriteAllTextAsync(template, Runtime);
        var destination = Path.Combine(workspace.Root, "page.html");

        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            NendoWebPageExport.ExportAsync(new NendoApplicationService(source), "Big.nendo", template, destination, maximumFileBytes: 1024));
        Assert.AreEqual("file-too-large", refused.Code);
        StringAssert.Matches(refused.Message, new Regex(@"^Big\.nendo is [0-9.]+ MiB; a web page opens files of up to 0 MiB\.$"));
        Assert.IsFalse(File.Exists(destination));
    }

    [TestMethod]
    public async Task AnExistingFileIsNeverReplaced()
    {
        await using var workspace = new Workspace();
        await using var source = await NendoWriteCoordinator.CreateAsync(workspace.FilePath, "export-test");
        var template = Path.Combine(workspace.Root, "Nendo.html");
        await File.WriteAllTextAsync(template, Runtime);
        var destination = Path.Combine(workspace.Root, "page.html");
        await File.WriteAllTextAsync(destination, "mine");

        await Assert.ThrowsExactlyAsync<IOException>(() =>
            NendoWebPageExport.ExportAsync(new NendoApplicationService(source), "ideas.nendo", template, destination));
        Assert.AreEqual("mine", await File.ReadAllTextAsync(destination));
        Assert.IsFalse(Directory.EnumerateFiles(workspace.Root, "*.partial").Any());
    }
}
