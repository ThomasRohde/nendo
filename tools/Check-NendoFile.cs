#:project ../src/Nendo.Engine/Nendo.Engine.csproj
#:property PublishAot=false
// Opens a copy of a .nendo file in the Windows Engine and checks it, for a lane that has a file a
// browser wrote (ADR-0035, ADR-0036). Prints one JSON line: the integrity result, the change
// sequence and the value of each record field asked for. Usage:
//   dotnet run tools/Check-NendoFile.cs -- <file.nendo> [<entity> <record> <field>]...
using System.Text.Json;
using Nendo.Engine;

if (args.Length == 0 || (args.Length - 1) % 3 != 0)
{
    Console.Error.WriteLine("Usage: dotnet run tools/Check-NendoFile.cs -- <file.nendo> [<entity> <record> <field>]...");
    return 2;
}

// The copy is opened, so the checked file is left as it was.
var copy = Path.Combine(Path.GetTempPath(), $"nendo-check-{Guid.NewGuid():N}.nendo");
File.Copy(args[0], copy);
try
{
    string integrity;
    long changeSequence;
    var values = new List<object?>();
    await using (var coordinator = await NendoWriteCoordinator.OpenAsync(copy, "check-nendo-file"))
    {
        integrity = (await coordinator.VerifyIntegrityAsync()).IntegrityResult;
        var snapshot = await coordinator.GetSnapshotAsync();
        changeSequence = snapshot.Manifest.ChangeSequence;
        for (var at = 1; at < args.Length; at += 3)
            values.Add(snapshot.Records.SingleOrDefault(r => r.EntityId == args[at] && r.RecordId == args[at + 1])?.Values.GetValueOrDefault(args[at + 2]));
    }
    Console.WriteLine(JsonSerializer.Serialize(new { integrity, changeSequence, values }));
    return 0;
}
finally
{
    foreach (var file in Directory.EnumerateFiles(Path.GetDirectoryName(copy)!, Path.GetFileName(copy) + "*"))
        File.Delete(file);
}
