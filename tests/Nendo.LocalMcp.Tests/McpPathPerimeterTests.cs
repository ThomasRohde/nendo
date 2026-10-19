using System.Net;
using System.Text;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// Routing matches /mcp without regard to case, but the perimeter tested the path
/// ordinally, so /MCP and /Mcp reached the MCP endpoint past the Host, Origin and size checks:
/// a page that rebound its own name to 127.0.0.1 could read and write the open file. These
/// cases go through a real host, so routing and the perimeter are measured together.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class McpPathPerimeterTests
{
    private static readonly string[] Paths = ["/mcp", "/MCP", "/Mcp", "/mcp/", "/MCP/anything", "/other"];

    [TestMethod]
    public async Task EveryPathSpellingMeetsTheSamePerimeter()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ReadOnly,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        using var http = new HttpClient();
        var port = host.Endpoint.Port;

        foreach (var path in Paths)
        {
            var (status, body) = await SendAsync(http, port, path, request => request.Headers.Host = $"rebound.example:{port}");
            Assert.AreEqual(HttpStatusCode.BadRequest, status, $"{path} with a rebound Host: {body}");
            StringAssert.Contains(body, "NENDO_INVALID_HOST", path);

            (status, body) = await SendAsync(http, port, path, request => request.Headers.Add("Origin", $"http://rebound.example:{port}"));
            Assert.AreEqual(HttpStatusCode.Forbidden, status, $"{path} with a foreign Origin: {body}");
            StringAssert.Contains(body, "NENDO_INVALID_ORIGIN", path);

            var oversize = new string(' ', (int)NendoMcpSecurityMiddleware.MaximumRequestBodyBytes + 1) + Initialize;
            // Answered as a JSON-RPC error under the request's id, so the status is not the measure.
            (_, body) = await SendAsync(http, port, path, _ => { }, oversize);
            StringAssert.Contains(body, "NENDO_REQUEST_TOO_LARGE", $"{path} with an oversize body: {body}");

            var depth = NendoMcpSecurityMiddleware.MaximumJsonDepth + 8;
            var deep = Initialize[..^1] + ",\"deep\":" + string.Concat(Enumerable.Repeat("{\"a\":", depth)) + "0" + new string('}', depth) + "}";
            (_, body) = await SendAsync(http, port, path, _ => { }, deep);
            StringAssert.Contains(body, "NENDO_INVALID_JSON", $"{path} with a body {depth} levels deep: {body}");
        }

        // The exact endpoint still answers, so the cases above measure the perimeter, not a dead host.
        var (accepted, answer) = await SendAsync(http, port, "/mcp", _ => { });
        Assert.AreEqual(HttpStatusCode.OK, accepted, answer);
        StringAssert.Contains(answer, "protocolVersion");
    }

    private const string Initialize =
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"," +
        "\"capabilities\":{},\"clientInfo\":{\"name\":\"perimeter-test\",\"version\":\"1.0\"}}}";

    private static async Task<(HttpStatusCode Status, string Body)> SendAsync(
        HttpClient http, int port, string path, Action<HttpRequestMessage> configure, string body = Initialize)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{port}{path}")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
        request.Headers.Add("Accept", "application/json, text/event-stream");
        request.Headers.Add("Mcp-Method", "initialize");
        configure(request);
        using var response = await http.SendAsync(request);
        return (response.StatusCode, await response.Content.ReadAsStringAsync());
    }
}
