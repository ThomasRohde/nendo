using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// R-003, 2026-09-26: a command step's today is the person's civil day, the same day a
/// screen's filter resolves in the Workbench. It used to be the UTC day, so a person in
/// Copenhagen at 00:30 stamped yesterday, and a DateTime step began the day at UTC
/// midnight rather than where the person is.
/// </summary>
[TestClass]
public sealed class CommandStepTodayTests
{
    private static readonly NendoSurfaceNodePlan Today = new(
        "step", "step", "commandStep",
        new Dictionary<string, JsonElement> { ["valueKind"] = JsonSerializer.SerializeToElement("today") },
        []);

    private static NendoFieldPlan Field(NendoStorageKind kind) =>
        new("field", "field", "Field", kind, false, null, []);

    private static object? Resolve(NendoStorageKind kind, string utc, string zone) =>
        NendoApplicationService.ResolveStepValue(
            Today, Field(kind), DateTimeOffset.Parse(utc, System.Globalization.CultureInfo.InvariantCulture),
            TimeZoneInfo.FindSystemTimeZoneById(zone));

    [TestMethod]
    [DataRow("2026-09-26T22:30:00Z", "Europe/Copenhagen", "2026-09-27", "2026-09-26T22:00:00Z", DisplayName = "Copenhagen, past UTC midnight's eve")]
    [DataRow("2026-09-27T06:30:00Z", "America/Los_Angeles", "2026-09-26", "2026-09-26T07:00:00Z", DisplayName = "Los Angeles, before local midnight")]
    [DataRow("2026-09-26T18:29:59Z", "Asia/Kolkata", "2026-09-26", "2026-09-25T18:30:00Z", DisplayName = "Kolkata, one second before its midnight")]
    [DataRow("2026-09-26T18:30:00Z", "Asia/Kolkata", "2026-09-27", "2026-09-26T18:30:00Z", DisplayName = "Kolkata, at its midnight")]
    [DataRow("2026-09-06T12:00:00Z", "America/Santiago", "2026-09-06", "2026-09-06T04:00:00Z", DisplayName = "Santiago, a day whose midnight is skipped")]
    [DataRow("2026-09-26T12:00:00Z", "UTC", "2026-09-26", "2026-09-26T00:00:00Z", DisplayName = "UTC")]
    public void TodayIsThePersonsCivilDayForDateAndDateTime(string utc, string zone, string date, string instant)
    {
        Assert.AreEqual(date, Resolve(NendoStorageKind.Date, utc, zone),
            "A Date step's today was not the person's civil date.");
        Assert.AreEqual(instant, Resolve(NendoStorageKind.DateTime, utc, zone),
            "A DateTime step's today was not the instant the person's day begins.");
    }
}
