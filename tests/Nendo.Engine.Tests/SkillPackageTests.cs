using System.Text;
using System.Text.Json;

namespace Nendo.Engine.Tests;

/// <summary>
/// A package of kind skill (ADR-0024, W-160): a SKILL.md and its supporting files for an agent
/// to read, with no entry point. It is the last rung of the layout ladder and the host version
/// that rung states, it keeps its kind, it reverses like any package, and nothing runs it or
/// writes in its name.
/// </summary>
[TestClass]
public sealed class SkillPackageTests
{
    private const string PackageId = "org.example.tasks";
    private const string Skill = "---\nname: tasks\ndescription: How to work this file's task list.\n---\n\n# Tasks\n";
    private const string SkillLayout =
        "production-semantic-reference-deletion-choice-retirement-behaviour-tone-scale-purpose-extension-hierarchy-rule-look-fold-newfile-skill-v1";

    [TestMethod]
    public async Task ASkillPackageTakesTheSkillRungAndHostAndReopensAsASkill()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);

        // A view package alone stays on the extension rung.
        await coordinator.ApplyAsync(Mutation("view", new SetExtensionPackageOperation("view", "org.example.map", "Map", "index.html"),
            PutExtensionFileOperation.FromContent("view-index", "org.example.map", "index.html", null, "<!doctype html>"u8.ToArray())));
        Assert.AreEqual(NendoFormat.ExtensionPackagesMinimumHostVersion, (await service.GetSnapshotAsync()).Manifest.MinimumHostVersion);

        await coordinator.ApplyAsync(Mutation("skill", SkillPackage("skill"), Put("SKILL.md", Skill), Put("references/statuses.md", "Open, Done.\n")));
        var after = await service.GetSnapshotAsync();
        Assert.AreEqual(NendoFormat.SkillPackageMinimumHostVersion, after.Manifest.MinimumHostVersion);
        var skill = after.ExtensionPackages.Single(package => package.PackageId == PackageId);
        Assert.AreEqual(NendoExtensionPackageKind.Skill, skill.Kind);
        Assert.IsNull(skill.EntryPoint, "A skill package reads back with an entry point.");
        Assert.AreEqual(NendoExtensionPackageKind.View, after.ExtensionPackages.Single(package => package.PackageId == "org.example.map").Kind);

        await coordinator.DisposeAsync();
        workspace.Forget(coordinator);
        var inspection = await NendoWriteCoordinator.InspectAsync(workspace.FilePath);
        Assert.AreEqual(SkillLayout, inspection.Layout);
        Assert.IsFalse(inspection.Findings.Any(finding => finding.Code is "unknown-protected-schema" or "layout-version-mismatch" or "mapping-drift"),
            string.Join("; ", inspection.Findings.Select(finding => finding.Code)));

        coordinator = await workspace.OpenAsync();
        var reopened = (await new NendoApplicationService(coordinator).GetSnapshotAsync()).ExtensionPackages.Single(package => package.PackageId == PackageId);
        Assert.IsTrue(reopened.IsSkill);
        Assert.IsNull(reopened.EntryPoint);
    }

    [TestMethod]
    public async Task APackageKeepsItsKindAndASkillReversesLikeAnyPackage()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(Mutation("create", SkillPackage("create"), Put("SKILL.md", Skill)));

        var refusal = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => coordinator.ApplyAsync(
            Mutation("as-view", new SetExtensionPackageOperation("as-view", PackageId, "Tasks", "index.html"))));
        Assert.AreEqual("extension-package-kind", refusal.Code);
        StringAssert.Contains(refusal.Message, "keeps its kind");

        var retitled = await coordinator.ApplyAsync(Mutation("retitle",
            new SetExtensionPackageOperation("retitle", PackageId, "Tasks, retitled", null, "1.1.0", kind: NendoExtensionPackageKind.Skill)));
        await service.CompensateRevisionAsync(retitled.RevisionId, "undo-retitle");
        var package = (await service.GetSnapshotAsync()).ExtensionPackages.Single();
        Assert.AreEqual("Working the task list/1.0.0/skill", $"{package.Title}/{package.Version}/{package.Kind}");

        var removed = await coordinator.ApplyAsync(Mutation("remove",
            new RemoveExtensionFileOperation("remove-skill", PackageId, "SKILL.md"), new RemoveExtensionPackageOperation("remove-package", PackageId)));
        Assert.IsEmpty((await service.GetSnapshotAsync()).ExtensionPackages);
        await service.CompensateRevisionAsync(removed.RevisionId, "undo-remove");
        package = (await service.GetSnapshotAsync()).ExtensionPackages.Single();
        Assert.IsTrue(package.IsSkill, "Restoring a removed skill package brought it back as a view.");
        Assert.AreEqual(Skill, Encoding.UTF8.GetString((await service.ReadExtensionFileAsync(PackageId, "SKILL.md"))!.Content));

        await coordinator.ApplyAsync(Mutation("remove-again",
            new RemoveExtensionFileOperation("remove-skill-2", PackageId, "SKILL.md"), new RemoveExtensionPackageOperation("remove-package-2", PackageId)));
        await coordinator.ApplyAsync(Mutation("view-now", new SetExtensionPackageOperation("view-now", PackageId, "Tasks as a view", "index.html")));
        Assert.IsFalse((await service.GetSnapshotAsync()).ExtensionPackages.Single().IsSkill, "A removed skill's kind outlived it.");
    }

    [TestMethod]
    public async Task NothingWritesOrKeepsStateInASkillPackagesName()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        await coordinator.ApplyAsync(new NendoMutation("skill-tests", "schema", "test", "Notes", [
            new CreateEntityOperation("notes", "notes", "Notes", "notes"),
            new AddFieldOperation("n-label", "notes", "label", "Label", "label", NendoStorageKind.Text, true)]));
        await coordinator.ApplyAsync(Mutation("skill", SkillPackage("skill"), Put("SKILL.md", Skill)));
        var before = (await service.GetSnapshotAsync()).Manifest.ChangeSequence;

        var write = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.CreateRecordAsync(new NendoCreateRecordRequest("notes", "n1",
            new Dictionary<string, object?> { ["label"] = "forged" }, new NendoRequestContext("skill-tests", "write", "extension:" + PackageId))));
        Assert.AreEqual("actor-not-allowed", write.Code, write.Message);
        StringAssert.Contains(write.Message, "skill package");

        var state = await Assert.ThrowsExactlyAsync<NendoPreconditionException>(() => service.SetExtensionStateAsync(PackageId, "view", "zoom", "2", null,
            "Keep zoom", new NendoRequestContext("skill-tests", "state", "extension:" + PackageId)));
        StringAssert.Contains(state.Message, "skill package");
        Assert.AreEqual(before, (await service.GetSnapshotAsync()).Manifest.ChangeSequence, "A refused write changed the file.");
    }

    [TestMethod]
    public void ASkillNamingAnEntryPointIsRefusedByTheFileItNamesAndAViewKeepsItsCanonicalBytes()
    {
        var refusal = Assert.ThrowsExactly<NendoValidationException>(() => NendoCanonicalOperations.Check("extension.setPackage",
            JsonSerializer.SerializeToElement(new { packageId = PackageId, title = "Tasks", kind = "skill", entryPoint = "run.html" })));
        StringAssert.Contains(refusal.Message, "names run.html as its entry point");
        Assert.ThrowsExactly<NendoValidationException>(() => NendoCanonicalOperations.Check("extension.setPackage",
            JsonSerializer.SerializeToElement(new { packageId = PackageId, title = "Tasks", kind = "macro" })));
        // A skill is named for the package ID's last segment, which must be a skill name.
        Assert.ThrowsExactly<NendoValidationException>(() => new SetExtensionPackageOperation("p", "org.example.tasks-", "Tasks", null, kind: "skill"));

        var view = Payload(new SetExtensionPackageOperation("p", "org.example.map", "Map", "index.html"));
        Assert.IsFalse(view.Contains("\"kind\"", StringComparison.Ordinal), "A view package's canonical bytes changed, and every digest over them with it.");
        var skill = Payload(SkillPackage("p"));
        StringAssert.Contains(skill, "\"kind\":\"skill\"");
        Assert.IsFalse(skill.Contains("entryPoint", StringComparison.Ordinal));
    }

    [TestMethod]
    public async Task AChangeThatLeavesAnAcceptedSkillWithoutItsSkillFileDoesNotValidate()
    {
        await using var workspace = new EngineTestWorkspace();
        var coordinator = await workspace.CreateAsync();
        var service = new NendoApplicationService(coordinator);
        var added = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest(ProposalId(1), "Add the skill", "test", Canonical(
            Operation("s", "extension.setPackage", new { packageId = PackageId, title = "Tasks", kind = "skill" }),
            Operation("f", "extension.putFile", new { packageId = PackageId, path = "SKILL.md", text = Skill }))));
        Assert.AreEqual(NendoProposalState.Previewable, added.State, string.Join("; ", added.Diagnostics.Select(item => item.Message)));
        Assert.IsTrue((await service.PromoteProposalAsync(added.ProposalId)).Applied);

        // A later change set touches only the file, and is judged by what it leaves.
        var broken = await service.PrepareProposalAsync(new NendoCanonicalProposalRequest(ProposalId(2), "Lose the frontmatter", "test", Canonical(
            Operation("r", "extension.putFile", new { packageId = PackageId, path = "SKILL.md", text = "# Tasks\n" }))));
        Assert.AreEqual(NendoProposalState.Invalid, broken.State);
        var diagnostic = broken.Diagnostics.Single(item => item.Code == "NPROP012");
        StringAssert.Contains(diagnostic.Message, $"{PackageId}/SKILL.md does not open with frontmatter");
        Assert.AreEqual(PackageId, diagnostic.SemanticId);
    }

    [TestMethod]
    public void TheFrontmatterIsReadAsTheAgentSkillsFormatWritesIt()
    {
        static NendoSkillFrontmatter Read(string text, byte[]? bytes = null)
        {
            Assert.IsTrue(NendoAgentSkill.TryRead(PackageId, bytes ?? Encoding.UTF8.GetBytes(text), out var frontmatter, out var problem), problem);
            return frontmatter!;
        }
        Assert.AreEqual(new NendoSkillFrontmatter("tasks", "How to work this file's task list."), Read(Skill));
        Assert.AreEqual("Quoted: yes", Read("---\r\nname: \"tasks\"\r\ndescription: 'Quoted: yes'\r\n---\r\n").Description);
        Assert.AreEqual("Folded over two lines.",
            Read("---\nname: tasks\ndescription: >\n  Folded over\n  two lines.\nmetadata:\n  author: someone\n  name: not this\n---\n").Description);
        Assert.AreEqual("tasks", Read("", [0xEF, 0xBB, 0xBF, .. Encoding.UTF8.GetBytes(Skill)]).Name, "A byte-order mark hid the frontmatter.");

        foreach (var (text, expected) in new[]
        {
            ("No frontmatter.\n", "does not open with frontmatter"),
            ("---\nname: tasks\ndescription: Never closed.\n", "does not open with frontmatter"),
            ("---\ndescription: Nameless.\n---\n", "has no name"),
            ("---\nname: chores\ndescription: Chores.\n---\n", "names the skill 'chores'"),
            ("---\nname: tasks\ndescription: \"\"\n---\n", "has no description"),
            ($"---\nname: tasks\ndescription: {new string('x', 1025)}\n---\n", "at most 1024"),
        })
        {
            Assert.IsFalse(NendoAgentSkill.TryRead(PackageId, Encoding.UTF8.GetBytes(text), out _, out var problem), text);
            StringAssert.Contains(problem, expected, text);
            StringAssert.Contains(problem, $"{PackageId}/SKILL.md", "The problem does not name the file.");
        }
        Assert.IsFalse(NendoAgentSkill.TryRead(PackageId, [0xC3, 0x28], out _, out var invalid));
        StringAssert.Contains(invalid, "is not UTF-8");
        Assert.IsFalse(NendoAgentSkill.TryRead(PackageId, null, out _, out var absent));
        StringAssert.Contains(absent, "has no SKILL.md at its root");
    }

    [TestMethod]
    public async Task ASkillFolderImportsAndExportsAsASkillAndOneThatRunsIsRefused()
    {
        var root = Path.Combine(Path.GetTempPath(), "nendo-skill-" + Guid.NewGuid().ToString("N"));
        try
        {
            var folder = Directory.CreateDirectory(Path.Combine(root, "tasks")).FullName;
            File.WriteAllText(Path.Combine(folder, NendoExtensionArchives.ManifestName),
                JsonSerializer.Serialize(new { packageId = PackageId, title = "Tasks", kind = "skill" }));
            File.WriteAllText(Path.Combine(folder, "SKILL.md"), Skill);
            Directory.CreateDirectory(Path.Combine(folder, "references"));
            File.WriteAllText(Path.Combine(folder, "references", "statuses.md"), "Open, Done.\n");

            var archive = NendoExtensionArchives.ReadFolder(folder);
            Assert.AreEqual(NendoExtensionPackageKind.Skill, archive.Kind);
            Assert.IsNull(archive.EntryPoint);

            await using var workspace = new EngineTestWorkspace();
            var coordinator = await workspace.CreateAsync();
            var service = new NendoApplicationService(coordinator);
            await coordinator.ApplyAsync(NendoExtensionArchives.ChangeSet(archive, null).Mutations.Single());
            var package = (await service.GetSnapshotAsync()).ExtensionPackages.Single();
            Assert.IsTrue(package.IsSkill);
            var manifest = Encoding.UTF8.GetString(NendoExtensionArchives.Manifest(package));
            StringAssert.Contains(manifest, "\"kind\": \"skill\"");
            Assert.IsFalse(manifest.Contains("entryPoint", StringComparison.Ordinal), manifest);
            Assert.ThrowsExactly<NendoPreconditionException>(() => NendoExtensionArchives.ChangeSet(archive, package), "Re-importing the same skill proposed a change.");

            File.WriteAllText(Path.Combine(folder, NendoExtensionArchives.ManifestName),
                JsonSerializer.Serialize(new { packageId = PackageId, title = "Tasks", kind = "skill", entryPoint = "SKILL.md" }));
            StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadFolder(folder)).Message,
                "names SKILL.md as its entry point");
            File.WriteAllText(Path.Combine(folder, NendoExtensionArchives.ManifestName),
                JsonSerializer.Serialize(new { packageId = PackageId, title = "Tasks", kind = "skill" }));
            File.WriteAllText(Path.Combine(folder, "SKILL.md"), "# No frontmatter\n");
            StringAssert.Contains(Assert.ThrowsExactly<NendoValidationException>(() => NendoExtensionArchives.ReadFolder(folder)).Message,
                $"{PackageId}/SKILL.md does not open with frontmatter");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    private static string Payload(NendoOperation operation)
    {
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream)) operation.WritePayload(writer);
        return Encoding.UTF8.GetString(stream.ToArray());
    }

    [TestMethod]
    public void ThePlannersOwnSkillReadsAsASkillPackage()
    {
        // tools/planner-skill is what is proposed into Planner.nendo; it must import as it stands.
        var archive = NendoExtensionArchives.ReadFolder(Path.Combine(TestRepository.Root(), "tools", "planner-skill"));
        Assert.AreEqual(NendoExtensionPackageKind.Skill, archive.Kind);
        var skill = archive.Files.Single(file => file.Path == NendoAgentSkill.FileName);
        Assert.IsTrue(NendoAgentSkill.TryRead(archive.PackageId, skill.Content, out var frontmatter, out var problem), problem);
        Assert.AreEqual("planner", frontmatter!.Name);
        StringAssert.Contains(Encoding.UTF8.GetString(skill.Content), "`pl.cmd.complete`");
    }

    private static SetExtensionPackageOperation SkillPackage(string id) =>
        new(id, PackageId, "Working the task list", null, "1.0.0", kind: NendoExtensionPackageKind.Skill);

    private static PutExtensionFileOperation Put(string path, string text) =>
        PutExtensionFileOperation.FromContent($"put-{Guid.NewGuid():N}", PackageId, path, null, Encoding.UTF8.GetBytes(text));

    private static NendoMutation Mutation(string key, params NendoOperation[] operations) =>
        new("skill-tests", key, "test", $"Skill change {key}", operations);

    private static NendoCanonicalOperationRequest Operation(string id, string type, object payload) =>
        new(id, type, JsonSerializer.SerializeToElement(payload));

    private static NendoCanonicalChangeSetRequest Canonical(params NendoCanonicalOperationRequest[] operations) =>
        new([new NendoCanonicalMutationRequest("skill-tests", Guid.NewGuid().ToString("N"), "test", "Skill change", operations)]);

    private static string ProposalId(int seed) => $"proposal-{seed:x32}";
}
