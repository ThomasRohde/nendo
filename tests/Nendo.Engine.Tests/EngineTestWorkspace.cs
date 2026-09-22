namespace Nendo.Engine.Tests;

internal sealed class EngineTestWorkspace : IAsyncDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "nendo-production-tests",
        Guid.NewGuid().ToString("N"));
    private readonly List<NendoWriteCoordinator> _coordinators = [];

    internal EngineTestWorkspace()
    {
        Directory.CreateDirectory(_root);
    }

    internal string FilePath => Path.Combine(_root, "ideas.nendo");

    internal async Task<NendoWriteCoordinator> CreateAsync(string owner = "test")
    {
        var coordinator = await NendoWriteCoordinator.CreateAsync(FilePath, owner);
        _coordinators.Add(coordinator);
        return coordinator;
    }

    internal async Task<NendoWriteCoordinator> OpenAsync(string owner = "test-reopen")
    {
        var coordinator = await NendoWriteCoordinator.OpenAsync(FilePath, owner);
        _coordinators.Add(coordinator);
        return coordinator;
    }

    internal void Forget(NendoWriteCoordinator coordinator) => _coordinators.Remove(coordinator);

    public async ValueTask DisposeAsync()
    {
        foreach (var coordinator in _coordinators.ToArray())
        {
            await coordinator.DisposeAsync();
        }
        _coordinators.Clear();
        for (var attempt = 0; Directory.Exists(_root); attempt++)
        {
            try { Directory.Delete(_root, recursive: true); }
            catch (IOException) when (attempt < 39)
            {
                // Owned-fixture cleanup only. Child tests have already asserted
                // process exit and released authority. Windows can briefly keep
                // a file busy after termination; a persistent leak still fails.
                //
                // The budget is generous rather than tight: on a machine running the
                // whole suite at once, a killed child's handle can outlive its process
                // by several seconds, and waiting longer for it says nothing about the
                // behaviour any test is checking.
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Min(250, 50 * (attempt + 1))));
            }
        }
    }
}
