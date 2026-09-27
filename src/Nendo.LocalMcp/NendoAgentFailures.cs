using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using ModelContextProtocol;

namespace Nendo.LocalMcp;

/// <summary>
/// One request that failed inside the host, as the person's device may keep it.
/// <para>
/// It names the request and the exception, and carries the reference the agent was given,
/// so what an agent reports can be found. It carries no exception message, no argument, no
/// handle, no lease and no path: a message is where a stored value or a location would
/// travel, and the frames are written without their source files.
/// </para>
/// </summary>
/// <param name="Source"><c>tool</c>, <c>resource</c>, <c>sdk</c> or <c>web server</c>.</param>
/// <param name="Request">The tool or resource name, or the logging category when no request was in flight.</param>
/// <param name="ExceptionType">The exception's type and each inner exception's, outermost first.</param>
/// <param name="Trace">The frames the failure passed through, without file names or line numbers.</param>
public sealed record NendoAgentFailure(
    DateTimeOffset At,
    string Reference,
    string Source,
    string Request,
    string ExceptionType,
    string Trace);

/// <summary>
/// Where an internal failure goes. Until 2026-09-27 the host cleared every log provider and
/// <c>NENDO_INTERNAL_ERROR</c> named only the exception type, so a failure inside the host
/// left no trace anywhere (F-181). A request now runs inside a scope that knows its name and
/// the host's sink, and the translation that turns an unexpected exception into
/// <c>NENDO_INTERNAL_ERROR</c> records it there, under the reference the agent is told.
/// </summary>
internal static partial class NendoAgentFailures
{
    private static readonly AsyncLocal<Scope?> Current = new();

    private const int MaximumFrames = 24;
    private const int MaximumTraceCharacters = 4_000;

    /// <summary>Everything a failure in this request is recorded against, until disposed.</summary>
    internal static IDisposable Begin(string source, string request, Action<NendoAgentFailure>? sink)
    {
        var scope = new Scope(source, request, sink, Current.Value);
        Current.Value = scope;
        return scope;
    }

    /// <summary>
    /// Record an unexpected exception against the request in flight, and return the
    /// reference the refusal carries. Recording fails soft: a diagnostic that could turn a
    /// refusal into a crash would be a worse defect than the one it is here to trace.
    /// </summary>
    internal static string Report(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        var reference = Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
        if (Current.Value is { Sink: { } sink } scope)
        {
            Deliver(sink, new NendoAgentFailure(
                DateTimeOffset.UtcNow,
                reference,
                scope.Source,
                scope.Request,
                TypeChain(exception),
                Trace(exception)));
        }
        return reference;
    }

    /// <summary>The same record, for a failure the SDK or the web server logged.</summary>
    internal static void ReportLogged(
        Action<NendoAgentFailure> sink,
        string source,
        string category,
        string eventName,
        Exception? exception)
    {
        var scope = Current.Value;
        Deliver(sink, new NendoAgentFailure(
            DateTimeOffset.UtcNow,
            Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant(),
            source,
            scope?.Request ?? category,
            exception is null ? eventName : $"{eventName}: {TypeChain(exception)}",
            exception is null ? string.Empty : Trace(exception)));
    }

    internal static string TypeChain(Exception exception)
    {
        var types = new List<string>();
        for (var current = exception; current is not null && types.Count < 8; current = current.InnerException)
        {
            types.Add(current.GetType().FullName ?? current.GetType().Name);
        }
        return string.Join(" <- ", types);
    }

    /// <summary>
    /// The frames, from the exception's own trace with every <c>in file:line</c> removed.
    /// A frame names a method and its parameter types, never a value.
    /// </summary>
    internal static string Trace(Exception exception)
    {
        var frames = (exception.StackTrace ?? string.Empty)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(frame => SourceLocation().Replace(frame, string.Empty))
            .Take(MaximumFrames);
        var text = new StringBuilder();
        foreach (var frame in frames)
        {
            if (text.Length + frame.Length + 1 > MaximumTraceCharacters) break;
            text.Append(frame).Append('\n');
        }
        return text.ToString().TrimEnd('\n');
    }

    private static void Deliver(Action<NendoAgentFailure> sink, NendoAgentFailure failure)
    {
        try
        {
            sink(failure);
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            // Fail soft; see Report.
        }
    }

    [GeneratedRegex(@"\s+in\s+.+?:line\s+\d+\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex SourceLocation();

    private sealed class Scope(string source, string request, Action<NendoAgentFailure>? sink, Scope? outer) : IDisposable
    {
        internal string Source { get; } = source;
        internal string Request { get; } = request;
        internal Action<NendoAgentFailure>? Sink { get; } = sink;

        public void Dispose() => Current.Value = outer;
    }
}

/// <summary>
/// The failure record, open only while the host serves. Starting and stopping are the
/// caller's to report -- a start that fails throws out of StartAsync -- and a start that
/// recovers is not a failure at all: the port-busy fallback binds another port after the
/// hosting layer has logged each refused bind as an error. Before this was closed during
/// startup, a test run that met a running Nendo on the fixed port wrote fifty such lines.
/// </summary>
internal sealed class NendoFailureRecord(Action<NendoAgentFailure>? sink)
{
    private volatile bool _open;

    /// <summary>The sink to hand a request scope, or null when nothing is recorded.</summary>
    internal Action<NendoAgentFailure>? Sink => sink is null ? null : Record;

    internal void Open() => _open = true;

    internal void Close() => _open = false;

    internal void Record(NendoAgentFailure failure)
    {
        if (_open) sink?.Invoke(failure);
    }
}

/// <summary>
/// The SDK's and the web server's own warnings and errors, into the same record. Before, the
/// host cleared every log provider, so a failure only they saw — a request the SDK could not
/// bind, a response the server could not write — vanished. What is kept is the event, the
/// exception type and the frames: never the formatted message, which for some events carries
/// the request body. A refusal the agent has already read (an <see cref="McpException"/>) and
/// a cancellation are ordinary answers, not failures, and are not recorded.
/// </summary>
internal sealed class NendoFailureLoggerProvider(Action<NendoAgentFailure> sink) : ILoggerProvider
{
    public ILogger CreateLogger(string categoryName) => new Logger(sink, categoryName);

    public void Dispose()
    {
    }

    private sealed class Logger(Action<NendoAgentFailure> sink, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning && logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel) || exception is McpException or OperationCanceledException) return;
            NendoAgentFailures.ReportLogged(
                sink,
                category.StartsWith("ModelContextProtocol", StringComparison.Ordinal) ? "sdk" : "web server",
                category,
                eventId.Name ?? eventId.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                exception);
        }
    }
}
