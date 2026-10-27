using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Nendo.Engine;

/// <summary>One option of a choice setting: the value kept and the label a person reads.</summary>
public sealed record NendoPackageSettingOption(string Value, string Label);

/// <summary>
/// One setting a view package declares in <c>nendo-package.json</c> (ADR-0038). Nendo draws it in
/// Settings, so it works while the package's views are off or broken. Normalised: a choice always
/// carries its options, a text setting its <see cref="MaxLength"/>, and a field the type does not
/// take is null.
/// </summary>
/// <param name="Type"><c>toggle</c>, <c>choice</c>, <c>number</c> or <c>text</c>.</param>
/// <param name="Default">The value used when no layer holds one: a boolean, an option's value, a number or text.</param>
/// <param name="Layers"><c>personal</c>, <c>shared</c> or <c>both</c>: where a value may be kept.</param>
public sealed record NendoPackageSettingDeclaration(
    string Id,
    string Title,
    string? Help,
    string Type,
    JsonElement Default,
    string Layers,
    IReadOnlyList<NendoPackageSettingOption>? Options,
    double? Min,
    double? Max,
    string? Unit,
    int? MaxLength);

/// <summary>
/// The rules a package's settings follow (ADR-0038), in one place, so the import that reads a
/// manifest, the operation that stores it, the operation that keeps a shared value and the host
/// that keeps a personal value agree on them.
/// </summary>
public static partial class NendoPackageSettings
{
    public const string Toggle = "toggle";
    public const string Choice = "choice";
    public const string Number = "number";
    public const string Text = "text";

    public const string Personal = "personal";
    public const string Shared = "shared";
    public const string Both = "both";

    /// <summary>The most settings one package declares.</summary>
    public const int Declarations = 64;

    public const int IdCharacters = 64;
    public const int TitleCharacters = 120;
    public const int HelpCharacters = 500;
    public const int MinimumOptions = 2;
    public const int MaximumOptions = 32;
    public const int OptionValueCharacters = 80;
    public const int OptionLabelCharacters = 120;
    public const int UnitCharacters = 24;

    /// <summary>The longest text a text setting may hold, and its <c>maxLength</c> when it names none.</summary>
    public const int TextCharacters = 1000;

    private static readonly string[] Types = [Toggle, Choice, Number, Text];
    private static readonly string[] LayerNames = [Personal, Shared, Both];

    [GeneratedRegex("^[a-z][A-Za-z0-9_.-]{0,63}\\z", RegexOptions.CultureInvariant)]
    private static partial Regex IdPattern();

    /// <summary>A lowercase letter, then at most 63 letters, digits and <c>_ . -</c>.</summary>
    public static bool ValidId(string? id) => id is { Length: >= 1 and <= IdCharacters } && IdPattern().IsMatch(id);

    /// <summary>Whether the file may keep a value for this setting.</summary>
    public static bool AllowsShared(NendoPackageSettingDeclaration declaration)
    {
        ArgumentNullException.ThrowIfNull(declaration);
        return declaration.Layers is Shared or Both;
    }

    /// <summary>Whether this computer may keep a value for this setting.</summary>
    public static bool AllowsPersonal(NendoPackageSettingDeclaration declaration)
    {
        ArgumentNullException.ThrowIfNull(declaration);
        return declaration.Layers is Personal or Both;
    }

