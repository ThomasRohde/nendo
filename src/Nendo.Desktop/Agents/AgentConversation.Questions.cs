using System.Globalization;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop;

/// <summary>One choice a question's field offers: the value sent, and the words shown.</summary>
internal sealed record AgentQuestionChoiceView(string Value, string Title);

/// <summary>
/// One field of a question the agent asks: its name in the answer, its words, and what it takes.
/// <c>Type</c> is <c>text</c>, <c>number</c>, <c>integer</c>, <c>boolean</c>, <c>choice</c>,
/// <c>choices</c>, or <c>unsupported</c> for one Nendo cannot show.
/// </summary>
internal sealed record AgentQuestionFieldView(
    string Name,
    string Title,
    string? Description,
    string Type,
    bool Required,
    string? Format = null,
    IReadOnlyList<AgentQuestionChoiceView>? Choices = null,
    double? Minimum = null,
    double? Maximum = null,
    int? MinLength = null,
    int? MaxLength = null,
    string? Default = null);

/// <summary>
/// The agent's structured questions (ACP <c>elicitation/create</c>), in form mode only
/// (ADR-0030): a message and a flat form, drawn as a card in the conversation. The host never
/// answers one by itself; it checks the person's answer against the form before the agent gets
/// it, and Stop, End or the connection's end answers it as cancelled. Link mode is not declared,
/// and a request in it, or in a mode Nendo does not know, is declined.
/// </summary>
internal sealed partial class AgentConversation
{
    internal const int MaximumQuestionFields = 16;
    internal const int MaximumQuestionChoices = 100;
    internal const int MaximumAnswerCharacters = 2_000;

    private sealed class PendingQuestion(TaskCompletionSource<object> answer, MutableEntry entry)
    {
        internal TaskCompletionSource<object> Answer { get; } = answer;
        internal MutableEntry Entry { get; } = entry;
    }

    private readonly Dictionary<string, PendingQuestion> _questions = new(StringComparer.Ordinal);

    private static object Declined() => new { action = "decline" };
    private static object QuestionCancelled() => new { action = "cancel" };

