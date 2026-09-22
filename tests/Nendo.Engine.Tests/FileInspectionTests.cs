using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace Nendo.Engine.Tests;

[TestClass]
public sealed class FileInspectionTests
{
    [TestMethod]
    public async Task EmptyInspectionGrantsNoWriterAndPreservesBytesAndDirectory()
    {
        await using var workspace = new EngineTestWorkspace();
        var created = await workspace.CreateAsync();
        var manifest = (await created.GetSnapshotAsync()).Manifest;
        await CloseAsync(workspace, created);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);

        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);

        Assert.AreEqual(NendoOpenClassification.NormalReadOnly, inspection.Classification);
        Assert.AreEqual("production-semantic-v1", inspection.Layout);
        Assert.AreEqual(manifest, inspection.Manifest);
        Assert.IsTrue(inspection.CanAcquireWriteAuthority);
        Assert.IsTrue(inspection.Capabilities.ReadData);
        Assert.IsFalse(inspection.Capabilities.Mutate);
        Assert.IsFalse(inspection.Capabilities.AgentAccess);
        Assert.IsEmpty(inspection.Findings);
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
    }

    [TestMethod]
    public async Task ReadOnlyApplicationUsesExactDataAndHistoryAndDeniesAllMutationLanes()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var service = new NendoApplicationService(original);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        await service.PromoteProposalAsync(proposal.ProposalId);
        await service.CreateIdeaRecordAsync("idea-1", "Keep this record", "record");
        var snapshot = await service.GetSnapshotAsync();
        var history = await service.GetHistoryAsync();
        var plan = (await service.CompileSemanticUiAsync()).App();
        await CloseAsync(workspace, original);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);

        await using (var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath))
        {
            var read = new NendoApplicationService(reader);
            Assert.AreEqual(NendoSessionHealth.ReadOnly, reader.Health);
            Assert.IsFalse(reader.Capabilities.Mutate);
            Assert.IsTrue(reader.Capabilities.CustomSurfaces);
            Assert.AreEqual(snapshot.Manifest, (await read.GetSnapshotAsync()).Manifest);
            Assert.AreEqual(JsonSerializer.Serialize(history), JsonSerializer.Serialize(await read.GetHistoryAsync()));
            Assert.AreEqual(plan.Digest, (await read.CompileSemanticUiAsync()).App().Digest);
            Assert.AreEqual("Keep this record", (await read.GetSnapshotAsync()).Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => read.CreateIdeaRecordAsync("idea-2", "Denied", "denied-create"));
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => read.SetFieldAsync(new(
                NendoApplicationService.IdeaEntityId, "idea-1", NendoApplicationService.IdeaTitleFieldId, 1, "Denied", new("test", "denied-edit", "test"))));
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => read.ExecuteCommandAsync(new(
                plan.Surfaces.Single(node => node.Kind == "recordCommand").SemanticId, "idea-1", 1, new("test", "denied-command", "test"))));
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => read.PrepareBoardTitleProposalAsync("Denied"));
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => read.CompensateRevisionAsync(history[^1].RevisionId, "denied-compensation"));
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => read.PromoteProposalAsync("not-owned"));
            await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => read.CreateIdeaSchemaAsync("denied-schema"));
            Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
            Assert.ThrowsExactly<IOException>(() => File.Move(workspace.FilePath, workspace.FilePath + ".moved"));
        }
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
        var reopened = await workspace.OpenAsync();
        Assert.AreEqual(NendoOpenClassification.NormalWritable, reopened.Inspection!.Classification);
        Assert.IsTrue(reopened.Capabilities.Mutate);
    }

    [TestMethod]
    [DataRow("PRAGMA user_version = 999;", "unsupported-format")]
    [DataRow("PRAGMA application_id = 12;", "not-nendo")]
    [DataRow("UPDATE __nendo_manifest SET minimum_host_version = '999.0.0';", "unsupported-host-version")]
    [DataRow("UPDATE __nendo_manifest SET minimum_host_version = 'invalid';", "unsupported-host-version")]
    [DataRow("UPDATE __nendo_manifest SET instance_id = '';", "invalid-manifest")]
    [DataRow("ALTER TABLE __nendo_field ADD COLUMN guessed TEXT;", "unknown-protected-schema")]
    [DataRow("CREATE TRIGGER hidden AFTER INSERT ON __nendo_entity BEGIN DELETE FROM __nendo_field; END;", "unknown-protected-schema")]
    public async Task UnsupportedFilesAreRejectedBeforeWritableOpenAndRemainUnchanged(string sql, string code)
    {
        await using var workspace = new EngineTestWorkspace();
        await CloseAsync(workspace, await workspace.CreateAsync());
        await ChangeFixtureAsync(workspace.FilePath, sql);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.Rejected, inspection.Classification);
        Assert.AreEqual(code, inspection.Findings.Single().Code);
        Assert.IsFalse(inspection.Capabilities.ReadData);
        var failure = await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
        Assert.AreEqual(code, failure.Inspection.Findings.Single().Code);
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
    }

    [TestMethod]
    [DataRow("{not-json")]
    [DataRow("\"unknown-entity\"")]
    public async Task BrokenCustomDefinitionsDoNotHideTrustedData(string invalidProperty)
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var service = new NendoApplicationService(original);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        await service.PromoteProposalAsync(proposal.ProposalId);
        await service.CreateIdeaRecordAsync("idea-1", "Data survives a broken view", "record");
        await CloseAsync(workspace, original);
        await ChangeFixtureAsync(workspace.FilePath, "UPDATE __nendo_ui_property SET value_json = @value WHERE property_name = 'entityId';", invalidProperty);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);

        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, reader.Inspection!.Classification);
        Assert.IsTrue(reader.Inspection.Findings.Any(finding => finding.Code == "invalid-surface"));
        Assert.IsFalse(reader.Capabilities.CustomSurfaces);
        Assert.IsFalse(reader.Capabilities.AgentAccess);
        Assert.IsFalse((await new NendoApplicationService(reader).CompileSemanticUiAsync()).IsValid);
        Assert.AreEqual("Data survives a broken view", (await reader.GetSnapshotAsync()).Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task UnknownScalarKindRetainsItsNameAndValuesInRestrictedInspection()
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var service = new NendoApplicationService(original);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Unknown but readable", "record");
        await CloseAsync(workspace, original);
        await ChangeFixtureAsync(workspace.FilePath, "UPDATE __nendo_field SET storage_kind = 'FutureScalar';");
        var before = await File.ReadAllBytesAsync(workspace.FilePath);

        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, reader.Inspection!.Classification);
        Assert.IsTrue(reader.Inspection.Findings.Any(finding => finding.Code == "unsupported-field-semantics"));
        var snapshot = await reader.GetSnapshotAsync();
        Assert.AreEqual(NendoStorageKind.Unsupported, snapshot.Entities.Single().Fields.Single().StorageKind);
        Assert.AreEqual("FutureScalar", snapshot.Entities.Single().Fields.Single().UnsupportedStorageKind);
        Assert.AreEqual("Unknown but readable", snapshot.Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.ThrowsExactly<ArgumentException>(() => new AddFieldOperation("op", "entity", "field", "Field", "field", NendoStorageKind.Unsupported, false));
    }

    [TestMethod]
    public async Task ActualReadOnlyAttributeRequiresNoWritableConnectionOrOwnerFile()
    {
        await using var workspace = new EngineTestWorkspace();
        await CloseAsync(workspace, await workspace.CreateAsync());
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        File.SetAttributes(workspace.FilePath, FileAttributes.ReadOnly);
        try
        {
            await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
            Assert.AreEqual(NendoOpenClassification.NormalReadOnly, reader.Inspection!.Classification);
            Assert.IsFalse(reader.Inspection.CanAcquireWriteAuthority);
            Assert.IsTrue(reader.Inspection.Findings.Any(finding => finding.Code == "file-read-only"));
            await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
            Assert.IsFalse(File.Exists(workspace.FilePath + ".write-owner"));
            CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        }
        finally
        {
            File.SetAttributes(workspace.FilePath, FileAttributes.Normal);
        }
    }

    [TestMethod]
    [DataRow("-journal")]
    [DataRow("-wal")]
    [DataRow("-shm")]
    public async Task UnqualifiedOperationalSetIsNotOpenedOrRepaired(string suffix)
    {
        await using var workspace = new EngineTestWorkspace();
        await CloseAsync(workspace, await workspace.CreateAsync());
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        var derivative = workspace.FilePath + suffix;
        await File.WriteAllBytesAsync(derivative, [1, 2, 3, 4]);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, inspection.Classification);
        Assert.AreEqual("operational-sidecars", inspection.Findings.Single().Code);
        Assert.IsFalse(inspection.Capabilities.ReadData);
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        CollectionAssert.AreEqual(new byte[] { 1, 2, 3, 4 }, await File.ReadAllBytesAsync(derivative));
        Assert.HasCount(2, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
    }

    /// <summary>
    /// W-038 / F-040 / F-043. The size bound is measured at its exact edge rather than
    /// trusted, and the sentence a person is refused with is checked against the number
    /// the decision records.
    /// <para>
    /// The bound this replaces reached people as the words "64 MiB" and existed nowhere
    /// else — no ADR, no contract, no test — so changing it could not fail anything. The
    /// literal here is deliberate: it is pinned to the 2026-09-16 amendment to ADR-0012,
    /// and moving the constant without amending that entry is what this fails on.
    /// </para>
    /// </summary>
    [TestMethod]
    public async Task TheSizeBoundRefusesOneByteOverAndSaysWhichBoundItIs()
    {
        await using var workspace = new EngineTestWorkspace();
        var limit = Nendo.Engine.Storage.SqliteNendoStore.MaximumInspectionFileBytes;
        Assert.AreEqual(256L * 1024 * 1024, limit,
            "The open bound is the one the 2026-09-16 amendment to ADR-0012 records. Move it there in the same change, or a person is told a number nothing wrote down.");

        // One byte over is refused by length alone, before SQLite is asked to open it.
        await using (var over = File.Create(workspace.FilePath)) over.SetLength(limit + 1);
        var refused = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.Rejected, refused.Classification);
        var finding = refused.Findings.Single();
        Assert.AreEqual("inspection-limit", finding.Code);
        StringAssert.Contains(finding.Message, "256 MiB",
            "The refusal names the bound, and names it from the constant rather than from prose typed beside it.");
        Assert.IsFalse(refused.Capabilities.ReadData);

        // Exactly at the bound is not over it. The length gate lets this through, so the
        // refusal that follows is about the content — which is what proves the edge is
        // where the constant says and not one byte to either side of it.
        await using (var at = File.Create(workspace.FilePath)) at.SetLength(limit);
        var atLimit = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreNotEqual("inspection-limit", atLimit.Findings.Single().Code,
            "A file of exactly the bound was refused for its size; the comparison is off by one.");
    }

    [TestMethod]
    public async Task MissingCorruptAndCancelledInspectionHaveNoSideEffects()
    {
        await using var workspace = new EngineTestWorkspace();
        Assert.AreEqual("file-missing", (await NendoWriteCoordinator.InspectAsync(workspace.FilePath)).Findings.Single().Code);
        await File.WriteAllBytesAsync(workspace.FilePath, [1, 2, 3, 4]);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.Rejected, inspection.Classification);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsExactlyAsync<OperationCanceledException>(() => NendoWriteCoordinator.InspectAsync(workspace.FilePath, cancellation.Token));
        CollectionAssert.AreEqual(new byte[] { 1, 2, 3, 4 }, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
    }

    [TestMethod]
    [DataRow("UPDATE __nendo_revision SET operation_digest = 'bad' WHERE change_sequence = 0;", "history-inconsistent")]
    [DataRow("UPDATE __nendo_manifest SET data_revision = data_revision + 1;", "revision-mismatch")]
    [DataRow("CREATE TABLE unexpected (value TEXT);", "mapping-drift")]
    [DataRow("UPDATE __nendo_field SET required = 0;", "mapping-drift")]
    [DataRow("UPDATE __nendo_operation SET canonical_json = '{}' WHERE ordinal = 0;", "history-inconsistent")]
    public async Task DriftCannotBecomeWritableAlthoughKnownRecordsRemainReadable(string sql, string code)
    {
        await using var workspace = new EngineTestWorkspace();
        var original = await workspace.CreateAsync();
        var service = new NendoApplicationService(original);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Preserved", "record");
        await CloseAsync(workspace, original);
        await ChangeFixtureAsync(workspace.FilePath, sql);
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual(NendoOpenClassification.RecoveryRequired, reader.Inspection!.Classification);
        Assert.IsTrue(reader.Inspection.Findings.Any(finding => finding.Code == code));
        Assert.IsFalse(reader.Capabilities.Mutate);
        Assert.IsFalse(reader.Capabilities.Backup);
        Assert.AreEqual("Preserved", (await reader.GetSnapshotAsync()).Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
    }

    [TestMethod]
    public async Task WalHeaderWithoutSidecarsIsRejectedBeforeSqliteCanCreateDerivatives()
    {
        await using var workspace = new EngineTestWorkspace();
        await CloseAsync(workspace, await workspace.CreateAsync());
        await ChangeFixtureAsync(workspace.FilePath, "PRAGMA journal_mode = WAL;");
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
        var before = await File.ReadAllBytesAsync(workspace.FilePath);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual("unsupported-journal", inspection.Findings.Single().Code);
        Assert.IsFalse(inspection.Capabilities.ReadData);
        await Assert.ThrowsExactlyAsync<NendoFileOpenException>(() => workspace.OpenAsync());
        CollectionAssert.AreEqual(before, await File.ReadAllBytesAsync(workspace.FilePath));
        Assert.HasCount(1, Directory.GetFiles(Path.GetDirectoryName(workspace.FilePath)!));
    }

    [TestMethod]
    public async Task ReadOnlyObservationDoesNotSilentlyAdoptLaterWriterState()
    {
        await using var workspace = new EngineTestWorkspace();
        var writer = await workspace.CreateAsync();
        var service = new NendoApplicationService(writer);
        await service.CreateIdeaSchemaAsync("schema");
        await service.CreateIdeaRecordAsync("idea-1", "Observed", "record");
        await using var reader = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        await service.SetIdeaTitleAsync("idea-1", 1, "Later", "edit");
        Assert.AreEqual("Observed", (await reader.GetSnapshotAsync()).Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        await using var refreshed = await NendoWriteCoordinator.OpenReadOnlyAsync(workspace.FilePath);
        Assert.AreEqual("Later", (await refreshed.GetSnapshotAsync()).Records.Single().Values[NendoApplicationService.IdeaTitleFieldId].GetString());
        Assert.IsFalse(refreshed.Capabilities.Mutate);
    }

    /// <summary>
    /// The write path is bounded by the same number the open path uses, so Nendo cannot
    /// write a file it will not open (F-040, W-039).
    /// </summary>
    /// <remarks>
    /// The file is grown to the ceiling rather than filled to it: the bytes past SQLite's
    /// own pages are never read, and the check measures the file rather than the pages, so
    /// this exercises the real bound at full scale without writing a quarter of a gigabyte.
    /// <para>
    /// Three things are asserted, and the third is the one that matters: the write is
    /// refused, nothing was committed, and the file still opens afterwards. A guard that
    /// only checked the refusal would pass against a version that refused *and* left the
    /// file damaged, which is the failure this exists to prevent.
    /// </para>
    /// </remarks>
    [TestMethod]
    public async Task AWriteIsRefusedBeforeItCanLeaveTheFileTooLargeToOpen()
    {
        await using var workspace = new EngineTestWorkspace();
        var created = await workspace.CreateAsync();
        var service = new NendoApplicationService(created);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        await service.PromoteProposalAsync(proposal.ProposalId);
        await service.CreateIdeaRecordAsync("idea-1", "Written under the ceiling", "record");
        var before = (await created.GetSnapshotAsync()).Manifest.ChangeSequence;
        await CloseAsync(workspace, created);

        var ceiling = Nendo.Engine.Storage.SqliteNendoStore.WriteCeilingFileBytes;
        Assert.AreEqual(
            Nendo.Engine.Storage.SqliteNendoStore.MaximumInspectionFileBytes - Nendo.Engine.Storage.SqliteNendoStore.WriteHeadroomFileBytes,
            ceiling,
            "The write ceiling is derived from the open bound. Typed separately, the two drift apart and a person is told a number nothing enforces.");
        Assert.IsLessThan(Nendo.Engine.Storage.SqliteNendoStore.MaximumInspectionFileBytes, ceiling,
            "The ceiling has to sit below the bound, or the last accepted write is the one that strands the file.");
        using (var pad = new FileStream(workspace.FilePath, FileMode.Open, FileAccess.Write)) pad.SetLength(ceiling);

        await using var reopened = await workspace.OpenAsync();
        var full = new NendoApplicationService(reopened);
        var refused = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(
            () => full.CreateIdeaRecordAsync("idea-2", "Written over the ceiling", "over"));
        StringAssert.Contains(refused.Message, "256 MiB",
            "The refusal names the bound from the constant, which is the discipline F-043 cost us.");
        StringAssert.Contains(refused.Message, "still opens",
            "A person told their write was refused needs to know the file is not the casualty.");

        // The other way in. A promotion replays validated operations into the active file
        // through a different entry point, and a bound enforced on one of the two would be
        // a bound an agent can walk around by sending a change set instead.
        var proposalId = "proposal-" + Guid.NewGuid().ToString("N");
        await reopened.BeginProposalAsync(proposalId, "Written over the ceiling", "test", new([
            new NendoMutation("test", "proposal-over", "test", "Written over the ceiling", [
                new CreateRecordOperation("over-record", NendoApplicationService.IdeaEntityId, "idea-3",
                    new Dictionary<string, object?>(StringComparer.Ordinal)
                    {
                        [NendoApplicationService.IdeaTitleFieldId] = "Written over the ceiling",
                    }),
            ]),
        ]));
        var refusedPromotion = await reopened.PromoteProposalAsync(proposalId);
        Assert.IsFalse(refusedPromotion.Applied,
            "A promotion meets the same ceiling, or the bound is one an agent walks around by sending a change set instead.");
        StringAssert.Contains(refusedPromotion.Message, "256 MiB",
            "The promotion path reports the reason the active file gave. Refusing without it leaves a person a bound that does not say where it came from, which is F-043 by another route.");
        StringAssert.Contains(refusedPromotion.Message, "still opens",
            "Both paths say the same thing about the file they refused to grow.");

        Assert.AreEqual(before, (await reopened.GetSnapshotAsync()).Manifest.ChangeSequence,
            "The refusal happens before anything is staged, so the change sequence has not moved.");
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreNotEqual("inspection-limit", inspection.Findings.FirstOrDefault()?.Code,
            "The file the write was refused on must still open. That is the whole point of refusing.");
        Assert.IsTrue(inspection.Capabilities.ReadData);
    }

    /// <summary>
    /// The reserve below each ceiling is large enough that no single commit can cross it.
    /// </summary>
    /// <remarks>
    /// The ceiling only works if a write cannot jump from under it to over the bound, and
    /// what a commit costs is not known until it is made. So the worst case is measured
    /// rather than reasoned about: the largest change this product accepts is a change set
    /// at the published 128-operation ceiling, and here it carries records of the size the
    /// 2026-09-16 amendment measured, 1,306 bytes of text each.
    /// </remarks>
    [TestMethod]
    public async Task NoSingleCommitCanCrossTheReserveBelowTheCeiling()
    {
        await using var workspace = new EngineTestWorkspace();
        var created = await workspace.CreateAsync();
        var service = new NendoApplicationService(created);
        var proposal = await service.PrepareIdeaGardenProposalAsync();
        await service.PromoteProposalAsync(proposal.ProposalId);

        var text = new string('x', 1_306);
        var operations = Enumerable.Range(0, 128)
            .Select(index => (NendoOperation)new CreateRecordOperation(
                $"bulk-{index}", NendoApplicationService.IdeaEntityId, $"bulk-idea-{index}",
                new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    [NendoApplicationService.IdeaTitleFieldId] = text,
                }))
            .ToArray();

        var before = new FileInfo(workspace.FilePath).Length;
        await created.ApplyAsync(new NendoMutation("test", "bulk", "test", "The largest commit this product accepts", operations));
        var growth = new FileInfo(workspace.FilePath).Length - before;

        Assert.IsGreaterThan(0, growth, "The commit did not grow the file, so this measures nothing.");
        Assert.IsLessThan(Nendo.Engine.Storage.SqliteNendoStore.WriteHeadroomFileBytes / 4, growth,
            $"A commit of 128 operations grew the file by {growth} bytes against a reserve of " +
            $"{Nendo.Engine.Storage.SqliteNendoStore.WriteHeadroomFileBytes}. The reserve has to stay comfortably " +
            "larger than the largest commit, or a write accepted under the ceiling lands over the open bound.");

        Assert.IsLessThan(Nendo.Engine.Storage.SqliteNendoStore.WriteHeadroomRows, (long)operations.Length + 1,
            "The row reserve has to exceed the operation rows one commit writes, plus its revision row.");
    }

    private static async Task CloseAsync(EngineTestWorkspace workspace, NendoWriteCoordinator coordinator)
    {
        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
    }

    private static async Task ChangeFixtureAsync(string path, string sql, string? value = null)
    {
        await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path, Mode = SqliteOpenMode.ReadWrite, Pooling = false,
        }.ToString());
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        if (value is not null)
        {
            command.Parameters.AddWithValue("@value", value);
        }
        await command.ExecuteNonQueryAsync();
    }
}
