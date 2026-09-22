using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Security.Cryptography;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Hosting;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using Nendo.Engine;

namespace Nendo.LocalMcp;

public sealed record NendoLocalMcpHostOptions(string DiscoveryRoot)
{
    /// <summary>The loopback port a single-user install binds by default. Owner-overridable.</summary>
    public const int StandardPort = 41763;

    /// <summary>
    /// Loopback port to bind. Zero requests an ephemeral port. A non-zero port that cannot be bound falls back
    /// to ephemeral and is never fatal.
    /// </summary>
    /// <remarks>
    /// This defaults to zero, not <see cref="StandardPort"/>, on purpose. The test suites run method-level
    /// parallel and start many hosts at once; a shared default port would serialize them all onto one socket.
    /// The product default is supplied by the Desktop settings layer.
    /// </remarks>
    public int PreferredPort { get; init; }

    /// <summary>
    /// How long an edit lease survives without renewal. Null means the lease never expires and ends only on
    /// explicit release, owner revocation or host stop.
    /// </summary>
    public TimeSpan? LeaseTtl { get; init; }

    public static NendoLocalMcpHostOptions CreateDefault() => new(
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Nendo",
            "Mcp",
            "active"));
}

public sealed class NendoLocalMcpHost : IAsyncDisposable
{
    private readonly WebApplication _application;
    private readonly NendoApplicationService _applicationService;
    private readonly NendoHostAuthority _authority;
    private readonly NendoAgentAuthority _agentAuthority;
    private readonly NendoAgentAuthoringService _authoring;
    private readonly NendoActivityLog _activity;
    private readonly NendoAgentProposalStore _proposals;
    private readonly NendoAgentWorkSignal _work;
    private readonly string _discoveryPath;
    private int _disposed;

    private NendoLocalMcpHost(
        WebApplication application,
        NendoApplicationService applicationService,
        NendoHostAuthority authority,
        NendoAgentAuthority agentAuthority,
        NendoAgentAuthoringService authoring,
        NendoActivityLog activity,
        NendoAgentProposalStore proposals,
        NendoAgentWorkSignal work,
        string discoveryPath,
        int requestedPort,
        bool usedFallbackPort)
    {
        _application = application;
        _applicationService = applicationService;
        _authority = authority;
        _agentAuthority = agentAuthority;
        _authoring = authoring;
        _activity = activity;
        _proposals = proposals;
        _work = work;
        _discoveryPath = discoveryPath;
        RequestedPort = requestedPort;
        UsedFallbackPort = usedFallbackPort;
    }

    public AgentAccessMode Mode => _authority.Mode;

    /// <summary>The port the owner asked for, or zero when any available port was acceptable.</summary>
    public int RequestedPort { get; }

    /// <summary>True when the requested port could not be bound and an ephemeral port was used instead.</summary>
    public bool UsedFallbackPort { get; }

    public bool IsReady => Volatile.Read(ref _disposed) == 0 && _authority.IsActive;

    /// <summary>Immediate, one-way admission closure; DisposeAsync drains and cleans the host.</summary>
    public void CloseAdmission() => _authority.CloseAdmission();

    public Uri Endpoint => _authority.Endpoint;

    internal string HostRunId => _authority.HostRunId;

    internal string DiscoveryPath => _discoveryPath;

    public Task<NendoLeaseStatus> GetLeaseStatusAsync(CancellationToken cancellationToken = default) =>
        _agentAuthority.GetStatusAsync(cancellationToken);

    /// <summary>
    /// Who holds the lease, without waiting for what they are doing with it. The gated
    /// read above is the serialized answer; this one is the answer a window can ask for
    /// while an agent is mid-write, which is the only time anybody looks.
    /// </summary>
    public NendoLeaseStatus PeekLeaseStatus() => _agentAuthority.PeekStatus();

    public Task RevokeEditingAsync() => _agentAuthority.RevokeAllAsync();

    public IReadOnlyList<NendoAgentActivity> GetActivities(int maximum = 200) =>
        _activity.Snapshot(maximum);

    public IReadOnlyList<NendoAgentProposalSummary> GetPendingProposals() =>
        _proposals.Snapshot();

    /// <summary>
    /// Whether an agent is working right now, pushed as it changes and readable without
    /// taking any gate. The host hands this to the window so a person on any screen can
    /// see that the file is being written to, rather than a window that has stopped
    /// answering for reasons nothing on it explains.
    /// </summary>
    public NendoAgentWorkSignal Work => _work;