    /// <summary>
    /// Reads a package's <c>settings</c>: a list of at most 64 declarations with unique IDs.
    /// Refuses the first one that breaks a rule, naming it and <paramref name="source"/>, the
    /// manifest or operation the list came from.
    /// </summary>
    public static IReadOnlyList<NendoPackageSettingDeclaration> Parse(JsonElement settings, string source)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(source);
        if (settings.ValueKind == JsonValueKind.Null) return [];
        if (settings.ValueKind != JsonValueKind.Array)
            throw new NendoValidationException($"settings in {source} is a list of setting declarations, each a JSON object.");
        var count = settings.GetArrayLength();
        if (count > Declarations)
            throw new NendoValidationException($"{source} declares {count} settings, and a package declares at most {Declarations}.");
        var declarations = new List<NendoPackageSettingDeclaration>(count);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var index = 0;
        foreach (var item in settings.EnumerateArray())
        {
            index++;
            var declaration = ParseOne(item, source, index);
            if (!ids.Add(declaration.Id))
                throw new NendoValidationException($"{source} declares the setting {declaration.Id} twice. Each setting's id is unique in its package.");
            declarations.Add(declaration);
        }
        return declarations.AsReadOnly();
    }

    /// <summary>
    /// Whether <paramref name="value"/> fits <paramref name="declaration"/>: its type, an option of
    /// a choice, the range of a number, the length of text. Null fits nothing: it is how a layer is
    /// cleared, never a value. <paramref name="reason"/> says why not, in the words
    /// <c>package.setSetting</c> refuses with.
    /// </summary>
    public static bool Fits(NendoPackageSettingDeclaration declaration, JsonElement value, out string? reason)
    {
        ArgumentNullException.ThrowIfNull(declaration);
        reason = Misfit(declaration, value);
        return reason is null;
    }

    private static string? Misfit(NendoPackageSettingDeclaration declaration, JsonElement value)
    {
        var id = declaration.Id;
        switch (declaration.Type)
        {
            case Toggle:
                return value.ValueKind is JsonValueKind.True or JsonValueKind.False
                    ? null
                    : $"The setting {id} is a toggle: its value is true or false.";
            case Choice:
            {
                var options = declaration.Options ?? [];
                var listed = string.Join(", ", options.Select(option => option.Value));
                if (value.ValueKind != JsonValueKind.String)
                    return $"The setting {id} is a choice: its value is one of {listed}.";
                var text = value.GetString()!;
                return options.Any(option => option.Value == text)
                    ? null
                    : $"The setting {id} is a choice of {listed}, and '{Shorten(text)}' is not one of them.";
            }
            case Number:
            {
                if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number))
                    return $"The setting {id} is a number{Range(declaration)}.";
                if (declaration.Min is { } min && number < min || declaration.Max is { } max && number > max)
                    return $"The setting {id} is a number{Range(declaration)}, and {Format(number)} is not.";
                return null;
            }
            case Text:
            {
                var limit = declaration.MaxLength ?? TextCharacters;
                if (value.ValueKind != JsonValueKind.String)
                    return $"The setting {id} is text of at most {limit} characters.";
                var length = value.GetString()!.Length;
                return length <= limit
                    ? null
                    : $"The setting {id} is text of at most {limit} characters, and this is {length}.";
            }
            default:
                return $"The setting {id} has the type {declaration.Type}, which this version of Nendo does not know.";
        }
    }

    private static string Range(NendoPackageSettingDeclaration declaration) => (declaration.Min, declaration.Max) switch
    {
        ({ } min, { } max) => $" from {Format(min)} to {Format(max)}",
        ({ } min, null) => $" of at least {Format(min)}",
        (null, { } max) => $" of at most {Format(max)}",
        _ => "",
    };

    private static string Format(double number) => number.ToString("R", CultureInfo.InvariantCulture);

    private static string Shorten(string text) => text.Length <= OptionValueCharacters ? text : text[..OptionValueCharacters] + "…";

    private static NendoPackageSettingDeclaration ParseOne(JsonElement item, string source, int index)
    {
        if (item.ValueKind != JsonValueKind.Object)
            throw new NendoValidationException($"Setting {index} in {source} is not a JSON object.");
        var rawId = item.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String ? idElement.GetString() : null;
        if (!ValidId(rawId))
            throw new NendoValidationException(rawId is null
                ? $"Setting {index} in {source} has no id. Give it one: a lowercase letter, then at most 63 letters, digits and _ . -."
                : $"Setting {index} in {source} has the id '{Shorten(rawId)}', and a setting's id is a lowercase letter, then at most 63 letters, digits and _ . -.");
        var id = rawId!;
        string Where() => $"The setting {id} in {source}";

        var type = OptionalText(item, "type", Where);
        if (type is null || !Types.Contains(type))
            throw new NendoValidationException($"{Where()} has {(type is null ? "no type" : $"the type '{Shorten(type)}'")}: it is one of {string.Join(", ", Types)}.");
        var allowed = new HashSet<string>(["id", "title", "help", "type", "default", "layers"], StringComparer.Ordinal);
        switch (type)
        {
            case Choice: allowed.Add("options"); break;
            case Number: allowed.UnionWith(["min", "max", "unit"]); break;
            case Text: allowed.Add("maxLength"); break;
        }
        foreach (var property in item.EnumerateObject())
        {
            if (!allowed.Contains(property.Name))
                throw new NendoValidationException($"{Where()} has the key {Shorten(property.Name)}, which a {type} setting does not take.");
        }

        var title = OptionalText(item, "title", Where);
        if (title is null || string.IsNullOrWhiteSpace(title) || title.Length > TitleCharacters)
            throw new NendoValidationException($"{Where()} needs a title of 1 to {TitleCharacters} characters.");
        var help = OptionalText(item, "help", Where);
        if (help is { Length: > HelpCharacters })
            throw new NendoValidationException($"{Where()} has help of {help.Length} characters, and a setting's help is at most {HelpCharacters}.");
        if (string.IsNullOrWhiteSpace(help)) help = null;
        var layers = OptionalText(item, "layers", Where);
        if (layers is null || !LayerNames.Contains(layers))
            throw new NendoValidationException($"{Where()} has {(layers is null ? "no layers" : $"the layers '{Shorten(layers)}'")}: they are one of {string.Join(", ", LayerNames)}.");

        IReadOnlyList<NendoPackageSettingOption>? options = null;
        double? min = null, max = null;
        string? unit = null;
        int? maxLength = null;
        switch (type)
        {
            case Choice:
                options = ParseOptions(item, Where);
                break;
            case Number:
                min = OptionalNumber(item, "min", Where);
                max = OptionalNumber(item, "max", Where);
                if (min is { } low && max is { } high && low > high)
                    throw new NendoValidationException($"{Where()} has a min of {Format(low)} above its max of {Format(high)}.");
                unit = OptionalText(item, "unit", Where);
                if (unit is { Length: > UnitCharacters })
                    throw new NendoValidationException($"{Where()} has a unit of {unit.Length} characters, and a unit is at most {UnitCharacters}.");
                if (string.IsNullOrWhiteSpace(unit)) unit = null;
                break;
            case Text:
                maxLength = TextCharacters;
                if (item.TryGetProperty("maxLength", out var length) && length.ValueKind != JsonValueKind.Null)
                {
                    if (length.ValueKind != JsonValueKind.Number || !length.TryGetInt32(out var parsed) || parsed is < 1 or > TextCharacters)
                        throw new NendoValidationException($"{Where()} has a maxLength that is not a whole number from 1 to {TextCharacters}.");
                    maxLength = parsed;
                }
                break;
        }

        if (!item.TryGetProperty("default", out var given) || given.ValueKind == JsonValueKind.Null)
            throw new NendoValidationException($"{Where()} needs a default: the value used until someone chooses another.");
        var declaration = new NendoPackageSettingDeclaration(id, title, help, type, given, layers, options, min, max, unit, maxLength);
        if (Misfit(declaration, given) is { } misfit)
            throw new NendoValidationException($"{Where()} has a default that does not fit it. {misfit}");
        return declaration with { Default = Element(CanonicalValue(given)) };
    }

    private static List<NendoPackageSettingOption> ParseOptions(JsonElement item, Func<string> where)
    {
        if (!item.TryGetProperty("options", out var list) || list.ValueKind != JsonValueKind.Array ||
            list.GetArrayLength() is < MinimumOptions or > MaximumOptions)
            throw new NendoValidationException(
                $"{where()} is a choice and needs options: {MinimumOptions} to {MaximumOptions} of {{ \"value\", \"label\" }}, each value unique.");
        var options = new List<NendoPackageSettingOption>();
        foreach (var option in list.EnumerateArray())
        {
            var value = option.ValueKind == JsonValueKind.Object && option.TryGetProperty("value", out var v) && v.ValueKind == JsonValueKind.String
                ? v.GetString()! : null;
            var label = option.ValueKind == JsonValueKind.Object && option.TryGetProperty("label", out var l) && l.ValueKind == JsonValueKind.String
                ? l.GetString()! : null;
            if (option.ValueKind != JsonValueKind.Object || option.EnumerateObject().Any(property => property.Name is not ("value" or "label")))
                throw new NendoValidationException($"{where()} has an option that is not {{ \"value\", \"label\" }}.");
            if (value is null || value.Length is < 1 or > OptionValueCharacters)
                throw new NendoValidationException($"{where()} has an option whose value is not 1 to {OptionValueCharacters} characters of text.");
            if (label is null || string.IsNullOrWhiteSpace(label) || label.Length > OptionLabelCharacters)
                throw new NendoValidationException($"{where()} has the option {Shorten(value)} without a label of 1 to {OptionLabelCharacters} characters.");
            if (options.Any(existing => existing.Value == value))
                throw new NendoValidationException($"{where()} has the option {Shorten(value)} twice. Each option's value is unique.");
            options.Add(new(value, label));
        }
        return options;
    }

    private static string? OptionalText(JsonElement item, string name, Func<string> where)
    {
        if (!item.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String)
            throw new NendoValidationException($"{where()} has a {name} that is not text.");
        return value.GetString();
    }

    private static double? OptionalNumber(JsonElement item, string name, Func<string> where)
    {
        if (!item.TryGetProperty(name, out var value) || value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number))
            throw new NendoValidationException($"{where()} has a {name} that is not a finite number.");
        return number;
    }

    /// <summary>The declarations as canonical JSON: an array of objects with their keys in order, absent fields left out.</summary>
    internal static string Canonical(IReadOnlyList<NendoPackageSettingDeclaration> declarations)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) Write(writer, declarations);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    internal static void Write(Utf8JsonWriter writer, IReadOnlyList<NendoPackageSettingDeclaration> declarations)
    {
        writer.WriteStartArray();
        foreach (var declaration in declarations) WriteDeclaration(writer, declaration);
        writer.WriteEndArray();
    }

    internal static string CanonicalDeclaration(NendoPackageSettingDeclaration declaration)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) WriteDeclaration(writer, declaration);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    private static void WriteDeclaration(Utf8JsonWriter writer, NendoPackageSettingDeclaration declaration)
    {
        writer.WriteStartObject();
        writer.WritePropertyName("default");
        WriteValue(writer, declaration.Default);
        if (declaration.Help is not null) writer.WriteString("help", declaration.Help);
        writer.WriteString("id", declaration.Id);
        writer.WriteString("layers", declaration.Layers);
        if (declaration.Max is { } max) writer.WriteNumber("max", max);
        if (declaration.MaxLength is { } maxLength) writer.WriteNumber("maxLength", maxLength);
        if (declaration.Min is { } min) writer.WriteNumber("min", min);
        if (declaration.Options is { } options)
        {
            writer.WriteStartArray("options");
            foreach (var option in options)
            {
                writer.WriteStartObject();
                writer.WriteString("label", option.Label);
                writer.WriteString("value", option.Value);
                writer.WriteEndObject();
            }
            writer.WriteEndArray();
        }
        writer.WriteString("title", declaration.Title);
        writer.WriteString("type", declaration.Type);
        if (declaration.Unit is not null) writer.WriteString("unit", declaration.Unit);
        writer.WriteEndObject();
    }

    /// <summary>A scalar value as stored and compared: a number as its shortest round-trip form.</summary>
    internal static string CanonicalValue(JsonElement value)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) WriteValue(writer, value);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    internal static void WriteValue(Utf8JsonWriter writer, JsonElement value)
    {
        switch (value.ValueKind)
        {
            case JsonValueKind.True: writer.WriteBooleanValue(true); break;
            case JsonValueKind.False: writer.WriteBooleanValue(false); break;
            case JsonValueKind.String: writer.WriteStringValue(value.GetString()); break;
            case JsonValueKind.Number: writer.WriteNumberValue(value.GetDouble()); break;
            default: writer.WriteNullValue(); break;
        }
    }

    /// <summary>Whether a value is one a layer can hold at all: text, a finite number, true or false.</summary>
    internal static bool IsScalar(JsonElement value) =>
        value.ValueKind is JsonValueKind.String or JsonValueKind.True or JsonValueKind.False ||
        value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number);

    internal static JsonElement Element(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    /// <summary>One stored declaration, or null when this version cannot read it, such as a type a newer Nendo added.</summary>
    internal static NendoPackageSettingDeclaration? TryRead(string json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return ParseOne(document.RootElement, "the file", 1);
        }
        catch (Exception exception) when (exception is JsonException or NendoValidationException)
        {
            return null;
        }
    }
}

