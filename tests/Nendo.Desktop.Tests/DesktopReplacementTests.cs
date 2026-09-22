using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using Nendo.Engine;
using Nendo.LocalMcp;

namespace Nendo.Desktop.Tests;

[TestClass]
[DoNotParallelize]
public sealed class DesktopReplacementTests
{
    [TestMethod]
    public async Task RestoreConfirmsProposalDiscardStopsLiveAgentAndReopensExactBackupWithFreshAuthority()
    {
        await using var workspace = new DesktopTestWorkspace();
        var discovery = PathIn(workspace, "discovery");
        await using var session = new DesktopSessionController(new(discovery), workspace.FileHistoryRoot);
        var created = await PopulateAsync(session, workspace.FilePath);
        var recentId = (await session.GetRecentFilesAsync()).Files.Single().Id;
        var backup = await session.PrepareBackupAsync(PathIn(workspace, "backup.nendo"), "backup");
        var copied = await session.CreateBackupAsync(backup.PlanId);
        Assert.IsTrue((await session.CreateBackupAsync(backup.PlanId)).IsIdempotentReplay);
        var backedUpHistory = JsonSerializer.Serialize(await session.GetHistoryAsync());
        await session.SetIdeaTitleAsync("idea-1", 1, "Displaced edit", "edit");
        var beforeRestore = await BytesAsync(workspace.FilePath);
        var proposal = await session.PrepareIdeaGardenProposalAsync();
        await session.SetAgentModeAsync("shapeApp");
        var firstDiscovery = Directory.GetFiles(discovery, "*.json").Single();
        await using var firstClient = await ConnectAsync(firstDiscovery);
        Assert.IsFalse((await firstClient.CallToolAsync("nendo.lease.acquire")).IsError ?? false);
        var plan = await session.PrepareRestoreAsync(PathIn(workspace, "backup.nendo"), "restore");
        Assert.AreEqual(1, plan.PendingProposalCount);

        var unconfirmed = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual("restore-proposals-pending", unconfirmed.Code);
        Assert.IsFalse(File.Exists(firstDiscovery));
        Assert.AreEqual("normal", (await session.GetViewAsync()).Health);
        Assert.AreEqual(proposal.ProposalId, (await session.GetProposalAsync(proposal.ProposalId)).ProposalId);
        CollectionAssert.AreEqual(beforeRestore, await BytesAsync(workspace.FilePath));

        await session.SetAgentModeAsync("shapeApp");
        var secondDiscovery = Directory.GetFiles(discovery, "*.json").Single();
        Assert.AreNotEqual(firstDiscovery, secondDiscovery);
        await using var secondClient = await ConnectAsync(secondDiscovery);
        Assert.IsFalse((await secondClient.CallToolAsync("nendo.lease.acquire")).IsError ?? false);
        var restored = await session.RestoreAsync(plan.PlanId, true);
        Assert.IsTrue(restored.Session.HasFile);
        Assert.AreEqual("normal", restored.Session.Health);
        Assert.IsNull(restored.Notice);
        Assert.AreEqual(copied.Manifest, restored.Session.Manifest);
        Assert.AreNotEqual(created.FileSessionId, restored.Session.FileSessionId);
        Assert.AreEqual("Original", Title(restored.Session));
        Assert.AreEqual(1L, restored.Session.Records.Single().RecordVersion);
        Assert.AreEqual(backedUpHistory, JsonSerializer.Serialize(await session.GetHistoryAsync()));
        Assert.IsEmpty(Directory.GetFiles(discovery, "*.json"));
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
        var staleProposal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.GetProposalAsync(proposal.ProposalId));
        Assert.AreEqual("proposal-not-found", staleProposal.Code);
        CollectionAssert.AreEqual(beforeRestore, await File.ReadAllBytesAsync(PathIn(workspace, restored.Restore.RetainedFileName)));
        Assert.IsTrue(File.Exists(PathIn(workspace, restored.Restore.ReceiptFileName)));
        Assert.AreEqual(recentId, (await session.GetRecentFilesAsync()).Files.Single().Id);
        Assert.IsFalse((await session.GetReplacementRecoveryAsync()).HasPendingReplacement);
        var payload = JsonSerializer.Serialize(restored);
        Assert.DoesNotContain("OpenObservation", payload);
        Assert.DoesNotContain("PhysicalFileKey", payload);
        Assert.DoesNotContain(JsonEncodedText.Encode(Path.GetDirectoryName(workspace.FilePath)!).ToString(), payload);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await Assert.ThrowsAsync<Exception>(() => secondClient.ListToolsAsync(cancellationToken: timeout.Token).AsTask());
        await session.SetIdeaTitleAsync("idea-1", 1, "Fresh session edit", "fresh-edit");
    }

    [TestMethod]
    public async Task CancelledConfirmationAndStalePlanPreserveTheCurrentSessionAndBytes()
    {
        await using var workspace = new DesktopTestWorkspace();
        var discovery = PathIn(workspace, "discovery");
        await using var session = new DesktopSessionController(new(discovery), workspace.FileHistoryRoot);
        await PopulateAsync(session, workspace.FilePath);
        var backup = await session.PrepareBackupAsync(PathIn(workspace, "backup.nendo"), "backup");
        await session.CreateBackupAsync(backup.PlanId);
        var plan = await session.PrepareRestoreAsync(PathIn(workspace, "backup.nendo"), "restore");
        await session.SetAgentModeAsync("editData");
        var originalDiscovery = Directory.GetFiles(discovery, "*.json").Single();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAsync<OperationCanceledException>(() => session.RestoreAsync(plan.PlanId, false, cancellation.Token));
        Assert.IsTrue(File.Exists(originalDiscovery));
        Assert.AreEqual("ready", (await session.GetAgentStatusAsync()).State);
        var edited = await session.SetIdeaTitleAsync("idea-1", 1, "Newer edit", "edit");
        var bytes = await BytesAsync(workspace.FilePath);
        var stale = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => session.RestoreAsync(plan.PlanId, false));
        Assert.AreEqual("restore-current-changed", stale.Code);
        var unchanged = await session.GetViewAsync();
        Assert.IsNotNull(edited.Session);
        Assert.AreEqual(edited.Session.FileSessionId, unchanged.FileSessionId);
        Assert.AreEqual(edited.Session.Manifest, unchanged.Manifest);
        Assert.AreEqual("Newer edit", Title(unchanged));
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
        Assert.IsFalse(File.Exists(originalDiscovery));
        CollectionAssert.AreEqual(bytes, await BytesAsync(workspace.FilePath));
        Assert.IsEmpty(Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!, "*.pre-restore-*.nendo"));
    }

    [TestMethod]
    public async Task RestoreOfInspectedRawCopyDoesNotDisplaceTheKnownWritableOriginal()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await PopulateAsync(session, workspace.FilePath);
        var originalRecent = (await session.GetRecentFilesAsync()).Files.Single().Id;
        var backup = await session.PrepareBackupAsync(PathIn(workspace, "backup.nendo"), "backup");
        await session.CreateBackupAsync(backup.PlanId);
        await session.CloseAsync();
        var originalBytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var rawCopy = PathIn(workspace, "raw.nendo");
        File.Copy(workspace.FilePath, rawCopy);
        await session.OpenReadOnlyAsync(rawCopy);
        var plan = await session.PrepareRestoreAsync(PathIn(workspace, "backup.nendo"), "restore");
        var result = await session.RestoreAsync(plan.PlanId, false);
        Assert.AreEqual("readOnly", result.Session.Health);
        Assert.IsNotNull(result.Notice);
        Assert.IsFalse(result.Session.Capabilities.Mutate);
        await session.CloseAsync();
        Assert.AreEqual("normal", (await session.OpenRecentAsync(originalRecent)).Health);
        CollectionAssert.AreEqual(originalBytes, await BytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task DeliberateRestoreTransfersOnlyTheDisplacedPhysicalObservationNotItsOldAlias()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await PopulateAsync(session, workspace.FilePath);
        var recentId = (await session.GetRecentFilesAsync()).Files.Single().Id;
        var backup = await session.PrepareBackupAsync(PathIn(workspace, "backup.nendo"), "backup");
        await session.CreateBackupAsync(backup.PlanId);
        await session.CloseAsync();
        var alias = PathIn(workspace, "alias.nendo");
        Assert.IsTrue(CreateHardLink(alias, workspace.FilePath, IntPtr.Zero), $"Win32 error {Marshal.GetLastWin32Error()}");
        await session.OpenAsync(workspace.FilePath);
        await using (var reader = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot))
            await reader.OpenReadOnlyAsync(alias);
        Assert.AreEqual("alias.nendo", (await session.GetRecentFilesAsync()).Files.Single().FileName);
        var plan = await session.PrepareRestoreAsync(PathIn(workspace, "backup.nendo"), "restore");
        Assert.AreEqual("normal", (await session.RestoreAsync(plan.PlanId, false)).Session.Health);
        var recent = (await session.GetRecentFilesAsync()).Files.Single();
        Assert.AreEqual(recentId, recent.Id);
        Assert.AreEqual("desktop-session.nendo", recent.FileName);
        await session.CloseAsync();
        var conflict = await Assert.ThrowsExactlyAsync<DesktopFileCollisionException>(() => session.OpenAsync(alias));
        Assert.AreEqual(recentId, conflict.Assessment.KnownOriginalRecentId);
    }

    [TestMethod]
    [DataRow(false)]
    [DataRow(true)]
    public async Task ReopenDoesNotAdoptAReplacedOrEditedPostActivationFile(bool editInPlace)
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await PopulateAsync(session, workspace.FilePath);
        var backup = await session.PrepareBackupAsync(PathIn(workspace, "backup.nendo"), "backup");
        await session.CreateBackupAsync(backup.PlanId);
        await session.SetIdeaTitleAsync("idea-1", 1, "Displaced", "edit");
        var plan = await session.PrepareRestoreAsync(PathIn(workspace, "backup.nendo"), "restore");
        session.BeforeReplacementReopenForTest = () =>
        {
            if (editInPlace)
            {
                using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
                {
                    DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
                }.ToString());
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "UPDATE idea SET title = 'Unexpected';";
                command.ExecuteNonQuery();
            }
            else
            {
                File.Move(workspace.FilePath, PathIn(workspace, "verified-result.nendo"));
                File.Copy(PathIn(workspace, "verified-result.nendo"), workspace.FilePath);
            }
        };
        var result = await session.RestoreAsync(plan.PlanId, false);
        Assert.IsNotNull(result.Notice);
        Assert.IsFalse(result.Session.HasFile);
        Assert.AreEqual("recoveryRequired", result.Session.Health);
        Assert.IsEmpty(result.Session.Records);
        Assert.IsFalse(result.Session.Capabilities.Mutate);
        Assert.IsTrue(File.Exists(PathIn(workspace, result.Restore.RetainedFileName)));
        Assert.AreEqual(result.Session, await session.GetViewAsync());
        Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
        Assert.IsFalse((await session.GetAgentStatusAsync()).Available);
        Assert.IsFalse((await session.GetReplacementRecoveryAsync()).HasPendingReplacement);
        session.BeforeReplacementReopenForTest = null;
        var inspected = await session.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual(editInPlace ? "Unexpected" : "Original", Title(inspected));
    }

    [TestMethod]
    public async Task ExplicitLegacyUpgradeReopensFreshWritableSessionAndPreservesOriginalHistory()
    {
        await using var workspace = new DesktopTestWorkspace();
        await using var session = new DesktopSessionController(fileHistoryRoot: workspace.FileHistoryRoot);
        await PopulateAsync(session, workspace.FilePath);
        var before = JsonSerializer.Serialize(await session.GetHistoryAsync());
        await session.CloseAsync();
        // Same recorded P1 production layout fixture as Engine upgrade tests;
        // this strips only empty semantic extension metadata from the owned file.
        await using (var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = workspace.FilePath, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString()))
        {
            await connection.OpenAsync();
            await using var command = connection.CreateCommand();
            command.CommandText = """
                DROP TABLE __nendo_ui_property;
                DROP INDEX __nendo_ui_node_surface;
                DROP TABLE __nendo_ui_node;
                ALTER TABLE __nendo_field DROP COLUMN options_json;
                ALTER TABLE __nendo_field DROP COLUMN presentation;
                ALTER TABLE __nendo_revision DROP COLUMN compensation_of_revision_id;
                ALTER TABLE __nendo_revision DROP COLUMN proposal_digest;
                ALTER TABLE __nendo_revision DROP COLUMN proposal_id;
                """;
            await command.ExecuteNonQueryAsync();
        }
        var originalBytes = await File.ReadAllBytesAsync(workspace.FilePath);
        var legacy = await session.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual("recoveryRequired", legacy.Health);
        var plan = await session.PrepareUpgradeAsync("upgrade");
        var upgraded = await session.UpgradeAsync(plan.PlanId);
        Assert.IsNull(upgraded.Notice);
        Assert.AreEqual("normal", upgraded.Session.Health);
        Assert.AreEqual(legacy.Manifest! with { MinimumHostVersion = "1.1.0" }, upgraded.Session.Manifest);
        Assert.AreNotEqual(legacy.FileSessionId, upgraded.Session.FileSessionId);
        Assert.AreEqual(before, JsonSerializer.Serialize(await session.GetHistoryAsync()));
        Assert.AreEqual("Original", Title(upgraded.Session));
        CollectionAssert.AreEqual(originalBytes, await File.ReadAllBytesAsync(PathIn(workspace, upgraded.Upgrade.RetainedFileName)));
        Assert.AreEqual("off", (await session.GetAgentStatusAsync()).Mode);
        Assert.DoesNotContain("OpenObservation", JsonSerializer.Serialize(upgraded));
        await session.SetIdeaTitleAsync("idea-1", 1, "After upgrade", "edit");
    }

    private static async Task<DesktopSessionView> PopulateAsync(DesktopSessionController session, string path)
    {
        await session.CreateAsync(path);
        await session.CreateIdeaSchemaAsync("schema");
        var created = await session.CreateIdeaRecordAsync("idea-1", "Original", "record");
        Assert.IsNotNull(created.Session);
        return created.Session;
    }

    private static string PathIn(DesktopTestWorkspace workspace, string name) => Path.Combine(Path.GetDirectoryName(workspace.FilePath)!, name);
    private static string? Title(DesktopSessionView view) => view.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString();

    private static async Task<byte[]> BytesAsync(string path)
    {
        await using var source = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        using var result = new MemoryStream();
        await source.CopyToAsync(result);
        return result.ToArray();
    }

    private static async Task<McpClient> ConnectAsync(string discoveryPath)
    {
        using var discovery = JsonDocument.Parse(await File.ReadAllTextAsync(discoveryPath));
        var transport = new HttpClientTransport(new HttpClientTransportOptions
        {
            Endpoint = new Uri(discovery.RootElement.GetProperty("endpoint").GetString()!),
            TransportMode = HttpTransportMode.StreamableHttp, ConnectionTimeout = TimeSpan.FromSeconds(5),
        });
        return await McpClient.CreateAsync(transport, new McpClientOptions
        {
            ClientInfo = new Implementation { Name = "nendo-desktop-lifecycle-tests", Version = "1.0.0" },
            ProtocolVersion = "2026-07-28", InitializationTimeout = TimeSpan.FromSeconds(5),
        });
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateHardLinkW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateHardLink(string fileName, string existingFileName, IntPtr securityAttributes);
}