    public static async Task<NendoLocalMcpHost> StartAsync(
        NendoApplicationService applicationService,
        AgentAccessMode mode,
        NendoLocalMcpHostOptions? options = null,
        NendoAgentProposalStore? proposalStore = null,
        CancellationToken cancellationToken = default,
        NendoUnattendedConsent? unattendedConsent = null)
    {
        ArgumentNullException.ThrowIfNull(applicationService);
        if (mode == AgentAccessMode.Disabled)
        {
            throw new ArgumentException(
                "Disabled agent access has no listener. Do not start a local MCP host.",
                nameof(mode));
        }
        if (!Enum.IsDefined(mode))
        {
            throw new ArgumentOutOfRangeException(nameof(mode));
        }
        options ??= NendoLocalMcpHostOptions.CreateDefault();
        ArgumentException.ThrowIfNullOrWhiteSpace(options.DiscoveryRoot);

        var snapshot = await applicationService.GetSnapshotAsync(cancellationToken);
        if (snapshot.Health != NendoSessionHealth.Normal)
        {
            throw new NendoRecoveryRequiredException(
                "Agent access requires a healthy open Nendo file.");
        }

        // The run ID is per-run: it names the discovery file, backs the stale-entry sweep, and is how
        // replacement invalidates authority from an earlier generation.
        var authority = new NendoHostAuthority(
            RandomHex(32),
            mode,
            RandomNumberGenerator.GetBytes(32),
            snapshot.Manifest.ApplicationId,
            snapshot.Manifest.InstanceId);
        var clock = new SystemNendoClock();
        var agentAuthority = new NendoAgentAuthority(
            authority,
            clock,
            options.LeaseTtl);
        var activity = new NendoActivityLog(clock);
        var work = new NendoAgentWorkSignal();
        proposalStore ??= new NendoAgentProposalStore();
        proposalStore.Bind(snapshot.Manifest.ApplicationId, snapshot.Manifest.InstanceId);
        // Bound to the mode here, once, so no later caller can reach consent by supplying
        // a delegate to a listener the person did not put at this level.
        var unattended = new NendoUnattendedAuthority(mode, unattendedConsent);
        var authoring = new NendoAgentAuthoringService(
            applicationService,
            agentAuthority,
            authority,
            proposalStore,
            unattended);
        agentAuthority.SetLeaseEndedHandler(authoring.DiscardSessionAsync);
        var discoveryStore = new NendoDiscoveryStore(options.DiscoveryRoot);
        WebApplication? webApplication = null;
        var usedFallbackPort = false;
        string? discoveryPath = null;
        // Subscribe before the listener starts. Even a recovery transition during
        // startup must close this authority before any new request can be admitted.
        applicationService.WriteAuthorityLost += authority.CloseAdmission;
        try
        {
            if (!applicationService.Capabilities.AgentAccess) authority.CloseAdmission();
            authority.RequireActive();
            async Task<WebApplication> BuildAndStartAsync(int port)
            {
                var builder = WebApplication.CreateBuilder(new WebApplicationOptions
                {
                    Args = [],
                    ApplicationName = typeof(NendoLocalMcpHost).Assembly.FullName,
                    EnvironmentName = Environments.Production,
                });
                builder.Logging.ClearProviders();
                builder.WebHost.ConfigureKestrel(kestrel =>
                    kestrel.Listen(
                        IPAddress.Loopback,
                        port,
                        listen => listen.Protocols = HttpProtocols.Http1));
                builder.Services.AddSingleton(applicationService);
                builder.Services.AddSingleton(authority);
                builder.Services.AddSingleton<INendoClock>(clock);
                builder.Services.AddSingleton(agentAuthority);
                builder.Services.AddSingleton(activity);
                builder.Services.AddSingleton(unattended);
                builder.Services.AddSingleton<NendoImportService>();
                builder.Services.AddSingleton<NendoDataMutationService>();
                builder.Services.AddSingleton(proposalStore);
                builder.Services.AddSingleton(authoring);
                builder.Services.AddSingleton(authority.Cursors);
                builder.Services.AddSingleton(discoveryStore);
                builder.Services.AddSingleton<NendoResourceProjection>();

                var mcp = builder.Services
                    .AddMcpServer(server =>
                    {
                        server.ServerInfo = new Implementation
                        {
                            Name = "nendo-local",
                            Version = NendoProduct.Version,
                        };
                        // ProtocolVersion is deliberately left null: the SDK then answers an initialize
                        // handshake on any version it supports and also serves the 2026-07-28 discover
                        // path. Pinned to 2026-07-28 it refused initialize, and every handshake-era
                        // client was locked out (ADR-0009).
                        server.Filters.Request.ListToolsFilters.Add(next => async (context, token) =>
                        {
                            authority.RequireActive();
                            var result = await next(context, token);
                            result.Tools = result.Tools.OrderBy(tool => tool.Name, StringComparer.Ordinal).ToList();
                            result.CacheScope = CacheScope.Private;
                            result.TimeToLive = TimeSpan.Zero;
                            return result;
                        });
                        server.Filters.Request.ListResourcesFilters.Add(next => async (context, token) =>
                        {
                            authority.RequireActive();
                            var result = await next(context, token);
                            result.CacheScope = CacheScope.Private;
                            result.TimeToLive = TimeSpan.Zero;
                            return result;
                        });
                        server.Filters.Request.ListResourceTemplatesFilters.Add(next => async (context, token) =>
                        {
                            authority.RequireActive();
                            var result = await next(context, token);
                            result.CacheScope = CacheScope.Private;
                            result.TimeToLive = TimeSpan.Zero;
                            return result;
                        });
                        // The first sentence says what the product is. A reviewer who read only
                        // the tool list could not tell this host had calculations at all, and the
                        // transport paragraph — written for someone building an HTTP client —
                        // stood where that sentence should have been.
                        server.ServerInstructions =
                            "This is a Nendo file: record types and records, screens (lists, boards, calendars, record pages and " +
                            "commands), calculated fields, reusable functions, and automatic actions that run on a trigger. " +
                            "Everything but records is authored through a change set — begin, add_operations, validate — that " +
                            "the person accepts in Nendo; calculations, functions, actions and triggers are the " +
                            "behaviour.setDefinition operation. " +
                            "Read nendo://application/describe first: it returns the whole open application in one call, and its " +
                            "reads block names every resource URI this host serves. resources/list returns only the parameterless " +
                            "ones; the read paths that take a parameter are templates, returned by resources/templates/list. " +
                            "Read a record back, with exact numericLexemes, at nendo://application/entity/{entityId}/records. " +
                            "nendo://application/vocabulary carries every node kind, the closed operator and value sets, every " +
                            "canonical operation with the payload it takes, the behaviour catalogue with every binding shape's keys, " +
                            "and the authoring limits; nendo://application/examples " +
                            "carries complete change sets you can send as they stand. " +
                            "nendo://application/proposals lists what is already waiting for the person to accept. " +
                            "Acquire a lease and keep its applicationHandle private. Pass it with leaseId on all owned operations. " +
                            (options.LeaseTtl is { } ttl
                                ? $"Renew within {(int)ttl.TotalSeconds} seconds; release explicitly when finished. "
                                : "The lease has no expiry: release it explicitly when finished. ") +
                            "nendo.lease.status reports who holds the lease and needs none itself; use it after a lost " +
                            "acquire response or a reconnect rather than assuming the lease is free. " +
                            "Closing your client does not release editing, and the person may revoke it at any time. " +
                            "Entity, field, record and node IDs are unique across the whole file, not scoped to a parent. " +
                            "Compiled screens are exercised in the Use view, not Studio. " +
                            "Save receiptContext from the lease grant before writing. After a lost response, " +
                            "nendo.data.get_receipt can read the original outcome without restoring edit authority. " +
                            "An unresolved receipt is not permission to resubmit with a new key. " +
                            "No SQL, file access, process access, network access or generic invocation is " +
                            "available. A validated change set is accepted by the person in Nendo; " +
                            (mode >= AgentAccessMode.Unattended
                                ? "this file session is set to Unattended, so nendo.change_set.accept applies your own validated proposal and records this device's consent for any automatic actions it installs. "
                                : "there is no promotion tool at this access level. ") +
                            "There is no credential and no session header.A standard MCP client sends initialize and " +
                            "proceeds. If you are building your own 2026-07-28 client: call server/discover, then send each " +
                            "request with MCP-Protocol-Version, Mcp-Method and Mcp-Name headers and params._meta keys " +
                            "io.modelcontextprotocol/protocolVersion, io.modelcontextprotocol/clientCapabilities and " +
                            "io.modelcontextprotocol/clientInfo, camelCase exactly as written.";
                        // The signal brackets the call; the log records it afterwards. Both
                        // are here because this is the one place that sees every request,
                        // its name and its client, and neither holds a gate.
                        server.Filters.Request.CallToolFilters.Add(next => async (context, token) =>
                        {
                            using var working = work.Begin(
                                NendoTransportIdentity.DisplayName(context.Server.ClientInfo),
                                context.Params.Name);
                            try
                            {
                                authority.RequireActive();
                                NendoToolBoundary.Validate(context.Params);
                                var result = await next(context, token);
                                activity.Record(
                                    "tool",
                                    context.Params.Name,
                                    context.Server,
                                    result.IsError is true ? "rejected" : "completed");
                                return result;
                            }
                            catch
                            {
                                activity.Record("tool", context.Params.Name, context.Server, "rejected");
                                throw;
                            }
                        });
                        server.Filters.Request.ReadResourceFilters.Add(next => async (context, token) =>
                        {
                            var name = NendoActivityLog.ResourceName(context.Params.Uri);
                            using var working = work.Begin(
                                NendoTransportIdentity.DisplayName(context.Server.ClientInfo),
                                name);
                            try
                            {
                                authority.RequireActive();
                                var result = await next(context, token);
                                result.CacheScope = CacheScope.Private;
                                result.TimeToLive = TimeSpan.Zero;
                                activity.Record("resource", name, context.Server, "completed");
                                return result;
                            }
                            catch
                            {
                                activity.Record("resource", name, context.Server, "rejected");
                                throw;
                            }
                        });
                    })
                    .WithHttpTransport(transport => transport.SessionMode = HttpServerSessionMode.Stateless)
                    .WithResources<NendoMcpResources>();

                if (mode >= AgentAccessMode.DataMutation)
                {
                    WithNendoTools<NendoLeaseTools>(mcp);
                    WithNendoTools<NendoDataTools>(mcp);
                    WithNendoTools<NendoHealthTools>(mcp);
                }
                else
                {
                    // Installed clients may initialize every configured server with tools/list.
                    // Keep Inspect's allowlist genuinely empty while returning a successful page.
                    mcp.WithListToolsHandler((_, _) => ValueTask.FromResult(new ListToolsResult
                    {
                        Tools = [],
                    }));
                }

                if (mode >= AgentAccessMode.ApplicationAuthoring)
                {
                    WithNendoTools<NendoAuthoringTools>(mcp);
                }

                // The level at which the agent accepts its own work. One tool, registered
                // in its own block, so what this level adds is readable in one line
                // (ADR-0009, 2026-09-22 amendment).
                if (mode >= AgentAccessMode.Unattended)
                {
                    WithNendoTools<NendoUnattendedTools>(mcp);
                }

                var application = builder.Build();
                application.UseMiddleware<NendoMcpSecurityMiddleware>();
                application.MapMcp("/mcp");
                try
                {
                    await application.StartAsync(cancellationToken);
                }
                catch
                {
                    // A listener that never bound must not leak; the caller may retry on another port.
                    await application.DisposeAsync();
                    throw;
                }
                return application;
            }

            // Bind the owner's port, then fall back rather than failing: a busy or OS-excluded port must never
            // stop the file from being agent-accessible. Attempt the real bind instead of probing first, which
            // would only introduce a race between the probe and the listener.
            if (options.PreferredPort == 0)
            {
                webApplication = await BuildAndStartAsync(0);
            }
            else
            {
                // Restarting for a mode or settings change races the outgoing listener releasing this very
                // port, so a first refusal usually means "not yet" rather than "taken". Retry briefly before
                // conceding, or the action that changes a setting would itself lose the fixed port.
                for (var attempt = 0; ; attempt++)
                {
                    try
                    {
                        webApplication = await BuildAndStartAsync(options.PreferredPort);
                        break;
                    }
                    catch (Exception exception) when (IsPortUnavailable(exception))
                    {
                        if (attempt == PortBindAttempts - 1)
                        {
                            usedFallbackPort = true;
                            webApplication = await BuildAndStartAsync(0);
                            break;
                        }
                        await Task.Delay(PortBindRetryDelay, cancellationToken);
                    }
                }
            }

            var server = webApplication.Services.GetRequiredService<IServer>();
            var addresses = server.Features.Get<IServerAddressesFeature>()?.Addresses
                ?? throw new InvalidOperationException("The local MCP listener did not publish an address.");
            var endpoint = addresses
                .Select(address => new Uri(address, UriKind.Absolute))
                .Single(address => address.Host == IPAddress.Loopback.ToString());
            authority.SetPort(endpoint.Port);
            authority.RequireActive();
            discoveryPath = await discoveryStore.WriteAsync(
                authority,
                snapshot.Manifest.ApplicationId,
                snapshot.Manifest.InstanceId,
                snapshot.FileName,
                cancellationToken);
            authority.RequireActive();
            return new NendoLocalMcpHost(
                webApplication,
                applicationService,
                authority,
                agentAuthority,
                authoring,
                activity,
                proposalStore,
                work,
                discoveryPath,
                options.PreferredPort,
                usedFallbackPort);
        }
        catch
        {
            authority.CloseAdmission();
            applicationService.WriteAuthorityLost -= authority.CloseAdmission;
            NendoDiscoveryStore.DeleteIfPresent(discoveryPath);
            if (webApplication is not null)
            {
                try
                {
                    await webApplication.StopAsync(CancellationToken.None);
                }
                finally
                {
                    await webApplication.DisposeAsync();
                }
            }
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        CloseAdmission();
        _applicationService.WriteAuthorityLost -= _authority.CloseAdmission;
        var cleanupFailures = new List<Exception>();
        try
        {
            NendoDiscoveryStore.DeleteIfPresent(_discoveryPath);
        }
        catch (Exception exception) { cleanupFailures.Add(exception); }
        try { await _agentAuthority.RevokeAllAsync(); }
        catch (Exception exception) { cleanupFailures.Add(exception); }
        try { await _authoring.DiscardAllDraftsAsync(); }
        catch (Exception exception) { cleanupFailures.Add(exception); }

        try
        {
            await _application.StopAsync(CancellationToken.None);
        }
        finally
        {
            await _application.DisposeAsync();
        }

        if (cleanupFailures.Count != 0)
        {
            throw new IOException(
                "Agent access stopped, but its local cleanup did not finish.",
                new AggregateException(cleanupFailures));
        }
    }

    /// <summary>
    /// The SDK's <c>WithTools</c>, with one addition: the schema options that give every
    /// advertised input node a type. The SDK overload takes serializer options only, so
    /// the four tool classes are registered here the way it registers them — one
    /// <see cref="McpServerTool"/> per attributed method, the instance constructed from
    /// the host's services on each call.
    /// </summary>
    private static void WithNendoTools<TTools>(IMcpServerBuilder mcp) where TTools : class
    {
        foreach (var method in typeof(TTools).GetMethods(
                     BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static))
        {
            if (method.GetCustomAttribute<McpServerToolAttribute>() is null) continue;
            mcp.Services.AddSingleton<McpServerTool>(services =>
            {
                var options = new McpServerToolCreateOptions
                {
                    Services = services,
                    SerializerOptions = NendoMcpJson.ToolOptions,
                    SchemaCreateOptions = NendoMcpJson.ToolSchemaOptions,
                };
                return method.IsStatic
                    ? McpServerTool.Create(method, target: null, options)
                    : McpServerTool.Create(method, _ => ActivatorUtilities.CreateInstance(services, typeof(TTools)), options);
            });
        }
    }

    // Kestrel wraps the socket failure, so walk the chain. AccessDenied matters as much as AddressAlreadyInUse:
    // a port inside a Windows excluded range (Hyper-V, WinNAT, WSL) refuses with access denied, and treating
    // that as fatal would break startup on exactly the machines that need the fallback.
    private static bool IsPortUnavailable(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is SocketException socket
                && socket.SocketErrorCode is SocketError.AddressAlreadyInUse or SocketError.AccessDenied)
            {
                return true;
            }
        }
        return false;
    }

    private const int PortBindAttempts = 4;
    private static readonly TimeSpan PortBindRetryDelay = TimeSpan.FromMilliseconds(150);

    private static string RandomHex(int byteCount) =>
        Convert.ToHexString(RandomNumberGenerator.GetBytes(byteCount)).ToLowerInvariant();
}
