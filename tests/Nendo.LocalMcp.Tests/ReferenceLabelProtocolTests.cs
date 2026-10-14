using System.Text.Json;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// schema.setReferenceLabel over MCP (ADR-0003, 2026-10-14 note, W-232): the authoring table
/// carries it, the compiler takes what the table describes, and its refusals reach an agent whole.
/// </summary>
[TestClass]
public sealed class ReferenceLabelProtocolTests
{
    [TestMethod]
    public void TheAuthoringTableCarriesTheOperationAndTheCompilerTakesIt()
    {
        var operation = NendoAuthoringOperations.All.Single(candidate => candidate.OperationType == "schema.setReferenceLabel");
        CollectionAssert.AreEqual(new[] { "entityId", "fieldId", "labelFieldId" }, operation.RequiredPayload.ToArray());
        CollectionAssert.Contains(operation.OptionalPayload.ToArray(), "expectedDefinitionRevision");
        StringAssert.Contains(operation.Summary, "change the label first, then retire the old field", StringComparison.Ordinal);
        NendoCanonicalOperations.Check("schema.setReferenceLabel", JsonSerializer.SerializeToElement(new
        {
            entityId = "tasks", fieldId = "project", labelFieldId = "code", expectedDefinitionRevision = 3,
        }));
    }

    [TestMethod]
    public void ItsRefusalsReachTheAgentWhole()
    {
        Assert.AreEqual("NENDO_REFERENCE_LABEL_UNCHANGED: Tasks.Project already shows Projects by Name.",
            NendoToolErrors.Translate(new NendoPreconditionException("reference-label-unchanged", "Tasks.Project already shows Projects by Name.")).Message);
        StringAssert.Contains(NendoToolErrors.Translate(new NendoPreconditionException("reference-label-in-use",
                "Tasks.Project shows Projects by Name, so Name cannot be retired. Show Projects by another text field with schema.setReferenceLabel first.")).Message,
            "schema.setReferenceLabel", StringComparison.Ordinal);
    }
}
