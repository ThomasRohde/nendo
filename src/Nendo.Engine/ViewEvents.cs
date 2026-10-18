namespace Nendo.Engine;

/// <summary>What happened to a custom view, as its package's recent events say it (W-251).</summary>
public enum NendoViewEventKind
{
    /// <summary>The view's frame connected to the Workbench.</summary>
    Loaded,

    /// <summary>The view stopped answering, or its frame was stopped.</summary>
    Stopped,

    /// <summary>The view's own code threw an error it did not catch.</summary>
    Error,

    /// <summary>The Workbench or the host refused a call the view made; <see cref="NendoViewEvent.Code"/> says why.</summary>
    Refused,
}

/// <summary>
/// One event of one custom view: when, which view, what, and for a refusal the method and code.
/// <see cref="Text"/> is the error's or the refusal's sentence, cut to <see cref="NendoViewEvents.MaximumText"/>.
/// </summary>
public sealed record NendoViewEvent(
    DateTimeOffset At,
    NendoViewEventKind Kind,
    string? ViewId,
    string? Method,
    string? Code,
    string? Text);

/// <summary>A package's recent events, oldest first, and how many earlier ones the bound let go.</summary>
public sealed record NendoViewEventLog(string PackageId, IReadOnlyList<NendoViewEvent> Events, long Dropped);

/// <summary>
/// The recent runtime events of the open file's custom views (W-251): loaded, stopped, an
/// uncaught error's text, and each refused call with its code, so the agent that wrote a view
/// can read what happened when it ran in the embedded host.
/// <para>
/// It is this open file's and nothing wider. One instance belongs to one application service,
/// which is one open file; it is memory only, never written to the file or the device, and gone
/// when the file closes. Each package keeps its last <see cref="EventsPerPackage"/> events, and
/// at most <see cref="Packages"/> packages are kept, the one heard from longest ago going first.
/// Nothing in it comes from the browser profile: the Workbench reports what its broker saw.
/// </para>
/// </summary>
public sealed class NendoViewEvents
{
    /// <summary>The events one package keeps.</summary>
    public const int EventsPerPackage = 50;

    /// <summary>The packages kept at once.</summary>
    public const int Packages = 32;

    /// <summary>The longest text an event keeps, in UTF-16 code units.</summary>
    public const int MaximumText = 500;

    private const int MaximumIdentifier = 120;

    private readonly object _gate = new();
    private readonly Dictionary<string, (LinkedList<NendoViewEvent> Events, long Dropped, long Heard)> _byPackage = new(StringComparer.Ordinal);
    private long _sequence;

    /// <summary>Keeps one event of a package, cutting what it says to the bounds.</summary>
    public void Record(string packageId, NendoViewEvent viewEvent)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageId);
        ArgumentNullException.ThrowIfNull(viewEvent);
        if (packageId.Length > MaximumIdentifier) throw new NendoValidationException("A package ID is at most 120 characters.");
        var kept = viewEvent with
        {
            ViewId = Cut(viewEvent.ViewId, MaximumIdentifier),
            Method = Cut(viewEvent.Method, MaximumIdentifier),
            Code = Cut(viewEvent.Code, MaximumIdentifier),
            Text = Cut(viewEvent.Text, MaximumText),
        };
        lock (_gate)
        {
            if (!_byPackage.TryGetValue(packageId, out var log))
            {
                if (_byPackage.Count >= Packages)
                    _byPackage.Remove(_byPackage.MinBy(entry => entry.Value.Heard).Key);
                log = (new LinkedList<NendoViewEvent>(), 0, 0);
            }
            log.Events.AddLast(kept);
            while (log.Events.Count > EventsPerPackage)
            {
                log.Events.RemoveFirst();
                log.Dropped++;
            }
            log.Heard = ++_sequence;
            _byPackage[packageId] = log;
        }
    }

    /// <summary>One package's events, or every package's, by package ID.</summary>
    public IReadOnlyList<NendoViewEventLog> Read(string? packageId = null)
    {
        lock (_gate)
        {
            return _byPackage
                .Where(entry => packageId is null || string.Equals(entry.Key, packageId, StringComparison.Ordinal))
                .OrderBy(entry => entry.Key, StringComparer.Ordinal)
                .Select(entry => new NendoViewEventLog(entry.Key, [.. entry.Value.Events], entry.Value.Dropped))
                .ToArray();
        }
    }

    private static string? Cut(string? text, int length) =>
        text is null ? null : text.Length <= length ? text : text[..length];
}
