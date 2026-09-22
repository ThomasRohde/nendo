[CmdletBinding()]
param()

# Every tracked binary, opened rather than counted.
#
# The repository gate passed while image assets were corrupted (W-019). It checks
# that binaries are tracked, that they live where they belong, and that the text
# files around them end their lines with LF -- and being binary is exactly what
# excused them from every one of those content checks. A file can be the right
# size, in the right place, with the right attribute, and still not open. That is
# how a broken icon reached the point where NSIS refused to build an installer,
# which is a late and confusing place to learn it.
#
# So this reads the structure each format declares about itself, and nothing else:
# no decoding, no re-encoding, and never a byte written back.
#
# The four formats are not equally checkable, and saying so is the point:
#
#   PNG  strong. Every chunk carries a CRC over its own bytes, so a single
#        flipped byte anywhere in the file is caught.
#   ICO  strong here, because every frame in this repository's icons is itself a
#        PNG and gets the PNG check. A bitmap-framed icon is refused rather than
#        half-checked; see the sentence it prints.
#   MP4  structural only. The format carries no checksum, so a flipped byte in
#        the media data cannot be caught. What is checked is that the box tree
#        tiles at every level, that the boxes a playable file needs are present,
#        and that the sample-table offsets point inside the file -- which is what
#        catches truncation, including a cut on a box boundary.
#   NENDO moderate. The SQLite header, Nendo's application id, a whole number of
#        pages, and (when the header's count is valid) the page count against
#        the file length. Any change in length is caught; a flipped byte inside
#        a page is not, because SQLite carries no checksum over the file.
#
# Run alone while working on assets: pwsh ./tools/Test-BinaryAssets.ps1
# (Editing the C# below and re-running inside one interactive session throws
# "type already exists"; start a new pwsh, or run the script as above.)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gitSafeRoot = $repoRoot.Replace('\', '/')

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;

// Structural readers. Each returns null when the file makes sense, or one
// sentence naming what is wrong and where. None of them writes anything.
//
// All offset arithmetic is long. A file may declare a chunk of nearly 2^31
// bytes, and int arithmetic on that wraps negative, which turns a bounds check
// into a pass and the next read into an IndexOutOfRangeException -- a stack
// trace where a sentence belongs.
public static class NendoAssetStructure
{
    static readonly uint[] CrcTable = BuildCrcTable();

