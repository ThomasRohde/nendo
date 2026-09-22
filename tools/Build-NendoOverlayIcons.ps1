[CmdletBinding()]
param(
    # Write a side-by-side preview of every size on both taskbar colours, for looking
    # at before accepting it. Not produced by default: it is not a payload file.
    [string] $PreviewPath
)
# The badges Windows draws in the corner of the taskbar button.
#
# A person whose window is behind three others cannot see that their file is
# read-only or waiting on approval. The frame says so; nobody is looking at the
# frame. These are the same two facts, moved to where they will be seen.
#
# An overlay is drawn at the small icon size -- 16px at 100% -- in the bottom-right
# quarter of a button that is already busy, so it has to survive being tiny and sit
# on either taskbar colour. Hence a filled disc with a white ring around it and a
# white glyph inside: the ring is what keeps the amber one off a light taskbar and
# the slate one off a dark one. Two shapes only, and both readable as silhouettes,
# because at this size colour is the first thing to go and detail is the second.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sizes = @(16, 20, 24, 32)
$badges = @(
    @{ name = 'OverlayAttention'; fill = @(217, 119, 6); glyph = 'bang'
       means = 'something is waiting for you: approval, or recovery' }
    @{ name = 'OverlayReadOnly'; fill = @(71, 85, 105); glyph = 'lock'
       means = 'the file is open and cannot be changed' }
)

function Add-RoundedRectangle($path, [single] $x, [single] $y, [single] $width, [single] $height, [single] $radius) {
    $d = [single]([Math]::Max(0.1, $radius * 2))
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $width - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $width - $d, $y + $height - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $height - $d, $d, $d, 90, 90)
    $path.CloseFigure()
}

function New-BadgeFrame([hashtable] $badge, [int] $size) {
    $bitmap = [Drawing.Bitmap]::new($size, $size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality

        $ring = [single]([Math]::Max(1.0, $size / 12.0))
        $inset = [single]($ring / 2.0 + 0.5)
        $diameter = [single]($size - 2 * $inset)
        $fill = [Drawing.Color]::FromArgb(255, $badge.fill[0], $badge.fill[1], $badge.fill[2])
        $white = [Drawing.Color]::FromArgb(255, 255, 255, 255)

        $brush = [Drawing.SolidBrush]::new($fill)
        try { $graphics.FillEllipse($brush, $inset, $inset, $diameter, $diameter) } finally { $brush.Dispose() }
        $pen = [Drawing.Pen]::new($white, $ring)
        try { $graphics.DrawEllipse($pen, $inset, $inset, $diameter, $diameter) } finally { $pen.Dispose() }

        $glyphBrush = [Drawing.SolidBrush]::new($white)
        try {
            if ($badge.glyph -eq 'bang') {
                # A stem and a dot. Rounded, because a square-ended bar at 16px reads
                # as a smear once the ring has eaten the outer pixel.
                $barWidth = [single]([Math]::Max(1.5, $size * 0.13))
                $barX = [single](($size - $barWidth) / 2.0)
                $barTop = [single]($size * 0.26)
                $barBottom = [single]($size * 0.60)
                $stem = [Drawing.Drawing2D.GraphicsPath]::new()
                try {
                    Add-RoundedRectangle $stem $barX $barTop $barWidth ($barBottom - $barTop) ([single]($barWidth / 2.0))
                    $graphics.FillPath($glyphBrush, $stem)
                } finally { $stem.Dispose() }
                $dot = [single]([Math]::Max(1.8, $size * 0.15))
                $graphics.FillEllipse($glyphBrush, [single](($size - $dot) / 2.0), [single]($size * 0.66), $dot, $dot)
            }
            else {
                # A padlock: a body wide enough to be a shape, and a shackle above it.
                # Both are needed -- the body alone is a rectangle and the shackle alone
                # is a smudge. What decides whether this reads as a lock rather than a
                # bag is the coloured gap between the shackle's two legs, so the shackle
                # is drawn wide and thin: at 16px that gap is three pixels, and it is
                # the first thing to disappear if either number is nudged.
                $bodyWidth = [single]($size * 0.50)
                $bodyHeight = [single]($size * 0.30)
                $bodyX = [single](($size - $bodyWidth) / 2.0)
                $bodyY = [single]($size * 0.50)
                $body = [Drawing.Drawing2D.GraphicsPath]::new()
                try {
                    Add-RoundedRectangle $body $bodyX $bodyY $bodyWidth $bodyHeight ([single]([Math]::Max(0.6, $size * 0.05)))
                    $graphics.FillPath($glyphBrush, $body)
                } finally { $body.Dispose() }
                $shackleWidth = [single]($size * 0.34)
                $shacklePen = [Drawing.Pen]::new($white, [single]([Math]::Max(1.1, $size * 0.075)))
                try {
                    $graphics.DrawArc($shacklePen,
                        [single](($size - $shackleWidth) / 2.0), [single]($size * 0.26),
                        $shackleWidth, [single]($size * 0.28), 180, 180)
                } finally { $shacklePen.Dispose() }
            }
        }
        finally { $glyphBrush.Dispose() }
        return $bitmap
    }
    finally { $graphics.Dispose() }
}

