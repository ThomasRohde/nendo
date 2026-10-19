#:project ../../src/Nendo.Engine/Nendo.Engine.csproj
#:property PublishAot=false
// The pictures reference file (ADR-0031): a small herbarium whose plants show a picture
// from each of the three places a picture can come from: embedded in the file, a file in the
// folder beside it, and the web. Built through the Engine's typed operations, as a host would
// write them; Build-Herbarium.ps1 runs it. Also measures a file at the 2 GiB budget.
//
//   dotnet run Herbarium.cs -- build <new .nendo path>
//   dotnet run Herbarium.cs -- measure <work folder>
using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using Nendo.Engine;

if (args.Length < 2) throw new ArgumentException("build <new .nendo path> | measure <work folder>");
if (args[0] == "build") await Build(Path.GetFullPath(args[1]));
else if (args[0] == "measure") await Measure(Path.GetFullPath(args[1]));
else throw new ArgumentException(args[0]);

static NendoRequestContext Context(string key) => new("herbarium-builder", key, "surface");

static async Task Build(string path)
{
    if (File.Exists(path)) throw new IOException($"{path} exists. The builder makes a new file and never writes over one.");
    var folder = Path.GetDirectoryName(path)!;
    var pictures = Path.Combine(folder, "Herbarium pictures");
    Directory.CreateDirectory(pictures);
    // The folder's pictures are part of the reference: written once, the same bytes every time.
    foreach (var (file, svg) in new[] { ("oak.svg", Pictures.Oak), ("maple.svg", Pictures.Maple) })
    {
        var target = Path.Combine(pictures, file);
        if (!File.Exists(target)) await File.WriteAllTextAsync(target, svg, new UTF8Encoding(false));
        else if (await File.ReadAllTextAsync(target) != svg) throw new IOException($"{target} is not the picture this builder writes.");
    }

    await using var coordinator = await NendoWriteCoordinator.CreateAsync(path, "herbarium-builder");
    var service = new NendoApplicationService(coordinator);
    const string E = "hb.plant", S = "herbarium";
    var revision = (await service.GetSnapshotAsync()).Manifest.DefinitionRevision;
    var n = 0;
    string Id() => $"op-herbarium-{++n:D3}";
    var definition = new List<NendoOperation>
    {
        new SetApplicationPurposeOperation(Id(), "A small herbarium: each plant with its picture, kept in the file, linked from the folder beside it, or shown from the web.", revision),
        new CreateEntityOperation(Id(), E, "Plants", "plants"),
        new AddFieldOperation(Id(), E, "hb.plant.name", "Name", "name", NendoStorageKind.Text, true),
        new AddFieldOperation(Id(), E, "hb.plant.family", "Family", "family", NendoStorageKind.Text, false),
        new AddFieldOperation(Id(), E, "hb.plant.picture", "Picture", "picture", NendoStorageKind.Text, false, NendoMedia.Presentation),
        new AddFieldOperation(Id(), E, "hb.plant.notes", "Notes", "notes", NendoStorageKind.Text, false, "markdown"),
    };
    var positions = new Dictionary<string, int>();
    void Node(string nodeId, string kind, string? parent, Dictionary<string, object?> properties)
    {
        var position = positions.GetValueOrDefault(parent ?? "");
        positions[parent ?? ""] = position + 1;
        definition.Add(new AddUiNodeOperation(Id(), S, nodeId, parent, kind, position));
        foreach (var (name, value) in properties) definition.Add(new SetUiPropertyOperation(Id(), S, nodeId, name, value));
    }
    void Bind(string parent, params string[] fields)
    {
        foreach (var field in fields) Node($"{parent}.{field}", "fieldBinding", parent, new() { ["fieldId"] = field });
    }
    Node("hb.plant.shelf", "gallerySurface", null, new()
    {
        ["definitionVersion"] = 3, ["entityId"] = E, ["title"] = "Shelf", ["titleFieldId"] = "hb.plant.name",
        ["coverFieldId"] = "hb.plant.picture", ["orderByFieldId"] = "hb.plant.name", ["orderDirection"] = "ascending",
    });
    Bind("hb.plant.shelf", "hb.plant.family");
    Node("hb.plant.all", "recordList", null, new()
    {
        ["definitionVersion"] = 3, ["entityId"] = E, ["title"] = "All plants", ["orderByFieldId"] = "hb.plant.name", ["orderDirection"] = "ascending",
    });
    Bind("hb.plant.all", "hb.plant.name", "hb.plant.picture", "hb.plant.family");
    Node("hb.plant.page", "detailSurface", null, new()
    {
        ["definitionVersion"] = 3, ["entityId"] = E, ["title"] = "Plant", ["titleFieldId"] = "hb.plant.name", ["subtitleFieldId"] = "hb.plant.family",
    });
    Bind("hb.plant.page", "hb.plant.picture", "hb.plant.notes");
    await coordinator.ApplyAsync(new NendoMutation("herbarium-builder", "definition", "surface", "The herbarium: plants, their pictures and three screens", definition));

    var web = "https://upload.wikimedia.org/wikipedia/commons/f/f9/Spores_under_a_fern_leaf.jpg";
    var plants = new (string Id, string Name, string Family, string? Picture, string Notes)[]
    {
        ("ginkgo", "Ginkgo", "Ginkgoaceae", null, "A living fossil. Its fan-shaped leaves turn gold together in autumn and fall within days.\n\n![The same leaf in autumn](AUTUMN)\n\nThe picture above is in the file too, named from this note."),
        ("monstera", "Monstera", "Araceae", null, "Its leaves split and open holes as they grow, which lets light reach the leaves below."),
        ("lavender", "Lavender", "Lamiaceae", null, "Grey-green and fragrant. The picture is a PNG kept in the file."),
        ("oak", "English oak", "Fagaceae", @".\Herbarium pictures\oak.svg", "Linked from the **Herbarium pictures** folder beside this file: move the two together and the picture follows."),
        ("maple", "Sugar maple", "Sapindaceae", @".\Herbarium pictures\maple.svg", "Linked from the folder beside the file. **Embed a copy** in its menu brings it into the file."),
        ("fern", "Fern", "Polypodiopsida", web, "Shown from the web while this device loads web pictures. Photo: kaibara87, CC BY 2.0, via Wikimedia Commons."),
        ("moss", "Moss", "Bryophyta", null, "No picture yet: its record page offers to drop, paste, pick or link one."),
    };
    var records = plants.Select((plant, index) => (NendoOperation)new CreateRecordOperation($"op-herbarium-record-{index}", E, plant.Id, new Dictionary<string, object?>
    {
        ["hb.plant.name"] = plant.Name, ["hb.plant.family"] = plant.Family, ["hb.plant.picture"] = plant.Picture,
        ["hb.plant.notes"] = plant.Id == "ginkgo" ? null : plant.Notes,
    })).ToList();
    await coordinator.ApplyAsync(new NendoMutation("herbarium-builder", "records", "surface", "Seven plants", records));

    async Task Embed(string id, byte[] content, string name, long version) =>
        await service.PutMediaAsync(new(content, null, name, Context("embed-" + id), new(E, id, "hb.plant.picture", version)));
    await Embed("ginkgo", Encoding.UTF8.GetBytes(Pictures.Ginkgo), "ginkgo.svg", 1);
    await Embed("monstera", Encoding.UTF8.GetBytes(Pictures.Monstera), "monstera.svg", 1);
    await Embed("lavender", Pictures.Lavender(), "lavender.png", 1);
    // A picture only a Markdown note names: put alone, then named in the same revision as the note.
    var autumn = Encoding.UTF8.GetBytes(Pictures.Ginkgo.Replace("#7fa63a", "#d9a21b").Replace("#5d7f25", "#a8730f"));
    var put = PutMediaOperation.FromContent("op-herbarium-autumn", autumn, null, "ginkgo-autumn.svg");
    await coordinator.ApplyAsync(new NendoMutation("herbarium-builder", "autumn", "surface", "Edit Plants Notes",
    [
        put,
        new SetFieldOperation("op-herbarium-autumn-note", E, "ginkgo", "hb.plant.notes", 2, plants[0].Notes.Replace("AUTUMN", put.Address)),
    ]));
    var usage = await service.ReadMediaUsageAsync();
    Console.WriteLine($"Built {path}: {plants.Length} plants, {usage.Count} embedded pictures ({usage.Bytes:N0} bytes), 2 linked from {pictures}, 1 from the web.");
}

