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
using ModelContextProtocol;
using ModelContextProtocol.AspNetCore;
using ModelContextProtocol.Extensions.Tasks;
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

    /// <summary>
    /// Where the host records a request that failed inside it: an unexpected exception
    /// behind <c>NENDO_INTERNAL_ERROR</c>, and the SDK's and the web server's own warnings
    /// and errors. Null records nothing. The host that owns the device decides whether and
    /// where a record is kept (ADR-0002, 2026-09-27 amendment).
    /// </summary>
    public Action<NendoAgentFailure>? RecordFailure { get; init; }

    /// <summary>
    /// How long one request may take, its body included, before it is cancelled and answered
    /// <c>NENDO_REQUEST_TIMEOUT</c>. Five minutes: longer than any validation or scan of a file
    /// this host opens, and short enough that a request nobody finishes gives its place back.
    /// </summary>
    public TimeSpan RequestTimeout { get; init; } = NendoRequestGate.DefaultTimeout;

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
    private readonly NendoRequestGate _requests;
    private readonly NendoFailureRecord _failures;
    private readonly NendoChangeFeed _feed;
    private readonly Action<long> _committed;
    private readonly Action _proposalsChanged;
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
        NendoRequestGate requests,
        NendoFailureRecord failures,
        NendoChangeFeed feed,
        Action<long> committed,
        Action proposalsChanged,
        string discoveryPath,
        int requestedPort,
        bool usedFallbackPort)
    {
        _application = application;
        _applicationService = applicationService;
        _feed = feed;
        _committed = committed;
        _proposalsChanged = proposalsChanged;
        _authority = authority;
        _agentAuthority = agentAuthority;
        _authoring = authoring;
        _activity = activity;
        _proposals = proposals;
        _work = work;
        _requests = requests;
        _failures = failures;
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

    /// <summary>Requests past the perimeter and not yet answered.</summary>
    internal int InFlightRequests => _requests.InFlight;

    /// <summary>
    /// Who holds the lease, read under the authority's gate. Once the host is disposed every
    /// lease has been revoked and the gate is gone, so the published answer is the whole one.
    /// </summary>
    public Task<NendoLeaseStatus> GetLeaseStatusAsync(CancellationToken cancellationToken = default) =>
        Volatile.Read(ref _disposed) != 0
            ? Task.FromResult(_agentAuthority.PeekStatus())
            : _agentAuthority.GetStatusAsync(cancellationToken);

    /// <summary>
    /// Who holds the lease, without waiting for what they are doing with it. The gated
    /// read above is the serialized answer; this one is the answer a window can ask for
    /// while an agent is mid-write, which is the only time anybody looks.
    /// </summary>
    public NendoLeaseStatus PeekLeaseStatus() => _agentAuthority.PeekStatus();

    /// <summary>Ends every lease at once. A disposed host has already done so.</summary>
    public Task RevokeEditingAsync() =>
        Volatile.Read(ref _disposed) != 0 ? Task.CompletedTask : _agentAuthority.RevokeAllAsync();

    public IReadOnlyList<NendoAgentActivity> GetActivities(int maximum = 200) =>
        _activity.Snapshot(maximum);

    /// <summary>How many subscriptions/listen streams are open now.</summary>
    public int ListenerCount => _feed.Count;

    /// <summary>
    /// The tools a client may run as a task (W-152): a physical clone plus compilation, up to
    /// ten batch revisions, and a full scan. Published here so the contract and the gate name
    /// the same three.
    /// </summary>
    public static readonly IReadOnlySet<string> TaskCapableTools = new HashSet<string>(StringComparer.Ordinal)
    {
        "nendo.change_set.validate",
        "nendo.data.import_records",
        "nendo.health.verify_integrity",
    };

    /// <summary>
    /// One <c>subscriptions/listen</c> stream (W-151): acknowledges the resource URIs this host
    /// pushes, among those the client asked for, then sends <c>resources/updated</c> for each
    /// as the Engine commits, the proposal queue changes or the file closes, until the client
    /// goes away. toolsListChanged is not honoured: a level change restarts the listener, and
    /// the stream ending is that signal. The stream holds one request-gate place for its
    /// life, so at most <see cref="NendoChangeFeed.MaximumListeners"/> are open at once.
    /// </summary>
    private static async ValueTask<EmptyResult> ListenAsync(
        RequestContext<SubscriptionsListenRequestParams> request,
        NendoChangeFeed feed,
        CancellationToken cancellationToken)
    {
        var wanted = request.Params?.Notifications?.ResourceSubscriptions ?? [];
        var honoured = NendoChangeFeed.Served.Where(uri => wanted.Contains(uri, StringComparer.Ordinal)).ToArray();
        using var listener = feed.TryOpen()
            ?? throw new McpProtocolException(
                $"NENDO_BUSY: {NendoChangeFeed.MaximumListeners} subscriptions/listen streams are already open to this file, the most this " +
                "host holds at once. Close one, or poll nendo://application/proposals instead.",
                McpErrorCode.InvalidParams);
        var subscriptionId = System.Text.Json.Nodes.JsonValue.Create(request.JsonRpcRequest?.Id.Id?.ToString() ?? string.Empty);
        System.Text.Json.Nodes.JsonObject Tagged() => new() { [MetaKeys.SubscriptionId] = subscriptionId.DeepClone() };
        await request.Server.SendNotificationAsync(
            NotificationMethods.SubscriptionsAcknowledgedNotification,
            new SubscriptionsAcknowledgedNotificationParams
            {
                Notifications = new SubscriptionsListenNotifications { ResourceSubscriptions = honoured },
            },
            cancellationToken: cancellationToken);
        try
        {
            await foreach (var uri in listener.Reader.ReadAllAsync(cancellationToken))
            {
                if (!honoured.Contains(uri, StringComparer.Ordinal)) continue;
                await request.Server.SendNotificationAsync(
                    NotificationMethods.ResourceUpdatedNotification,
                    new ResourceUpdatedNotificationParams { Uri = uri, Meta = Tagged() },
                    cancellationToken: cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // The client went away, or the request was stopped: the stream is over.
        }
        return new EmptyResult();
    }

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
        NendoUnattendedConsent? unattendedConsent = null,
        CancellationToken cancellationToken = default)
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
            NendoText.RandomHex(32),
            mode,
            RandomNumberGenerator.GetBytes(32),
            snapshot.Manifest.ApplicationId,
            snapshot.Manifest.InstanceId,
            snapshot.FileName);
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
        var queries = NendoResourceQuery.ForDeclaredResources();
        var requests = new NendoRequestGate(NendoRequestGate.DefaultMaximum, options.RequestTimeout);
        var failures = new NendoFailureRecord(options.RecordFailure);
        // What a listen stream is told (W-151): a commit moves the manifest and may stale
        // every proposal; the queue changes when one joins, is promoted or is rejected.
        var feed = new NendoChangeFeed();
        // Task state is host memory keyed by task ID (W-152): it dies with this listener,
        // which is what NENDO_HOST_CLOSED already means, and the TTL says so.
        var tasks = new InMemoryMcpTaskStore { DefaultTimeToLive = TimeSpan.FromMinutes(30), DefaultPollIntervalMs = 1000 };
        Action<long> committed = _ => feed.Signal(NendoChangeFeed.Manifest, NendoChangeFeed.Proposals);
        Action proposalsChanged = () => feed.Signal(NendoChangeFeed.Proposals);
        applicationService.Committed += committed;
        proposalStore.ProposalsChanged += proposalsChanged;
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
                if (options.RecordFailure is not null)
                {
                    builder.Logging.SetMinimumLevel(LogLevel.Warning);
                    // Registered as a service, so the container that builds it disposes it.
                    builder.Services.AddSingleton<ILoggerProvider>(_ => new NendoFailureLoggerProvider(failures.Record));
                }
                builder.WebHost.ConfigureKestrel(kestrel =>
                {
                    // Every response named the web server it came from. Nothing a client
                    // does depends on it, and a loopback endpoint has no reason to say.
                    kestrel.AddServerHeader = false;
                    kestrel.Listen(
                        IPAddress.Loopback,
                        port,
                        listen => listen.Protocols = HttpProtocols.Http1);
                });
                builder.Services.AddSingleton(applicationService);
                builder.Services.AddSingleton(authority);
                builder.Services.AddSingleton(requests);
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
                            // "Nendo · BCM", so two registered files are two names in a
                            // client's server list rather than the same one twice.
                            Title = NendoFileLabel.Title(snapshot.FileName),
                            Version = NendoProduct.Version,
                            Description = "The file open in Nendo on this computer, at the access level its person chose.",
                            WebsiteUrl = "https://thomasrohde.github.io/nendo/",
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
                        server.ServerInstructions = NendoServerInstructions.For(mode, options.LeaseTtl, snapshot.FileName);
                        // The Skills extension (W-154, SEP-2640): the host's skill and the open file's own
                        // (ADR-0024), listed and fetched by two methods the SDK does not know, their files
                        // served as resources.
                        server.Capabilities ??= new ServerCapabilities();
                        server.Capabilities.Extensions ??= new Dictionary<string, object>(StringComparer.Ordinal);
                        server.Capabilities.Extensions[NendoHostSkill.ExtensionId] = System.Text.Json.JsonSerializer.SerializeToElement(new { });
                        server.RequestHandlers ??= [];
                        server.RequestHandlers.Add(new McpServerRequestHandler
                        {
                            Method = "skills/list",
                            Handler = async (_, token) =>
                            {
                                authority.RequireActive();
                                return NendoHostSkill.ListResult(await NendoFileSkills.ReadAsync(applicationService, token));
                            },
                        });
                        server.RequestHandlers.Add(new McpServerRequestHandler
                        {
                            Method = "skills/get",
                            RoutingNameParameter = "uri",
                            Handler = async (request, token) =>
                            {
                                authority.RequireActive();
                                return NendoHostSkill.GetResult(request.Params, await NendoFileSkills.ReadAsync(applicationService, token));
                            },
                        });
                        // The signal brackets the call; the log records it afterwards. Both
                        // are here because this is the one place that sees every request,
                        // its name and its client, and neither holds a gate.
                        server.Filters.Request.CallToolFilters.Add(next => async (context, token) =>
                        {
                            using var working = work.Begin(
                                NendoTransportIdentity.DisplayName(context.Server.ClientInfo),
                                context.Params.Name);
                            using var failed = NendoAgentFailures.Begin("tool", context.Params.Name, failures.Sink);
                            // One entry per call. The tool says what it did through this slot --
                            // the revision it committed, the proposal it touched -- and the entry
                            // is written here, once, after the call. It used to be written twice:
                            // once here and once by the tool, so twenty entries held ten calls.
                            var slot = new NendoActivityLog.Slot();
                            context.Items[NendoActivityLog.SlotKey] = slot;
                            // The refusal a tool translates is recorded into this scope, and put
                            // beside the text here, where the result is in hand (W-149).
                            using var refusal = NendoToolRefusal.Begin();
                            try
                            {
                                authority.RequireActive();
                                NendoToolBoundary.Validate(context.Params, mode);
                                var result = await next(context, token);
                                activity.Record(slot, context.Params.Name, context.Server, rejected: result.IsError is true);
                                return result;
                            }
                            // A tool's refusal leaves it as an exception and the SDK writes the error
                            // result above this filter, so the result is built here instead, in the
                            // SDK's own words, with the structured form beside them (W-149).
                            catch (McpException exception) when (exception is not McpProtocolException && refusal.Refusal is { } structured)
                            {
                                activity.Record(slot, context.Params.Name, context.Server, rejected: true);
                                return new CallToolResult
                                {
                                    IsError = true,
                                    Content = [new TextContentBlock { Text = $"An error occurred invoking '{context.Params.Name}': {exception.Message}" }],
                                    Meta = new System.Text.Json.Nodes.JsonObject
                                    {
                                        [NendoToolRefusal.MetaKey] = System.Text.Json.JsonSerializer.SerializeToNode(structured, NendoMcpJson.Options),
                                    },
                                };
                            }
                            catch
                            {
                                activity.Record(slot, context.Params.Name, context.Server, rejected: true);
                                throw;
                            }
                        });
                        server.Filters.Request.ReadResourceFilters.Add(next => async (context, token) =>
                        {
                            var name = NendoActivityLog.ResourceName(context.Params.Uri);
                            using var working = work.Begin(
                                NendoTransportIdentity.DisplayName(context.Server.ClientInfo),
                                name);
                            using var failed = NendoAgentFailures.Begin("resource", name, failures.Sink);
                            try
                            {
                                authority.RequireActive();
                                // A query is a set, not a sequence: either order, and an empty
                                // value left out. The SDK matched the URI before this filter
                                // ran, so a rewritten one is matched again here.
                                var canonical = queries.Canonicalize(context.Params.Uri);
                                if (!string.Equals(canonical, context.Params.Uri, StringComparison.Ordinal))
                                {
                                    context.Params.Uri = canonical;
                                    context.MatchedPrimitive = context.Server.ServerOptions.ResourceCollection?
                                        .FirstOrDefault(resource => resource.IsMatch(canonical));
                                }
                                var result = await next(context, token);
                                result.CacheScope = CacheScope.Private;
                                // The vocabulary, the examples and the view API describe this
                                // build, not the open file, so a client may keep them for an hour.
                                result.TimeToLive = NendoMcpResources.StaticForBuild.Contains(canonical)
                                    ? NendoMcpResources.StaticTimeToLive
                                    : TimeSpan.Zero;
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
                    .WithResources<NendoMcpResources>()
                    .WithSubscriptionsListenHandler((request, token) => ListenAsync(request, feed, token))
                    // The three long operations run as tasks for a client that declares the Tasks
                    // extension on its request, and as today for one that does not (W-152). Every
                    // other tool stays synchronous: a write is answered, not polled for.
                    .WithTasks(tasks, taskOptions => taskOptions.ExecutionModeSelector = context =>
                        TaskCapableTools.Contains(context.Params?.Name ?? string.Empty)
                            ? McpTaskExecutionMode.Optional
                            : McpTaskExecutionMode.Synchronous);

                // One table says which tool class each level serves; the boundary refuses
                // from the same table, so a level code names exactly what is not here.
                foreach (var (tools, minimum) in NendoToolBoundary.ToolClasses)
                {
                    if (mode >= minimum) WithNendoTools(mcp, tools);
                }
                if (mode < AgentAccessMode.DataMutation)
                {
                    // Installed clients may initialize every configured server with tools/list.
                    // Keep Inspect's allowlist genuinely empty while returning a successful page,
                    // and answer a call so the boundary can name the level it needs.
                    mcp.WithListToolsHandler((_, _) => ValueTask.FromResult(new ListToolsResult
                    {
                        Tools = [],
                    }));
                    mcp.WithCallToolHandler((_, _) => throw new McpProtocolException(
                        "NENDO_TOOL_UNAVAILABLE: Inspect serves no tools.",
                        McpErrorCode.InvalidParams));
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
            // Only now is there a host whose requests can fail; see NendoFailureRecord.
            failures.Open();
            return new NendoLocalMcpHost(
                webApplication,
                applicationService,
                authority,
                agentAuthority,
                authoring,
                activity,
                proposalStore,
                work,
                requests,
                failures,
                feed,
                committed,
                proposalsChanged,
                discoveryPath,
                options.PreferredPort,
                usedFallbackPort);
        }
        catch
        {
            authority.CloseAdmission();
            applicationService.WriteAuthorityLost -= authority.CloseAdmission;
            applicationService.Committed -= committed;
            proposalStore.ProposalsChanged -= proposalsChanged;
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
            authoring.Dispose();
            agentAuthority.Dispose();
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
        _failures.Close();
        _applicationService.WriteAuthorityLost -= _authority.CloseAdmission;
        _applicationService.Committed -= _committed;
        _proposals.ProposalsChanged -= _proposalsChanged;
        // Every listen stream hears that health changed and then ends, before the
        // listener stops taking requests (W-151).
        _feed.Close();
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
            // Nothing can reach either gate once the listener has stopped.
            _authoring.Dispose();
            _agentAuthority.Dispose();
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
    /// the tool classes are registered here the way it registers them — one
    /// <see cref="McpServerTool"/> per attributed method, the instance constructed from
    /// the host's services on each call.
    /// </summary>
    private static void WithNendoTools(IMcpServerBuilder mcp, Type tools)
    {
        foreach (var method in NendoToolBoundary.ToolMethods(tools))
        {
            mcp.Services.AddSingleton<McpServerTool>(services =>
            {
                var options = new McpServerToolCreateOptions
                {
                    Services = services,
                    SerializerOptions = NendoMcpJson.ToolOptions,
                    SchemaCreateOptions = NendoMcpJson.ToolSchemaOptions,
                };
                var tool = method.IsStatic
                    ? McpServerTool.Create(method, target: null, options)
                    : McpServerTool.Create(method, _ => ActivatorUtilities.CreateInstance(services, tools), options);
                // The arguments object is closed: the boundary refuses a key the method does
                // not declare, and the schema says so rather than leaving it to be found out.
                tool.ProtocolTool.InputSchema = NendoJsonInputs.Closed(tool.ProtocolTool.InputSchema);
                return tool;
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
}