/// <summary>
/// Keeps a view package's setting in the file, for everyone who opens it, or clears it so the
/// package's default is used (ADR-0038). Only a setting whose layers are <c>shared</c> or
/// <c>both</c> has a value in the file; a personal value is kept on each computer by the host.
/// </summary>
public sealed record SetPackageSettingOperation : NendoOperation
{
    public SetPackageSettingOperation(string operationId, string packageId, string settingId, JsonElement? value, long expectedDefinitionRevision)
        : base(operationId)
    {
        PackageId = NendoExtensionContent.ValidPackageId(packageId)
            ? packageId
            : throw new NendoValidationException($"Package ID '{packageId}' is not valid.");
        SettingId = NendoPackageSettings.ValidId(settingId)
            ? settingId
            : throw new NendoValidationException(
                $"'{settingId}' is not a setting id: a lowercase letter, then at most 63 letters, digits and _ . -.");
        if (value is { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } given)
        {
            if (!NendoPackageSettings.IsScalar(given))
                throw new NendoValidationException("A setting's value is text, a finite number, true or false, or null to clear it.");
            if (given.ValueKind == JsonValueKind.String && given.GetString()!.Length > NendoPackageSettings.TextCharacters)
                throw new NendoValidationException($"A setting's value is at most {NendoPackageSettings.TextCharacters} characters.");
            Value = NendoPackageSettings.Element(NendoPackageSettings.CanonicalValue(given));
        }
        if (expectedDefinitionRevision < 0) throw new NendoValidationException("The definition revision cannot be negative.");
        ExpectedDefinitionRevision = expectedDefinitionRevision;
    }

    public string PackageId { get; }
    public string SettingId { get; }

    /// <summary>The value the file keeps, or null to clear it so the package's default is used.</summary>
    public JsonElement? Value { get; }

    public long ExpectedDefinitionRevision { get; }
    public override string OperationType => "package.setSetting";
    public override NendoRevisionLane Lane => NendoRevisionLane.Definition;

    // Its undo puts back the value the evidence retained, including none.
    public override NendoReversibilityClass Reversibility => NendoReversibilityClass.ReversibleWithRetainedState;

    internal override void WritePayload(Utf8JsonWriter writer)
    {
        writer.WriteStartObject();
        writer.WriteNumber("expectedDefinitionRevision", ExpectedDefinitionRevision);
        writer.WriteString("packageId", PackageId);
        writer.WriteString("settingId", SettingId);
        writer.WritePropertyName("value");
        if (Value is { } value) NendoPackageSettings.WriteValue(writer, value);
        else writer.WriteNullValue();
        writer.WriteEndObject();
    }
}
