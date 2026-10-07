# Regenerates ChiefUpdater.ico from the app icon (apps/web/public/icons/icon-512.png). The .ico is committed, so this
# only runs when the icon changes:  powershell -NoProfile -File apps/desktop/updater-helper/make-icon.ps1
# Every size is a PNG entry (Windows Vista and later read those), resampled with high-quality bicubic filtering.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$source = Join-Path $PSScriptRoot '..\..\web\public\icons\icon-512.png'
$target = Join-Path $PSScriptRoot 'ChiefUpdater.ico'
$sizes = 16, 20, 24, 32, 40, 48, 64, 96, 256

$original = [System.Drawing.Image]::FromFile((Resolve-Path $source))
$frames = foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($original, 0, 0, $size, $size)
  $g.Dispose()
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  [pscustomobject]@{ Size = $size; Bytes = $stream.ToArray() }
}
$original.Dispose()

# ICONDIR, then one ICONDIRENTRY per frame, then the PNG data.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$frames.Count)
$offset = 6 + 16 * $frames.Count
foreach ($f in $frames) {
  $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$f.Bytes.Length); $w.Write([uint32]$offset)
  $offset += $f.Bytes.Length
}
foreach ($f in $frames) { $w.Write($f.Bytes) }
$w.Flush()
[System.IO.File]::WriteAllBytes($target, $out.ToArray())
Write-Host "wrote $target ($($out.Length) bytes, $($frames.Count) sizes)"