    private async Task<object?> AskQuestionAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        if (Text(parameters, "mode", 20) != "form" || !parameters.TryGetProperty("requestedSchema", out var schema) || schema.ValueKind != JsonValueKind.Object)
            return Declined();
        var message = Text(parameters, "message", MaximumNoticeCharacters) ?? string.Empty;
        var description = Text(schema, "description", MaximumNoticeCharacters);
        var fields = QuestionFields(schema);
        var pending = new PendingQuestion(new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously), null!);
        MutableEntry entry;
        long revision;
        lock (_sync)
        {
            if (_state == "ended") return QuestionCancelled();
            _openMessage = null;
            entry = Add("question", description is null ? message : message.Length == 0 ? description : $"{message}\n\n{description}");
            entry.Title = Text(schema, "title", MaximumNoticeTitleCharacters);
            entry.ToolCallId = Text(parameters, "toolCallId", 200);
            entry.Status = "waiting";
            entry.Fields = fields;
            pending = new PendingQuestion(pending.Answer, entry);
            _questions[entry.Id] = pending;
            revision = Touch();
        }
        Raise(revision);
        object answer;
        try
        {
            using var registration = cancellationToken.Register(() => pending.Answer.TrySetResult(QuestionCancelled()));
            answer = await pending.Answer.Task;
        }
        finally
        {
            lock (_sync) _questions.Remove(entry.Id);
        }
        return answer;
    }

    /// <summary>The form's fields, in the agent's order, at most sixteen.</summary>
    private static AgentQuestionFieldView[] QuestionFields(JsonElement schema)
    {
        if (!schema.TryGetProperty("properties", out var properties) || properties.ValueKind != JsonValueKind.Object) return [];
        var required = schema.TryGetProperty("required", out var list) && list.ValueKind == JsonValueKind.Array
            ? list.EnumerateArray().Where(name => name.ValueKind == JsonValueKind.String).Select(name => name.GetString()!).ToHashSet(StringComparer.Ordinal)
            : [];
        return properties.EnumerateObject()
            .Where(property => property.Name.Length is > 0 and <= 200 && property.Value.ValueKind == JsonValueKind.Object)
            .Take(MaximumQuestionFields)
            .Select(property => QuestionField(property.Name, property.Value, required.Contains(property.Name)))
            .ToArray();
    }

    private static AgentQuestionFieldView QuestionField(string name, JsonElement field, bool required)
    {
        // A field's words are the agent's text: any application handle in them is hidden.
        var title = Redact(Text(field, "title", 200) ?? name);
        var description = Text(field, "description", 500) is { } said ? Redact(said) : null;
        var type = Text(field, "type", 40);
        AgentQuestionFieldView Make(string kind) => new(name, title, description, kind, required);
        switch (type)
        {
            case "string":
                var choices = Choices(field, "enum", "oneOf");
                if (choices is not null) return Make("choice") with { Choices = choices, Default = Text(field, "default", 300) };
                var format = Text(field, "format", 20) is { } stated && stated is "email" or "uri" or "date" or "date-time" ? stated : null;
                return Make("text") with
                {
                    Format = format, MinLength = WholeNumber(field, "minLength"),
                    MaxLength = Math.Min(WholeNumber(field, "maxLength") ?? MaximumAnswerCharacters, MaximumAnswerCharacters),
                    Default = Text(field, "default", MaximumAnswerCharacters),
                };
            case "number":
            case "integer":
                return Make(type) with
                {
                    Minimum = Number(field, "minimum"), Maximum = Number(field, "maximum"),
                    Default = Number(field, "default")?.ToString(CultureInfo.InvariantCulture),
                };
            case "boolean":
                return Make("boolean") with
                {
                    Default = field.TryGetProperty("default", out var initial) && initial.ValueKind is JsonValueKind.True or JsonValueKind.False
                        ? (initial.ValueKind == JsonValueKind.True ? "true" : "false") : null,
                };
            case "array":
                var items = field.TryGetProperty("items", out var given) && given.ValueKind == JsonValueKind.Object ? given : default;
                var options = items.ValueKind == JsonValueKind.Object && (Text(items, "type", 40) is null or "string") ? Choices(items, "enum", "anyOf") : null;
                return options is null ? Make("unsupported") : Make("choices") with
                {
                    Choices = options, MinLength = WholeNumber(field, "minItems"), MaxLength = WholeNumber(field, "maxItems"),
                };
            default:
                // A future or custom field is never drawn as a known control.
                return Make("unsupported");
        }
    }

    /// <summary>A field's choices: plain values under <paramref name="plain"/>, or titled ones under <paramref name="titled"/>.</summary>
    private static AgentQuestionChoiceView[]? Choices(JsonElement field, string plain, string titled)
    {
        if (field.TryGetProperty(plain, out var values) && values.ValueKind == JsonValueKind.Array)
            return values.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.String)
                .Select(value => AcpConnection.Bounded(value.GetString()!, 300)).Distinct(StringComparer.Ordinal)
                .Take(MaximumQuestionChoices).Select(value => new AgentQuestionChoiceView(value, value)).ToArray();
        if (field.TryGetProperty(titled, out var options) && options.ValueKind == JsonValueKind.Array)
            return options.EnumerateArray().Where(option => option.ValueKind == JsonValueKind.Object && Text(option, "const", 300) is not null)
                .Select(option => new AgentQuestionChoiceView(Text(option, "const", 300)!, Redact(Text(option, "title", 200) ?? Text(option, "const", 200)!)))
                .DistinctBy(choice => choice.Value).Take(MaximumQuestionChoices).ToArray();
        return null;
    }

    private static int? WholeNumber(JsonElement field, string name) =>
        field.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) && number >= 0 ? number : null;

    private static double? Number(JsonElement field, string name) =>
        field.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var number) && double.IsFinite(number) ? number : null;

    /// <summary>
    /// The person's answer to a question: accept with what they filled in, decline, or cancel.
    /// An accepted answer is checked against the form; one Nendo cannot show is only declined.
    /// </summary>
    internal void Respond(string entryId, string action, JsonElement content)
    {
        PendingQuestion? question;
        lock (_sync)
        {
            if (!_questions.TryGetValue(entryId, out question))
                throw new NendoPreconditionException("agent-question-gone", "The agent is no longer waiting for that answer.");
        }
        var fields = question.Entry.Fields!;
        object answer;
        string said;
        switch (action)
        {
            case "accept":
                if (fields.Any(field => field.Type == "unsupported"))
                    throw new NendoValidationException("This question has a field Nendo cannot show. Decline it, or answer the agent in a message.");
                var values = Checked(fields, content);
                answer = new { action = "accept", content = values };
                said = values.Count == 0 ? "Answered"
                    : string.Join(" · ", fields.Where(field => values.ContainsKey(field.Name)).Select(field => $"{field.Title}: {Shown(field, values[field.Name])}"));
                break;
            case "decline":
                answer = Declined();
                said = "Declined";
                break;
            case "cancel":
                answer = QuestionCancelled();
                said = "Cancelled";
                break;
            default:
                throw new NendoValidationException("Answer with accept, decline or cancel.");
        }
        long revision;
        lock (_sync)
        {
            if (!_questions.Remove(entryId)) throw new NendoPreconditionException("agent-question-gone", "The agent is no longer waiting for that answer.");
            question.Entry.Status = action == "accept" ? "answered" : action == "decline" ? "declined" : "cancelled";
            question.Entry.Answer = AcpConnection.Bounded(said, MaximumNoticeCharacters);
            question.Entry.Revision = _revision + 1;
            revision = Touch();
        }
        Raise(revision);
        question.Answer.TrySetResult(answer);
    }

    /// <summary>Every open question answered as cancelled, its card said so. Called under the lock.</summary>
    private PendingQuestion[] CancelQuestionsLocked()
    {
        var open = _questions.Values.ToArray();
        foreach (var question in open)
        {
            question.Entry.Status = "cancelled";
            question.Entry.Answer = "Cancelled";
            question.Entry.Revision = _revision + 1;
        }
        _questions.Clear();
        return open;
    }

    /// <summary>The answer's values by field name, each the type its field takes and within its bounds.</summary>
    private static Dictionary<string, object> Checked(IReadOnlyList<AgentQuestionFieldView> fields, JsonElement content)
    {
        if (content.ValueKind is not (JsonValueKind.Object or JsonValueKind.Undefined or JsonValueKind.Null))
            throw new NendoValidationException("An answer's content is an object of field names to values.");
        var given = content.ValueKind == JsonValueKind.Object ? content.EnumerateObject().ToDictionary(item => item.Name, item => item.Value, StringComparer.Ordinal) : [];
        foreach (var name in given.Keys)
            if (!fields.Any(field => field.Name == name)) throw new NendoValidationException($"The question has no field {name}.");
        var values = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var field in fields)
        {
            if (!given.TryGetValue(field.Name, out var value) || value.ValueKind == JsonValueKind.Null
                || (value.ValueKind == JsonValueKind.String && value.GetString()!.Length == 0 && field.Type is "text" or "choice"))
            {
                if (field.Required) throw new NendoValidationException($"{field.Title} needs an answer.");
                continue;
            }
            values[field.Name] = field.Type switch
            {
                "text" => CheckedText(field, value),
                "choice" => value.ValueKind == JsonValueKind.String && field.Choices!.Any(choice => choice.Value == value.GetString())
                    ? value.GetString()! : throw new NendoValidationException($"Choose one of the answers offered for {field.Title}."),
                "choices" => CheckedChoices(field, value),
                "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False
                    ? value.ValueKind == JsonValueKind.True : throw new NendoValidationException($"{field.Title} is yes or no."),
                "integer" => CheckedNumber(field, value, whole: true),
                "number" => CheckedNumber(field, value, whole: false),
                _ => throw new NendoValidationException($"{field.Title} cannot be answered here."),
            };
        }
        return values;
    }

    private static string CheckedText(AgentQuestionFieldView field, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String) throw new NendoValidationException($"{field.Title} is text.");
        var text = value.GetString()!;
        if (text.Length > (field.MaxLength ?? MaximumAnswerCharacters)) throw new NendoValidationException($"{field.Title} is {field.MaxLength ?? MaximumAnswerCharacters} characters at most.");
        if (field.MinLength is { } least && text.Length < least) throw new NendoValidationException($"{field.Title} is {least} characters at least.");
        return text;
    }

    private static string[] CheckedChoices(AgentQuestionFieldView field, JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array) throw new NendoValidationException($"Choose answers for {field.Title} from those offered.");
        var chosen = value.EnumerateArray().Select(item => item.ValueKind == JsonValueKind.String ? item.GetString()! : null).ToArray();
        if (chosen.Any(item => item is null || !field.Choices!.Any(choice => choice.Value == item)) || chosen.Distinct().Count() != chosen.Length)
            throw new NendoValidationException($"Choose answers for {field.Title} from those offered, each once.");
        if (field.MinLength is { } least && chosen.Length < least) throw new NendoValidationException($"Choose at least {least} for {field.Title}.");
        if (field.MaxLength is { } most && chosen.Length > most) throw new NendoValidationException($"Choose at most {most} for {field.Title}.");
        return chosen!;
    }

    private static object CheckedNumber(AgentQuestionFieldView field, JsonElement value, bool whole)
    {
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number))
            throw new NendoValidationException($"{field.Title} is a number.");
        if (whole && (!value.TryGetInt64(out _) || number != Math.Floor(number))) throw new NendoValidationException($"{field.Title} is a whole number.");
        if (field.Minimum is { } least && number < least) throw new NendoValidationException($"{field.Title} is {least.ToString(CultureInfo.InvariantCulture)} at least.");
        if (field.Maximum is { } most && number > most) throw new NendoValidationException($"{field.Title} is {most.ToString(CultureInfo.InvariantCulture)} at most.");
        return whole ? value.GetInt64() : number;
    }

    private static string Shown(AgentQuestionFieldView field, object value) => value switch
    {
        bool yes => yes ? "Yes" : "No",
        string[] chosen => string.Join(", ", chosen.Select(item => field.Choices!.First(choice => choice.Value == item).Title)),
        string text when field.Type == "choice" => field.Choices!.First(choice => choice.Value == text).Title,
        IFormattable number => number.ToString(null, CultureInfo.InvariantCulture),
        _ => value.ToString() ?? string.Empty,
    };
}
