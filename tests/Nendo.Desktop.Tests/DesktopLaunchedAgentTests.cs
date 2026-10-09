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
    /// The live check of 2026-10-08 showed the agent's application handle in a permission card:
    /// Copilot CLI sends it with every owned call. The tab may say it was sent, never what it was.
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

        await fixture.Controller.SetAgentModeAsync("shapeApp");
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
    /// The owner asked for the agent's own options (2026-10-08). An agent that sends ACP session
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
        // W-200: the owner's "Add more books!" stalled because the agent did not know the record
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
        // 2026-10-08: the owner's claude-agent-acp came from @zed-industries/claude-agent-acp, which
        // stopped at 0.23.1 when it was renamed, and refused to start. npm's shim names the package.
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
            return new Fixture(workspace, controller, log, view.FileSessionId!);
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
