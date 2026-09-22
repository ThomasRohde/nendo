# Nendo instructions for Claude Code

@AGENTS.md

The imported repository instructions are shared with Codex. For development
tasks, read `docs/dogfooding.md` and use the registered `nendo` MCP server for
the live work item, acceptance criteria, findings and check outcomes.

## Editing past the Bash limit

`AGENTS.md` explains why a Bash command over ~8 KB is silently truncated, and its
error message lies. In Claude Code the way around it is a patch script rather than
a heredoc:

1. **Write** the script to the session scratchpad directory with the Write tool,
   which has no size limit.
2. Run it with `python <path>` from the Bash tool.
3. Have the script `assert` the expected match count before replacing, write with
   `newline=''`, and print the CR count.

An anchored `str.replace` that asserts it matched exactly once is safer than a
regex, and the assertion is what turns a silent mis-edit into a stopped run. Use
this for anything repetitive, multi-file, or too long for one Edit — and keep
heredocs for content comfortably under ~6 KB.

## Large MCP reads

A resource read over ~30 KB is saved to a file and only its head is returned.
That is the intended path for `nendo://application/describe`: read it once and
then query the saved file, rather than re-reading the resource for each question.
`docs/dogfooding.md` lists the narrow resources to prefer when one fact is wanted.
