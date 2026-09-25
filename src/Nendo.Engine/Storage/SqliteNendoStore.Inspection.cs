using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Nendo.Engine.Storage;

internal sealed record InspectedNendoFile(
    NendoFileInspection Inspection,
    NendoSessionSnapshot? Snapshot,
    IReadOnlyList<NendoRevisionSnapshot> History,
    string? ContentDigest = null);

internal sealed partial class SqliteNendoStore
{
    /// <summary>
    /// How large a file may be and still be opened. The bound exists because opening a
    /// file inspects the whole of it before any capability is granted, so the cost of
    /// being wrong about a file is paid at open; it is not a statement about how much
    /// data the format can hold.
    /// <para>
    /// Raised from 64 MiB to 256 MiB on 2026-09-16 (W-038, F-040), after two files that
    /// Nendo itself had written could not be reopened. Measured at this size: a record
    /// carrying 1,306 bytes of text costs 3,554 bytes on disk, a multiple of 2.72, so
    /// this bound is reached at about 75,500 such records — where 64 MiB was reached at
    /// about 18,900. One cold open of a file at this size costs about 6.6 seconds, which
    /// is the whole of what this bound is bounding; the ADR-0012 amendment carries the
    /// measurements at every size between.
    /// </para>
    /// <para>
    /// Whoever changes it next: say why here, and change nothing else. The sentence a
    /// person is shown is derived from this constant rather than written beside it,
    /// because the previous number reached people as prose and was never written down
    /// anywhere else (F-043).
    /// </para>
    /// </summary>
    internal const long MaximumInspectionFileBytes = 256L * 1024 * 1024;

    /// <summary>
    /// How many rows the audit and definition tables may carry and still be inspected.
    /// Counted per table over <c>__nendo_entity</c>, <c>__nendo_field</c>,
    /// <c>__nendo_revision</c> and <c>__nendo_operation</c>.
    /// <para>
    /// Deliberately not raised with the byte bound in 2026-09-16. It is the wall that
    /// binds next: <c>__nendo_operation</c> carries one row per record write and one per
    /// later edit, measured at 10,003 rows for 10,000 records, so a file reaches this
    /// bound at about 100,000 writes whatever they weigh. Moving it is its own call with
    /// its own cost, and is named as the open question in the ADR-0012 amendment.
    /// </para>
    /// </summary>
    internal const long MaximumInspectionRows = 100_000;

    /// <summary>
    /// How much room is kept below each open bound for the write about to be made.
    /// <para>
    /// This is headroom, not a measurement, and the distinction matters: what a commit
    /// costs is not known until it is made, so the ceiling has to sit far enough below the
    /// bound that no single write can cross the gap. The figures are justified by measuring
    /// the largest commit the suite produces and asserting it stays well inside them,
    /// rather than by reasoning about what a large write might be.
    /// </para>
    /// <para>
    /// Raised from 4 MiB to 32 MiB on 2026-09-25 (ADR-0013), when custom-view packages moved
    /// into the file: a change set may carry <see cref="NendoExtensionLimits.ContentBytesPerChangeSet"/>
    /// of new file content in one commit, which is now the largest commit the product accepts.
    /// The reserve keeps several times that, so the write ceiling is 224 MiB.
    /// </para>
    /// </summary>
    internal const long WriteHeadroomFileBytes = 32L * 1024 * 1024;

    /// <inheritdoc cref="WriteHeadroomFileBytes"/>
    internal const long WriteHeadroomRows = 1_000;

    /// <summary>
    /// The size a file may reach and still accept a write, derived from the open bound so
    /// the two cannot part company. Past this a mutation is refused before anything is
    /// staged, which is what stops Nendo writing a file it will not open (F-040, W-039).
    /// </summary>
    internal const long WriteCeilingFileBytes = MaximumInspectionFileBytes - WriteHeadroomFileBytes;

    /// <inheritdoc cref="WriteCeilingFileBytes"/>
    internal const long WriteCeilingRows = MaximumInspectionRows - WriteHeadroomRows;

    /// <summary>The bound as a person is told it, so the number is never typed twice.</summary>
    private static string InspectionLimitText =>
        $"{MaximumInspectionFileBytes / (1024 * 1024)} MiB";

