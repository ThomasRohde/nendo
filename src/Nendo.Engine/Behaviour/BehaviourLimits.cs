namespace Nendo.Engine;

/// <summary>
/// The finite ceilings every behaviour definition and evaluation is held to.
/// <para>
/// These are host-owned. A file can declare what it wants to compute but never how
/// much of this machine it may use, so nothing here is read from stored data. Tests
/// lower them to exercise exact boundaries; nothing raises them.
/// </para>
/// <para>
/// They are deliberately small. Together they bound parser input, recursion,
/// primitive work and host functions — which is containment by arithmetic, not a
/// memory sandbox and not a wall-clock guarantee. Widening one needs new
/// measurements, not a passing test suite.
/// </para>
/// </summary>
public sealed record NendoBehaviourLimits
{
    /// <summary>The shipped ceilings. See <c>docs/contracts/calculations-and-actions.md</c>.</summary>
    public static NendoBehaviourLimits Default { get; } = new();

    /// <summary>Checked before the parser allocates anything.</summary>
    public int SourceLength { get; init; } = 2_048;

    /// <summary>Lexical tokens and punctuation, counted in a preflight scan.</summary>
    public int SyntaxItems { get; init; } = 128;

    /// <summary>Nodes in the parsed tree, counted during the typed walk.</summary>
    public int AstNodes { get; init; } = 128;

    /// <summary>Bracket and parenthesis nesting, checked before a recursive parse.</summary>
    public int ParseDepth { get; init; } = 24;

    /// <summary>Depth of the walked tree, guarding unary and call chains.</summary>
    public int AstDepth { get; init; } = 24;

    /// <summary>Depth of the definition graph, revalidated even on a warm cache.</summary>
    public int GraphDepth { get; init; } = 8;

    /// <summary>Functions in one catalogue, checked before the lookup table is built.</summary>
    public int CatalogueSize { get; init; } = 32;

    /// <summary>
    /// Definitions of every kind in one file, checked before the graph is walked. Each
    /// formula compiles under its own work allowance, so this is what bounds the whole
    /// compile — and the whole open.
    /// </summary>
    public int Definitions { get; init; } = 256;

    /// <summary>Parameters or bindings declared by one formula.</summary>
    public int Parameters { get; init; } = 16;

    /// <summary>Length of any stable ID or alias appearing in a formula.</summary>
    public int IdentifierLength { get; init; } = 128;

    /// <summary>Source visits, validation, evaluation, scans and changes all spend these.</summary>
    public int WorkUnits { get; init; } = 16_384;

    /// <summary>Function calls, counted once across nested evaluation and action chains.</summary>
    public int FunctionCalls { get; init; } = 64;

    /// <summary>Length of any text input or result, checked before allocation.</summary>
    public int TextLength { get; init; } = 4_096;

    /// <summary>Validated expressions one adapter retains.</summary>
    public int CacheEntries { get; init; } = 16;

    /// <summary>Related rows read per chain, as a SQL LIMIT and a charge per row.</summary>
    public int RelatedRows { get; init; } = 256;

    /// <summary>Generated non-no-op changes per chain.</summary>
    public int GeneratedChanges { get; init; } = 64;

    /// <summary>
    /// Refuses a host setting that is not a usable finite bound. A limit of zero or
    /// less cannot be honoured by charging, so it is a configuration error rather
    /// than a very strict policy.
    /// </summary>
    public NendoBehaviourLimits Validate()
    {
        Positive(SourceLength, nameof(SourceLength));
        Positive(SyntaxItems, nameof(SyntaxItems));
        Positive(AstNodes, nameof(AstNodes));
        Positive(ParseDepth, nameof(ParseDepth));
        Positive(AstDepth, nameof(AstDepth));
        Positive(GraphDepth, nameof(GraphDepth));
        Positive(CatalogueSize, nameof(CatalogueSize));
        Positive(Definitions, nameof(Definitions));
        Positive(Parameters, nameof(Parameters));
        Positive(IdentifierLength, nameof(IdentifierLength));
        Positive(WorkUnits, nameof(WorkUnits));
        Positive(FunctionCalls, nameof(FunctionCalls));
        Positive(TextLength, nameof(TextLength));
        Positive(CacheEntries, nameof(CacheEntries));
        Positive(RelatedRows, nameof(RelatedRows));
        Positive(GeneratedChanges, nameof(GeneratedChanges));
        return this;
    }

    /// <summary>
    /// Identifies this exact limit policy. A cached validated expression carries it so
    /// a stricter run can never reuse a result produced under a more permissive one.
    /// </summary>
    internal string PolicyKey() => string.Join('/', [
        SourceLength, SyntaxItems, AstNodes, ParseDepth, AstDepth, GraphDepth, CatalogueSize,
        Definitions, Parameters, IdentifierLength, WorkUnits, FunctionCalls, TextLength, CacheEntries,
        RelatedRows, GeneratedChanges]);

    private static void Positive(int value, string name)
    {
        if (value <= 0) throw new NendoValidationException($"The behaviour limit {name} must be a positive whole number.");
    }
}