function Save-Icon([array] $frames, [string] $target) {
    $output = [IO.File]::Create($target)
    $writer = [IO.BinaryWriter]::new($output)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
        $offset = 6 + 16 * $frames.Count
        foreach ($frame in $frames) {
            $writer.Write([byte]$frame.size); $writer.Write([byte]$frame.size)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$frame.bytes.Length); $writer.Write([uint32]$offset)
            $offset += $frame.bytes.Length
        }
        foreach ($frame in $frames) { $writer.Write([byte[]]$frame.bytes) }
    }
    finally { $writer.Dispose(); $output.Dispose() }
}

$previews = @()
foreach ($badge in $badges) {
    $frames = @()
    foreach ($size in $sizes) {
        $bitmap = New-BadgeFrame $badge $size
        $stream = [IO.MemoryStream]::new()
        try {
            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $frames += @{ size = $size; bytes = $stream.ToArray() }
            if ($PreviewPath) { $previews += @{ name = $badge.name; size = $size; image = [Drawing.Bitmap]::new($bitmap) } }
        }
        finally { $stream.Dispose(); $bitmap.Dispose() }
    }
    Save-Icon $frames (Join-Path $repo ("src/Nendo.Desktop/Assets/{0}.ico" -f $badge.name))
    Write-Output ("{0}: {1} sizes -- {2}." -f $badge.name, $frames.Count, $badge.means)
}

if ($PreviewPath) {
    # Each badge at every size, on both taskbar colours, and again at 6x so the
    # shapes can be judged apart from whether they survive being small.
    $scale = 6
    $pad = 12
    $cell = 32 * $scale + $pad
    $sheetWidth = $pad + ($sizes.Count * ($cell + $pad))
    $sheetHeight = $pad + $badges.Count * 2 * ($cell + $pad)
    $sheet = [Drawing.Bitmap]::new([int]$sheetWidth, [int]$sheetHeight)
    $graphics = [Drawing.Graphics]::FromImage($sheet)
    try {
        $graphics.Clear([Drawing.Color]::FromArgb(255, 243, 243, 243))
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
        $row = 0
        foreach ($badge in $badges) {
            foreach ($dark in @($false, $true)) {
                $y = $pad + $row * ($cell + $pad)
                if ($dark) {
                    $background = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 32, 32, 32))
                    try { $graphics.FillRectangle($background, 0, $y - [int]($pad / 2), [int]$sheetWidth, $cell + $pad) }
                    finally { $background.Dispose() }
                }
                $column = 0
                foreach ($preview in ($previews | Where-Object { $_.name -eq $badge.name })) {
                    $x = $pad + $column * ($cell + $pad)
                    $graphics.DrawImage($preview.image, $x, $y, $preview.size * $scale, $preview.size * $scale)
                    $graphics.DrawImage($preview.image, $x, $y + 32 * $scale - $preview.size, $preview.size, $preview.size)
                    $column++
                }
                $row++
            }
        }
        $sheet.Save($PreviewPath, [Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $graphics.Dispose(); $sheet.Dispose(); foreach ($preview in $previews) { $preview.image.Dispose() } }
    Write-Output "Preview: $PreviewPath"
}
