namespace Nendo.Session.Tests;

/// <summary>A folder of a test's own under the temporary folder, removed after it.</summary>
internal sealed class Workspace : IAsyncDisposable
{
    internal Workspace() => Directory.CreateDirectory(Root);

    internal string Root { get; } = Path.Combine(Path.GetTempPath(), "nendo-session-tests", Guid.NewGuid().ToString("N"));

    internal string FilePath => Path.Combine(Root, "session.nendo");

    internal string DeviceState => Path.Combine(Root, "device-state");

    public ValueTask DisposeAsync()
    {
        try { Directory.Delete(Root, recursive: true); }
        catch (IOException) { }
        return ValueTask.CompletedTask;
    }
}
