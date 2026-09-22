[CmdletBinding()]
param(
    # Write a side-by-side preview of every size beside the icon, for looking at
    # before accepting it. Not produced by default: it is not a payload file.
    [string] $PreviewPath
)
# The icon a .nendo file wears in Explorer.
#
# Deliberately not the application icon. A person looking at a folder needs to
# tell the app from its documents, and two identical icons make the folder say
# that everything in it is Nendo and nothing about which is which.
#
# A page below 32px is mush -- the outline, the fold and the mark all land inside
# about ten pixels and none of them survive. So the small sizes are the bare mark,
# exactly as the app icon draws it, and the page appears at 32 and above where
# there is room for it to mean something. That is what most document icons do.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = [Drawing.Image]::FromFile((Join-Path $repo 'docs/assets/brand/nendo-mark.png'))
$sizes = @(16, 24, 32, 48, 64, 128, 256)
# Below this the page is noise; see the note above.
$pageFrom = 32

function New-RoundedPage([single] $x, [single] $y, [single] $width, [single] $height, [single] $radius, [single] $fold) {
    $path = [Drawing.Drawing2D.GraphicsPath]::new()
    $d = $radius * 2
    # Clockwise from below the top-left corner, with the top-right replaced by the
    # cut the folded corner leaves.
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddLine($x + $radius, $y, $x + $width - $fold, $y)
    $path.AddLine($x + $width - $fold, $y, $x + $width, $y + $fold)
    $path.AddLine($x + $width, $y + $fold, $x + $width, $y + $height - $radius)
    $path.AddArc($x + $width - $d, $y + $height - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $height - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

$frames = @()
$previews = @()
try {
    foreach ($size in $sizes) {
        $bitmap = [Drawing.Bitmap]::new($size, $size)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $stream = [IO.MemoryStream]::new()
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality

            if ($size -ge $pageFrom) {
                # A portrait page, inset so its shadowless edge is not clipped, with
                # the mark sitting on it at a little over half the page width.
                $margin = [single]($size * 0.14)
                $pageWidth = [single]($size - 2 * $margin)
                $pageHeight = [single]($size - 2 * ($size * 0.07))
                $pageX = [single]$margin
                $pageY = [single]($size * 0.07)
                $radius = [single][Math]::Max(1.0, $size * 0.06)
                $fold = [single]($size * 0.26)

                $page = New-RoundedPage $pageX $pageY $pageWidth $pageHeight $radius $fold
                try {
                    $graphics.FillPath([Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 251, 251, 252)), $page)
                    $pen = [Drawing.Pen]::new([Drawing.Color]::FromArgb(255, 201, 207, 219), [single][Math]::Max(1.0, $size / 64.0))
                    try { $graphics.DrawPath($pen, $page) } finally { $pen.Dispose() }
                } finally { $page.Dispose() }

                # The turned corner, drawn as the darker triangle the fold leaves.
                $corner = [Drawing.Drawing2D.GraphicsPath]::new()
                try {
                    $cornerPoints = [Drawing.PointF[]]@(
                        [Drawing.PointF]::new($pageX + $pageWidth - $fold, $pageY),
                        [Drawing.PointF]::new($pageX + $pageWidth, $pageY + $fold),
                        [Drawing.PointF]::new($pageX + $pageWidth - $fold, $pageY + $fold))
                    $corner.AddPolygon($cornerPoints)
                    $graphics.FillPath([Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 217, 221, 230)), $corner)
                } finally { $corner.Dispose() }

                $markWidth = [single]($pageWidth * 0.68)
                $scale = $markWidth / [double][Math]::Max($source.Width, $source.Height)
                $markHeight = [single]($source.Height * $scale)
                $graphics.DrawImage($source,
                    [single]($pageX + ($pageWidth - $markWidth) / 2),
                    [single]($pageY + $pageHeight * 0.58 - $markHeight / 2),
                    $markWidth, $markHeight)
            }
            else {
                # The mark alone, filling the frame as the app icon does.
                $scale = $size / [double][Math]::Max($source.Width, $source.Height)
                $width = [int][Math]::Round($source.Width * $scale)
                $height = [int][Math]::Round($source.Height * $scale)
                $graphics.DrawImage($source, [int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
            }

            $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $frames += @{ size = $size; bytes = $stream.ToArray() }
            if ($PreviewPath) { $previews += @{ size = $size; image = [Drawing.Bitmap]::new($bitmap) } }
        }
        finally { $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose() }
    }

    $target = Join-Path $repo 'src/Nendo.Desktop/Assets/DocumentIcon.ico'
    $output = [IO.File]::Create($target)
    $writer = [IO.BinaryWriter]::new($output)
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
        $offset = 6 + 16 * $frames.Count
        foreach ($frame in $frames) {
            $dimension = if ($frame.size -eq 256) { 0 } else { $frame.size }
            $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$frame.bytes.Length); $writer.Write([uint32]$offset)
            $offset += $frame.bytes.Length
        }
        foreach ($frame in $frames) { $writer.Write([byte[]]$frame.bytes) }
    }
    finally { $writer.Dispose(); $output.Dispose() }

    if ($PreviewPath) {
        # Every size at its own scale, on the two backgrounds Explorer uses, so the
        # small ones can be judged at the size they are actually seen.
        $pad = 16
        # Measure-Object sums to a Double, and the Bitmap constructor wants two ints.
        $sheetWidth = [int](($sizes | Measure-Object -Sum).Sum) + $pad * ($sizes.Count + 1)
        $sheetHeight = 256 + 256 + $pad * 3
        $sheet = [Drawing.Bitmap]::new([int]$sheetWidth, [int]$sheetHeight)
        $sheetGraphics = [Drawing.Graphics]::FromImage($sheet)
        try {
            $sheetGraphics.Clear([Drawing.Color]::FromArgb(255, 244, 245, 247))
            $sheetGraphics.FillRectangle([Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 7, 23, 37)),
                0, 256 + $pad * 2, [int]$sheetWidth, 256 + $pad)
            $x = $pad
            foreach ($preview in $previews) {
                $sheetGraphics.DrawImage($preview.image, $x, $pad + (256 - $preview.size))
                $sheetGraphics.DrawImage($preview.image, $x, 256 + $pad * 2 + (256 - $preview.size))
                $x += $preview.size + $pad
            }
            $sheet.Save($PreviewPath, [Drawing.Imaging.ImageFormat]::Png)
        }
        finally { $sheetGraphics.Dispose(); $sheet.Dispose(); foreach ($preview in $previews) { $preview.image.Dispose() } }
        Write-Output "Preview: $PreviewPath"
    }
}
finally { $source.Dispose() }
Write-Output ("Generated {0} document icon sizes; the page appears at {1}px and above." -f $frames.Count, $pageFrom)
