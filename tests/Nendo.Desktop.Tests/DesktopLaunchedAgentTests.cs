using System.Diagnostics;
using System.Text.Json;
using Nendo.Engine;

namespace Nendo.Desktop.Tests;

/// <summary>
/// ADR-0030: the Agent page launches the person's own agent program over ACP. What Nendo tells
/// the agent, when it may launch, how a conversation runs, and what ends it, measured against a
/// stand-in agent that records what it was told (TestFixtures/fake-acp-agent.mjs).
/// </summary>
[TestClass]
public sealed class DesktopLaunchedAgentTests
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(30);

    [TestMethod]
    public async Task TheAgentIsGivenTheFilesAddressAnEmptyFolderAndNothingElse()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        var launched = await fixture.LaunchAsync();
        Assert.AreEqual("starting", launched.State);
        var ready = await fixture.WaitAsync(view => view.State == "ready");

        var told = fixture.Log();
        var initialize = told.Single(entry => Method(entry) == "initialize").GetProperty("params");
        var capabilities = initialize.GetProperty("clientCapabilities");
        Assert.IsFalse(capabilities.GetProperty("fs").GetProperty("readTextFile").GetBoolean(), "The agent was offered Nendo's file reads.");
        Assert.IsFalse(capabilities.GetProperty("fs").GetProperty("writeTextFile").GetBoolean(), "The agent was offered Nendo's file writes.");
        Assert.IsFalse(capabilities.GetProperty("terminal").GetBoolean(), "The agent was offered Nendo's terminal.");

        var session = told.Single(entry => Method(entry) == "session/new").GetProperty("params");
        var servers = session.GetProperty("mcpServers").EnumerateArray().ToArray();
        Assert.HasCount(1, servers, "The agent was named more than one MCP server.");
        Assert.AreEqual("http", servers[0].GetProperty("type").GetString());
        var status = await fixture.Controller.GetAgentStatusAsync();
        Assert.AreEqual(status.Endpoint, servers[0].GetProperty("url").GetString(), "The MCP server named is not this file's address.");
        Assert.AreEqual(status.Endpoint, ready.Endpoint);
        Assert.AreEqual("Edit data", ready.Level);

        var started = told.Single(entry => entry.TryGetProperty("started", out _));
        var cwd = started.GetProperty("cwd").GetString()!;
        Assert.AreEqual(Path.GetFullPath(session.GetProperty("cwd").GetString()!), Path.GetFullPath(cwd), "The agent runs somewhere other than the folder it was told.");
        Assert.AreEqual(0, started.GetProperty("cwdEntries").GetArrayLength(), "The agent's working folder was not empty.");
        Assert.IsFalse(PathsOverlap(cwd, Path.GetDirectoryName(fixture.FilePath)!), "The agent was started in or around the file's own folder.");
    }

    [TestMethod]
    public async Task ChosenForThisFileTheAgentStartsInTheFilesRepositoryAndNendoNeverRemovesIt()
    {
        // ADR-0030: the person may start the agent where it picks up the repository's own
        // instructions and skills. Nendo made none of that folder, so it never removes any of it.
        await using var fixture = await Fixture.StartAsync("editData");
        var repository = Path.GetDirectoryName(fixture.FilePath)!;
        Directory.CreateDirectory(Path.Combine(repository, ".git"));
        var instructions = Path.Combine(repository, "AGENTS.md");
        File.WriteAllText(instructions, "Use the file's skill.");
        var before = await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId);
        Assert.IsFalse(before.StartInRepository, "A file's agent started in its repository before anyone chose it.");
        Assert.AreEqual(repository, before.RepositoryFolder);

        var chosen = await fixture.Controller.SetAgentStartInRepositoryAsync(fixture.FileSessionId, true);
        Assert.IsTrue(chosen.StartInRepository);
        Assert.IsTrue(new DesktopAgentLaunchStore(fixture.DeviceRoot).StartsInRepository(fixture.FilePath), "The choice was not kept on the device.");
        await fixture.LaunchAsync();
        var ready = await fixture.WaitAsync(view => view.State == "ready");
        Assert.AreEqual(repository, ready.WorkingFolder);
        var started = fixture.Log().Last(entry => entry.TryGetProperty("started", out _));
        Assert.AreEqual(Path.GetFullPath(repository), Path.GetFullPath(started.GetProperty("cwd").GetString()!), "The agent did not start in the file's repository.");
        var told = fixture.Log().Last(entry => Method(entry) == "session/new").GetProperty("params");
        Assert.AreEqual(Path.GetFullPath(repository), Path.GetFullPath(told.GetProperty("cwd").GetString()!), "The agent was told another folder than it runs in.");

        await fixture.Controller.EndLaunchedAgentAsync(fixture.FileSessionId, 0);
        Assert.IsTrue(File.Exists(instructions) && File.Exists(fixture.FilePath) && Directory.Exists(Path.Combine(repository, ".git")),
            "Ending the agent removed something from the file's repository.");

        await fixture.Controller.SetAgentStartInRepositoryAsync(fixture.FileSessionId, false);
        await fixture.LaunchAsync();
        var again = await fixture.WaitAsync(view => view.State == "ready");
        Assert.IsNull(again.WorkingFolder);
        var empty = fixture.Log().Last(entry => entry.TryGetProperty("started", out _)).GetProperty("cwd").GetString()!;
        Assert.IsFalse(PathsOverlap(empty, repository), "Chosen back, the agent still started in the repository.");
    }

    [TestMethod]
    public void TheRepositoryIsTheNearestFolderAboveTheFileThatHoldsGit()
    {
        var root = Directory.CreateTempSubdirectory("nendo-repository-");
        try
        {
            var workspace = Directory.CreateDirectory(Path.Combine(root.FullName, "repo", "workspace")).FullName;
            var file = Path.Combine(workspace, "Planner.nendo");
            Assert.AreEqual(workspace, DesktopSessionController.RepositoryFolderOf(file), "Without .git, the file's own folder.");
            Directory.CreateDirectory(Path.Combine(root.FullName, "repo", ".git"));
            Assert.AreEqual(Path.Combine(root.FullName, "repo"), DesktopSessionController.RepositoryFolderOf(file), "A repository folder holding .git was missed.");
            File.WriteAllText(Path.Combine(workspace, ".git"), "gitdir: ../../elsewhere");
            Assert.AreEqual(workspace, DesktopSessionController.RepositoryFolderOf(file), "A worktree's .git file was missed.");
        }
        finally
        {
            root.Delete(recursive: true);
        }
    }

    [TestMethod]
    public async Task AnAgentThatCannotReachHttpMcpIsRefusedByName()
    {
        await using var fixture = await Fixture.StartAsync("inspect", "--no-http");
        await fixture.LaunchAsync();
        var ended = await fixture.WaitAsync(view => view.State == "ended");
        StringAssert.Contains(ended.Notice, "does not connect to MCP servers over HTTP");
        Assert.IsFalse(fixture.Log().Any(entry => Method(entry) == "session/new"), "A session was opened with an agent that cannot reach the file.");
    }

    [TestMethod]
    public async Task AnAgentThatRefusesToStartSaysWhy()
    {
        // claude-agent-acp 0.23.1 answered session/new with "Internal error" and its reason, a
        // settings value it did not know, only in data.details; the owner saw no reason.
        await using var fixture = await Fixture.StartAsync("inspect", "--refuse-session");
        await fixture.LaunchAsync();
        var ended = await fixture.WaitAsync(view => view.State == "ended");
        StringAssert.Contains(ended.Notice, "refused to start: Internal error: Invalid permissions.defaultMode: auto.");
    }

    [TestMethod]
    public async Task AnAgentSpeakingAnotherProtocolVersionIsRefusedByName()
    {
        await using var fixture = await Fixture.StartAsync("inspect", "--version", "2");
        await fixture.LaunchAsync();
        var ended = await fixture.WaitAsync(view => view.State == "ended");
        StringAssert.Contains(ended.Notice, "speaks ACP version 2");
    }

    /// <summary>
    /// A refusal at the handshake ended the conversation but not
    /// the program, which kept its input open and ran on with its folder until the file closed.
    /// </summary>
    [TestMethod]
    [DataRow("--no-http")]
    [DataRow("--refuse-session")]
    public async Task AnAgentRefusedAtTheHandshakeIsEndedWithItsFolder(string flag)
    {
        await using var fixture = await Fixture.StartAsync("inspect", flag);
        await fixture.LaunchAsync();
        var agent = fixture.Controller.LaunchedAgent!;
        await fixture.WaitAsync(view => view.State == "ended");
        await WaitUntil(() => !IsRunning(agent.ProcessId), $"The agent refused with {flag} kept running after its conversation ended.");
        await WaitUntil(() => !Directory.Exists(agent.WorkingDirectory), $"The agent refused with {flag} left its folder behind.");
        Assert.IsNull((await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId)).Running);
    }

    [TestMethod]
    public async Task LaunchIsOfferedFromInspectUpAndRefusedAtOff()
    {
        await using var fixture = await Fixture.StartAsync("off");
        var offered = await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId);
        Assert.IsFalse(offered.CanLaunch, "Launch was offered with agent access off.");
        StringAssert.Contains(offered.Reason, "Inspect");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => fixture.LaunchAsync());
        Assert.AreEqual("agent-launch-unavailable", refused.Code);

        await fixture.Controller.SetAgentModeAsync("inspect");
        Assert.IsTrue((await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId)).CanLaunch, "Launch was not offered at Inspect.");
        Assert.IsTrue((await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId)).Agents.Any(agent => agent.Id == "custom" && agent.Found));
    }

    [TestMethod]
    public async Task APromptIsAnsweredInTheTranscript()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "hello there", 0);
        var answered = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent"));
        Assert.AreEqual("hello there", answered.Entries.Single(entry => entry.Kind == "you").Text);
        Assert.AreEqual("You said: hello there", answered.Entries.Single(entry => entry.Kind == "agent").Text, "Two chunks did not make one message.");
    }

    [TestMethod]
    public async Task ToolCallsAndThePlanAreKeptAsTextAndUpdatedInPlace()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "tool", 0);
        var done = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "tool" && entry.Status == "completed"));
        var tool = done.Entries.Single(entry => entry.Kind == "tool");
        Assert.AreEqual("nendo.read.resource", tool.Title);
        Assert.AreEqual("<b>three</b> record types", tool.Text, "The tool's output was not kept as the text it was.");
        Assert.AreEqual("Read the schema", done.Entries.Single(entry => entry.Kind == "plan").Plan!.Single().Text);

        // A reader that already holds the latest revision is sent nothing again.
        var later = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, done.Revision);
        Assert.IsEmpty(later.Entries);
    }

    /// <summary>
    /// Copilot CLI sends the agent's application handle with every owned call, so a permission card
    /// could show it. The tab may say it was sent, never what it was.
    /// </summary>
    [TestMethod]
    public async Task TheAgentsApplicationHandleIsNeverShown()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "handle", 0);
        var asking = await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission"));
        var shown = string.Join("\n", asking.Entries.SelectMany(entry => new[] { entry.Text, entry.Input, entry.Title }).Where(text => text is not null));
        Assert.DoesNotContain("secret-handle-0123456789", shown, "The agent's application handle reached the tab.");
        // Sent by the tool call, returned plain, returned inside an escaped string, and asked about.
        Assert.AreEqual(4, System.Text.RegularExpressions.Regex.Count(shown, @"Handle\\?"":\\?""\(hidden\)"), shown);
        StringAssert.Contains(asking.Entries.Single(entry => entry.Kind == "permission").Input, "lease-1", "More than the handle was hidden.");
    }

    /// <summary>
    /// Only tool payloads were redacted. A handle the agent repeats
    /// in its reply (split across two chunks), its reasoning, its plan, a tool's title or its last
    /// words on stderr reached the tab.
    /// </summary>
    [TestMethod]
    public async Task AHandleTheAgentRepeatsIsHiddenInEveryPartOfTheTranscript()
    {
        const string Secret = "0123456789";
        Assert.AreEqual("{\"applicationHandle\":\"(hidden)", AgentConversation.Redact("{\"applicationHandle\":\"secret-han"),
            "The start of a handle still streaming was shown.");
        Assert.AreEqual("applicationHandle: (hidden)", AgentConversation.Redact(AgentConversation.Redact("applicationHandle: abc")), "Hiding twice changed the text.");
        // A handle this process granted is hidden by its value, however the agent words it.
        var minted = Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        Nendo.LocalMcp.NendoMintedHandles.Remember(minted);
        foreach (var said in new[] { $"Your applicationHandle is {minted}", $"| applicationHandle | {minted} |", $"Keep {minted} private." })
            Assert.AreEqual(said.Replace(minted, "(hidden)"), AgentConversation.Redact(said), "A granted handle in the agent's own words was shown.");

        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "leak", 0);
        var done = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "tool"));
        static string Shown(DesktopLaunchedAgentView view) => string.Join("\n", view.Entries.SelectMany(entry =>
            new[] { entry.Text, entry.Title, entry.Input }.Concat(entry.Plan?.Select(item => item.Text) ?? [])).Where(text => text is not null).Append(view.Notice));
        Assert.DoesNotContain(Secret, Shown(done), "The agent's application handle reached the tab.");
        foreach (var kind in new[] { "agent", "thought", "plan", "tool" })
        {
            var entry = done.Entries.Single(candidate => candidate.Kind == kind);
            var text = kind == "plan" ? entry.Plan!.Single().Text : kind == "tool" ? entry.Title! : entry.Text;
            StringAssert.Contains(text, "(hidden)", $"The {kind} entry does not say a handle was there.");
        }
        StringAssert.Contains(done.Entries.Single(entry => entry.Kind == "agent").Text, "\"leaseId\":\"lease-2\"", "More than the handle was hidden.");

        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "leak-exit", 0);
        var ended = await fixture.WaitAsync(view => view.State == "ended");
        Assert.DoesNotContain(Secret, Shown(ended), "The handle the agent wrote to stderr reached the tab.");
        StringAssert.Contains(ended.Notice, "(hidden)");
    }

    /// <summary>
    /// A permission request that described its operation only by a
    /// diff and a location showed Allow and Reject with nothing to inspect, and a diff was told
    /// only as "Changed path".
    /// </summary>
    [TestMethod]
    public async Task APermissionShowsTheChangeTheAgentSupplied()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "diff", 0);
        var asking = await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission"));
        var question = asking.Entries.Single(entry => entry.Kind == "permission");
        Assert.AreEqual("Edit configuration", question.Title);
        Assert.IsNull(question.Input, "The request sent no input; the card would show one.");
        StringAssert.Contains(question.Text, "C:/work/config.json", "The permission card does not say what it changes.");
        StringAssert.Contains(question.Text, "retries = 1", "The permission card does not show the text before.");
        StringAssert.Contains(question.Text, "retries = 5", "The permission card does not show the text after.");
        StringAssert.Contains(question.Text, "C:/work/config.json:3", "The permission card does not say where.");
        var written = asking.Entries.Single(entry => entry.Kind == "tool" && entry.Title == "Write notes");
        StringAssert.Contains(written.Text, "Creates C:/work/notes.md");
        StringAssert.Contains(written.Text, "first <b>note</b>", "A diff-only tool update lost its text.");
        fixture.Controller.AnswerLaunchedAgent(fixture.FileSessionId, question.Id, "reject", 0);
        await fixture.WaitAsync(view => !view.Working);
    }

    /// <summary>A shell command was badged Nendo because its input printed a nendo:// address.</summary>
    [TestMethod]
    public async Task AShellCommandThatMentionsNendoIsStillTheAgentsOwn()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "shell", 0);
        var done = await fixture.WaitAsync(view => !view.Working && view.Entries.Count(entry => entry.Kind == "tool") == 3);
        string? OriginOf(string title) => done.Entries.Single(entry => entry.Kind == "tool" && entry.Title == title).Origin;
        Assert.AreEqual("agent", OriginOf("Run shell command"), "A shell whose input names nendo:// was told as Nendo's.");
        Assert.AreEqual("agent", OriginOf("echo nendo://application/manifest"), "A shell whose title names nendo:// was told as Nendo's.");
        Assert.AreEqual("nendo", OriginOf("Read the manifest"), "A tool the agent's metadata names as Nendo's was told as its own.");
    }

    /// <summary>
    /// The transcript keeps 1,000 entries, but a tab that read from
    /// the start was never told which ones had gone, and kept them all.
    /// </summary>
    [TestMethod]
    public async Task TheTabIsToldWhichEntriesTheTranscriptStillKeeps()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "flood", 0);
        var first = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0);
        var held = first.Entries.ToDictionary(entry => entry.Id);
        await fixture.WaitAsync(view => !view.Working);
        // Follow as the tab does: only what changed since the last read, page by page.
        DesktopLaunchedAgentView page;
        var after = first.Revision;
        do
        {
            page = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, after);
            foreach (var entry in page.Entries) held[entry.Id] = entry;
            after = page.Revision;
        }
        while (page.More);
        Assert.IsGreaterThan(1L, page.FirstOrder, "The read does not say the oldest entries are gone.");
        Assert.AreEqual(AgentConversation.MaximumEntries, held.Values.Count(entry => entry.Order >= page.FirstOrder),
            "The entries at or after the first order kept are not the transcript's.");
        Assert.IsTrue(held.Values.Any(entry => entry.Kind == "you" && entry.Order < page.FirstOrder), "The person's message was expected to have gone first.");
    }

    /// <summary>
    /// Entry IDs start again with every launch, so an answer meant
    /// for a replaced conversation's question could land on the new one's.
    /// </summary>
    [TestMethod]
    public async Task ARequestMeantForAReplacedConversationIsRefused()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        var launched = await fixture.LaunchAsync();
        Assert.IsNotNull(launched.ConversationId);
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "permission", 0, conversationId: launched.ConversationId);
        var old = (await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission"))).Entries.Single(entry => entry.Kind == "permission");
        await fixture.Controller.EndLaunchedAgentAsync(fixture.FileSessionId, 0, launched.ConversationId);

        var replacement = await fixture.LaunchAsync();
        Assert.AreNotEqual(launched.ConversationId, replacement.ConversationId, "Two launches carry the same conversation.");
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "permission", 0);
        var current = (await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission"))).Entries.Single(entry => entry.Kind == "permission");
        Assert.AreEqual(old.Id, current.Id, "The case this guards needs the two questions to share an entry ID.");

        var refused = Assert.ThrowsExactly<NendoPreconditionException>(() =>
            fixture.Controller.AnswerLaunchedAgent(fixture.FileSessionId, old.Id, "allow", 0, launched.ConversationId));
        Assert.AreEqual("agent-conversation-replaced", refused.Code);
        Assert.ThrowsExactly<NendoPreconditionException>(() =>
            fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "hello", 0, conversationId: launched.ConversationId));
        Assert.IsNull(fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0).Entries.Single(entry => entry.Kind == "permission").Answer,
            "The replaced conversation's answer reached the new question.");
        fixture.Controller.AnswerLaunchedAgent(fixture.FileSessionId, current.Id, "reject", 0, replacement.ConversationId);
        await fixture.WaitAsync(view => !view.Working);
    }

    [TestMethod]
    public async Task APermissionRequestWaitsForThePersonsAnswer()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "permission", 0);
        var asking = await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission"));
        var question = asking.Entries.Single(entry => entry.Kind == "permission");
        Assert.AreEqual("Write the record", question.Title);
        CollectionAssert.AreEqual(new[] { "allow", "reject" }, question.Options!.Select(option => option.OptionId).ToArray());
        await Task.Delay(500);
        Assert.IsFalse(fixture.Log().Any(entry => entry.TryGetProperty("permission", out _)), "The request was answered without the person.");
        Assert.IsTrue(fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0).Working);

        Assert.ThrowsExactly<NendoValidationException>(() => fixture.Controller.AnswerLaunchedAgent(fixture.FileSessionId, question.Id, "allow_always", 0));
        fixture.Controller.AnswerLaunchedAgent(fixture.FileSessionId, question.Id, "reject", 0);
        var answered = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent"));
        Assert.AreEqual("The person selected reject.", answered.Entries.Single(entry => entry.Kind == "agent").Text);
        Assert.AreEqual("Reject", answered.Entries.Single(entry => entry.Kind == "permission").Answer);
    }

    [TestMethod]
    public async Task StopCancelsTheTurnAndAnyQuestionOpenInIt()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "wait", 0);
        await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "agent"));
        Assert.ThrowsExactly<NendoPreconditionException>(() => fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "again", 0));
        await fixture.Controller.CancelLaunchedAgentTurnAsync(fixture.FileSessionId, 0);
        var stopped = await fixture.WaitAsync(view => !view.Working);
        Assert.AreEqual("Stopped.", stopped.Entries.Last().Text);
        Assert.AreEqual("ready", stopped.State, "Stopping a turn ended the conversation.");

        // A question open when the person stops is answered cancelled, as ACP asks, so
        // the agent's request does not wait for ever. The turn above never had one open.
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "permission", 0);
        await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission"));
        await fixture.Controller.CancelLaunchedAgentTurnAsync(fixture.FileSessionId, 0);
        var ended = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent" && entry.Text == "The person cancelled."));
        Assert.AreEqual("Cancelled", ended.Entries.Single(entry => entry.Kind == "permission").Answer, "Stop left the open question unanswered.");
        Assert.AreEqual("cancelled", fixture.Log().Single(entry => entry.TryGetProperty("permission", out _))
            .GetProperty("permission").GetProperty("outcome").GetProperty("outcome").GetString(), "The agent was not told its question was cancelled.");
        Assert.AreEqual("ready", ended.State);
    }

    [TestMethod]
    public async Task AViewsMessageIsMarkedAndItsOwnTurnIsReadBackWhole()
    {
        // ADR-0033: a view hears the reply of its own turn, not the conversation's.
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var first = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "first", 0).TurnId!;
        await fixture.WaitAsync(view => !view.Working);
        var sent = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "hello there", 0, from: "Lens");
        Assert.IsNotNull(sent.TurnId);
        Assert.AreNotEqual(first, sent.TurnId, "Two turns shared an ID.");
        var turn = await WaitForTurnAsync(fixture, sent.TurnId);
        Assert.AreEqual("You said: hello there", turn.Reply, "The reply carried more, or less, than its own turn.");
        Assert.AreEqual("end_turn", turn.StopReason);
        var view = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0);
        Assert.AreEqual("Lens", view.Entries.Single(entry => entry.Kind == "you" && entry.Text == "hello there").From, "The transcript did not say which view sent it.");
        Assert.IsNull(view.Entries.Single(entry => entry.Kind == "you" && entry.Text == "first").From, "The person's own message was marked as a view's.");
        Assert.AreEqual("You said: first", fixture.Controller.ReadLaunchedAgentTurn(fixture.FileSessionId, first).Reply);
        Assert.AreEqual("agent-turn-gone",
            Assert.ThrowsExactly<NendoPreconditionException>(() => fixture.Controller.ReadLaunchedAgentTurn(fixture.FileSessionId, "t99")).Code);

        // A stopped turn says so, and a turn the conversation's end overtook says that.
        var stopped = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "wait", 0, from: "Lens").TurnId!;
        await fixture.WaitAsync(current => current.Entries.Any(entry => entry.Kind == "agent" && entry.Text == "Working…"));
        await fixture.Controller.CancelLaunchedAgentTurnAsync(fixture.FileSessionId, 0);
        Assert.AreEqual("cancelled", (await WaitForTurnAsync(fixture, stopped)).StopReason);
        var overtaken = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "wait", 0, from: "Lens").TurnId!;
        await fixture.WaitAsync(current => current.Working);
        await fixture.Controller.EndLaunchedAgentAsync(fixture.FileSessionId, 0);
        Assert.AreEqual("ended", (await WaitForTurnAsync(fixture, overtaken)).StopReason);
    }

    [TestMethod]
    public async Task ViewsMessagesWaitInOrderWithinTheirBoundsAndStopDropsThem()
    {
        // ACP runs one turn at a time: a view's message during a turn waits for it (ADR-0033).
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var running = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "wait", 0, from: "Lens").TurnId!;
        await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Text == "Working…"));
        var first = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "one", 0, from: "Lens").TurnId!;
        var other = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "two", 0, from: "Garden").TurnId!;
        var dropped = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "three", 0, from: "Lens");
        Assert.AreEqual(3, dropped.Queued);
        Assert.AreEqual("agent-working", Assert.ThrowsExactly<NendoPreconditionException>(
            () => fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "four", 0, from: "Lens")).Code, "One view had more than two messages waiting.");
        Assert.AreEqual("agent-working", Assert.ThrowsExactly<NendoPreconditionException>(
            () => fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "mine", 0)).Code, "The person's own message was queued rather than refused.");
        Assert.IsFalse(fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0).Entries.Any(entry => entry.Text == "one"),
            "A waiting message entered the transcript before its turn.");

        // A view's cancel drops its own waiting message and nothing else.
        await fixture.Controller.CancelLaunchedAgentTurnAsync(fixture.FileSessionId, 0, turnId: dropped.TurnId);
        Assert.AreEqual("cancelled", fixture.Controller.ReadLaunchedAgentTurn(fixture.FileSessionId, dropped.TurnId!).StopReason);
        Assert.IsTrue(fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0).Working, "Dropping a waiting message stopped the running turn.");

        // Ending the running turn sends the next ones, in the order they came.
        await fixture.Controller.CancelLaunchedAgentTurnAsync(fixture.FileSessionId, 0, turnId: running);
        Assert.AreEqual("cancelled", (await WaitForTurnAsync(fixture, running)).StopReason);
        Assert.AreEqual("You said: one", (await WaitForTurnAsync(fixture, first)).Reply);
        Assert.AreEqual("You said: two", (await WaitForTurnAsync(fixture, other)).Reply);
        var said = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0).Entries.Where(entry => entry.Kind == "you").Select(entry => entry.Text).ToArray();
        CollectionAssert.AreEqual(new[] { "wait", "one", "two" }, said);

        // The person's Stop drops whatever still waits.
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "wait", 0);
        await fixture.WaitAsync(view => view.Entries.Count(entry => entry.Text == "Working…") == 2);
        var waiting = fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "five", 0, from: "Lens").TurnId!;
        await fixture.Controller.CancelLaunchedAgentTurnAsync(fixture.FileSessionId, 0);
        Assert.AreEqual("cancelled", fixture.Controller.ReadLaunchedAgentTurn(fixture.FileSessionId, waiting).StopReason);
        var after = await fixture.WaitAsync(view => !view.Working);
        Assert.AreEqual(0, after.Queued);
        Assert.IsFalse(after.Entries.Any(entry => entry.Text == "five"), "A message dropped by Stop was sent anyway.");
    }

    [TestMethod]
    public async Task ViewsSetToNeverAreRefusedAndThePersonIsNot()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        var before = await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId);
        Assert.AreEqual("ask", before.ViewAccess, "Views were not asked about by default.");
        Assert.IsNull(before.LastAgentId);
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var chosen = await fixture.Controller.SetAgentViewAccessAsync(fixture.FileSessionId, "never");
        Assert.AreEqual("never", chosen.ViewAccess);
        Assert.AreEqual(DesktopAgentCatalog.CustomId, chosen.LastAgentId, "The agent launched was not remembered for a view's card.");
        Assert.AreEqual("never", new DesktopAgentLaunchStore(fixture.DeviceRoot).ViewAccess, "The choice was not kept on the device.");
        var refused = Assert.ThrowsExactly<NendoPreconditionException>(() => fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "hello", 0, from: "Lens"));
        Assert.AreEqual("assistant-off", refused.Code);
        Assert.IsFalse(fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0).Entries.Any(entry => entry.Kind == "you"), "A refused view's message reached the transcript.");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "hello", 0);
        await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent"));
        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => fixture.Controller.SetAgentViewAccessAsync(fixture.FileSessionId, "sometimes"));
    }

    private static async Task<AgentTurnView> WaitForTurnAsync(Fixture fixture, string turnId)
    {
        var deadline = DateTime.UtcNow + Patience;
        while (true)
        {
            var turn = fixture.Controller.ReadLaunchedAgentTurn(fixture.FileSessionId, turnId);
            if (turn.Done) return turn;
            if (DateTime.UtcNow > deadline) Assert.Fail($"Turn {turnId} never ended.");
            await Task.Delay(50);
        }
    }

    [TestMethod]
    public async Task ClosingTheFileEndsTheAgentEverythingItStartedAndItsFolder()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var agent = fixture.Controller.LaunchedAgent!;
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "spawn", 0);
        await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent"));
        var spawned = fixture.Log().Single(entry => entry.TryGetProperty("child", out _));
        var child = spawned.GetProperty("child").GetInt32();
        Assert.IsTrue(IsRunning(child), "The agent's child did not start.");

        await fixture.Controller.CloseAsync();
        Assert.IsNull(fixture.Controller.LaunchedAgent, "The conversation outlived its file.");
        await WaitUntil(() => !IsRunning(agent.ProcessId) && !IsRunning(child), "The agent or its child outlived the file.");
        Assert.IsFalse(Directory.Exists(agent.WorkingDirectory), "The agent's working folder was left behind.");
    }

    [TestMethod]
    public async Task AnotherLevelKeepsTheAgentAndOffEndsIt()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        // This file keeps a port of its own, so a new level restarts the listener at the same address.
        await fixture.Controller.SetAgentSettingsAsync(false, 60, true, FreePort());
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var endpoint = (await fixture.Controller.GetAgentStatusAsync()).Endpoint;

        // The tab shows the level and its review policy, and was
        // not told when the level changed under an idle agent.
        var told = 0;
        fixture.Controller.LaunchedAgentChanged += _ => Interlocked.Increment(ref told);
        await fixture.Controller.SetAgentModeAsync("shapeApp");
        Assert.IsGreaterThan(0, Volatile.Read(ref told), "The tab was not told the level changed; it would go on showing Edit data.");
        Assert.AreEqual(endpoint, (await fixture.Controller.GetAgentStatusAsync()).Endpoint);
        var kept = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0);
        Assert.AreEqual("ready", kept.State, "A new level ended an agent whose address had not moved.");
        Assert.AreEqual("Shape app", kept.Level);

        await fixture.Controller.SetAgentModeAsync("off");
        var ended = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0);
        Assert.AreEqual("ended", ended.State, "Turning agent access off left the agent running.");
        StringAssert.Contains(ended.Notice, "Agent access was turned off");
        Assert.IsTrue(ended.Entries.Any(entry => entry.Kind == "notice"), "The transcript does not say why it ended.");
    }

    [TestMethod]
    public async Task AnAddressThatMovesEndsTheAgentAndSaysWhere()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        // Without a fixed port every start takes a new one, so the agent is stranded on the old.
        await fixture.Controller.SetAgentSettingsAsync(false, 60, false, 41763);
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        await fixture.Controller.SetAgentModeAsync("shapeApp");
        var moved = fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0);
        Assert.AreEqual("ended", moved.State, "An agent stranded on an old address was left running.");
        StringAssert.Contains(moved.Notice, (await fixture.Controller.GetAgentStatusAsync()).Endpoint);
    }

    private static int FreePort()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        listener.Start();
        var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    [TestMethod]
    public async Task AnAgentThatStopsOnItsOwnSaysWhy()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "exit", 0);
        var ended = await fixture.WaitAsync(view => view.State == "ended");
        StringAssert.Contains(ended.Notice, "exit code 3");
        StringAssert.Contains(ended.Notice, "gave up on purpose");
    }

    [TestMethod]
    public async Task AnAgentThatAsksToSignInIsSignedInByItsOwnMethod()
    {
        await using var fixture = await Fixture.StartAsync("inspect", "--auth", "--banner");
        await fixture.LaunchAsync();
        var signIn = await fixture.WaitAsync(view => view.State == "signIn");
        Assert.AreEqual("browser", signIn.SignInMethods.Single().Id);
        Assert.ThrowsExactly<NendoValidationException>(() => fixture.Controller.AuthenticateLaunchedAgent(fixture.FileSessionId, "password", 0));
        fixture.Controller.AuthenticateLaunchedAgent(fixture.FileSessionId, "browser", 0);
        await fixture.WaitAsync(view => view.State == "ready");
        Assert.AreEqual("browser", fixture.Log().Single(entry => Method(entry) == "authenticate").GetProperty("params").GetProperty("methodId").GetString());
    }

    [TestMethod]
    public async Task ARequestFromAnotherFileSessionIsRefused()
    {
        await using var fixture = await Fixture.StartAsync("inspect");
        var refused = Assert.ThrowsExactly<NendoPreconditionException>(() => fixture.Controller.ReadLaunchedAgent("file-session-of-another-file", 0));
        Assert.AreEqual("stale-file-session", refused.Code);
    }

    /// <summary>
    /// An agent that sends ACP session
    /// config options has them shown as it offers them, groups flattened and a kind Nendo cannot
    /// draw left out; one is set only by the person's pick, to a value the agent offered; and the
    /// agent's own restatement is what the tab then shows.
    /// </summary>
    [TestMethod]
    public async Task TheAgentsConfigOptionsAreShownAndSetOnlyAsThePersonPicks()
    {
        await using var fixture = await Fixture.StartAsync("editData", "--config");
        await fixture.LaunchAsync();
        var ready = await fixture.WaitAsync(view => view.State == "ready");
        CollectionAssert.AreEqual(new[] { "mode", "model", "reasoning_effort", "allow_all" }, ready.Options.Select(option => option.Id).ToArray(),
            "The options are not the agent's, in its order, without the boolean Nendo cannot draw.");
        var model = ready.Options.Single(option => option.Id == "model");
        Assert.AreEqual("sonnet", model.CurrentValue);
        CollectionAssert.AreEqual(new[] { "Fast", "Smart" }, model.Values.Select(value => value.Group).ToArray(), "A grouped option lost its groups.");
        Assert.AreEqual("thought_level", ready.Options.Single(option => option.Id == "reasoning_effort").Category);
        Assert.IsFalse(fixture.Log().Any(entry => Method(entry) is "session/set_config_option" or "session/set_mode" or "session/set_model"),
            "Nendo set an option nobody picked.");

        await Assert.ThrowsExactlyAsync<NendoValidationException>(() =>
            fixture.Controller.SetLaunchedAgentOptionAsync(fixture.FileSessionId, "reasoning_effort", "extreme", 0));
        Assert.IsFalse(fixture.Log().Any(entry => Method(entry) == "session/set_config_option"), "A value the agent never offered was sent to it.");

        var set = await fixture.Controller.SetLaunchedAgentOptionAsync(fixture.FileSessionId, "reasoning_effort", "high", 0);
        Assert.AreEqual("high", set.Options.Single(option => option.Id == "reasoning_effort").CurrentValue);
        var sent = fixture.Log().Single(entry => Method(entry) == "session/set_config_option").GetProperty("params");
        Assert.AreEqual("reasoning_effort", sent.GetProperty("configId").GetString());
        Assert.AreEqual("high", sent.GetProperty("value").GetString());
        Assert.AreEqual("session-1", sent.GetProperty("sessionId").GetString());

        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "switch", 0);
        var switched = await fixture.WaitAsync(view => !view.Working && view.Options.Single(option => option.Id == "mode").CurrentValue == "plan");
        Assert.AreEqual("high", switched.Options.Single(option => option.Id == "reasoning_effort").CurrentValue);
    }

    /// <summary>
    /// A value the person sets is kept for that agent on this device and is the agent's before
    /// it is next ready, so a view's message launched into it runs with it; the list names the
    /// kept settings for a launch card, a card's picks are kept and sent the same way, a value the
    /// agent never offered is refused, and another command forgets what was kept.
    /// </summary>
    [TestMethod]
    public async Task APickedSettingIsKeptAndTheAgentsBeforeItIsNextReady()
    {
        await using var fixture = await Fixture.StartAsync("editData", "--config");
        Assert.IsNull((await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId)).Agents.Single(agent => agent.Id == "custom").Settings,
            "An agent that never ran here had settings to show.");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var offered = (await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId)).Agents.Single(agent => agent.Id == "custom").Settings;
        Assert.IsNotNull(offered, "The options the agent offered were not kept for a launch card.");
        CollectionAssert.AreEqual(new[] { "mode", "model", "reasoning_effort", "allow_all" }, offered.Select(setting => setting.Id).ToArray());
        await fixture.Controller.SetLaunchedAgentOptionAsync(fixture.FileSessionId, "reasoning_effort", "high", 0);
        await fixture.Controller.EndLaunchedAgentAsync(fixture.FileSessionId, 0);

        await fixture.LaunchAsync();
        var ready = await fixture.WaitAsync(view => view.State == "ready");
        Assert.AreEqual("high", ready.Options.Single(option => option.Id == "reasoning_effort").CurrentValue,
            "The value the person set last time was not the agent's when it was ready.");
        Assert.AreEqual("high", (await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId)).Agents.Single(agent => agent.Id == "custom")
            .Settings!.Single(setting => setting.Id == "reasoning_effort").Value, "The launch card would not show the kept value.");
        await fixture.Controller.EndLaunchedAgentAsync(fixture.FileSessionId, 0);

        await Assert.ThrowsExactlyAsync<NendoValidationException>(() => fixture.Controller.LaunchAgentAsync(fixture.FileSessionId, DesktopAgentCatalog.CustomId,
            settings: new Dictionary<string, string> { ["model"] = "gone" }));
        await fixture.Controller.LaunchAgentAsync(fixture.FileSessionId, DesktopAgentCatalog.CustomId, settings: new Dictionary<string, string> { ["mode"] = "plan" });
        var picked = await fixture.WaitAsync(view => view.State == "ready");
        Assert.AreEqual("plan", picked.Options.Single(option => option.Id == "mode").CurrentValue, "The launch card's pick was not the agent's when it was ready.");
        Assert.AreEqual("high", picked.Options.Single(option => option.Id == "reasoning_effort").CurrentValue, "A card's pick dropped what was kept before.");
        await fixture.Controller.EndLaunchedAgentAsync(fixture.FileSessionId, 0);

        await fixture.Controller.SetAgentCommandAsync(fixture.FileSessionId, fixture.Command + " --another");
        Assert.IsNull(new DesktopAgentOptionsStore(fixture.DeviceRoot).For(DesktopAgentCatalog.CustomId), "Another command kept the settings of the one before.");
    }

    /// <summary>An older agent's modes and models (OpenCode 1.1) are shown as Mode and Model and set by their own methods.</summary>
    [TestMethod]
    public async Task AnOlderAgentsModesAndModelsAreShownAndSetByTheirOwnMethods()
    {
        await using var fixture = await Fixture.StartAsync("editData", "--legacy");
        await fixture.LaunchAsync();
        var ready = await fixture.WaitAsync(view => view.State == "ready");
        CollectionAssert.AreEqual(new[] { AgentConversation.LegacyModeOption, AgentConversation.LegacyModelOption }, ready.Options.Select(option => option.Id).ToArray());
        Assert.AreEqual("build", ready.Options[0].CurrentValue);

        var set = await fixture.Controller.SetLaunchedAgentOptionAsync(fixture.FileSessionId, AgentConversation.LegacyModelOption, "small", 0);
        Assert.AreEqual("small", set.Options[1].CurrentValue);
        Assert.AreEqual("small", fixture.Log().Single(entry => Method(entry) == "session/set_model").GetProperty("params").GetProperty("modelId").GetString());

        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "switch", 0);
        await fixture.WaitAsync(view => !view.Working && view.Options[0].CurrentValue == "plan");
    }

    /// <summary>
    /// The agent's advertised commands reach
    /// the tab as names the box can write after a slash, each once, with the hint of one that
    /// takes input; the agent's restatement replaces them whole; and a command runs as a message
    /// whose first block is the command's text, as ACP says.
    /// </summary>
    [TestMethod]
    public async Task TheAgentsSlashCommandsAreListedAndRunAsAMessage()
    {
        await using var fixture = await Fixture.StartAsync("editData", "--commands");
        await fixture.LaunchAsync();
        var ready = await fixture.WaitAsync(view => view.State == "ready" && view.Commands!.Count > 0);
        CollectionAssert.AreEqual(new[] { "review", "compact" }, ready.Commands!.Select(command => command.Name).ToArray(),
            "The commands are not the agent's runnable ones, once each, without the slash it sent.");
        Assert.AreEqual("what to review", ready.Commands![0].Hint, "A command that takes input lost its hint.");
        Assert.IsNull(ready.Commands![1].Hint, "A command that takes no input was given a hint.");
        Assert.AreEqual("Summarise the conversation so far", ready.Commands![1].Description);

        var books = new AgentPromptContext("nendo://application/entity/books", "Books", "Record type \"Books\"");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "/review the @Books changes", 0, [books]);
        var ran = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent"));
        var prompt = fixture.Log().Single(entry => Method(entry) == "session/prompt").GetProperty("params").GetProperty("prompt");
        Assert.AreEqual("/review the @Books changes", prompt[0].GetProperty("text").GetString(), "The command was not the message's first text block.");
        StringAssert.StartsWith(ran.Entries.Single(entry => entry.Kind == "agent").Text, "Ran review with");

        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "drop-commands", 0);
        var dropped = await fixture.WaitAsync(view => !view.Working && view.Commands!.All(command => command.Name != "review"));
        CollectionAssert.AreEqual(new[] { "compact" }, dropped.Commands!.Select(command => command.Name).ToArray(), "The restated list did not replace the old one.");
    }

    /// <summary>An agent that advertises no commands leaves the list empty rather than absent.</summary>
    [TestMethod]
    public async Task AnAgentWithoutCommandsHasAnEmptyList()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        var ready = await fixture.WaitAsync(view => view.State == "ready");
        Assert.IsNotNull(ready.Commands);
        Assert.IsEmpty(ready.Commands);
    }

    [TestMethod]
    public async Task AToolSaysWhetherItWentThroughNendoOrWasTheAgentsOwn()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "tool", 0);
        var nendo = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "tool"));
        Assert.AreEqual("nendo", nendo.Entries.Single(entry => entry.Kind == "tool").Origin, "nendo.read.resource was not told as Nendo's.");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "permission", 0);
        var asking = await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission"));
        Assert.AreEqual("agent", asking.Entries.Single(entry => entry.Kind == "permission").Origin, "A tool of the agent's own was told as Nendo's.");
    }

    [TestMethod]
    public async Task WhatThePersonPointsAtTravelsWithTheMessage()
    {
        // The owner's "Add more books!" stalled because the agent did not know the record
        // type's ID or fields. What the person points at with @ goes with the message.
        var books = new AgentPromptContext("nendo://application/entity/books", "Books", "Record type \"Books\"\nentityId: `books`\n- Rating: fieldId `books.rating`");
        await using (var fixture = await Fixture.StartAsync("editData"))
        {
            await fixture.LaunchAsync();
            await fixture.WaitAsync(view => view.State == "ready");
            fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "Rate every book in @Books", 0, [books]);
            var done = await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent"));
            Assert.AreEqual("Books", done.Entries.First(entry => entry.Kind == "you").Title, "The person's message does not name what they pointed at.");
            var prompt = fixture.Log().Single(entry => Method(entry) == "session/prompt").GetProperty("params").GetProperty("prompt");
            Assert.AreEqual(2, prompt.GetArrayLength(), prompt.GetRawText());
            Assert.AreEqual("Rate every book in @Books", prompt[0].GetProperty("text").GetString());
            Assert.AreEqual("resource", prompt[1].GetProperty("type").GetString(), "An agent that reads embedded context did not get the description embedded.");
            Assert.AreEqual(books.Uri, prompt[1].GetProperty("resource").GetProperty("uri").GetString());
            Assert.AreEqual(books.Text, prompt[1].GetProperty("resource").GetProperty("text").GetString());
        }

        // An agent that does not read embedded context gets a link, which every ACP agent reads,
        // and the description as text.
        await using (var fixture = await Fixture.StartAsync("editData", "--no-embedded"))
        {
            await fixture.LaunchAsync();
            await fixture.WaitAsync(view => view.State == "ready");
            fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "Rate every book in @Books", 0, [books]);
            await fixture.WaitAsync(view => !view.Working && view.Entries.Any(entry => entry.Kind == "agent"));
            var prompt = fixture.Log().Single(entry => Method(entry) == "session/prompt").GetProperty("params").GetProperty("prompt");
            Assert.AreEqual("resource_link", prompt[1].GetProperty("type").GetString(), prompt.GetRawText());
            Assert.AreEqual(books.Uri, prompt[1].GetProperty("uri").GetString());
            Assert.AreEqual("Books", prompt[1].GetProperty("name").GetString());
            StringAssert.Contains(prompt[2].GetProperty("text").GetString(), "entityId: `books`", "The description did not reach an agent without embedded context.");
        }
    }

    [TestMethod]
    public async Task OnlyTheFilesOwnAddressesAndBoundedTextArePointedAt()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var refused = new[]
        {
            new[] { new AgentPromptContext("file:///C:/Users/someone/secret.txt", "Secret", "text") },
            new[] { new AgentPromptContext("https://example.com/nendo", "Elsewhere", "text") },
            new[] { new AgentPromptContext("nendo://application/entity/books", "Books", new string('x', AgentConversation.MaximumContextTextCharacters + 1)) },
            Enumerable.Range(0, AgentConversation.MaximumContextItems + 1).Select(index => new AgentPromptContext($"nendo://application/entity/t{index}", $"T{index}", "text")).ToArray(),
            Enumerable.Range(0, 5).Select(index => new AgentPromptContext($"nendo://application/entity/t{index}", $"T{index}", new string('x', 7_000))).ToArray(),
        };
        foreach (var context in refused)
        {
            Assert.ThrowsExactly<NendoValidationException>(() => fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "Look", 0, context),
                $"{context[0].Uri} ×{context.Length} was sent.");
        }
        Assert.IsFalse(fixture.Log().Any(entry => Method(entry) == "session/prompt"), "A refused message reached the agent.");
        Assert.IsFalse((await fixture.WaitAsync(view => true)).Working, "A refused message started a turn.");
    }

    /// <summary>
    /// A program that answered initialize with a version as
    /// text (an MCP server named as the person's own command) threw out of the handshake and left
    /// the tab at Starting, saying nothing, with the next launch refused.
    /// </summary>
    [TestMethod]
    public async Task AnAgentAnsweringWithAVersionAsTextIsEndedWithASentenceNamingIt()
    {
        await using var fixture = await Fixture.StartAsync("inspect", "--version-text");
        await fixture.LaunchAsync();
        var ended = await fixture.WaitAsync(view => view.State == "ended");
        StringAssert.Contains(ended.Notice, "\"2025-06-18\"", "The notice does not name the version the program sent.");
        Assert.IsNull((await fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId)).Running, "The refused agent still counts as running.");
    }

    /// <summary>
    /// A permission request whose location had a null line, which ACP allows, threw after
    /// its entry was added, so the agent was answered "Nendo could not answer." and the tab kept a
    /// question with no answers at Waiting for you.
    /// </summary>
    [TestMethod]
    public async Task APermissionWhoseLineIsNullIsStillAskedAndAnswerable()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "line-null", 0);
        var asking = await fixture.WaitAsync(view => view.Entries.Any(entry => entry.Kind == "permission") || !view.Working);
        var question = asking.Entries.SingleOrDefault(entry => entry.Kind == "permission");
        Assert.IsNotNull(question, "No permission request was shown: " + string.Join(" | ", asking.Entries.Select(entry => $"{entry.Kind}: {entry.Text}")));
        Assert.IsNotNull(question.Options, "The request was shown with no answers to choose from.");
        Assert.HasCount(2, question.Options, "The request does not offer the agent's two answers.");
        StringAssert.Contains(question.Text, "Where: C:/work/notes.md");
        fixture.Controller.AnswerLaunchedAgent(fixture.FileSessionId, question.Id, "allow", 0);
        await fixture.WaitAsync(view => !view.Working);
        var answer = fixture.Log().Single(entry => entry.TryGetProperty("permission", out _)).GetProperty("permission");
        Assert.AreEqual("allow", answer.GetProperty("outcome").GetProperty("optionId").GetString(), answer.GetRawText());
    }

    /// <summary>
    /// An error answer whose code was text faulted the read loop, the conversation ended
    /// saying the agent closed its output, and the faulted loop then made closing the file throw
    /// before agent access stopped, so the file's MCP listener kept its port.
    /// </summary>
    [TestMethod]
    public async Task AnAnswerWhoseCodeIsTextIsARefusalAndClosingTheFileStillStopsTheListener()
    {
        await using var fixture = await Fixture.StartAsync("editData", "--config", "--text-code");
        // A port of this test's own, so another test's listener on the shared default is not mistaken for this one.
        await fixture.Controller.SetAgentSettingsAsync(false, 60, true, FreePort());
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() =>
            fixture.Controller.SetLaunchedAgentOptionAsync(fixture.FileSessionId, "reasoning_effort", "high", 0));
        StringAssert.Contains(refused.Message, "boom", "The agent's refusal was not told as its own.");
        Assert.AreEqual("ready", fixture.Controller.ReadLaunchedAgent(fixture.FileSessionId, 0).State, "One answer with a text code ended the conversation.");

        var endpoint = new Uri((await fixture.Controller.GetAgentStatusAsync()).Endpoint!);
        await fixture.Controller.CloseAsync();
        using var probe = new System.Net.Sockets.TcpClient();
        var reached = false;
        try { await probe.ConnectAsync(endpoint.Host, endpoint.Port); reached = true; }
        catch (System.Net.Sockets.SocketException) { }
        Assert.IsFalse(reached, $"The closed file's agent listener still answers at {endpoint}.");
    }

    /// <summary>
    /// When Nendo ended the connection over a message too large, the tab said the agent
    /// "stopped answering", and the person relaunched into the same failure.
    /// </summary>
    [TestMethod]
    public async Task AMessageTooLargeIsToldAsNendosLimitNotTheAgentsSilence()
    {
        await using var fixture = await Fixture.StartAsync("editData");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "ready");
        fixture.Controller.PromptLaunchedAgent(fixture.FileSessionId, "huge", 0);
        var ended = await fixture.WaitAsync(view => view.State == "ended");
        StringAssert.Contains(ended.Notice, "larger than the 8 MiB Nendo accepts", "The notice does not say Nendo ended it over the size.");
        Assert.IsFalse(ended.Notice!.Contains("stopped answering", StringComparison.Ordinal), ended.Notice);
    }

    /// <summary>
    /// A second press while the first sign-in ran sent a second authenticate and opened a
    /// second session over the first. The read says a sign-in runs, so the tab holds its buttons.
    /// </summary>
    [TestMethod]
    public async Task SignInRunsOnceWhileItRuns()
    {
        await using var fixture = await Fixture.StartAsync("inspect", "--auth", "--slow-auth");
        await fixture.LaunchAsync();
        await fixture.WaitAsync(view => view.State == "signIn");
        var first = fixture.Controller.AuthenticateLaunchedAgent(fixture.FileSessionId, "browser", 0);
        Assert.IsTrue(first.SigningIn, "The read does not say a sign-in runs, so the tab would leave its buttons live.");
        var again = Assert.ThrowsExactly<NendoPreconditionException>(() => fixture.Controller.AuthenticateLaunchedAgent(fixture.FileSessionId, "browser", 0),
            "A second sign-in was started while the first ran.");
        Assert.AreEqual("agent-signing-in", again.Code);
        var ready = await fixture.WaitAsync(view => view.State == "ready");
        Assert.IsFalse(ready.SigningIn);
        Assert.AreEqual(1, fixture.Log().Count(entry => Method(entry) == "authenticate"), "The agent was asked to sign in more than once.");
        Assert.AreEqual(2, fixture.Log().Count(entry => Method(entry) == "session/new"), "A second session was opened over the first: one before signing in, one after, is all.");
    }

    /// <summary>
    /// A launch that did not end through EndAsync (a host killed, upgraded over or logged
    /// off, a delete that gave up) left its folder under device state for good. The next launch
    /// takes every folder no running agent can be using, and leaves another running window's.
    /// </summary>
    [TestMethod]
    public async Task LeftOverAgentFoldersAreSweptAtTheNextLaunch()
    {
        await using var fixture = await Fixture.StartAsync("inspect");
        var root = DesktopDeviceStateLayout.AgentSessions(fixture.DeviceRoot);
        using var ended = Process.Start(new ProcessStartInfo("node", "-e \"0\"") { UseShellExecute = false, CreateNoWindow = true })!;
        await ended.WaitForExitAsync();
        using var running = Process.Start(new ProcessStartInfo("node", "-e \"setTimeout(() => {}, 60000)\"") { UseShellExecute = false, CreateNoWindow = true })!;
        try
        {
            var legacy = Directory.CreateDirectory(Path.Combine(root, Guid.NewGuid().ToString("N"))).FullName;
            File.WriteAllText(Path.Combine(legacy, "left.txt"), "what an agent wrote");
            var ofEnded = Directory.CreateDirectory(Path.Combine(root, $"{ended.Id}-{Guid.NewGuid():N}")).FullName;
            var ofThis = Directory.CreateDirectory(Path.Combine(root, $"{Environment.ProcessId}-{Guid.NewGuid():N}")).FullName;
            var ofRunning = Directory.CreateDirectory(Path.Combine(root, $"{running.Id}-{Guid.NewGuid():N}")).FullName;
            // An older Nendo's agent at work: one of its files is open, so nothing in it is taken.
            var inUse = Directory.CreateDirectory(Path.Combine(root, Guid.NewGuid().ToString("N"))).FullName;
            var spare = Path.Combine(inUse, "notes.txt");
            File.WriteAllText(spare, "kept");
            var heldPath = Path.Combine(inUse, "held.txt");
            File.WriteAllText(heldPath, "open");
            using var held = new FileStream(heldPath, FileMode.Open, FileAccess.Read, FileShare.Read);

            await fixture.LaunchAsync();
            await fixture.WaitAsync(view => view.State == "ready");
            Assert.IsFalse(Directory.Exists(legacy), "A folder from before folders were named by their process was left.");
            Assert.IsFalse(Directory.Exists(ofEnded), "A folder of a process that has ended was left.");
            Assert.IsFalse(Directory.Exists(ofThis), "A folder of this process that no agent runs in was left.");
            Assert.IsTrue(Directory.Exists(ofRunning), "A folder of another running Nendo was taken.");
            Assert.IsTrue(File.Exists(spare), "A folder a program still has a file open in was emptied.");
            Assert.IsTrue(Directory.Exists(fixture.Controller.LaunchedAgent!.WorkingDirectory), "The new agent's own folder was taken.");
        }
        finally
        {
            try { running.Kill(); } catch (InvalidOperationException) { }
        }
    }

    /// <summary>
    /// PATH and the variables were the snapshot this process took when it started, so a
    /// program installed since stayed "not installed" and an API key set since never reached the
    /// agent. The catalogue and the launch read the environment as Windows holds it now.
    /// </summary>
    [TestMethod]
    public async Task AProgramInstalledSinceStartIsFoundAndTheAgentGetsTodaysVariables()
    {
        await using var fixture = await Fixture.StartAsync("inspect");
        var installed = Directory.CreateTempSubdirectory("nendo-agent-installed-");
        try
        {
            File.WriteAllText(Path.Combine(installed.FullName, "fresh-acp-agent.cmd"), "@echo off\r\n");
            fixture.Controller.AgentEnvironmentReader = () =>
            {
                var now = new Dictionary<string, string>(AgentEnvironment.Read(), StringComparer.OrdinalIgnoreCase);
                now[AgentEnvironment.PathName] = AgentEnvironment.PathOf(now) + ";" + installed.FullName;
                now["NENDO_AGENT_PROBE"] = "set after start";
                return now;
            };
            var offered = await fixture.Controller.SetAgentCommandAsync(fixture.FileSessionId, "fresh-acp-agent --acp");
            Assert.IsTrue(offered.Agents.Single(agent => agent.Id == DesktopAgentCatalog.CustomId).Found,
                "A program in a PATH folder added since Nendo started is still not found.");

            await fixture.Controller.SetAgentCommandAsync(fixture.FileSessionId, fixture.Command);
            await fixture.LaunchAsync();
            await fixture.WaitAsync(view => view.State == "ready");
            var started = fixture.Log().Single(entry => entry.TryGetProperty("started", out _));
            Assert.AreEqual("set after start", started.GetProperty("probe").GetString(), "A variable set since Nendo started did not reach the agent.");
        }
        finally
        {
            installed.Delete(recursive: true);
        }
    }

    [TestMethod]
    public void TheEnvironmentIsTheMachinesThenThePersonsOverThisProcesss()
    {
        var process = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Path"] = "C:/old;C:/only-here", ["ONLY_HERE"] = "kept", ["KEY"] = "old" };
        var machine = new Dictionary<string, EnvironmentValue>(StringComparer.OrdinalIgnoreCase) { ["Path"] = new("C:/old;C:/Program Files/nodejs") };
        var user = new Dictionary<string, EnvironmentValue>(StringComparer.OrdinalIgnoreCase) { ["PATH"] = new("C:/Users/someone/npm"), ["KEY"] = new("new") };
        var merged = AgentEnvironment.Merge(process, machine, user);
        Assert.AreEqual("C:/old;C:/Program Files/nodejs;C:/Users/someone/npm;C:/only-here", AgentEnvironment.PathOf(merged));
        Assert.AreEqual("kept", merged["ONLY_HERE"], "A variable only this process had was lost.");
        Assert.AreEqual("new", merged["KEY"], "The person's variable as set now did not win over this process's copy.");
    }

    /// <summary>
    /// The machine's key names USERNAME=SYSTEM, which no launched agent is given. This process's identity
    /// and per-sign-in variables stay its own.
    /// </summary>
    [TestMethod]
    public void TheAgentKeepsThisProcesssIdentityOverTheMachinesKey()
    {
        var process = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["USERNAME"] = "someone", ["USERPROFILE"] = "C:/Users/someone" };
        var machine = new Dictionary<string, EnvironmentValue>(StringComparer.OrdinalIgnoreCase) { ["USERNAME"] = new("SYSTEM"), ["USERPROFILE"] = new("C:/Windows/system32/config/systemprofile") };
        var merged = AgentEnvironment.Merge(process, machine, new Dictionary<string, EnvironmentValue>());
        Assert.AreEqual("someone", merged["USERNAME"], "The agent was given the machine key's user name.");
        Assert.AreEqual("C:/Users/someone", merged["USERPROFILE"]);
    }

    /// <summary>
    /// An expandable value is expanded against the current variables, not this process's old ones,
    /// so a PATH folder that names a variable set since it started is found.
    /// </summary>
    [TestMethod]
    public void AnExpandableValueIsExpandedAgainstTheEnvironmentBeingBuilt()
    {
        var process = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["Path"] = "C:/old" };
        var user = new Dictionary<string, EnvironmentValue>(StringComparer.OrdinalIgnoreCase)
        {
            ["NEWVAR"] = new("C:/x"),
            ["Path"] = new("%NEWVAR%\\bin", Expandable: true),
            ["TOOLS"] = new("%NEWVAR%\\tools;%UNSET%", Expandable: true),
        };
        var merged = AgentEnvironment.Merge(process, new Dictionary<string, EnvironmentValue>(), user);
        Assert.AreEqual("C:/x\\bin;C:/old", AgentEnvironment.PathOf(merged), "A PATH folder naming a variable set since was not expanded with it.");
        Assert.AreEqual("C:/x\\tools;%UNSET%", merged["TOOLS"], "An expandable value was not expanded against the new variables, or an unknown name was not left as it was.");
    }

    /// <summary>
    /// Finding the agents walks every PATH folder, about 20 seconds with an unreachable
    /// share first; under the request gate the Agent page's 3-second poll held every save, open and
    /// switch behind it. Nothing in the file is read to find them, so the gate is not held.
    /// </summary>
    [TestMethod]
    public async Task FindingTheAgentsHoldsNoOtherRequest()
    {
        await using var fixture = await Fixture.StartAsync("inspect");
        using var unreachable = new ManualResetEventSlim();
        fixture.Controller.AgentEnvironmentReader = () =>
        {
            unreachable.Wait(Patience);
            return AgentEnvironment.Read();
        };
        var listing = fixture.Controller.ListLaunchableAgentsAsync(fixture.FileSessionId);
        await Task.Delay(200);
        Assert.IsFalse(listing.IsCompleted, "The blocked PATH walk did not block the list.");
        var status = fixture.Controller.GetAgentStatusAsync();
        var first = await Task.WhenAny(status, Task.Delay(TimeSpan.FromSeconds(5)));
        unreachable.Set();
        Assert.AreSame(status, first, "A request on the gate waited for the agents to be found.");
        Assert.IsNotEmpty((await listing).Agents);
    }

    [TestMethod]
    public void ACommandLineKeepsQuotedWordsTogether()
    {
        CollectionAssert.AreEqual(new[] { "node", @"C:\Program Files\agent.mjs", "--flag" },
            DesktopAgentCatalog.Split(@"node ""C:\Program Files\agent.mjs"" --flag").ToArray());
        Assert.IsNull(DesktopAgentCatalog.Custom("   "));
    }

    [TestMethod]
    public void AnAgentFromARenamedPackageIsToldApartAndAMissingOneSaysWhatToInstall()
    {
        // claude-agent-acp from @zed-industries/claude-agent-acp stopped at 0.23.1 when it was renamed,
        // and refuses to start. npm's shim names the package.
        var folder = Directory.CreateTempSubdirectory("nendo-agent-shims-");
        try
        {
            var shim = Path.Combine(folder.FullName, "claude-agent-acp.cmd");
            const string NpmShim = "@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\{0}\\dist\\index.js\" %*\r\n";
            File.WriteAllText(shim, string.Format(NpmShim, @"@zed-industries\claude-agent-acp"));
            var agents = DesktopAgentCatalog.List(null, folder.FullName);
            var claude = agents.Single(agent => agent.Id == "claude");
            Assert.AreEqual(shim, claude.ResolvedPath);
            Assert.AreEqual("@zed-industries/claude-agent-acp", claude.RenamedFrom, "The renamed package was not told apart.");
            Assert.AreEqual("npm uninstall -g @zed-industries/claude-agent-acp\nnpm install -g @agentclientprotocol/claude-agent-acp", claude.UpdateCommand);

            var gemini = agents.Single(agent => agent.Id == "gemini");
            Assert.IsNull(gemini.ResolvedPath);
            Assert.AreEqual("npm install -g @google/gemini-cli", gemini.InstallCommand);
            Assert.IsNull(gemini.RenamedFrom);

            File.WriteAllText(shim, string.Format(NpmShim, @"@agentclientprotocol\claude-agent-acp"));
            claude = DesktopAgentCatalog.List(null, folder.FullName).Single(agent => agent.Id == "claude");
            Assert.IsNull(claude.RenamedFrom, "The package that is still updated was taken for the renamed one.");
            Assert.IsNull(claude.UpdateCommand);

            var own = DesktopAgentCatalog.Custom($"\"{shim}\"", folder.FullName)!;
            Assert.IsNull(own.InstallCommand, "The person's own command was given an install command.");
            Assert.IsNull(own.RenamedFrom);
        }
        finally
        {
            folder.Delete(recursive: true);
        }
    }

    private static string? Method(JsonElement entry) =>
        entry.TryGetProperty("method", out var method) ? method.GetString() : null;

    private static bool PathsOverlap(string left, string right)
    {
        var a = Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)) + Path.DirectorySeparatorChar;
        var b = Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)) + Path.DirectorySeparatorChar;
        return a.StartsWith(b, StringComparison.OrdinalIgnoreCase) && a.Length == b.Length
            || b.StartsWith(a, StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsRunning(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static async Task WaitUntil(Func<bool> condition, string failure)
    {
        var deadline = DateTime.UtcNow + Patience;
        while (!condition())
        {
            if (DateTime.UtcNow > deadline) Assert.Fail(failure);
            await Task.Delay(50);
        }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly DesktopTestWorkspace _workspace;
        private readonly string _log;

        private Fixture(DesktopTestWorkspace workspace, DesktopSessionController controller, string log, string fileSessionId)
        {
            _workspace = workspace;
            Controller = controller;
            _log = log;
            FileSessionId = fileSessionId;
        }

        internal DesktopSessionController Controller { get; }
        internal string FileSessionId { get; }
        internal string FilePath => _workspace.FilePath;
        internal string DeviceRoot => _workspace.FileHistoryRoot;
        internal string Command { get; private init; } = string.Empty;

        internal static async Task<Fixture> StartAsync(string mode, params string[] flags)
        {
            var workspace = new DesktopTestWorkspace();
            var deviceRoot = workspace.FileHistoryRoot;
            var controller = new DesktopSessionController(
                new Nendo.LocalMcp.NendoLocalMcpHostOptions(Path.Combine(deviceRoot, "discovery")),
                Path.Combine(deviceRoot, "history"), deviceStateRoot: deviceRoot);
            await controller.CreateAsync(workspace.FilePath);
            if (mode != "off") await controller.SetAgentModeAsync(mode);
            var view = await controller.GetViewAsync();
            var log = Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, "agent-log.jsonl");
            var agent = Path.Combine(AppContext.BaseDirectory, "TestFixtures", "fake-acp-agent.mjs");
            Assert.IsNotNull(DesktopAgentCatalog.Resolve("node", Environment.GetEnvironmentVariable("PATH") ?? string.Empty),
                "These tests run a stand-in agent with Node, which is not on PATH.");
            var command = $"node \"{agent}\" --log \"{log}\" {string.Join(' ', flags)}";
            await controller.SetAgentCommandAsync(view.FileSessionId!, command);
            return new Fixture(workspace, controller, log, view.FileSessionId!) { Command = command };
        }

        internal Task<DesktopLaunchedAgentView> LaunchAsync() =>
            Controller.LaunchAgentAsync(FileSessionId, DesktopAgentCatalog.CustomId);

        /// <summary>Read the whole conversation until <paramref name="condition"/> holds.</summary>
        internal async Task<DesktopLaunchedAgentView> WaitAsync(Func<DesktopLaunchedAgentView, bool> condition)
        {
            var deadline = DateTime.UtcNow + Patience;
            while (true)
            {
                var view = Controller.ReadLaunchedAgent(FileSessionId, 0);
                if (condition(view)) return view;
                if (DateTime.UtcNow > deadline)
                    Assert.Fail($"The conversation never got there. It is {view.State}: {view.Notice}; " +
                        string.Join(" | ", view.Entries.Select(entry => $"{entry.Kind}: {entry.Text}")));
                await Task.Delay(50);
            }
        }

        internal IReadOnlyList<JsonElement> Log()
        {
            if (!File.Exists(_log)) return [];
            using var stream = new FileStream(_log, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            return reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries)
                .Select(line => JsonDocument.Parse(line).RootElement.Clone()).ToArray();
        }

        public async ValueTask DisposeAsync()
        {
            await Controller.DisposeAsync();
            // Best effort: a failure here would hide the assertion that failed the test, and the
            // temporary folder is the operating system's to clear.
            for (var attempt = 0; attempt < 20; attempt++)
            {
                try
                {
                    await _workspace.DisposeAsync();
                    return;
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    await Task.Delay(100);
                }
            }
        }
    }
}
