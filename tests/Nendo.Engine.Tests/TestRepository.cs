namespace Nendo.Engine.Tests;

/// <summary>
/// The repository a test runs in, found by walking up from the test binaries to Nendo.slnx.
/// Linked into the Desktop and LocalMcp test projects as well, so all three find it one way.
/// </summary>
internal static class TestRepository
{
    internal static string Root()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(Path.Combine(directory.FullName, "Nendo.slnx"))) return directory.FullName;
        throw new InvalidOperationException("The repository root (Nendo.slnx) was not found above the test binaries.");
    }
}