    static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            uint c = n;
            for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }

    public static uint Crc32(byte[] data, long offset, long count)
    {
        uint c = 0xFFFFFFFFu;
        for (long i = offset; i < offset + count; i++) c = CrcTable[(c ^ data[i]) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }

    static uint BigEndian(byte[] b, long at)
    {
        return ((uint)b[at] << 24) | ((uint)b[at + 1] << 16) | ((uint)b[at + 2] << 8) | b[at + 3];
    }

    static ulong BigEndian64(byte[] b, long at)
    {
        ulong v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | b[at + i];
        return v;
    }

    static uint LittleEndian(byte[] b, long at)
    {
        return ((uint)b[at + 3] << 24) | ((uint)b[at + 2] << 16) | ((uint)b[at + 1] << 8) | b[at];
    }

    static readonly byte[] PngSignature = { 137, 80, 78, 71, 13, 10, 26, 10 };

    static bool StartsWithPng(byte[] b, long at)
    {
        if (at + PngSignature.Length > b.Length) return false;
        for (int i = 0; i < PngSignature.Length; i++) if (b[at + i] != PngSignature[i]) return false;
        return true;
    }

    public static string Png(byte[] b) { return Png(b, 0, b.Length, ""); }

    // The CRC over every chunk is the point of this one. A truncated or
    // byte-flipped PNG keeps a valid signature and a plausible header; what it
    // cannot keep is the checksum the file itself carries for each chunk.
    //
    // Stricter than a decoder in one way, deliberately: a byte after IEND is
    // refused rather than ignored. The spec says IEND is last, and for assets
    // this repository builds, trailing bytes mean something went wrong.
    static string Png(byte[] b, long start, long length, string where)
    {
        if (length < PngSignature.Length) return where + "is " + length + " bytes, too short to be a PNG";
        if (!StartsWithPng(b, start)) return where + "does not begin with the PNG signature";

        long end = start + length;
        long at = start + PngSignature.Length;
        bool sawHeader = false, sawData = false, sawEnd = false;
        int chunks = 0;

        while (at < end)
        {
            if (at + 12 > end) return where + "has " + (end - at) + " bytes left at offset " + (at - start) + ", too few for a chunk";
            long size = BigEndian(b, at);
            if (size > 0x7FFFFFFF) return where + "declares a chunk of " + size + " bytes at offset " + (at - start);
            if (at + 12 + size > end)
                return where + "has a chunk at offset " + (at - start) + " declaring " + size + " bytes, which runs past the end of the file";

            string type = Encoding.ASCII.GetString(b, (int)at + 4, 4);
            foreach (char c in type)
                if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')))
                    return where + "has a chunk at offset " + (at - start) + " whose type is not four letters";

            uint stored = BigEndian(b, at + 8 + size);
            uint computed = Crc32(b, at + 4, 4 + size);
            if (stored != computed)
                return where + "chunk " + type + " at offset " + (at - start) + " fails its CRC: the file stores 0x" +
                    stored.ToString("X8") + ", its bytes produce 0x" + computed.ToString("X8");

            if (chunks == 0 && type != "IHDR") return where + "begins with " + type + " rather than IHDR";
            if (type == "IHDR")
            {
                if (sawHeader) return where + "carries a second IHDR at offset " + (at - start);
                if (size != 13) return where + "has an IHDR of " + size + " bytes rather than 13";
                uint width = BigEndian(b, at + 8);
                uint height = BigEndian(b, at + 12);
                if (width == 0 || height == 0) return where + "declares a size of " + width + "x" + height;
                sawHeader = true;
            }
            if (type == "IDAT") sawData = true;
            if (type == "IEND")
            {
                sawEnd = true;
                at += 12 + size;
                if (at != end) return where + "has " + (end - at) + " bytes after IEND";
                break;
            }
            at += 12 + size;
            chunks++;
        }

        if (!sawHeader) return where + "has no IHDR";
        if (!sawData) return where + "has no IDAT, so it carries no image";
        if (!sawEnd) return where + "ends without an IEND chunk, so it is truncated";
        return null;
    }

    // An icon is a directory of images. Every entry has to point inside the file
    // and at something that is itself a readable image.
    public static string Ico(byte[] b)
    {
        if (b.Length < 6) return "is " + b.Length + " bytes, too short to be an icon";
        if (b[0] != 0 || b[1] != 0) return "does not begin with the icon reserved field";
        int type = b[2] | (b[3] << 8);
        if (type != 1 && type != 2) return "declares image type " + type + ", which is neither icon nor cursor";
        int count = b[4] | (b[5] << 8);
        if (count == 0) return "declares no images";
        if (6L + count * 16L > b.Length) return "declares " + count + " images, more than its directory can hold";

        for (int i = 0; i < count; i++)
        {
            long entry = 6 + i * 16;
            long size = LittleEndian(b, entry + 8);
            long offset = LittleEndian(b, entry + 12);
            string where = "image " + (i + 1) + " of " + count + " ";
            if (size == 0) return where + "is empty";
            if (offset < 6 || offset + size > b.Length)
                return where + "claims " + size + " bytes at offset " + offset + ", which is outside the file";

            if (StartsWithPng(b, offset))
            {
                string fault = Png(b, offset, size, where);
                if (fault != null) return fault;
                continue;
            }
            // The other legal frame is a bitmap, and it is refused rather than
            // waved through. A DIB carries no checksum, so the most a reader here
            // could confirm is that some plausible header bytes are present --
            // which is the kind of check that passes a corrupted file and calls
            // it qualified. Every frame of every icon in this repository is a
            // PNG, because Build-NendoIcon.ps1 writes PNG frames. If that stops
            // being true, this sentence is where the question gets asked.
            //
            // A frame that is not a bitmap either is corruption, not a change of
            // tooling, and says so: reporting shifted bytes as "a bitmap frame"
            // sends somebody to read Build-NendoIcon.ps1 for a fault that is not
            // there. Stripping the carriage returns out of an icon lands here.
            uint declaredHeader = size >= 4 ? LittleEndian(b, offset) : 0;
            bool looksLikeBitmap = declaredHeader == 40 || declaredHeader == 52 ||
                declaredHeader == 56 || declaredHeader == 108 || declaredHeader == 124;
            if (!looksLikeBitmap)
            {
                var opening = new StringBuilder();
                for (int k = 0; k < 8 && offset + k < b.Length; k++) opening.Append(b[offset + k].ToString("X2")).Append(' ');
                return where + "is neither a PNG nor a bitmap: it begins " + opening.ToString().Trim() +
                    ", so the frame is corrupt rather than in another format";
            }
            return where + "is a bitmap frame. Every icon in this repository is PNG-framed, and no bitmap reader exists here; " +
                "if the icon tooling has changed, add one to tools/Test-BinaryAssets.ps1 rather than leaving the frame unchecked.";
        }
        return null;
    }

    class Mp4State { public bool Movie; public bool Data; public List<string> Faults = new List<string>(); }

    // Boxes that hold other boxes and nothing else, so the walk can descend. A
    // truncation inside one of these is invisible at the top level, which is the
    // whole reason for descending.
    static readonly HashSet<string> Containers = new HashSet<string> {
        "moov", "trak", "mdia", "minf", "stbl", "udta", "edts", "dinf", "mvex", "moof", "traf"
    };

    public static string Mp4(byte[] b)
    {
        if (b.Length < 8) return "is " + b.Length + " bytes, too short to hold a box";
        var state = new Mp4State();
        string fault = Boxes(b, 0, b.Length, true, "", state);
        if (fault != null) return fault;
        if (!state.Movie) return "has no moov box, so it carries no playable track";
        // A cut exactly on a box boundary leaves the boxes before it tiling
        // perfectly. This file is faststart -- ftyp, uuid, moov, free, then one
        // large mdat -- so losing the media alone loses 98% of the bytes and
        // nothing above notices. The media has to be named as required.
        if (!state.Data) return "has no mdat box, so its media is missing";
        return null;
    }

    static string Boxes(byte[] b, long start, long end, bool top, string where, Mp4State state)
    {
        long at = start;
        bool first = true;
        while (at < end)
        {
            if (at + 8 > end) return where + "has " + (end - at) + " bytes left at offset " + at + ", too few for a box header";
            long size = BigEndian(b, at);
            string type = Encoding.ASCII.GetString(b, (int)at + 4, 4);
            long headerSize = 8;
            if (size == 1)
            {
                if (at + 16 > end) return where + "has a 64-bit box at offset " + at + " with no room for its size";
                ulong wide = BigEndian64(b, at + 8);
                if (wide > long.MaxValue) return where + "has box " + type + " at offset " + at + " declaring " + wide + " bytes";
                size = (long)wide;
                headerSize = 16;
            }
            else if (size == 0)
            {
                size = end - at;
            }
            if (top && first && type != "ftyp") return "begins with box " + type + " rather than ftyp";
            if (size < headerSize) return where + "has box " + type + " at offset " + at + " declaring " + size + " bytes";
            if (at + size > end)
                return where + "has box " + type + " at offset " + at + " declaring " + size + " bytes, which runs " +
                    (at + size - end) + " bytes past the end of " + (top ? "the file" : "its parent");

            if (type == "moov") state.Movie = true;
            if (type == "mdat") state.Data = true;

            if (Containers.Contains(type))
            {
                string fault = Boxes(b, at + headerSize, at + size, false, type + " ", state);
                if (fault != null) return fault;
            }
            else if (type == "stco" || type == "co64")
            {
                string fault = ChunkOffsets(b, at + headerSize, at + size, type);
                if (fault != null) return fault;
            }
            at += size;
            first = false;
        }
        return null;
    }

    // Where the sample table says the media lives. This is the one statement an
    // MP4 makes that a truncated file stops being able to make, checksum or no
    // checksum: an offset into media that is no longer there.
    static string ChunkOffsets(byte[] b, long start, long end, string type)
    {
        if (start + 8 > end) return type + " is too short to declare its entries";
        long entryCount = BigEndian(b, start + 4);
        int entrySize = type == "stco" ? 4 : 8;
        if (start + 8 + entryCount * entrySize > end)
            return type + " declares " + entryCount + " entries, more than the box holds";
        for (long i = 0; i < entryCount; i++)
        {
            long at = start + 8 + i * entrySize;
            ulong offset = entrySize == 4 ? BigEndian(b, at) : BigEndian64(b, at);
            if (offset >= (ulong)b.Length)
                return type + " entry " + (i + 1) + " of " + entryCount + " points at offset " + offset +
                    ", which is outside a file of " + b.Length + " bytes";
        }
        return null;
    }

    // A .nendo file is a SQLite database that says it is Nendo's. Nothing here reads a
    // page or a row: the header states how large a page is, how many there are and whose
    // file this is, and those three answers have to agree with the bytes on disk. That
    // catches the failures a copy actually suffers -- truncation, a half-written page tail,
    // and a file that is simply not the thing its name claims.
    //
    // Strength: moderate. SQLite carries no checksum over the main database file, so a
    // flipped byte inside a page cannot be caught here; the page count and the page
    // multiple catch every change in length. The header's page count is only authoritative
    // when the change counter matches the version-valid-for counter, and it is checked
    // only then, because a database left in WAL mode legitimately disagrees.
    public static string Nendo(byte[] b)
    {
        const long NendoApplicationId = 0x4E454E44;
        if (b.Length < 100) return "is " + b.Length + " bytes, shorter than a SQLite header";
        if (Encoding.ASCII.GetString(b, 0, 15) != "SQLite format 3" || b[15] != 0)
            return "does not begin with the SQLite file header";
        int declared = (b[16] << 8) | b[17];
        long pageSize = declared == 1 ? 65536 : declared;
        if (pageSize < 512 || (pageSize & (pageSize - 1)) != 0)
            return "declares a page size of " + declared + ", which is not a power of two between 512 and 65536";
        if (b.LongLength % pageSize != 0)
            return "is " + b.LongLength + " bytes, which is not a whole number of " + pageSize + "-byte pages";
        long applicationId = BigEndian32(b, 68);
        if (applicationId != NendoApplicationId)
            return "declares application id 0x" + applicationId.ToString("X8") + ", not Nendo's 0x4E454E44";
        if (BigEndian32(b, 24) == BigEndian32(b, 92))
        {
            long pages = BigEndian32(b, 28);
            if (pages * pageSize != b.LongLength)
                return "says it holds " + pages + " pages of " + pageSize + " bytes (" + (pages * pageSize) +
                    ") but the file is " + b.LongLength + " bytes";
        }
        return null;
    }

    private static long BigEndian32(byte[] b, int at) =>
        ((long)b[at] << 24) | ((long)b[at + 1] << 16) | ((long)b[at + 2] << 8) | b[at + 3];
}
'@

