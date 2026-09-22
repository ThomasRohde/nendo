using System.Diagnostics;

namespace Nendo.Engine;

// Stage names only. No listener means no activity allocation or file output.
internal static class NendoStartupDiagnostics
{
    internal static readonly ActivitySource Source = new("Nendo.Engine.Startup");
}
