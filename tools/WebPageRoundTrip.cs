#:project ../src/Nendo.Session/Nendo.Session.csproj
#:property PublishAot=false
// The Windows half of the browser host lane (ADR-0035): exports a file as a web page with the code
// Export -> Web page runs, and applies a page's downloaded working file back with the code Apply
// changes from a web page runs. Prints one JSON line. Usage:
//   dotnet run tools/WebPageRoundTrip.cs -- export <source.nendo> <runtime page.html> <out.html>
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
Console.Error.WriteLine("Usage: export <source.nendo> <runtime page.html> <out.html> | apply <source.nendo> <download.nendo> [<entity> <record> <field>]...");
return 2;

sealed class Approved : INendoBehaviourAuthority
{
    public long RevocationGeneration => 0;
    public bool IsGranted(NendoBehaviourGrant required) => true;
}
