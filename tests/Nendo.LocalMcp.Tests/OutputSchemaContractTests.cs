using System.Text.Json;
using ModelContextProtocol.Client;
using Nendo.Engine;

namespace Nendo.LocalMcp.Tests;

/// <summary>
/// A schema-validating MCP client rejects a result whose structured content does
/// not satisfy the output schema the tool itself advertises. The official C#
/// client does not validate, so every other suite here passed while a real agent
/// was hard-stopped on its first call: <c>nendo.lease.acquire</c> declared
/// <c>expiresAt</c> required and omitted it, and every nullable member of a
/// validation preview did the same. This suite checks what the wire says against
/// what the wire carries, for every tool the authoring mode lists.
/// </summary>
[TestClass]
[DoNotParallelize]
public sealed class OutputSchemaContractTests
{
    [TestMethod]
    public async Task EveryToolResultSatisfiesItsDeclaredOutputSchema()
    {
        await using var workspace = new LocalMcpTestWorkspace();
        await workspace.CreateEmptyAsync();
        // Promotion runs through the proposal store, as the Desktop review does, so
        // the host's own count of outstanding proposals stays true.
        var proposals = new NendoAgentProposalStore();
        await using var host = await NendoLocalMcpHost.StartAsync(
            workspace.Service,
            AgentAccessMode.ApplicationAuthoring,
            new NendoLocalMcpHostOptions(workspace.DiscoveryRoot),
            proposals);
        await using var client = await ProtocolResourceTests.ConnectAsync(host);

        var schemas = (await client.ListToolsAsync())
            .ToDictionary(tool => tool.Name, tool => tool.ProtocolTool.OutputSchema, StringComparer.Ordinal);
        var observed = new List<string>();

        async Task<JsonElement> CallAsync(string name, Dictionary<string, object?>? arguments = null)
        {
            var result = await client.CallToolAsync(name, arguments);
            Assert.AreNotEqual(true, result.IsError, $"{name}: {JsonSerializer.Serialize(result)}");
            Assert.IsNotNull(result.StructuredContent, $"{name} returned no structured content.");
            Assert.IsTrue(schemas.TryGetValue(name, out var schema), $"{name} was not listed.");
            Assert.IsNotNull(schema, $"{name} advertises no output schema while returning structured content.");
            AssertSatisfies(schema.Value, schema.Value, result.StructuredContent.Value, name);
            observed.Add(name);
            return result.StructuredContent.Value;
        }

        static T Result<T>(JsonElement structured) where T : notnull =>
            structured.Deserialize<T>(NendoMcpJson.Options)
            ?? throw new AssertFailedException($"The structured result was not a {typeof(T).Name}.");

        // The very first call of any session, and the one the review could not get past.
        var lease = Result<NendoLeaseGrant>(await CallAsync("nendo.lease.acquire"));
        var owned = new Dictionary<string, object?>
        {
            ["applicationHandle"] = lease.ApplicationHandle,
            ["leaseId"] = lease.LeaseId,
        };
        await CallAsync("nendo.lease.renew", new(owned));
        await CallAsync("nendo.lease.status", new() { ["applicationHandle"] = lease.ApplicationHandle });

        // Authoring lane, built as a contract version 3 application: the shape the
        // review built, and the one whose preview summary was entirely null.
        var begun = Result<NendoChangeSetBeginResult>(await CallAsync("nendo.change_set.begin", new(owned)
        {
            ["title"] = "Build the CRM",
            ["idempotencyKey"] = "contract-begin",
        }));
        var scoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = begun.ChangeSetId };

        var ordinal = 0;
        async Task AddAsync(string description, IReadOnlyList<NendoAgentOperationInput> operations)
        {
            foreach (var chunk in operations.Chunk(16))
            {
                await CallAsync("nendo.change_set.add_operations", new(scoped)
                {
                    ["mutations"] = new[] { new NendoAgentMutationInput(description, chunk) },
                    ["idempotencyKey"] = $"contract-add-{ordinal++:D2}",
                });
            }
        }

        await AddAsync("Create the CRM record types", CrmAuthoringFixture.SchemaOperations());
        // No expectedDefinitionRevision: the host resolves it from the mutation's
        // position, so the caller does not model the host's counter.
        await AddAsync("Bind the CRM references", CrmAuthoringFixture.ReferenceOperations());
        await AddAsync("Shape the CRM surfaces", CrmAuthoringFixture.SurfaceOperations());