# Assets that ship, or that a shipping asset is generated from. Named rather than
# discovered: a corruption check that only walked whatever it found would pass an
# empty repository, and the acceptance for this asks specifically that the
# installer's own assets are confirmed readable.
#
# AppIcon.ico is the one with history -- the executable's icon, the NSIS installer
# and uninstaller icon, and the Start Menu shortcut icon -- and it is generated by
# Build-NendoIcon.ps1 from docs/assets/brand/nendo-mark.png, which is why the
# source is guarded here too although it never ships.
#
# This list fails loudly when an asset is renamed or removed, and drifts silently
# when one is added. It has already drifted once: two Square44x44 target sizes
# that Nendo.Desktop.csproj ships were missing from the first version of it.
$shipping = @(
    'src/Nendo.Desktop/Assets/AppIcon.ico',
    'src/Nendo.Desktop/Assets/DocumentIcon.ico',
    'src/Nendo.Desktop/Assets/OverlayAttention.ico',
    'src/Nendo.Desktop/Assets/OverlayReadOnly.ico',
    'src/Nendo.Desktop/Assets/LockScreenLogo.scale-200.png',
    'src/Nendo.Desktop/Assets/SplashScreen.scale-200.png',
    'src/Nendo.Desktop/Assets/Square150x150Logo.scale-200.png',
    'src/Nendo.Desktop/Assets/Square44x44Logo.scale-200.png',
    'src/Nendo.Desktop/Assets/Square44x44Logo.targetsize-24_altform-unplated.png',
    'src/Nendo.Desktop/Assets/Square44x44Logo.targetsize-48_altform-lightunplated.png',
    'src/Nendo.Desktop/Assets/StoreLogo.png',
    'src/Nendo.Desktop/Assets/Wide310x150Logo.scale-200.png',
    'src/Nendo.Workbench/public/nendo.png',
    'src/Nendo.Workbench/public/nendo-mark.png',
    'docs/assets/brand/nendo-mark.png'
)

