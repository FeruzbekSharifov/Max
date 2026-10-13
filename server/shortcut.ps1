# Creates a MAX shortcut (with its own reactor icon) on the Desktop, or in the Startup folder with -Startup.
param([switch]$Startup, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$folder = if ($Startup) { [Environment]::GetFolderPath('Startup') } else { [Environment]::GetFolderPath('Desktop') }
$lnk = Join-Path $folder 'MAX.lnk'

if ($Remove) {
    if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "Removed $lnk" } else { Write-Host 'Nothing to remove.' }
    return
}

# Draw the icon: dark disc, glowing amber rings, bright core. Saved as a PNG-in-ICO.
$ico = Join-Path $dataDir 'max.ico'
if (-not (Test-Path $ico)) {
    Add-Type -AssemblyName System.Drawing
    $size = 256
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 14, 9, 6))), 8, 8, 240, 240)
    foreach ($r in @(@(104, 6, 90), @(88, 3, 160), @(70, 10, 120), @(50, 2, 200))) {
        $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($r[2], 255, 154, 46)), $r[1]
        $g.DrawEllipse($pen, 128 - $r[0], 128 - $r[0], $r[0] * 2, $r[0] * 2)
    }
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(78, 78, 100, 100)
    $brush = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
    $brush.CenterColor = [System.Drawing.Color]::FromArgb(255, 255, 246, 220)
    $brush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 120, 20))
    $g.FillEllipse($brush, 78, 78, 100, 100)
    $g.Dispose()
    $ms = New-Object IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $png = $ms.ToArray()
    $out = New-Object IO.MemoryStream
    $w = New-Object IO.BinaryWriter $out
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)                # ICONDIR
    $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)  # 256x256, no palette
    $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
    $w.Write($png)
    [IO.File]::WriteAllBytes($ico, $out.ToArray())
}

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\server\server.ps1`""
$s.WorkingDirectory = $root
$s.IconLocation = $ico
$s.WindowStyle = 7
$s.Description = 'MAX - personal assistant'
$s.Save()
Write-Host "Created $lnk"