    /// <summary>
    /// Refuses a write that would leave the file too large to open again.
    /// </summary>
    /// <remarks>
    /// Both bounds are checked, because they are reached by different files. Bytes arrive
    /// first for records carrying text; rows arrive first for small records, and for a file
    /// edited as much as it is written, since <c>__nendo_operation</c> carries one row per
    /// write and one per later edit. Guarding only the one that was reported would leave an
    /// identical trap one step over.
    /// <para>
    /// Sits beside <see cref="RequireSupportedWritableLayoutAsync"/> and after the replay
    /// check, so an idempotent replay is never refused: it commits nothing and cannot make
    /// the file larger.
    /// </para>
    /// </remarks>
    private async Task RequireRoomToGrowAsync(SqliteTransaction transaction, CancellationToken cancellationToken)
    {
        var bytes = new FileInfo(_path).Length;
        if (bytes >= WriteCeilingFileBytes)
        {
            throw new NendoPreconditionException("write-ceiling-bytes",
                $"This file is {bytes / (1024 * 1024)} MiB and Nendo opens files up to {InspectionLimitText}. " +
                "The write was refused and nothing was changed, so the file still opens. " +
                "Export what you need or start a new file.");
        }
        var rows = Convert.ToInt64(
            await ScalarAsync("SELECT COUNT(*) FROM __nendo_operation;", transaction, cancellationToken),
            CultureInfo.InvariantCulture);
        if (rows >= WriteCeilingRows)
        {
            throw new NendoPreconditionException("write-ceiling-rows",
                $"This file has recorded {rows} changes and Nendo opens files up to {MaximumInspectionRows}. " +
                "The write was refused and nothing was changed, so the file still opens. " +
                "Export what you need or start a new file.");
        }
    }
    private static readonly Lazy<Task<IReadOnlyDictionary<string, string>>> KnownLayouts = new(BuildKnownLayoutsAsync);