        // Replace the tail with itself: amend returns the same shape as an append
        // and must satisfy the same schema.
        await CallAsync("nendo.change_set.amend", new(scoped)
        {
            ["dropFromMutationOrdinal"] = ordinal - 1,
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput(
                    "Shape the CRM surfaces",
                    CrmAuthoringFixture.SurfaceOperations().Chunk(16).Last()),
            },
            ["idempotencyKey"] = "contract-amend",
        });

        var validated = Result<NendoAgentProposalPreview>(
            await CallAsync("nendo.change_set.validate", new(scoped) { ["idempotencyKey"] = "contract-validate" }));
        Assert.AreEqual(
            NendoProposalState.Previewable,
            validated.State,
            JsonSerializer.Serialize(validated.Diagnostics, NendoMcpJson.Options));
        await CallAsync("nendo.change_set.preview", new(scoped));

        // Acceptance is the owner's act; the test stands in for the click.
        var promotion = await proposals.PromoteAsync(workspace.Service, validated.ProposalId);
        Assert.IsTrue(promotion.Applied, promotion.Message);

        // A second change set covers the rejection path.
        var rejected = Result<NendoChangeSetBeginResult>(await CallAsync("nendo.change_set.begin", new(owned)
        {
            ["title"] = "Rename the account",
            ["idempotencyKey"] = "contract-begin-reject",
        }));
        Assert.AreEqual(0, rejected.OutstandingProposals);
        var rejectScoped = new Dictionary<string, object?>(owned) { ["changeSetId"] = rejected.ChangeSetId };
        await CallAsync("nendo.change_set.add_operations", new(rejectScoped)
        {
            ["mutations"] = new[]
            {
                new NendoAgentMutationInput("Rename the account", CrmAuthoringFixture.RenameAccountOperations()),
            },
            ["idempotencyKey"] = "contract-add-reject",
        });
        await CallAsync("nendo.change_set.reject", new(rejectScoped) { ["idempotencyKey"] = "contract-reject" });

        // Data lane over the accepted application, including a version 3 command.
        await CallAsync("nendo.data.create_record", new(owned)
        {
            ["entityId"] = CrmAuthoringFixture.AccountEntityId,
            ["recordId"] = "account-northwind",
            ["values"] = JsonSerializer.SerializeToElement(new Dictionary<string, object?>
            {
                [CrmAuthoringFixture.AccountNameFieldId] = "Northwind Logistics",
                [CrmAuthoringFixture.AccountTierFieldId] = "Strategic",
            }),
            ["idempotencyKey"] = "contract-create",
        });
        await CallAsync("nendo.data.create_records", new(owned)
        {
            ["entityId"] = CrmAuthoringFixture.DealEntityId,
            ["records"] = new[]
            {
                new NendoRecordInput("deal-renewal", JsonSerializer.SerializeToElement(new Dictionary<string, object?>
                {
                    [CrmAuthoringFixture.DealNameFieldId] = "Northwind renewal",
                    [CrmAuthoringFixture.DealStageFieldId] = "Negotiation",
                    [CrmAuthoringFixture.DealClosedFieldId] = false,
                })),
                new NendoRecordInput("deal-expansion", JsonSerializer.SerializeToElement(new Dictionary<string, object?>
                {
                    [CrmAuthoringFixture.DealNameFieldId] = "Northwind expansion",
                    [CrmAuthoringFixture.DealStageFieldId] = "Proposal",
                    [CrmAuthoringFixture.DealClosedFieldId] = false,
                })),
            },
            ["idempotencyKey"] = "contract-batch",
        });
        // Bulk import, both ways it can be fed. The CSV branch goes through the same
        // profile the person's own Export writes, so this is also the round trip in
        // miniature: what the export resource emits is what this accepts.
        await CallAsync("nendo.data.import_records", new(owned)
        {
            ["entityId"] = CrmAuthoringFixture.DealEntityId,
            ["format"] = "json",
            ["records"] = new[]
            {
                new NendoRecordInput("deal-imported-json", JsonSerializer.SerializeToElement(new Dictionary<string, object?>
                {
                    [CrmAuthoringFixture.DealNameFieldId] = "Northwind support",
                    [CrmAuthoringFixture.DealStageFieldId] = "Proposal",
                    [CrmAuthoringFixture.DealClosedFieldId] = false,
                })),
            },
            ["idempotencyKey"] = "contract-import-json",
        });
        await CallAsync("nendo.data.import_records", new(owned)
        {
            ["entityId"] = CrmAuthoringFixture.DealEntityId,
            ["format"] = "csv",
            ["csv"] = "Name,Stage,Closed\r\nNorthwind pilot,Proposal,false\r\n",
            ["columnMappings"] = new[]
            {
                new NendoCsvColumnMapping(0, CrmAuthoringFixture.DealNameFieldId),
                new NendoCsvColumnMapping(1, CrmAuthoringFixture.DealStageFieldId),
                new NendoCsvColumnMapping(2, CrmAuthoringFixture.DealClosedFieldId),
            },
            ["idempotencyKey"] = "contract-import-csv",
        });

        await CallAsync("nendo.data.set_field", new(owned)
        {
            ["entityId"] = CrmAuthoringFixture.DealEntityId,
            ["recordId"] = "deal-expansion",
            ["fieldId"] = CrmAuthoringFixture.DealStageFieldId,
            ["expectedRecordVersion"] = 1L,
            ["value"] = JsonSerializer.SerializeToElement("Negotiation"),
            ["idempotencyKey"] = "contract-set",
        });
        // Mark won sets two fields, so the record lands on version 3. The host
        // states that: the steps live in the stored definition, so a caller
        // cannot derive it, and without it the next optimistic write has nothing
        // to pin to.
        var commanded = Result<NendoDataApplyResult>(await CallAsync("nendo.data.execute_command", new(owned)
        {
            ["commandId"] = CrmAuthoringFixture.DealWinCommandId,
            ["recordId"] = "deal-renewal",
            ["expectedRecordVersion"] = 1L,
            ["idempotencyKey"] = "contract-command",
        }));
        Assert.AreEqual(3L, commanded.RecordVersion);
        await CallAsync("nendo.data.delete_record", new(owned)
        {
            ["entityId"] = CrmAuthoringFixture.DealEntityId,
            ["recordId"] = "deal-expansion",
            ["expectedRecordVersion"] = 2L,
            ["idempotencyKey"] = "contract-delete",
        });

        // A committed receipt carries a nested apply result; the unresolved branch
        // carries null, which must still satisfy the schema rather than vanish.
        await CallAsync("nendo.data.get_receipt", new()
        {
            ["receiptContext"] = lease.ReceiptContext,
            ["idempotencyKey"] = "contract-create",
        });
        await CallAsync("nendo.data.get_receipt", new()
        {
            ["receiptContext"] = lease.ReceiptContext,
            ["idempotencyKey"] = "contract-never-submitted",
        });
        // The file has moved a long way since the last integrity scan, so this
        // measures rather than reporting the recorded verdict.
        var scanned = Result<NendoMcpIntegrityCheck>(await CallAsync("nendo.health.verify_integrity"));
        Assert.IsTrue(scanned.Rescanned, scanned.Message);
        Assert.IsFalse(scanned.Health.IntegrityStale);
        Assert.AreEqual(0L, scanned.Health.ChangesSinceIntegrityCheck);

        // An unchanged file is not rescanned; the recorded result already stands.
        var repeated = Result<NendoMcpIntegrityCheck>(await CallAsync("nendo.health.verify_integrity"));
        Assert.IsFalse(repeated.Rescanned, repeated.Message);

        await CallAsync("nendo.lease.release", new(owned));

        // Every declared tool must have been exercised, or this suite silently
        // stops covering the one that breaks next.
        CollectionAssert.AreEquivalent(
            schemas.Keys.ToArray(),
            observed.Distinct(StringComparer.Ordinal).ToArray(),
            "A declared tool was never exercised against its output schema.");
    }

    /// <summary>
    /// Walks the declared schema against the payload. Only the failure the review
    /// hit is asserted — a name the schema requires that the payload does not
    /// carry — so this needs no JSON Schema implementation and no new dependency.
    /// </summary>
    private static void AssertSatisfies(JsonElement root, JsonElement schema, JsonElement value, string path)
    {
        schema = Resolve(root, schema);
        if (schema.TryGetProperty("required", out var required) && value.ValueKind == JsonValueKind.Object)
        {
            foreach (var name in required.EnumerateArray().Select(item => item.GetString()).OfType<string>())
            {
                Assert.IsTrue(
                    value.TryGetProperty(name, out _),
                    $"{path} declares '{name}' required but its structured content omits it. " +
                    $"Payload: {value.GetRawText()}");
            }
        }
        if (schema.TryGetProperty("properties", out var properties) && value.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in properties.EnumerateObject())
            {
                if (value.TryGetProperty(property.Name, out var child))
                {
                    AssertSatisfies(root, property.Value, child, $"{path}/{property.Name}");
                }
            }
        }
        if (schema.TryGetProperty("items", out var items) && value.ValueKind == JsonValueKind.Array)
        {
            var index = 0;
            foreach (var element in value.EnumerateArray())
            {
                AssertSatisfies(root, items, element, $"{path}/{index++}");
            }
        }
    }

    /// <summary>
    /// The exporter emits shared shapes as local reference nodes. A reference that
    /// does not resolve is returned as-is, which asserts nothing rather than
    /// asserting something false.
    /// </summary>
    private static JsonElement Resolve(JsonElement root, JsonElement schema)
    {
        for (var depth = 0; depth < 8; depth++)
        {
            if (schema.ValueKind != JsonValueKind.Object ||
                !schema.TryGetProperty("$ref", out var reference) ||
                reference.GetString() is not { } pointer ||
                !pointer.StartsWith("#/", StringComparison.Ordinal))
            {
                return schema;
            }
            var current = root;
            foreach (var segment in pointer[2..].Split('/', StringSplitOptions.RemoveEmptyEntries))
            {
                if (!current.TryGetProperty(segment.Replace("~1", "/", StringComparison.Ordinal)
                        .Replace("~0", "~", StringComparison.Ordinal), out current))
                {
                    return schema;
                }
            }
            schema = current;
        }
        return schema;
    }
}