static async Task Measure(string work)
{
    Directory.CreateDirectory(work);
    var rows = new List<string>();
    foreach (var (label, pictures) in new[] { ("without pictures", 0), ("at the budget", 32) })
    {
        var path = Path.Combine(work, $"budget-{pictures}.nendo");
        foreach (var stale in Directory.GetFiles(work, $"budget-{pictures}*")) File.Delete(stale);
        await using (var coordinator = await NendoWriteCoordinator.CreateAsync(path, "herbarium-measure"))
        {
            var service = new NendoApplicationService(coordinator);
            await coordinator.ApplyAsync(new NendoMutation("measure", "schema", "surface", "Plants",
            [
                new CreateEntityOperation("op-m-e", "hb.plant", "Plants", "plants"),
                new AddFieldOperation("op-m-n", "hb.plant", "hb.plant.name", "Name", "name", NendoStorageKind.Text, true),
                new AddFieldOperation("op-m-p", "hb.plant", "hb.plant.picture", "Picture", "picture", NendoStorageKind.Text, false, NendoMedia.Presentation),
            ]));
            var random = new Random(274);
            for (var index = 0; index < 32; index++)
            {
                await service.CreateRecordAsync(new("hb.plant", $"p{index}", new Dictionary<string, object?> { ["hb.plant.name"] = $"Plant {index}" }, Context($"p{index}")));
                if (index >= pictures) continue;
                // 64 MiB less a page: the item bound, so 32 of them reach the 2 GiB budget.
                var content = new byte[NendoMedia.MaximumItemBytes - 4096];
                random.NextBytes(content);
                Pictures.PngSignature.CopyTo(content, 0);
                await service.PutMediaAsync(new(content, null, $"p{index}.png", Context($"put{index}"), new("hb.plant", $"p{index}", "hb.plant.picture", 1)));
            }
        }
        var length = new FileInfo(path).Length;
        var open = Stopwatch.StartNew();
        await using (var coordinator = await NendoWriteCoordinator.OpenAsync(path, "herbarium-measure-open"))
        {
            open.Stop();
            var backupPath = Path.Combine(work, $"budget-{pictures}-backup.nendo");
            var backup = Stopwatch.StartNew();
            var plan = await coordinator.PrepareBackupAsync(backupPath, $"measure-{pictures}");
            await coordinator.CreateBackupAsync(plan.PlanId);
            backup.Stop();
            var usage = await new NendoApplicationService(coordinator).ReadMediaUsageAsync();
            rows.Add($"{{\"file\":\"{label}\",\"bytes\":{length},\"pictureBytes\":{usage.Bytes},\"openMs\":{open.ElapsedMilliseconds},\"backupMs\":{backup.ElapsedMilliseconds}}}");
        }
    }
    foreach (var row in rows) Console.WriteLine(row);
}