    internal static async Task<InspectedNendoFile> InspectAsync(
        string path,
        CancellationToken cancellationToken,
        bool ignoreReplacementMarker = false)
    {
        using var inspectionTiming = NendoStartupDiagnostics.Source.StartActivity("engine.inspection");
        using var layoutTiming = NendoStartupDiagnostics.Source.StartActivity("engine.inspection.layout");
        cancellationToken.ThrowIfCancellationRequested();
        var observedAt = DateTimeOffset.UtcNow;
        if (!File.Exists(path))
        {
            return Unreadable("file-missing", "The selected file is no longer available.", observedAt);
        }
        // Opening a WAL database can create derivatives even for a read-only
        // connection. Do not open an unqualified operational set at all.
        if (new[] { "-journal", "-wal", "-shm" }.Any(suffix => File.Exists(path + suffix)))
        {
            return Unreadable("operational-sidecars", "This file has an unfinished or unsupported storage operation. Close its writer before inspecting it.", observedAt, recovery: true);
        }
        try
        {
            using var pin = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (pin.Length > MaximumInspectionFileBytes)
            {
                return Unreadable("inspection-limit", $"This file exceeds the current {InspectionLimitText} inspection limit. Its contents have not been changed.", observedAt);
            }
            var header = new byte[20];
            if (pin.Length >= header.Length)
            {
                await pin.ReadExactlyAsync(header, cancellationToken);
                if (header.AsSpan(0, 16).SequenceEqual("SQLite format 3\0"u8) &&
                    (header[18] != 1 || header[19] != 1))
                {
                    return Unreadable("unsupported-journal", "This file uses an unsupported storage read/write profile. It was not opened by SQLite or changed.", observedAt, recovery: true);
                }
            }
            await using var connection = await OpenConnectionAsync(path, SqliteOpenMode.ReadOnly, cancellationToken);
            var store = new SqliteNendoStore(path, connection);
            await store.NonQueryAsync("PRAGMA query_only = ON;", null, cancellationToken);
            await store.NonQueryAsync($"PRAGMA busy_timeout = {BusyTimeoutMilliseconds};", null, cancellationToken);
            // SQL BEGIN keeps all existing read helpers in one SQLite snapshot
            // without exposing a transaction outside storage. Disposal rolls it back.
            await store.NonQueryAsync("BEGIN DEFERRED;", null, cancellationToken);

            var marker = Convert.ToInt64(await store.ScalarAsync("PRAGMA application_id;", null, cancellationToken), CultureInfo.InvariantCulture);
            var version = Convert.ToInt64(await store.ScalarAsync("PRAGMA user_version;", null, cancellationToken), CultureInfo.InvariantCulture);
            if (marker != NendoFormat.SqliteApplicationId)
            {
                return Unreadable("not-nendo", "The selected file is not a supported Nendo application.", observedAt);
            }
            if (version != NendoFormat.CurrentVersion)
            {
                return Unreadable("unsupported-format", "This core file format is not supported by this Nendo version. No upgrade or repair was attempted.", observedAt);
            }
            if (!string.Equals(Convert.ToString(await store.ScalarAsync("PRAGMA integrity_check;", null, cancellationToken), CultureInfo.InvariantCulture), "ok", StringComparison.Ordinal))
            {
                return Unreadable("integrity-failed", "The file did not pass its integrity check. Preserve it and open a verified backup separately.", observedAt);
            }

            var layoutSignature = await store.ProtectedSchemaSignatureAsync(cancellationToken);
            var layouts = await KnownLayouts.Value.WaitAsync(cancellationToken);
            var layout = layouts.FirstOrDefault(pair => pair.Value == layoutSignature).Key;
            if (layout is null)
            {
                return Unreadable("unknown-protected-schema", "The protected file structure is not a recognised production layout. No repair was attempted.", observedAt);
            }
            var manifest = await store.ReadManifestAsync(null, cancellationToken);
            if (manifest.FormatIdentifier != NendoFormat.Identifier || manifest.FormatVersion != version ||
                string.IsNullOrWhiteSpace(manifest.ApplicationId) || string.IsNullOrWhiteSpace(manifest.InstanceId) ||
                manifest.DefinitionRevision < 0 || manifest.DataRevision < 0 || manifest.ChangeSequence < 0)
            {
                return Unreadable("invalid-manifest", "The protected application identity or revision metadata is invalid.", observedAt);
            }
            if (!Version.TryParse(manifest.MinimumHostVersion, out var minimumHost) ||
                minimumHost > Version.Parse(NendoFormat.CurrentHostVersion))
            {
                return Unreadable("unsupported-host-version", "This file requires a newer or unrecognised Nendo host version.", observedAt);
            }
            if (layout == "production-p1-v1" && manifest.MinimumHostVersion != NendoFormat.MinimumHostVersion)
            {
                return Unreadable("layout-version-mismatch", "The older protected layout does not match the declared host version. It is not treated as an upgradeable file.", observedAt);
            }

            var findings = new List<NendoOpenFinding>();
            if (layout.Contains("-extension-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.ExtensionPackagesMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "Custom-view packages require the declared package-capable host version.", observedAt);
            if (layout.Contains("-purpose-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.ApplicationPurposeMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "A stored purpose requires the declared purpose-capable host version.", observedAt);
            if (layout.Contains("-scale-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.GalleryAndRatingMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "A rating scale requires the declared rating-capable host version.", observedAt);
            if (layout.Contains("-tone-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.ColourAndHeaderMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "Choice colour metadata requires the declared colour-capable host version.", observedAt);
            if (layout.Contains("-behaviour-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.BehaviourMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "Calculation and action metadata requires the declared behaviour-capable host version.", observedAt);
            if (layout.Contains("-retirement-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.RetirementMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "Retirement metadata requires the declared retirement-capable host version.", observedAt);
            if (layout.Contains("-choice-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.ChoiceMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "Choice metadata requires the declared choice-capable host version.", observedAt);
            if (layout.Contains("-deletion-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.DeletionMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "Deletion metadata requires the declared deletion-capable host version.", observedAt);
            if (layout.Contains("-reference-", StringComparison.Ordinal) && minimumHost < Version.Parse(NendoFormat.ReferenceMinimumHostVersion))
                return Unreadable("layout-version-mismatch", "Reference metadata requires the declared reference-capable host version.", observedAt);
            if (!ignoreReplacementMarker && File.Exists(FileReplacementReceipt.PendingPath(path)))
            {
                findings.Add(new("replacement-pending", "A previous file replacement needs explicit recovery review. No staged file was adopted automatically."));
            }
            if (layout == "production-p1-v1")
            {
                findings.Add(new("upgrade-required", "This recognised older file needs an explicit staged upgrade before editing."));
            }
            var journal = Convert.ToString(await store.ScalarAsync("PRAGMA journal_mode;", null, cancellationToken), CultureInfo.InvariantCulture);
            if (!string.Equals(journal, "delete", StringComparison.OrdinalIgnoreCase))
            {
                findings.Add(new("unsupported-journal", "This file does not use the supported local storage profile. Inspection has not changed it."));
            }
            var readonlyFile = (File.GetAttributes(path) & FileAttributes.ReadOnly) != 0;
            if (readonlyFile)
            {
                findings.Add(new("file-read-only", "The file is marked read-only. You can inspect it without changing it."));
            }

            foreach (var table in new[] { "__nendo_entity", "__nendo_field", "__nendo_revision", "__nendo_operation" })
            {
                var count = Convert.ToInt64(await store.ScalarAsync($"SELECT COUNT(*) FROM {Quote(table)};", null, cancellationToken), CultureInfo.InvariantCulture);
                if (count > MaximumInspectionRows)
                {
                    return Unreadable("inspection-limit", "The file exceeds the bounded metadata inspection limit. No partial result is presented as complete.", observedAt);
                }
            }
            layoutTiming?.Dispose();
            using var mappingsTiming = NendoStartupDiagnostics.Source.StartActivity("engine.inspection.mappings");
            var coreValid = true;
            try
            {
                await store.ValidateAsync(cancellationToken);
            }
            catch (NendoValidationException)
            {
                coreValid = false;
                findings.Add(new("revision-mismatch", "The recorded revisions do not agree with the manifest. Editing is disabled."));
            }
            var mappings = await store.ReadEntityMappingsAsync(null, cancellationToken);
            var mappingDrift = await store.ValidateReadableMappingsAsync(mappings, cancellationToken) || !ReferenceMetadataIsValid(mappings) || !ChoiceMetadataIsValid(mappings) ||
                !RatingScaleMetadataIsValid(mappings) || !ApplicationPurposeIsValid(manifest.Purpose) ||
                !await store.RetirementMetadataIsValidAsync(cancellationToken) ||
                !await store.ExtensionPackagesAreValidAsync(cancellationToken);
            if (mappingDrift)
            {
                coreValid = false;
                findings.Add(new("mapping-drift", "Stored tables or constraints differ from the declared application. Only the recognised data is shown; editing is disabled."));
            }
            if (!mappingDrift && !await store.ReferencesHaveValidTargetsAsync(mappings, cancellationToken))
            {
                coreValid = false;
                findings.Add(new("reference-target-missing", "A stored reference has no target record. Editing is disabled; no target was guessed."));
            }
            await using (var foreignKeys = store.Command("PRAGMA foreign_key_check;", null))
            await using (var foreignKeyRows = await foreignKeys.ExecuteReaderAsync(cancellationToken))
            {
                if (await foreignKeyRows.ReadAsync(cancellationToken))
                {
                    coreValid = false;
                    findings.Add(new("relationship-integrity", "The file contains inconsistent internal references. Editing is disabled."));
                }
            }
            if (mappings.SelectMany(entity => entity.Fields).Any(field =>
                    field.StorageKind == NendoStorageKind.Unsupported ||
                    field.Presentation is not (null or "singleLine" or "longText" or "singleChoice" or "date" or "rating")))
            {
                findings.Add(new("unsupported-field-semantics", "An unknown field type or presentation is shown as unsupported. Its stored values have not been changed."));
            }
            mappingsTiming?.Dispose();
            using var recordsTiming = NendoStartupDiagnostics.Source.StartActivity("engine.inspection.records");
            var records = await store.ReadRecordsAsync(mappings, null, cancellationToken);
            if (records.Any(record => string.IsNullOrWhiteSpace(record.RecordId) || record.RecordVersion < 1))
            {
                coreValid = false;
                findings.Add(new("invalid-record-metadata", "Some record identities or versions are invalid. Editing is disabled."));
            }
            // Calculated fields travel with the record type here too. A surface may
            // bind one, so an inspection that left them out would compile every such
            // surface as broken and refuse to open a perfectly sound file.
            Dictionary<string, IReadOnlyList<NendoDerivedFieldSnapshot>> derivedFields = [];
            try { derivedFields = await store.ReadDerivedFieldsAsync(null, cancellationToken); }
            catch (Exception exception) when (exception is NendoException or System.Text.Json.JsonException)
            {
                // Damaged or unfamiliar definitions are reported further down, where
                // editing is disabled and the data stays readable. Inspection itself
                // must still finish: it is the route a person recovers through.
            }
            var entities = mappings.Select(mapping => new NendoEntitySnapshot(
                mapping.EntityId,
                mapping.DisplayName,
                mapping.Fields.Select(field => new NendoFieldSnapshot(
                    field.FieldId, field.DisplayName, field.StorageKind, field.Required, field.Presentation, field.Options)
                { UnsupportedStorageKind = field.UnsupportedStorageKind, Reference = field.Reference, Choices = field.Choices, Scale = field.Scale, Retired = field.Retired }).ToArray())
                {
                    Retired = mapping.Retired,
                    DerivedFields = derivedFields.TryGetValue(mapping.EntityId, out var calculated) ? calculated : [],
                }).ToArray();

            recordsTiming?.Dispose();
            using var historyTiming = NendoStartupDiagnostics.Source.StartActivity("engine.inspection.history");
            IReadOnlyList<NendoRevisionSnapshot> history = [];
            var historyReadable = true;
            try
            {
                history = await store.ReadRevisionsAsync(null, cancellationToken);
                if (!HistoryIsConsistent(history) || !IdentityHistoryIsConsistent(history, manifest))
                {
                    coreValid = false;
                    findings.Add(new("history-inconsistent", "History has inconsistent ordering, counters or operation evidence. It is shown for inspection only."));
                }
            }
            catch (Exception exception) when (IsProjectionFailure(exception))
            {
                historyReadable = false;
                coreValid = false;
                findings.Add(new("history-unreadable", "History could not be safely interpreted. The readable data remains available."));
            }
            historyTiming?.Dispose();
            using var surfaceTiming = NendoStartupDiagnostics.Source.StartActivity("engine.inspection.surface");
            IReadOnlyList<NendoUiNodeSnapshot> nodes = [];
            var surfaceReadable = true;
            try
            {
                nodes = await store.ReadUiNodesAsync(null, cancellationToken);
            }
            catch (Exception exception) when (IsProjectionFailure(exception))
            {
                surfaceReadable = false;
            }
            IReadOnlyList<NendoExtensionPackageSnapshot> packages = [];
            try
            {
                packages = await store.ReadExtensionPackagesAsync(null, cancellationToken);
            }
            catch (Exception exception) when (IsProjectionFailure(exception))
            {
                surfaceReadable = false;
            }
            var snapshot = new NendoSessionSnapshot(
                Path.GetFileName(path), NendoSessionHealth.ReadOnly, manifest, entities, records, nodes,
                await store.GetStorageHealthAsync(cancellationToken))
            {
                ExtensionPackages = packages,
            };
            // What a definition needs is its shape, not the version number on a
            // root: contract version 3 covers a plain form and a tabbed page with
            // two boards alike. The central capability calculation names the
            // widened features, so an insufficient minimum says which one it is.
            var capabilityFields = CapabilityFields(mappings);
            var requiredForSurfaces = NendoSemanticCapability.RequiredHostVersion(nodes, capabilityFields);
            if (minimumHost < Version.Parse(requiredForSurfaces))
            {
                var features = NendoSemanticCapability.PresentFeatures(nodes, capabilityFields)
                    .Where(feature => Version.Parse(feature.MinimumHostVersion) > minimumHost)
                    .Select(feature => feature.Name)
                    .ToArray();
                findings.Add(new("surface-version-mismatch",
                    $"These surfaces need Nendo {requiredForSurfaces} or newer" +
                    (features.Length == 0 ? "" : $" for {string.Join(", ", features)}") +
                    $", and the file records {manifest.MinimumHostVersion}. Editing is disabled."));
            }
            if (!surfaceReadable || (nodes.Count > 0 && !new NendoSemanticCompiler().Compile(snapshot).IsValid))
            {
                findings.Add(new("invalid-surface", "A custom surface cannot run safely. Your readable data is still available in Studio."));
            }
            // Calculations and actions decide both what the file shows and what a save
            // writes, so a host that cannot evaluate them exactly must not edit the file
            // at all. Reading and recovery stay open: the data is still the owner's.
            try
            {
                var contracts = (await store.ReadBehaviourContractVersionsAsync(null, cancellationToken))
                    .Where(version => !NendoBehaviourContract.IsSupported(version))
                    .ToArray();
                if (contracts.Length != 0)
                {
                    findings.Add(new("behaviour-contract-mismatch",
                        $"This file's calculations and actions were written for {string.Join(", ", contracts)}, and this Nendo runs {NendoBehaviourContract.Version}. Editing is disabled and your data stays readable."));
                }
                else
                {
                    await store.ReadBehaviourDefinitionsAsync(null, cancellationToken);
                }
            }
            catch (Exception exception) when (IsProjectionFailure(exception))
            {
                findings.Add(new("behaviour-unreadable",
                    "A stored calculation or action could not be safely interpreted. Editing is disabled and your readable data remains available."));
            }
            var unexpectedBehavior = Convert.ToInt64(await store.ScalarAsync(
                "SELECT COUNT(*) FROM sqlite_schema WHERE type IN ('trigger', 'view');", null, cancellationToken), CultureInfo.InvariantCulture) > 0;
            if (unexpectedBehavior)
            {
                findings.Add(new("unrecognised-schema-behavior", "The file contains unrecognised views or triggers. Editing and custom behavior are disabled."));
            }

            var recovery = findings.Any(finding => finding.Code != "file-read-only");
            var capabilities = new NendoFileCapabilities(true, historyReadable,
                coreValid && journal == "delete", true,
                !recovery && surfaceReadable && nodes.Count > 0, false, false);
            var inspection = new NendoFileInspection(
                recovery ? NendoOpenClassification.RecoveryRequired : NendoOpenClassification.NormalReadOnly,
                capabilities, findings.AsReadOnly(), manifest, layout,
                !recovery && !readonlyFile, observedAt);
            surfaceTiming?.Dispose();
            return new(inspection,
                snapshot with { Health = recovery ? NendoSessionHealth.RecoveryRequired : NendoSessionHealth.ReadOnly }, history,
                capabilities.Backup ? await store.ReadContentDigestAsync(cancellationToken) : null);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (SqliteException exception) when (exception.SqliteErrorCode is 5 or 6)
        {
            return Unreadable("file-busy", "The file is busy. Close its writer or try again after the current operation finishes.", observedAt, recovery: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return Unreadable("file-unavailable", "Nendo cannot safely read the selected file. Check access or open a backup separately.", observedAt);
        }
        catch (Exception exception) when (IsProjectionFailure(exception))
        {
            return Unreadable("unreadable-data", "The file could not be safely interpreted. No change or guessed repair was made.", observedAt);
        }
    }

    private async Task<bool> ValidateReadableMappingsAsync(IReadOnlyList<EntityMapping> mappings, CancellationToken cancellationToken)
    {
        long totalRows = 0;
        var drift = false;
        var physicalTables = new HashSet<string>(StringComparer.Ordinal);
        await using (var tables = Command("SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 8) != '__nendo_' AND substr(name, 1, 7) != 'sqlite_';", null))
        await using (var rows = await tables.ExecuteReaderAsync(cancellationToken))
        {
            while (await rows.ReadAsync(cancellationToken))
            {
                physicalTables.Add(rows.GetString(0));
            }
        }
        drift |= !physicalTables.SetEquals(mappings.Select(mapping => mapping.PhysicalTableName));
        foreach (var entity in mappings)
        {
            ValidatePhysicalIdentifier(entity.PhysicalTableName, "table");
            await using var type = Command("SELECT type FROM sqlite_schema WHERE name = @name;", null);
            type.Parameters.AddWithValue("@name", entity.PhysicalTableName);
            if (!string.Equals(Convert.ToString(await type.ExecuteScalarAsync(cancellationToken), CultureInfo.InvariantCulture), "table", StringComparison.Ordinal))
            {
                throw new NendoValidationException("An entity does not map to an ordinary stored table.");
            }
            var columns = new Dictionary<string, (string Type, bool Required, int Key)>(StringComparer.Ordinal);
            await using (var columnQuery = Command($"PRAGMA table_info({Quote(entity.PhysicalTableName)});", null))
            await using (var columnRows = await columnQuery.ExecuteReaderAsync(cancellationToken))
            {
                while (await columnRows.ReadAsync(cancellationToken))
                {
                    columns.Add(columnRows.GetString(1), (columnRows.GetString(2), columnRows.GetInt64(3) == 1, columnRows.GetInt32(5)));
                }
            }
            drift |= !columns.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(
                entity.Fields.Select(field => field.PhysicalColumnName).Concat(["__nendo_record_id", "__nendo_record_version"]));
            drift |= !columns.TryGetValue("__nendo_record_id", out var idColumn) || idColumn != ("TEXT", true, 1);
            drift |= !columns.TryGetValue("__nendo_record_version", out var versionColumn) || versionColumn != ("INTEGER", true, 0);
            foreach (var field in entity.Fields)
            {
                ValidatePhysicalIdentifier(field.PhysicalColumnName, "column");
                if (!Enum.IsDefined(field.StorageKind))
                {
                    throw new NendoValidationException("An unknown field cannot be interpreted by the typed reader.");
                }
                if (!columns.TryGetValue(field.PhysicalColumnName, out var column))
                {
                    throw new NendoValidationException("A mapped data column is missing.");
                }
                if (field.StorageKind != NendoStorageKind.Unsupported)
                {
                    drift |= column.Type != SqliteType(field.StorageKind) || column.Required != (field.Required && !field.Retired) || column.Key != 0;
                }
                var binary = Convert.ToInt64(await ScalarAsync(
                    $"SELECT EXISTS(SELECT 1 FROM {Quote(entity.PhysicalTableName)} WHERE typeof({Quote(field.PhysicalColumnName)}) = 'blob');",
                    null, cancellationToken), CultureInfo.InvariantCulture);
                if (binary != 0)
                {
                    throw new NendoValidationException("Binary values cannot be projected as scalar recovery data.");
                }
            }
            totalRows += Convert.ToInt64(await ScalarAsync($"SELECT COUNT(*) FROM {Quote(entity.PhysicalTableName)};", null, cancellationToken), CultureInfo.InvariantCulture);
            if (totalRows > MaximumInspectionRows)
            {
                throw new NendoValidationException("The file exceeds the bounded record inspection limit.");
            }
        }
        return drift;
    }

    private static bool HistoryIsConsistent(IReadOnlyList<NendoRevisionSnapshot> history)
    {
        long definition = 0;
        long data = 0;
        for (var index = 0; index < history.Count; index++)
        {
            var revision = history[index];
            if (revision.ChangeSequence != index || revision.DefinitionRevisionBefore != definition || revision.DataRevisionBefore != data)
            {
                return false;
            }
            if (index == 0)
            {
                if (revision.Lane != NendoRevisionLane.Genesis || revision.Operations.Count != 0)
                {
                    return false;
                }
            }
            else if (revision.Lane == NendoRevisionLane.Definition)
            {
                definition++;
            }
            else if (revision.Lane == NendoRevisionLane.Data)
            {
                data++;
            }
            else
            {
                return false;
            }
            if (revision.DefinitionRevisionAfter != definition || revision.DataRevisionAfter != data ||
                index > 0 && revision.Operations.Count == 0)
            {
                return false;
            }
            foreach (var operation in revision.Operations)
            {
                using var document = JsonDocument.Parse(operation.CanonicalJson);
                var json = document.RootElement;
                if (json.ValueKind != JsonValueKind.Object ||
                    !json.TryGetProperty("operationId", out var id) || id.GetString() != operation.OperationId ||
                    !json.TryGetProperty("operationType", out var type) || type.GetString() != operation.OperationType ||
                    !json.TryGetProperty("lane", out var lane) || lane.GetString() != revision.Lane.ToString() ||
                    !json.TryGetProperty("reversibility", out var reversibility) || reversibility.GetString() != operation.Reversibility.ToString())
                {
                    return false;
                }
            }
            var canonical = "[" + string.Join(',', revision.Operations.Select(operation => operation.CanonicalJson)) + "]";
            var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
            if (revision.OperationDigest != digest)
            {
                return false;
            }
        }
        return history.Count > 0;
    }

    private static bool IsProjectionFailure(Exception exception) => exception is
        SqliteException or NendoException or JsonException or FormatException or
        InvalidCastException or OverflowException or ArgumentException or InvalidOperationException;

    private static bool IdentityHistoryIsConsistent(IReadOnlyList<NendoRevisionSnapshot> history, NendoManifestSnapshot manifest)
    {
        IdentityTransitionOperation? previous = null;
        foreach (var revision in history)
        {
            foreach (var operation in revision.Operations.Where(operation => operation.OperationType == "identity.transition"))
            {
                IdentityTransitionOperation transition;
                try { transition = IdentityTransitionOperation.ParseCanonical(operation.CanonicalJson); }
                catch (Exception exception) when (IsProjectionFailure(exception) || exception is KeyNotFoundException) { return false; }
                if (revision.Operations.Count != 1 || revision.Lane != NendoRevisionLane.Definition ||
                    transition.Source.DefinitionRevision != revision.DefinitionRevisionBefore ||
                    transition.Source.DataRevision != revision.DataRevisionBefore ||
                    transition.Source.ChangeSequence != revision.ChangeSequence - 1 ||
                    previous is not null && (transition.Source.ApplicationId != previous.ResultApplicationId ||
                        transition.Source.InstanceId != previous.ResultInstanceId)) return false;
                previous = transition;
            }
        }
        return previous is null || (previous.ResultApplicationId == manifest.ApplicationId && previous.ResultInstanceId == manifest.InstanceId &&
            Version.Parse(manifest.MinimumHostVersion) >= Version.Parse(NendoFormat.LifecycleMinimumHostVersion));
    }

    private static InspectedNendoFile Unreadable(string code, string message, DateTimeOffset observedAt, bool recovery = false) => new(
        new NendoFileInspection(recovery ? NendoOpenClassification.RecoveryRequired : NendoOpenClassification.Rejected,
            NendoFileCapabilities.None, [new(code, message)], null, null, false, observedAt), null, []);

    private async Task<string> ProtectedSchemaSignatureAsync(CancellationToken cancellationToken, SqliteTransaction? transaction = null)
    {
        await using var command = Command("""
            SELECT type, name, tbl_name, sql FROM sqlite_schema
            WHERE substr(name, 1, 8) = '__nendo_' OR substr(tbl_name, 1, 8) = '__nendo_'
            ORDER BY type, name;
            """, transaction);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var parts = new List<string>();
        while (await reader.ReadAsync(cancellationToken))
        {
            if (parts.Count >= 128)
            {
                throw new NendoValidationException("Too many protected schema objects.");
            }
            parts.Add(string.Join('|', reader.GetString(0), reader.GetString(1), reader.GetString(2),
                reader.IsDBNull(3) ? "" : Regex.Replace(reader.GetString(3), @"\s+", "", RegexOptions.CultureInvariant)));
        }
        return string.Join('\n', parts);
    }

    private static async Task<IReadOnlyDictionary<string, string>> BuildKnownLayoutsAsync()
    {
        // Both layouts come from production: the original released file layout
        // and the current semantic schema. This connection exists only in memory.
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        var store = new SqliteNendoStore(":memory:", connection);
        await store.NonQueryAsync(CurrentSchemaSql, null, CancellationToken.None);
        var layouts = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["production-semantic-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None),
        };
        await store.NonQueryAsync(ReferenceSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(DeletionSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ChoiceSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-choice-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(RetirementSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-choice-retirement-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(BehaviourSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-choice-retirement-behaviour-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ChoiceToneSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-choice-retirement-behaviour-tone-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(RatingScaleSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ApplicationPurposeSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ExtensionPackageSchemaSql, null, CancellationToken.None);
        layouts["production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync("""
            DROP TABLE __nendo_extension_state;
            DROP TABLE __nendo_extension_file;
            DROP TABLE __nendo_extension_blob;
            DROP TABLE __nendo_extension_package;
            """, null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_application_purpose;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_field_scale;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_choice_tone;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_attribution;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_behaviour;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_retirement;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_choice;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_deleted_record;", null, CancellationToken.None);
        await store.NonQueryAsync("DROP TABLE __nendo_reference;", null, CancellationToken.None);
        await store.NonQueryAsync("""
            DROP TABLE __nendo_ui_property;
            DROP TABLE __nendo_ui_node;
            DROP TABLE __nendo_field;
            DROP TABLE __nendo_revision;
            """, null, CancellationToken.None);
        await store.NonQueryAsync(LegacyFieldAndRevisionSql, null, CancellationToken.None);
        layouts["production-p1-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        using var transaction = connection.BeginTransaction();
        await store.ExpandLegacyP1SchemaAsync(transaction, CancellationToken.None);
        transaction.Commit();
        layouts["production-p1-semantic-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ReferenceSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(DeletionSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ChoiceSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-choice-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(RetirementSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-choice-retirement-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(BehaviourSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-choice-retirement-behaviour-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ChoiceToneSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(RatingScaleSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ApplicationPurposeSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        await store.NonQueryAsync(ExtensionPackageSchemaSql, null, CancellationToken.None);
        layouts["production-p1-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-v1"] = await store.ProtectedSchemaSignatureAsync(CancellationToken.None);
        return layouts;
    }

    // Verbatim DDL from the first production implementation, not an inferred
    // layout obtained by dropping whichever columns happen to be missing.
    internal const string LegacyFieldAndRevisionSql = """
        CREATE TABLE __nendo_field (
            field_id TEXT NOT NULL PRIMARY KEY,
            entity_id TEXT NOT NULL,
            display_name TEXT NOT NULL,
            physical_column_name TEXT NOT NULL,
            storage_kind TEXT NOT NULL,
            required INTEGER NOT NULL,
            UNIQUE (entity_id, physical_column_name),
            FOREIGN KEY (entity_id) REFERENCES __nendo_entity(entity_id) ON DELETE CASCADE
        );
        CREATE TABLE __nendo_revision (
            revision_id TEXT NOT NULL PRIMARY KEY,
            created_at TEXT NOT NULL,
            origin TEXT NOT NULL,
            description TEXT NOT NULL,
            lane TEXT NOT NULL,
            definition_revision_before INTEGER NOT NULL,
            definition_revision_after INTEGER NOT NULL,
            data_revision_before INTEGER NOT NULL,
            data_revision_after INTEGER NOT NULL,
            change_sequence INTEGER NOT NULL UNIQUE,
            operation_digest TEXT NOT NULL,
            idempotency_scope TEXT NULL,
            idempotency_key TEXT NULL
        );
        """;
}
