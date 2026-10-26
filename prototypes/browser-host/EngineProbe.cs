using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using Nendo.Engine;

/// <summary>
/// Prototype: the real Engine in a browser page. The page hands in a file's bytes; the Engine
/// opens them in the in-memory file system, runs a write that fires an automatic action, and
/// hands the bytes back.
/// </summary>
public static partial class EngineProbe
{
    private const string Path = "/work/station.nendo";
    private static NendoWriteCoordinator? _coordinator;

    [JSExport]
    public static async Task<string> RunAsync(byte[] file)
    {
        var steps = new List<string>();
        var started = DateTime.UtcNow;
        Directory.CreateDirectory("/work");
        await File.WriteAllBytesAsync(Path, file);
        steps.Add($"wrote {file.Length} bytes");

        _coordinator = await NendoWriteCoordinator.OpenAsync(Path, "browser-probe");
        var trust = _coordinator.BehaviourTrust;
        steps.Add($"opened; behaviour requires approval {trust.RequiresApproval}, approved {trust.IsApproved}");
        if (trust.Required is { } required) _coordinator.BehaviourAuthority = new PageAuthority(required);
        steps.Add($"approved here: {_coordinator.BehaviourTrust.IsApproved}");

        var service = new NendoApplicationService(_coordinator);
        var compiled = await service.CompileSemanticUiAsync();
        steps.Add($"compiled valid {compiled.IsValid}, {compiled.Applications.Count} applications");

        var snapshot = await _coordinator.GetSnapshotAsync();
        var thermal = snapshot.Records.Single(r => r.EntityId == "system" && r.RecordId == "system.thermal");
        var context = (string key) => new NendoRequestContext("browser-probe", key, "browser");
        var cleared = await service.SetFieldAsync(new NendoSetFieldRequest("system", "system.thermal", "systemReviewFlag", thermal.RecordVersion, false, context("clear-flag")));
        steps.Add($"cleared thermal flag at change {cleared.ChangeSequence}");
        var thermalNow = (await _coordinator.GetSnapshotAsync()).Records.Single(r => r.EntityId == "system" && r.RecordId == "system.thermal");

        await service.CreateRecordAsync(new NendoCreateRecordRequest("incident", "incident.browser-probe", new Dictionary<string, object?>
        {
            ["incidentTitle"] = "Raised in a browser page",
            ["incidentSystem"] = "system.thermal",
            ["incidentRaised"] = "2026-10-26",
            ["incidentSeverity"] = "Routine",
            ["incidentStatus"] = "Open",
        }, context("create-incident"), new Dictionary<string, long> { ["incidentSystem"] = thermalNow.RecordVersion }));
        var after = (await _coordinator.GetSnapshotAsync()).Records.Single(r => r.EntityId == "system" && r.RecordId == "system.thermal");
        var flag = after.Values.TryGetValue("systemReviewFlag", out var value) ? value.ToString() : "missing";
        steps.Add($"after the incident, thermal flag {flag}");

        await _coordinator.DisposeAsync();
        _coordinator = null;
        var bytes = await File.ReadAllBytesAsync(Path);
        _saved = bytes;
        steps.Add($"closed; read back {bytes.Length} bytes");
        return JsonSerializer.Serialize(new { ok = true, flagRaised = flag == "True" || flag == "true", ms = (DateTime.UtcNow - started).TotalMilliseconds, steps });
    }

    private static byte[] _saved = [];

    [JSExport]
    public static byte[] Saved() => _saved;

    private sealed class PageAuthority(NendoBehaviourGrant granted) : INendoBehaviourAuthority
    {
        public long RevocationGeneration => 0;
        public bool IsGranted(NendoBehaviourGrant required) => required == granted;
    }
}
