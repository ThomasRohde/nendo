#:package Microsoft.Data.Sqlite
// A measurement (ADR-0031 point 7), not a lane: what opening costs once a file embeds 2 GiB
// of pictures, and whether leaving the media content out of the integrity check and the content
// digest keeps that cost where a file without media has it. SQLite only, on synthetic files shaped
// like a Nendo file near its bound; Measure-MediaOpen.ps1 runs it cold. Build nothing while it runs.
//
//   dotnet run MediaOpen.cs -- build <dir> <baseMiB> <mediaMiB>
//   dotnet run MediaOpen.cs -- measure <file> left-out|full
//
// "measure" is run on a cold copy (robocopy /J writes unbuffered), and prints one JSON line.
using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

var verb = args[0];
if (verb == "build") Build(args[1], int.Parse(args[2]), int.Parse(args[3]));
else if (verb == "measure") Measure(args[1], args[2]);
else throw new ArgumentException(verb);

static SqliteConnection Open(string path, SqliteOpenMode mode)
{
    var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Mode = mode, Pooling = false }.ToString());
    c.Open();
    return c;
}

static void Exec(SqliteConnection c, string sql) { using var cmd = c.CreateCommand(); cmd.CommandText = sql; cmd.ExecuteNonQuery(); }

static void Build(string dir, int baseMiB, int mediaMiB)
{
    Directory.CreateDirectory(dir);
    var basePath = Path.Combine(dir, "base.sqlite");
    var mediaPath = Path.Combine(dir, "media.sqlite");
    foreach (var p in new[] { basePath, mediaPath }) if (File.Exists(p)) File.Delete(p);
    using (var c = Open(basePath, SqliteOpenMode.ReadWriteCreate))
    {
        Exec(c, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;");
        // Shaped like a Nendo file near its bound: a records table with an index, an operations
        // table holding history, and a small metadata table.
        Exec(c, "CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);");
        Exec(c, "CREATE TABLE records(record_id TEXT PRIMARY KEY, title TEXT, body TEXT, version INTEGER);");
        Exec(c, "CREATE INDEX records_title ON records(title);");
        Exec(c, "CREATE TABLE operations(id INTEGER PRIMARY KEY, record_id TEXT, canonical_json TEXT);");
        var rng = new Random(264);
        string Text(int n) { var b = new char[n]; for (var i = 0; i < n; i++) b[i] = (char)('a' + rng.Next(26)); return new string(b); }
        var target = (long)baseMiB * 1024 * 1024;
        var row = 0;
        using var tx = c.BeginTransaction();
        using var rec = c.CreateCommand(); rec.Transaction = tx;
        rec.CommandText = "INSERT INTO records VALUES($id,$t,$b,1)";
        var pid = rec.Parameters.Add("$id", SqliteType.Text); var pt = rec.Parameters.Add("$t", SqliteType.Text); var pb = rec.Parameters.Add("$b", SqliteType.Text);
        using var op = c.CreateCommand(); op.Transaction = tx;
        op.CommandText = "INSERT INTO operations(record_id, canonical_json) VALUES($id,$j)";
        var oid = op.Parameters.Add("$id", SqliteType.Text); var oj = op.Parameters.Add("$j", SqliteType.Text);
        while (true)
        {
            for (var i = 0; i < 1000; i++, row++)
            {
                pid.Value = oid.Value = $"r{row:D8}"; pt.Value = Text(40); pb.Value = Text(900); rec.ExecuteNonQuery();
                oj.Value = "{\"op\":\"data.createRecord\",\"values\":\"" + Text(500) + "\"}"; op.ExecuteNonQuery();
            }
            using var pc = c.CreateCommand(); pc.Transaction = tx; pc.CommandText = "PRAGMA page_count";
            if ((long)pc.ExecuteScalar()! * 4096 >= target) break;
        }
        tx.Commit();
        Console.WriteLine($"base rows {row}, {new FileInfo(basePath).Length / 1048576.0:F1} MiB");
    }
    File.Copy(basePath, mediaPath);
    using (var c = Open(mediaPath, SqliteOpenMode.ReadWrite))
    {
        Exec(c, "PRAGMA journal_mode=DELETE; PRAGMA synchronous=OFF;");
        Exec(c, "CREATE TABLE media(sha256 TEXT PRIMARY KEY, media_type TEXT, byte_length INTEGER, name TEXT);");
        Exec(c, "CREATE TABLE media_content(sha256 TEXT PRIMARY KEY, content BLOB NOT NULL);");
        var items = mediaMiB / 4;
        var bytes = new byte[4 * 1024 * 1024];
        var rng = new Random(31);
        using var tx = c.BeginTransaction();
        using var m = c.CreateCommand(); m.Transaction = tx;
        m.CommandText = "INSERT INTO media VALUES($s,'image/jpeg',$n,'photo.jpg')";
        var ms = m.Parameters.Add("$s", SqliteType.Text); var mn = m.Parameters.Add("$n", SqliteType.Integer);
        using var mc = c.CreateCommand(); mc.Transaction = tx;
        mc.CommandText = "INSERT INTO media_content VALUES($s,$b)";
        var cs = mc.Parameters.Add("$s", SqliteType.Text); var cb = mc.Parameters.Add("$b", SqliteType.Blob);
        for (var i = 0; i < items; i++)
        {
            rng.NextBytes(bytes);
            var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
            ms.Value = cs.Value = sha; mn.Value = bytes.Length; cb.Value = bytes;
            m.ExecuteNonQuery(); mc.ExecuteNonQuery();
        }
        tx.Commit();
        Console.WriteLine($"media items {items}, {new FileInfo(mediaPath).Length / 1048576.0:F1} MiB");
    }
}

static void Measure(string path, string mode)
{
    var total = Stopwatch.StartNew();
    using var c = Open(path, SqliteOpenMode.ReadOnly);
    Exec(c, "PRAGMA query_only=ON; BEGIN DEFERRED;");
    var tables = new List<string>();
    using (var cmd = c.CreateCommand())
    {
        cmd.CommandText = "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name";
        using var r = cmd.ExecuteReader();
        while (r.Read()) tables.Add(r.GetString(0));
    }
    string Scalar(string sql) { using var cmd = c.CreateCommand(); cmd.CommandText = sql; return Convert.ToString(cmd.ExecuteScalar())!; }

    var sw = Stopwatch.StartNew();
    if (mode == "full")
    {
        // Today's check, which reads every page, the media's overflow chains included.
        if (Scalar("PRAGMA integrity_check") != "ok") throw new Exception("full check failed");
        Console.WriteLine($"{{\"file\":\"{Path.GetFileName(path)}\",\"mode\":\"full\",\"fullCheckMs\":{sw.Elapsed.TotalMilliseconds:F0}}}");
        return;
    }
    // Partial: every table but the media content, each with its indexes.
    foreach (var t in tables.Where(t => t != "media_content"))
        if (Scalar($"PRAGMA integrity_check(\"{t}\")") != "ok") throw new Exception("partial check failed on " + t);
    var partialMs = sw.Elapsed.TotalMilliseconds;

    // Digest: every row of every table, except that media content contributes its key only.
    sw.Restart();
    using (var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
    {
        foreach (var t in tables)
        {
            using var cmd = c.CreateCommand();
            cmd.CommandText = t == "media_content" ? "SELECT sha256 FROM media_content ORDER BY sha256" : $"SELECT rowid, * FROM \"{t}\" ORDER BY rowid";
            using var r = cmd.ExecuteReader();
            while (r.Read())
                for (var i = 0; i < r.FieldCount; i++)
                    hash.AppendData(r.IsDBNull(i) ? [0] : r.GetFieldType(i) == typeof(byte[]) ? (byte[])r.GetValue(i) : System.Text.Encoding.UTF8.GetBytes(Convert.ToString(r.GetValue(i))!));
        }
        _ = hash.GetHashAndReset();
    }
    var digestMs = sw.Elapsed.TotalMilliseconds;
    var keyedMs = partialMs + digestMs;

    Console.WriteLine($"{{\"file\":\"{Path.GetFileName(path)}\",\"mode\":\"left-out\",\"bytes\":{new FileInfo(path).Length},\"partialCheckMs\":{partialMs:F0},\"digestMs\":{digestMs:F0},\"openWithMediaLeftOutMs\":{keyedMs:F0}}}");
}
