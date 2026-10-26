using Nendo.Engine;

namespace Nendo.Session;

internal sealed partial class DesktopSessionController
{
    internal Task<NendoCsvBatchPreview> PrepareCsvBatchAsync(NendoCsvDocument document, string entityId,
        IReadOnlyList<NendoCsvMapping> mappings, NendoCsvOptions options, int offset, string batchId,
        CancellationToken cancellationToken = default, long? expectedDefinitionRevision = null) => QueryAsync(service =>
            service.PrepareCsvBatchAsync(document, entityId, mappings, options, offset, batchId, cancellationToken, expectedDefinitionRevision), cancellationToken);

    internal Task<NendoCsvDocument> OrderCsvParentsFirstAsync(NendoCsvDocument document, string entityId,
        IReadOnlyList<NendoCsvMapping> mappings, CancellationToken cancellationToken = default, NendoCsvOptions? options = null) => QueryAsync(service =>
            service.OrderCsvParentsFirstAsync(document, entityId, mappings, cancellationToken, options), cancellationToken);

    internal Task<int> ExportCsvFileAsync(string entityId, Stream destination, CancellationToken cancellationToken = default,
        IReadOnlyDictionary<string, string>? pictureAddresses = null) =>
        QueryAsync(service => service.ExportCsvFileAsync(entityId, destination, cancellationToken, pictureAddresses), cancellationToken);

    /// <summary>The record type's embedded pictures, written beside the CSV.</summary>
    internal Task<IReadOnlyDictionary<string, string>> ExportCsvPicturesAsync(string entityId, string csvFolder, CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.ExportCsvPicturesAsync(entityId, csvFolder, cancellationToken), cancellationToken);

    /// <summary>
    /// Copies the record type's linked picture files into the file, each picture its own
    /// revision, read against the open file's folder.
    /// </summary>
    internal async Task<NendoEmbedLinkedResult> EmbedLinkedPicturesAsync(string entityId, CancellationToken cancellationToken = default)
    {
        await EnterRequestGateAsync(cancellationToken);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            var folder = _currentPath is null ? null : Path.GetDirectoryName(Path.GetFullPath(_currentPath));
            var result = await RequireService().EmbedLinkedPicturesAsync(entityId, folder,
                new NendoRequestContext("desktop.p2.5", "media-embed-linked-" + Guid.NewGuid().ToString("N"), "surface"), cancellationToken);
            await RefreshAfterOutcomeAsync(cancellationToken);
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal Task<int> ExportCsvAsync(string entityId, TextWriter writer, CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.ExportCsvAsync(entityId, writer, cancellationToken), cancellationToken);
}
