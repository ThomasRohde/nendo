using System.Diagnostics;

namespace Nendo.Engine.Tests;

/// <summary>
/// ADR-0028, the measurement half: what building the search index costs on a real file, how much
/// it adds to the file, and how long a search then takes. Each named workspace file is copied into
/// a task-owned folder first; the original is only read.
/// <para>
/// Not an assertion, and not a lane that runs by itself. Set NENDO_MEASURE_SEARCH to a
/// semicolon-separated list of .nendo paths to run it.
/// </para>
/// </summary>
[DoNotParallelize]
[TestClass]
public sealed class SearchIndexMeasurementTests
{
    public TestContext TestContext { get; set; } = null!;

    [TestMethod]
    public async Task WhatBuildingTheIndexCostsOnRealFiles()
    {
        var paths = Environment.GetEnvironmentVariable("NENDO_MEASURE_SEARCH");
        if (string.IsNullOrWhiteSpace(paths)) Assert.Inconclusive("Set NENDO_MEASURE_SEARCH to the .nendo files to measure.");
        foreach (var source in paths.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            await using var workspace = new EngineTestWorkspace();
            File.Copy(source, workspace.FilePath);
            var before = new FileInfo(workspace.FilePath).Length;
            var coordinator = await workspace.OpenAsync("measure");
            var service = new NendoApplicationService(coordinator);
            var builds = new List<double>();
            var watch = Stopwatch.StartNew();
            await service.BuildSearchIndexAsync(new NendoRequestContext("measure", "build-0", "measure"));
            builds.Add(watch.Elapsed.TotalMilliseconds);
            // Building again is the repair path: the same work over an index that exists.
            for (var run = 1; run <= 2; run++)
            {
                watch.Restart();
                await service.BuildSearchIndexAsync(new NendoRequestContext("measure", $"build-{run}", "measure"));
                builds.Add(watch.Elapsed.TotalMilliseconds);
            }
            Assert.IsEmpty(await coordinator.SearchIndexDriftAsync(), "The built index differs from the records.");
            var searches = new List<double>();
            var hits = 0;
            foreach (var text in new[] { "the", "capability", "a", "management", "data process" })
            {
                watch.Restart();
                var page = await service.SearchRecordsAsync(new(text, 20));
                searches.Add(watch.Elapsed.TotalMilliseconds);
                hits += page.Items.Count;
            }
            await coordinator.DisposeAsync();
            workspace.Forget(coordinator);
            var after = new FileInfo(workspace.FilePath).Length;
            searches.Sort();
            TestContext.WriteLine(FormattableString.Invariant(
                $"{Path.GetFileName(source)}: {before / 1024.0 / 1024:F1} MiB to {after / 1024.0 / 1024:F1} MiB; build {builds[0]:F0} ms, rebuilds {builds[1]:F0} and {builds[2]:F0} ms; search median {searches[searches.Count / 2]:F1} ms, slowest {searches[^1]:F1} ms ({hits} hits over five searches)"));
        }
    }
}