static class Pictures
{
    internal static readonly byte[] PngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1];

    internal const string Ginkgo = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360">
          <rect width="480" height="360" fill="#f3efe2"/>
          <path d="M240 330 C238 280 236 240 240 200" stroke="#5d7f25" stroke-width="6" fill="none" stroke-linecap="round"/>
          <path d="M240 205 C150 200 85 150 80 80 C130 50 200 45 240 60 C280 45 350 50 400 80 C395 150 330 200 240 205 Z" fill="#7fa63a"/>
          <path d="M240 60 L238 120" stroke="#f3efe2" stroke-width="5" stroke-linecap="round"/>
          <g stroke="#5d7f25" stroke-width="1.5" opacity="0.6" fill="none">
            <path d="M240 200 L120 90"/><path d="M240 200 L160 70"/><path d="M240 200 L205 60"/>
            <path d="M240 200 L275 60"/><path d="M240 200 L320 70"/><path d="M240 200 L360 90"/>
          </g>
        </svg>
        """;

    internal const string Monstera = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360">
          <rect width="480" height="360" fill="#e7efe8"/>
          <path d="M250 340 C250 300 245 270 240 250" stroke="#2f5d3a" stroke-width="7" fill="none" stroke-linecap="round"/>
          <path d="M240 255 C130 250 70 190 75 120 C85 60 160 25 240 30 C320 25 395 60 405 120 C410 190 350 250 240 255 Z" fill="#3d7a4a"/>
          <g fill="#e7efe8">
            <ellipse cx="160" cy="120" rx="18" ry="10" transform="rotate(-30 160 120)"/>
            <ellipse cx="320" cy="120" rx="18" ry="10" transform="rotate(30 320 120)"/>
            <ellipse cx="190" cy="185" rx="16" ry="9" transform="rotate(-20 190 185)"/>
            <ellipse cx="290" cy="185" rx="16" ry="9" transform="rotate(20 290 185)"/>
            <path d="M75 150 L140 160 L80 175 Z"/><path d="M405 150 L340 160 L400 175 Z"/>
            <path d="M110 80 L170 105 L120 60 Z"/><path d="M370 80 L310 105 L360 60 Z"/>
          </g>
          <path d="M240 250 L240 35" stroke="#2f5d3a" stroke-width="4"/>
        </svg>
        """;

    internal const string Oak = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360">
          <rect width="480" height="360" fill="#f1ebe1"/>
          <path d="M240 340 L240 300" stroke="#6b4a24" stroke-width="7" stroke-linecap="round"/>
          <path d="M240 300 C215 295 200 280 205 262 C180 270 160 255 168 235 C140 238 125 215 140 198 C115 195 105 170 125 155 C105 145 108 118 132 112 C120 92 135 70 158 76 C160 52 185 40 205 55 C210 32 230 25 240 30 C250 25 270 32 275 55 C295 40 320 52 322 76 C345 70 360 92 348 112 C372 118 375 145 355 155 C375 170 365 195 340 198 C355 215 340 238 312 235 C320 255 300 270 275 262 C280 280 265 295 240 300 Z" fill="#8a6a2f"/>
          <path d="M240 300 L240 45" stroke="#f1ebe1" stroke-width="3" opacity="0.7"/>
        </svg>
        """;

    internal const string Maple = """
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 360" width="480" height="360">
          <rect width="480" height="360" fill="#f6ece8"/>
          <path d="M240 345 L240 285" stroke="#7a2a1c" stroke-width="6" stroke-linecap="round"/>
          <path d="M240 290 L215 262 L150 280 L170 240 L95 205 L135 190 L110 135 L170 150 L180 110 L215 145 L205 60 L240 35 L275 60 L265 145 L300 110 L310 150 L370 135 L345 190 L385 205 L310 240 L330 280 L265 262 Z" fill="#c4452c"/>
          <g stroke="#7a2a1c" stroke-width="2" opacity="0.5" fill="none">
            <path d="M240 288 L240 50"/><path d="M240 230 L130 200"/><path d="M240 230 L350 200"/><path d="M240 200 L175 130"/><path d="M240 200 L305 130"/>
          </g>
        </svg>
        """;

    /// <summary>A lavender sprig as a PNG, drawn here pixel by pixel, so the file holds a raster picture too.</summary>
    internal static byte[] Lavender()
    {
        const int width = 480, height = 360;
        var raw = new byte[height * (1 + width * 3)];
        for (var y = 0; y < height; y++)
        {
            raw[y * (1 + width * 3)] = 0;
            for (var x = 0; x < width; x++)
            {
                var (r, g, b) = (238 - y / 12, 236 - y / 16, 244 - y / 20);
                // The stem, and buds along its top.
                if (Math.Abs(x - (240 + (y - 180) / 6)) < 3 && y > 120) (r, g, b) = (92, 120, 84);
                for (var bud = 0; bud < 9; bud++)
                {
                    var cx = 240 + (40 + bud * 12 - 180) / 6 + (bud % 2 == 0 ? -9 : 9);
                    var cy = 40 + bud * 12;
                    var dx = (x - cx) / 9.0; var dy = (y - cy) / 7.0;
                    if (dx * dx + dy * dy < 1) (r, g, b) = (128 + bud * 4, 96 + bud * 3, 178);
                }
                var at = y * (1 + width * 3) + 1 + x * 3;
                raw[at] = (byte)r; raw[at + 1] = (byte)g; raw[at + 2] = (byte)b;
            }
        }
        using var png = new MemoryStream();
        png.Write([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        var header = new byte[13];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header, width);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), height);
        header[8] = 8; header[9] = 2;
        Chunk(png, "IHDR", header);
        using (var compressed = new MemoryStream())
        {
            using (var zlib = new ZLibStream(compressed, CompressionLevel.SmallestSize, leaveOpen: true)) zlib.Write(raw);
            Chunk(png, "IDAT", compressed.ToArray());
        }
        Chunk(png, "IEND", []);
        return png.ToArray();
    }

    private static void Chunk(Stream png, string type, byte[] data)
    {
        var length = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(length, data.Length);
        png.Write(length);
        var typed = Encoding.ASCII.GetBytes(type).Concat(data).ToArray();
        png.Write(typed);
        var crc = new byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(crc, Crc32(typed));
        png.Write(crc);
    }

    private static uint Crc32(byte[] bytes)
    {
        var crc = 0xFFFFFFFFu;
        foreach (var value in bytes)
        {
            crc ^= value;
            for (var bit = 0; bit < 8; bit++) crc = (crc & 1) != 0 ? (crc >> 1) ^ 0xEDB88320u : crc >> 1;
        }
        return ~crc;
    }
}
