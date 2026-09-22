namespace Nendo.Engine.Storage;

internal sealed record NendoAuthoritySnapshot(
    string ApplicationId,
    string InstanceId,
    long DefinitionRevision,
    long DataRevision,
    long ChangeSequence,
    string SessionToken);

internal sealed record EntityMapping(
    string EntityId,
    string DisplayName,
    string PhysicalTableName,
    IReadOnlyList<FieldMapping> Fields)
{
    internal bool Retired { get; init; }
}

internal sealed record FieldMapping(
    string FieldId,
    string EntityId,
    string DisplayName,
    string PhysicalColumnName,
    NendoStorageKind StorageKind,
    bool Required,
    string? Presentation,
    IReadOnlyList<string> Options)
{
    internal string? UnsupportedStorageKind { get; init; }
    internal NendoReferenceDefinition? Reference { get; init; }
    internal IReadOnlyList<NendoChoiceOption> Choices { get; init; } = [];
    internal NendoRatingScale? Scale { get; init; }
    internal bool Retired { get; init; }
}

internal sealed record OperationEvidence(
    NendoOperation Operation,
    string EvidenceJson)
{
    internal string RequiredHostVersion { get; init; } = NendoFormat.MinimumHostVersion;
}
