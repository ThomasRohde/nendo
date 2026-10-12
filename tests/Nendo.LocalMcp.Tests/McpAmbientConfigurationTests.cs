using System.Net;
using System.Net.Sockets;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// MHS-06. The web host was built with the default configuration sources, so a Kestrel
/// endpoint named in an environment variable, or in an appsettings.json in the current
/// directory (often the opened file's folder), was bound beside the loopback listener. The
/// host now reads no ambient configuration: it listens on 127.0.0.1 only, whatever the
/// process environment and its current directory say.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class McpAmbientConfigurationTests
{
    private const string EnvironmentEndpoint = "Kestrel__Endpoints__Ambient__Url";

    [TestMethod]
    public async Task EndpointsNamedInTheEnvironmentOrTheCurrentDirectoryAreNotBound()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        var environmentPort = FreePort(IPAddress.Loopback);
        var settingsPort = FreePort(IPAddress.Loopback);
        var folder = Path.Combine(Path.GetDirectoryName(workspace.DiscoveryRoot)!, "cwd-with-appsettings");
        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(Path.Combine(folder, "appsettings.json"),
            """{"Kestrel":{"Endpoints":{"Settings":{"Url":"http://127.0.0.1:""" + settingsPort + "\"}}}}");
        var previousDirectory = Directory.GetCurrentDirectory();
        Environment.SetEnvironmentVariable(EnvironmentEndpoint, $"http://127.0.0.1:{environmentPort}");
        Directory.SetCurrentDirectory(folder);
        try
        {
            await using var host = await NendoLocalMcpHost.StartAsync(
                workspace.Service,
                AgentAccessMode.ReadOnly,
                new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));

            Assert.AreEqual(IPAddress.Loopback.ToString(), host.Endpoint.Host);
            Assert.IsFalse(Accepts(environmentPort), $"The host bound {EnvironmentEndpoint}'s endpoint, port {environmentPort}.");
            Assert.IsFalse(Accepts(settingsPort), $"The host bound the current directory's appsettings.json endpoint, port {settingsPort}.");
            Assert.IsTrue(Accepts(host.Endpoint.Port), "The loopback listener itself is not accepting, so the checks above measure nothing.");
        }
        finally
        {
            Directory.SetCurrentDirectory(previousDirectory);
            Environment.SetEnvironmentVariable(EnvironmentEndpoint, null);
        }
    }

    private static int FreePort(IPAddress address)
    {
        using var listener = new TcpListener(address, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static bool Accepts(int port)
    {
        using var client = new TcpClient();
        try
        {
            client.Connect(IPAddress.Loopback, port);
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
