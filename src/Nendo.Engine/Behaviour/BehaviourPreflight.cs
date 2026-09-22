namespace Nendo.Engine;

/// <summary>
/// The cheap scan that runs before the parser is allowed to see the source.
/// <para>
/// The parser is recursive, so nesting is bounded here rather than by catching what
/// deep input does to it: a stack overflow is not a refusal, it is the end of the
/// process. Length and token count are bounded here for the same reason — they cap
/// what the parser will allocate before it allocates it.
/// </para>
/// <para>
/// It is deliberately approximate and deliberately conservative. It does not need to
/// agree with the grammar; it needs to be cheap and to reject more than the typed
/// walk would, never less.
/// </para>
/// </summary>
internal static class NendoBehaviourPreflight
{
    internal static void Check(string source, BehaviourBudget budget)
    {
        ArgumentNullException.ThrowIfNull(source);
        var limits = budget.Limits;
        budget.SpendWork();
        if (source.Length > limits.SourceLength)
            throw new NendoValidationException(
                $"A formula is limited to {limits.SourceLength} characters.");

        budget.SpendWork(source.Length);
        var items = 0;
        var depth = 0;
        var index = 0;
        while (index < source.Length)
        {
            var character = source[index];
            if (char.IsWhiteSpace(character)) { index++; continue; }

            if (character is '\'' or '"')
            {
                // One string literal is one item however long it is; its length is
                // already bounded by the source ceiling above.
                var quote = character;
                index++;
                while (index < source.Length && source[index] != quote)
                {
                    if (source[index] == '\\' && index + 1 < source.Length) index++;
                    index++;
                }
                if (index >= source.Length)
                    throw new NendoValidationException("A text value in this formula is missing its closing quote.");
                index++;
                Count();
                continue;
            }

            if (char.IsAsciiLetter(character) || character == '_')
            {
                while (index < source.Length &&
                       (char.IsAsciiLetterOrDigit(source[index]) || source[index] is '_' or '.'))
                {
                    index++;
                }
                Count();
                continue;
            }

            if (char.IsAsciiDigit(character))
            {
                while (index < source.Length && (char.IsAsciiDigit(source[index]) || source[index] == '.')) index++;
                Count();
                continue;
            }

            if (character is '(' or '[')
            {
                depth++;
                if (depth > limits.ParseDepth)
                    throw new NendoValidationException(
                        $"This formula nests more than {limits.ParseDepth} levels deep.");
                index++;
                Count();
                continue;
            }

            if (character is ')' or ']')
            {
                depth--;
                index++;
                Count();
                continue;
            }

            // Two-character operators are one item, so `<=` is not penalised against `<`.
            if (index + 1 < source.Length && TwoCharacterOperator(character, source[index + 1])) index += 2;
            else index++;
            Count();
        }

        if (items == 0)
            throw new NendoValidationException("A formula needs an expression.");

        void Count()
        {
            if (++items > limits.SyntaxItems)
                throw new NendoValidationException(
                    $"This formula has more than the {limits.SyntaxItems} parts a formula may contain.");
        }
    }

    private static bool TwoCharacterOperator(char first, char second) =>
        (first, second) is ('<', '=') or ('>', '=') or ('!', '=') or ('=', '=') or ('&', '&') or ('|', '|') or ('<', '>');
}