# quotePath off, or a non-ASCII path comes back quoted and octal-escaped and
# names a file that does not exist.
$eolRows = @(& git -c "safe.directory=$gitSafeRoot" -c 'core.quotePath=false' -C $repoRoot ls-files --eol)
if ($LASTEXITCODE -ne 0) { throw 'git ls-files --eol failed.' }

$pathOf = { param($row) ($row -split "`t", 2)[1] }

# i/-text is what git actually stores as binary, and is the set that must be
# readable. attr/-text is what .gitattributes declares, and is narrower: it names
# nine extensions, so a .webp or a .woff2 would be stored as binary, skipped by
# every text check in the gate, and skipped by this one too if the attribute were
# the selector. Selecting on what git stores and then requiring the declaration to
# agree closes both halves.
$binaries = @($eolRows | Where-Object { $_ -match '^i/-text' } | ForEach-Object { & $pathOf $_ } | Sort-Object)
if ($binaries.Count -eq 0) { throw 'No tracked binary assets were found; this check would pass vacuously.' }

$undeclared = @(
    $eolRows |
        Where-Object { $_ -match '^i/-text' -and $_ -notmatch '\sattr/-text' } |
        ForEach-Object { & $pathOf $_ }
)
if ($undeclared.Count -gt 0) {
    throw "Tracked file(s) that git stores as binary but .gitattributes does not declare binary; add the extension there so the text checks keep skipping them for a stated reason:`n$($undeclared -join "`n")"
}

foreach ($required in $shipping) {
    if ($required -notin $binaries) {
        throw "A shipping asset is missing, untracked, or no longer stored as a binary: $required"
    }
}

$faults = @()
$totalBytes = 0L
foreach ($path in $binaries) {
    $full = Join-Path $repoRoot $path
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $faults += "$path is tracked but not on disk"
        continue
    }
    $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
    # Any exception from a reader is reported against its file. Without this a
    # malformed asset that reached an unguarded index would print a stack trace
    # naming the script, and never name the file.
    try {
        $bytes = [IO.File]::ReadAllBytes($full)
        $totalBytes += $bytes.LongLength
        $fault = switch ($extension) {
            '.png' { [NendoAssetStructure]::Png($bytes) }
            '.ico' { [NendoAssetStructure]::Ico($bytes) }
            '.mp4' { [NendoAssetStructure]::Mp4($bytes) }
            '.nendo' { [NendoAssetStructure]::Nendo($bytes) }
            default {
                # Not a gap to shrug at. An unreadable format here is a binary that
                # no content check in this repository covers, which is the whole
                # defect this lane exists for. .nendo, .sqlite and .db are declared
                # binary too; .nendo has a reader below, and .sqlite or .db would stop
                # here until one exists.
                throw "no structural check exists for $extension. Add one to tools/Test-BinaryAssets.ps1 rather than leaving the file unchecked."
            }
        }
    } catch {
        $fault = "could not be read: $($_.Exception.Message)"
    }
    if ($null -ne $fault) { $faults += "$path $fault" }
}

if ($faults.Count -gt 0) {
    throw "Corrupt binary asset(s); the bytes are tracked but the files cannot be read:`n$($faults -join "`n")"
}

$megabytes = [Math]::Round($totalBytes / 1MB, 1)
Write-Host "OK       $($binaries.Count) tracked binary asset(s) read end to end ($megabytes MB), including $($shipping.Count) that ship or generate one."
