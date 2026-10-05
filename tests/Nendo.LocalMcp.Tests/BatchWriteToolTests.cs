using System.Text.Json;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// W-147: a multi-field edit is one call and one revision; a cross-type batch commits
/// atomically with every record's version in the result; a reference may be named by a
/// unique field's value and the host resolves it, for a create, a batch and a JSON import.
/// </summary>
[TestClass]
public sealed class BatchWriteToolTests
{
    [TestMethod]
    public async Task AThreeFieldEditIsOneCallAndOneRevision()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var before = (await workspace.Service.GetHistoryAsync()).Count;

        var updated = await CallAsync<NendoDataApplyResult>(client, "nendo.data.update_record", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t1",
            ["expectedRecordVersion"] = 1L,
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                ["title"] = "Renamed",
                ["estimate"] = new Dictionary<string, string> { ["$nendoNumber"] = "12.50" },
                ["done"] = true,
            }),
            ["idempotencyKey"] = "edit-three",
        });
        Assert.AreEqual(4L, updated.RecordVersion, "Three fields advance the record by three.");
        Assert.HasCount(before + 1, await workspace.Service.GetHistoryAsync(), "Three fields are one revision.");
        var record = (await workspace.Service.QueryRecordsAsync(new("tasks", 1) { RecordId = "t1" })).Items.Single();
        Assert.AreEqual(4L, record.RecordVersion);
        Assert.AreEqual("Renamed", record.Values["title"].GetString());
        Assert.AreEqual("12.50", record.Values["estimate"].GetRawText());

        var replayed = await CallAsync<NendoDataApplyResult>(client, "nendo.data.update_record", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t1",
            ["expectedRecordVersion"] = 1L,
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                ["title"] = "Renamed",
                ["estimate"] = new Dictionary<string, string> { ["$nendoNumber"] = "12.50" },
                ["done"] = true,
            }),
            ["idempotencyKey"] = "edit-three",
        });
        Assert.IsTrue(replayed.IsIdempotentReplay);
        Assert.AreEqual(updated.RevisionId, replayed.RevisionId);
    }

    [TestMethod]
    public async Task ACrossTypeBatchCommitsAtomicallyWithEveryRecordsVersion()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var before = (await workspace.Service.GetHistoryAsync()).Count;

        var written = await CallAsync<NendoDataWritesResult>(client, "nendo.data.apply_writes", new(session)
        {
            ["writes"] = new object[]
            {
                new { kind = "create", entityId = "projects", recordId = "p2", values = new { name = "Second", code = "P2" } },
                // Points at the project created one write earlier: the host supplies its version.
                new { kind = "create", entityId = "tasks", recordId = "t2", values = new { title = "Under second", project = "p2" } },
                new { kind = "update", entityId = "projects", recordId = "p1", expectedRecordVersion = 1L, values = new { name = "Renamed first" } },
                new { kind = "delete", entityId = "tasks", recordId = "t1", expectedRecordVersion = 1L },
            },
            ["idempotencyKey"] = "batch-one",
            ["label"] = "Reshuffle",
        });
        Assert.HasCount(before + 1, await workspace.Service.GetHistoryAsync(), "A batch is one revision.");
        CollectionAssert.AreEqual(
            new[] { ("projects", "p2", (long?)1), ("tasks", "t2", (long?)1), ("projects", "p1", (long?)2), ("tasks", "t1", (long?)null) },
            written.Records.Select(record => (record.EntityId, record.RecordId, record.RecordVersion)).ToArray());
        var p2 = (await workspace.Service.QueryRecordsAsync(new("projects", 1) { RecordId = "p2" })).Items.Single();
        Assert.AreEqual(1L, p2.RecordVersion);
        var t2 = (await workspace.Service.QueryRecordsAsync(new("tasks", 1) { RecordId = "t2" })).Items.Single();
        Assert.AreEqual("p2", t2.Values["project"].GetString());
        Assert.IsEmpty((await workspace.Service.QueryRecordsAsync(new("tasks", 1) { RecordId = "t1" })).Items);
        var history = await workspace.Service.GetHistoryAsync();
        StringAssert.Contains(JsonSerializer.Serialize(history[^1]), "Reshuffle", StringComparison.Ordinal);

        // One bad write, nothing committed.
        var refused = await client.CallToolAsync("nendo.data.apply_writes", new Dictionary<string, object?>(session)
        {
            ["writes"] = new object[]
            {
                new { kind = "create", entityId = "projects", recordId = "p3", values = new { name = "Third", code = "P3" } },
                new { kind = "update", entityId = "projects", recordId = "p1", expectedRecordVersion = 1L, values = new { name = "Stale version" } },
            },
            ["idempotencyKey"] = "batch-bad",
        });
        Assert.IsTrue(refused.IsError, JsonSerializer.Serialize(refused));
        StringAssert.Contains(Text(refused), "NENDO_RECORD_VERSION_CONFLICT", StringComparison.Ordinal);
        Assert.IsEmpty((await workspace.Service.QueryRecordsAsync(new("projects", 1) { RecordId = "p3" })).Items, "The create before the refused update must not have committed.");
        Assert.HasCount(before + 1, await workspace.Service.GetHistoryAsync());

        var kind = await client.CallToolAsync("nendo.data.apply_writes", new Dictionary<string, object?>(session)
        {
            ["writes"] = new object[] { new { kind = "upsert", entityId = "projects", recordId = "p3", values = new { name = "Third" } } },
            ["idempotencyKey"] = "batch-kind",
        });
        StringAssert.Contains(Text(kind), "kind is create, update or delete; 'upsert' is not", StringComparison.Ordinal);
    }

    [TestMethod]
    public async Task AReferenceNamedByAUniqueFieldIsResolvedForACreateABatchAndAnImport()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var created = await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_records", new(session)
        {
            ["entityId"] = "tasks",
            ["records"] = new object[]
            {
                new { recordId = "t3", values = new { title = "By code" }, references = new { project = new { matchFieldId = "code", value = "P1" } } },
                new { recordId = "t4", values = new { title = "By ID" }, references = new { project = new { recordId = "p1" } } },
            },
            ["idempotencyKey"] = "create-by-reference",
        });
        Assert.AreEqual(1L, created.RecordVersion);
        foreach (var id in new[] { "t3", "t4" })
        {
            var task = (await workspace.Service.QueryRecordsAsync(new("tasks", 1) { RecordId = id })).Items.Single();
            Assert.AreEqual("p1", task.Values["project"].GetString(), id);
        }

        var updated = await CallAsync<NendoDataApplyResult>(client, "nendo.data.update_record", new(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t1",
            ["expectedRecordVersion"] = 1L,
            ["values"] = JsonSerializer.SerializeToElement(new { title = "Moved" }),
            ["references"] = new { project = new { matchFieldId = "code", value = "P1" } },
            ["idempotencyKey"] = "update-by-reference",
        });
        Assert.AreEqual(3L, updated.RecordVersion, "The resolved reference is a written field too.");

        var imported = await CallAsync<NendoImportResult>(client, "nendo.data.import_records", new(session)
        {
            ["entityId"] = "tasks",
            ["format"] = "json",
            ["records"] = new object[]
            {
                new { recordId = "t5", values = new { title = "Imported" }, references = new { project = new { matchFieldId = "code", value = "P1" } } },
            },
            ["idempotencyKey"] = "import-by-reference",
        });
        Assert.AreEqual(1, imported.Committed);
        Assert.AreEqual("p1", (await workspace.Service.QueryRecordsAsync(new("tasks", 1) { RecordId = "t5" })).Items.Single().Values["project"].GetString());

        var missing = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t6",
            ["values"] = new { title = "Nowhere" },
            ["references"] = new { project = new { matchFieldId = "code", value = "P9" } },
            ["idempotencyKey"] = "create-missing-reference",
        });
        Assert.IsTrue(missing.IsError);
        StringAssert.Contains(Text(missing), "NENDO_TARGET_NOT_FOUND", StringComparison.Ordinal);
        StringAssert.Contains(Text(missing), "No Projects record holds P9 in code", StringComparison.Ordinal);

        var notUnique = await client.CallToolAsync("nendo.data.create_record", new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t7",
            ["values"] = new { title = "By name" },
            ["references"] = new { project = new { matchFieldId = "name", value = "Project" } },
            ["idempotencyKey"] = "create-by-non-unique",
        });
        StringAssert.Contains(Text(notUnique), "can be matched only by a unique field of Projects; name is not one", StringComparison.Ordinal);
    }

    /// <summary>
    /// W-166: a target an earlier write of the same batch creates is found there under
    /// references, by record ID and by a unique field's value, as a plain value always was.
    /// </summary>
    [TestMethod]
    public async Task ReferencesFindATargetAnEarlierWriteInTheBatchCreated()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);

        var applied = await client.CallToolAsync("nendo.data.apply_writes", new Dictionary<string, object?>(session)
        {
            ["writes"] = new object[]
            {
                new { kind = "create", entityId = "projects", recordId = "p2", values = new { name = "Second", code = "P2" } },
                new { kind = "create", entityId = "tasks", recordId = "t-by-id", values = new { title = "By ID" }, references = new { project = new { recordId = "p2" } } },
                new { kind = "create", entityId = "tasks", recordId = "t-by-code", values = new { title = "By code" }, references = new { project = new { matchFieldId = "code", value = "P2" } } },
                new { kind = "update", entityId = "projects", recordId = "p1", expectedRecordVersion = 1L, values = new { code = "P1-renamed" } },
                new { kind = "create", entityId = "tasks", recordId = "t-by-new-code", values = new { title = "By new code" }, references = new { project = new { matchFieldId = "code", value = "P1-renamed" } } },
            },
            ["idempotencyKey"] = "same-batch-references",
        });
        Assert.AreNotEqual(true, applied.IsError, "A same-batch target under references was refused: " + Text(applied));
        foreach (var (id, project) in new[] { ("t-by-id", "p2"), ("t-by-code", "p2"), ("t-by-new-code", "p1") })
        {
            var task = (await workspace.Service.QueryRecordsAsync(new("tasks", 1) { RecordId = id })).Items.Single();
            Assert.AreEqual(project, task.Values["project"].GetString(), id);
        }
    }

    /// <summary>
    /// F-258: a write that names a reference resolves the target's current version before
    /// the Engine compares replay digests, so an exact retry after the target moved was
    /// NENDO_IDEMPOTENCY_CONFLICT, the one case the receipt exists for. The retry now
    /// carries the versions its committed revision recorded, as the import's does.
    /// </summary>
    [TestMethod]
    public async Task AnExactRetryThatNamesAReferenceReplaysAfterItsTargetMoved()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await PrepareAsync(workspace);
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service, AgentAccessMode.DataMutation, new NendoLocalMcpHostOptions(workspace.DiscoveryRoot));
        await using var client = await ProtocolResourceTests.ConnectAsync(host);
        var session = await AcquireAsync(client);
        var projectVersion = 1L;
        async Task MoveTargetAsync()
        {
            await workspace.Service.SetFieldAsync(new NendoSetFieldRequest("projects", "p1", "name", projectVersion, $"Renamed {projectVersion}",
                new("test", $"p1-rename-{projectVersion}", "test")));
            projectVersion++;
        }

        var create = new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks",
            ["records"] = new object[]
            {
                new { recordId = "t3", values = new { title = "By code" }, references = new { project = new { matchFieldId = "code", value = "P1" } } },
            },
            ["idempotencyKey"] = "retry-create-by-reference",
        };
        var created = await CallAsync<NendoDataApplyResult>(client, "nendo.data.create_records", new(create));
        await MoveTargetAsync();
        var retried = await client.CallToolAsync("nendo.data.create_records", new Dictionary<string, object?>(create));
        Assert.AreNotEqual(true, retried.IsError, "An exact create_records retry was refused after its target moved: " + JsonSerializer.Serialize(retried));
        var replay = retried.StructuredContent!.Value.Deserialize<NendoDataApplyResult>(NendoMcpJson.Options)!;
        Assert.IsTrue(replay.IsIdempotentReplay);
        Assert.AreEqual(created.RevisionId, replay.RevisionId);

        var update = new Dictionary<string, object?>(session)
        {
            ["entityId"] = "tasks",
            ["recordId"] = "t1",
            ["expectedRecordVersion"] = 1L,
            ["values"] = JsonSerializer.SerializeToElement(new { title = "Moved" }),
            ["references"] = new { project = new { matchFieldId = "code", value = "P1" } },
            ["idempotencyKey"] = "retry-update-by-reference",
        };
        var updated = await CallAsync<NendoDataApplyResult>(client, "nendo.data.update_record", new(update));
        await MoveTargetAsync();
        var updateReplay = await CallAsync<NendoDataApplyResult>(client, "nendo.data.update_record", new(update));
        Assert.IsTrue(updateReplay.IsIdempotentReplay, "An exact update_record retry was refused after its target moved.");
        Assert.AreEqual(updated.RevisionId, updateReplay.RevisionId);

        var writes = new Dictionary<string, object?>(session)
        {
            ["writes"] = new object[]
            {
                new { kind = "create", entityId = "tasks", recordId = "t4", values = new { title = "Batched" }, references = new { project = new { recordId = "p1" } } },
            },
            ["idempotencyKey"] = "retry-apply-by-reference",
        };
        var applied = await CallAsync<NendoDataWritesResult>(client, "nendo.data.apply_writes", new(writes));
        await MoveTargetAsync();
        var appliedReplay = await CallAsync<NendoDataWritesResult>(client, "nendo.data.apply_writes", new(writes));
        Assert.IsTrue(appliedReplay.IsIdempotentReplay, "An exact apply_writes retry was refused after its target moved.");
        Assert.AreEqual(applied.RevisionId, appliedReplay.RevisionId);
        Assert.HasCount(3, (await workspace.Service.QueryRecordsAsync(new("tasks", 50))).Items, "A retry wrote a second copy.");

        // The recorded versions do not loosen what the key stands for: a different payload
        // under a used key is still a conflict and writes nothing.
        var changed = await client.CallToolAsync("nendo.data.create_records", new Dictionary<string, object?>(create)
        {
            ["records"] = new object[]
            {
                new { recordId = "t3", values = new { title = "Changed" }, references = new { project = new { matchFieldId = "code", value = "P1" } } },
            },
        });
        Assert.IsTrue(changed.IsError, "A different payload under a used key was accepted.");
        StringAssert.Contains(Text(changed), "NENDO_IDEMPOTENCY_CONFLICT", StringComparison.Ordinal);
    }

    /// <summary>Projects with a unique code; tasks with a title, an estimate, a flag and a required project.</summary>
    private static async Task PrepareAsync(LocalMcpTestWorkspace workspace)
    {
        await workspace.CreateEmptyAsync();
        var schema = await workspace.Service.PrepareProposalAsync(new NendoProposalRequest(
            $"proposal-{Guid.NewGuid():N}", "Projects and tasks", "test",
            new([new("test", "schema", "test", "Projects and tasks", [
                new CreateEntityOperation("projects", "projects", "Projects", "projects"),
                new AddFieldOperation("p-name", "projects", "name", "Name", "name", NendoStorageKind.Text, true),
                new AddFieldOperation("p-code", "projects", "code", "Code", "code", NendoStorageKind.Text, false),
                new SetFieldUniqueOperation("p-code-unique", "projects", "code", true, 0),
                new CreateEntityOperation("tasks", "tasks", "Tasks", "tasks"),
                new AddFieldOperation("t-project", "tasks", "project", "Project", "project_id", NendoStorageKind.Reference, true),
                new AddFieldOperation("t-title", "tasks", "title", "Title", "title", NendoStorageKind.Text, true),
                new AddFieldOperation("t-estimate", "tasks", "estimate", "Estimate", "estimate", NendoStorageKind.Decimal, false),
                new AddFieldOperation("t-done", "tasks", "done", "Done", "done", NendoStorageKind.Boolean, false),
                new ConfigureReferenceOperation("bind", "tasks", "project", "projects", "name", 0),
            ])])));
        Assert.IsTrue((await workspace.Service.PromoteProposalAsync(schema.ProposalId)).Applied, JsonSerializer.Serialize(schema.Diagnostics));
        await workspace.Service.CreateRecordAsync(new("projects", "p1",
            new Dictionary<string, object?> { ["name"] = "Project", ["code"] = "P1" }, new("test", "p1", "test")));
        await workspace.Service.CreateRecordAsync(new("tasks", "t1",
            new Dictionary<string, object?> { ["title"] = "First", ["project"] = "p1" }, new("test", "t1", "test"), new Dictionary<string, long> { ["project"] = 1 }));
    }

    private static string Text(CallToolResult result) =>
        string.Join(' ', result.Content.OfType<TextContentBlock>().Select(block => block.Text));

    private static async Task<Dictionary<string, object?>> AcquireAsync(McpClient client)
    {
        var lease = await CallAsync<NendoLeaseGrant>(client, "nendo.lease.acquire");
        return new(StringComparer.Ordinal) { ["applicationHandle"] = lease.ApplicationHandle, ["leaseId"] = lease.LeaseId };
    }

    private static async Task<T> CallAsync<T>(McpClient client, string name, Dictionary<string, object?>? arguments = null) where T : notnull
    {
        var result = await client.CallToolAsync(name, arguments);
        Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
        Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
        return result.StructuredContent.Value.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"{name} did not return a {typeof(T).Name}.");
    }
}
