#:project ../src/Nendo.Session/Nendo.Session.csproj
#:property PublishAot=false
// The Windows half of the browser host lane (ADR-0035): exports a file as a web page with the code
// Export -> Web page runs, and applies a page's downloaded working file back with the code Apply
// changes from a web page runs. Prints one JSON line. Usage:
//   dotnet run tools/WebPageRoundTrip.cs -- export <source.nendo> <runtime page.html> <out.html>
//   dotnet run tools/WebPageRoundTrip.cs -- export-app <source.nendo> <runtime page.html> <sw.js> <empty folder>
//   dotnet run tools/WebPageRoundTrip.cs -- set <source.nendo> <entity> <record> <field> <text>
//   dotnet run tools/WebPageRoundTrip.cs -- apply <source.nendo> <download.nendo> [<entity> <record> <field>]...
using System.Text.Json;
using Nendo.Engine;
using Nendo.Session;

if (args is ["export", var exported, var template, var page])
{
    await using var source = await NendoWriteCoordinator.OpenAsync(exported, "web-page-round-trip");
    await NendoWebPageExport.ExportAsync(new NendoApplicationService(source), Path.GetFileName(exported), template, page);
    Console.WriteLine(JsonSerializer.Serialize(new { page, bytes = new FileInfo(page).Length }));
    return 0;
}
if (args is ["set", var edited, var entity, var record, var field, var text])
{
    // The owner changing the source between two exports, with its automatic actions approved.
    await using var source = await NendoWriteCoordinator.OpenAsync(edited, "web-page-round-trip");
    source.BehaviourAuthority = new Approved();
    var service = new NendoApplicationService(source);
    var version = (await service.GetSnapshotAsync()).Records.Single(r => r.EntityId == entity && r.RecordId == record).RecordVersion;
    await service.SetFieldAsync(new(entity, record, field, version, text, new("web-page-round-trip", $"set-{Guid.NewGuid():N}", "studio")));
    Console.WriteLine(JsonSerializer.Serialize(new { record, field, text }));
    return 0;
}
if (args is ["export-app", var app, var appTemplate, var worker, var folder])
{
    // Export -> Web app (ADR-0037), with a plain square standing in for the icons the Desktop host
    // draws from the file's look.
    await using var source = await NendoWriteCoordinator.OpenAsync(app, "web-page-round-trip");
    Directory.CreateDirectory(folder);
    var icons = NendoWebAppExport.IconSizes.ToDictionary(size => size, SquarePng);
    await NendoWebAppExport.ExportAsync(new NendoApplicationService(source), Path.GetFileName(app), appTemplate, worker, icons, folder);
    Console.WriteLine(JsonSerializer.Serialize(new { folder, bytes = new FileInfo(Path.Combine(folder, "index.html")).Length }));
    return 0;
}
if (args.Length >= 3 && args[0] == "apply" && (args.Length - 3) % 3 == 0)
{
    // The download is checked whole on a copy first, so the file applied from is left as it was.
    string integrity;
    var copy = Path.Combine(Path.GetTempPath(), $"nendo-round-trip-{Guid.NewGuid():N}.nendo");
    File.Copy(args[2], copy);
    try
    {
        await using var download = await NendoWriteCoordinator.OpenAsync(copy, "web-page-round-trip-check");
        integrity = (await download.VerifyIntegrityAsync()).IntegrityResult;
    }
    finally
    {
        foreach (var file in Directory.EnumerateFiles(Path.GetDirectoryName(copy)!, Path.GetFileName(copy) + "*")) File.Delete(file);
    }

    await using var source = await NendoWriteCoordinator.OpenAsync(args[1], "web-page-round-trip");
    // The person approves the file's automatic actions in Nendo before accepting; the lane stands in for them.
    source.BehaviourAuthority = new Approved();
    var service = new NendoApplicationService(source);
    var changes = await service.PrepareWebPageChangesAsync(args[2]);
    var applied = changes.Proposal is { } proposal && (await service.PromoteProposalAsync(proposal.ProposalId)).Applied;
    var snapshot = await service.GetSnapshotAsync();
    var values = new List<object?>();
    for (var at = 3; at < args.Length; at += 3)
        values.Add(snapshot.Records.SingleOrDefault(r => r.EntityId == args[at] && r.RecordId == args[at + 1])?.Values.GetValueOrDefault(args[at + 2]));
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        integrity, replayed = changes.Replayed, leftOut = changes.LeftOut.Select(revision => $"{revision.Description}: {revision.Reason}"), applied, values,
    }));
    return 0;
}
Console.Error.WriteLine("Usage: export <source.nendo> <runtime page.html> <out.html> | export-app <source.nendo> <runtime page.html> <sw.js> <empty folder> | apply <source.nendo> <download.nendo> [<entity> <record> <field>]...");
return 2;

// One opaque square of the given size, as a PNG: eight-bit RGB rows, each with filter byte 0.
static byte[] SquarePng(int size)
{
    var rows = new byte[size * (size * 3 + 1)];
    for (var y = 0; y < size; y++)
        for (var x = 0; x < size; x++)
        {
            var at = y * (size * 3 + 1) + 1 + x * 3;
            (rows[at], rows[at + 1], rows[at + 2]) = ((byte)0x2F, (byte)0x63, (byte)0xD6);
        }
    using var packed = new MemoryStream();
    using (var zlib = new System.IO.Compression.ZLibStream(packed, System.IO.Compression.CompressionLevel.Optimal, leaveOpen: true)) zlib.Write(rows);
    var header = new byte[13];
    System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header, size);
    System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), size);
    (header[8], header[9]) = (8, 2);
    using var png = new MemoryStream();
    png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    void Chunk(string type, byte[] data)
    {
        var length = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(length, data.Length);
        png.Write(length);
        var body = System.Text.Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
        png.Write(body);
        var crc = new byte[4];
        var sum = 0xFFFFFFFFu;
        foreach (var value in body)
        {
            sum ^= value;
            for (var bit = 0; bit < 8; bit++) sum = (sum & 1) != 0 ? 0xEDB88320u ^ (sum >> 1) : sum >> 1;
        }
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(crc, ~sum);
        png.Write(crc);
    }
    Chunk("IHDR", header);
    Chunk("IDAT", packed.ToArray());
    Chunk("IEND", []);
    return png.ToArray();
}

sealed class Approved : INendoBehaviourAuthority
{
    public long RevocationGeneration => 0;
    public bool IsGranted(NendoBehaviourGrant required) => true;
}
