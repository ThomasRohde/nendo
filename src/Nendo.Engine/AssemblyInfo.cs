using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Nendo.Engine.Tests")]
// The Desktop and LocalMcp suites build Garden files with the same linked test support.
[assembly: InternalsVisibleTo("Nendo.Desktop.Tests")]
[assembly: InternalsVisibleTo("Nendo.LocalMcp.Tests")]
