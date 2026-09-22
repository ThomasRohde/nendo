namespace Nendo.Desktop.Tests;

internal sealed class DesktopTestWorkspace : IAsyncDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "nendo-desktop-tests",
        Guid.NewGuid().ToString("N"));

    internal DesktopTestWorkspace()
    {
        Directory.CreateDirectory(_root);
    }

    internal string FilePath => Path.Combine(_root, "desktop-session.nendo");
    internal string FileHistoryRoot => Path.Combine(_root, "device-state");

    public ValueTask DisposeAsync()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
        return ValueTask.CompletedTask;
    }
}
