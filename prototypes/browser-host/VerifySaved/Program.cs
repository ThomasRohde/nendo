using Nendo.Engine;

// Usage: dotnet run -- <saved .nendo>. Opens a copy, so the saved file is left as it was.
var copy = Path.Combine(Path.GetTempPath(), $"nendo-verify-{Guid.NewGuid():N}.nendo");
File.Copy(args[0], copy);
try
{
    await using var coordinator = await NendoWriteCoordinator.OpenAsync(copy, "verify-saved");
    var health = await coordinator.VerifyIntegrityAsync();
    var snapshot = await coordinator.GetSnapshotAsync();
    var thermal = snapshot.Records.Single(r => r.EntityId == "system" && r.RecordId == "system.thermal");
    var incident = snapshot.Records.SingleOrDefault(r => r.EntityId == "incident" && r.RecordId == "incident.browser-probe");
    Console.WriteLine($"integrity={health.IntegrityResult} thermalFlag={thermal.Values["systemReviewFlag"]} incident={(incident is null ? "missing" : incident.Values["incidentTitle"].ToString())} changeSequence={snapshot.Manifest.ChangeSequence}");
}
finally
{
    File.Delete(copy);
}
