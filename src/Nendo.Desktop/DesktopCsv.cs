using Nendo.Engine;

namespace Nendo.Desktop;

internal sealed partial class DesktopSessionController
{
    internal Task<NendoCsvBatchPreview> PrepareCsvBatchAsync(NendoCsvDocument document, string entityId,
        IReadOnlyList<NendoCsvMapping> mappings, NendoCsvOptions options, int offset, string batchId,
        CancellationToken cancellationToken = default, long? expectedDefinitionRevision = null) => QueryAsync(service =>
            service.PrepareCsvBatchAsync(document, entityId, mappings, options, offset, batchId, cancellationToken, expectedDefinitionRevision), cancellationToken);

    internal Task<int> ExportCsvAsync(string entityId, TextWriter writer, CancellationToken cancellationToken = default) =>
        QueryAsync(service => service.ExportCsvAsync(entityId, writer, cancellationToken), cancellationToken);
}
