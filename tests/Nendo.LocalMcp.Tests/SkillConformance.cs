using System.Text.Json;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// The two Skills-extension rules MCP Inspector checked and the host broke: the URI segment
/// before <c>SKILL.md</c> is the frontmatter name (SEP-2640), and the served frontmatter is
/// YAML a real parser accepts. A plain scalar holding ": " or " #" is not, so a line whose
/// value is not quoted or a block must not hold either.
/// </summary>
internal static class SkillConformance
{
    internal static void AssertEntry(JsonElement entry, string markdown)
    {
        var uri = entry.GetProperty("uri").GetString()!;
        var name = entry.GetProperty("frontmatter").GetProperty("name").GetString();
        var segments = uri["skill://".Length..].Split('/');
        Assert.AreEqual("SKILL.md", segments[^1], uri);
        Assert.AreEqual(name, segments[^2], $"name-path-mismatch: the segment before SKILL.md in {uri} is not the frontmatter name.");

        var lines = markdown.Split('\n');
        Assert.AreEqual("---", lines[0], uri);
        foreach (var line in lines.Skip(1).TakeWhile(line => line != "---"))
        {
            if (line.Length == 0 || line[0] is ' ' or '\t' or '#') continue;
            var value = line[(line.IndexOf(':') + 1)..].Trim();
            if (value.Length == 0 || value[0] is '"' or '\'' or '|' or '>') continue;
            Assert.IsFalse(value.Contains(": ", StringComparison.Ordinal) || value.Contains(" #", StringComparison.Ordinal),
                $"frontmatter-unparsable: '{line}' in {uri} is a plain YAML scalar holding ': ' or ' #'; quote it.");
            Assert.IsFalse("-?:,[]{}&*!|>'\"%@`".Contains(value[0], StringComparison.Ordinal),
                $"frontmatter-unparsable: '{line}' in {uri} opens a plain YAML scalar with an indicator; quote it.");
        }
    }
}
