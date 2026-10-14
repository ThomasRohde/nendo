using System.Reflection;
using System.Text.RegularExpressions;

namespace Nendo.Engine.Tests;

/// <summary>
/// TST-15: a regression lane's ID names one test and one catalogue row. BehaviourScalarTests had
/// two tests for each of D1_18 to D1_22, ADR-0008 pointed at one set and the catalogue at the
/// other, and a filter on D1_19 ran two unrelated tests.
/// </summary>
[TestClass]
public sealed partial class RegressionLaneIdTests
{
    [TestMethod]
    public void EachLaneIdNamesOneTestAndOneCatalogueRow()
    {
        var ids = typeof(RegressionLaneIdTests).Assembly.GetTypes()
            .SelectMany(type => type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            .Where(method => method.GetCustomAttribute<TestMethodAttribute>() is not null)
            .Select(method => (Method: $"{method.DeclaringType!.Name}.{method.Name}", Id: LaneId().Match(method.Name)))
            .Where(entry => entry.Id.Success)
            .ToArray();
        Assert.IsGreaterThan(40, ids.Length, "The lane-numbered tests were not found.");
        var shared = ids.GroupBy(entry => entry.Id.Value).Where(group => group.Count() > 1)
            .Select(group => $"{group.Key}: {string.Join(", ", group.Select(entry => entry.Method))}").ToArray();
        Assert.IsEmpty(shared, "Two tests share a lane ID: " + string.Join("; ", shared));

        var catalogue = File.ReadAllText(Path.Combine(TestRepository.Root(), "docs", "design", "adr-0008-regressions.md"));
        var missing = ids.Where(entry => entry.Id.Groups[1].Value == "1")
            .Where(entry => !catalogue.Contains($"| D1.{entry.Id.Groups[2].Value} |", StringComparison.Ordinal))
            .Select(entry => entry.Method).ToArray();
        Assert.IsEmpty(missing, "These D1 tests have no row in docs/design/adr-0008-regressions.md: " + string.Join(", ", missing));
    }

    [GeneratedRegex(@"^D(\d+)_(\d+)_")]
    private static partial Regex LaneId();
}
