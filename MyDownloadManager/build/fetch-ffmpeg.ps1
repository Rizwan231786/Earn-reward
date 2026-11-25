<#
.SYNOPSIS
  Downloads an LGPL-licensed FFmpeg build for Windows x64 (BtbN/FFmpeg-Builds) and verifies its SHA-256 checksum.
  Only ffmpeg.exe, its license and a source pointer are kept. See docs\FFMPEG.md for the licensing rationale.
#>
param(
    [string]$Destination = "artifacts\ffmpeg",
    [string]$Release = "latest",
    # Optional exact asset name; by default the newest release-branch win64 LGPL build is chosen automatically.
    [string]$Asset = ""
)
$ErrorActionPreference = "Stop"
$base = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Release"

if (-not $Asset) {
    # Asset names change with each FFmpeg release (e.g. ffmpeg-n7.1-latest-win64-lgpl-7.1.zip), so discover them.
    $headers = @{ "User-Agent" = "MyDownloadManager-build"; "Accept" = "application/vnd.github+json" }
    if ($env:GITHUB_TOKEN) { $headers["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
    $rel = Invoke-RestMethod "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/$Release" -Headers $headers
    $names = $rel.assets | ForEach-Object { $_.name }
    $stable = $names | Where-Object { $_ -match '^ffmpeg-n(\d+)\.(\d+)-latest-win64-lgpl-\d+\.\d+\.zip$' } |
        Sort-Object { [int]($_ -replace '^ffmpeg-n(\d+)\.(\d+).*$', '$1') * 1000 + [int]($_ -replace '^ffmpeg-n(\d+)\.(\d+).*$', '$2') } -Descending |
        Select-Object -First 1
    $Asset = if ($stable) { $stable } elseif ($names -contains "ffmpeg-master-latest-win64-lgpl.zip") { "ffmpeg-master-latest-win64-lgpl.zip" } else { $null }
    if (-not $Asset) { throw "No win64 LGPL FFmpeg build found in release '$Release'. Assets: $($names -join ', ')" }
    Write-Host "Selected FFmpeg asset: $Asset"
}
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mdm-ffmpeg-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $zip = Join-Path $tmp $Asset
    Invoke-WebRequest "$base/$Asset" -OutFile $zip -UseBasicParsing
    Invoke-WebRequest "$base/checksums.sha256" -OutFile (Join-Path $tmp "checksums.sha256") -UseBasicParsing
    $line = Get-Content (Join-Path $tmp "checksums.sha256") | Where-Object { $_ -match [Regex]::Escape($Asset) } | Select-Object -First 1
    if (-not $line) { throw "No published checksum for $Asset" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "SHA-256 mismatch for $Asset (expected $expected, got $actual)" }
    Write-Host "Checksum OK: $actual"

    Expand-Archive $zip -DestinationPath $tmp
    $dir = Get-ChildItem $tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName "bin\ffmpeg.exe") } | Select-Object -First 1
    if (Test-Path $Destination) { Remove-Item $Destination -Recurse -Force }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    Copy-Item (Join-Path $dir.FullName "bin\ffmpeg.exe") $Destination
    Copy-Item (Join-Path $dir.FullName "LICENSE.txt") (Join-Path $Destination "FFMPEG-LICENSE.txt")
    $exe = Join-Path $Destination "ffmpeg.exe"
    $version = & $exe -hide_banner -version | Select-Object -First 1
    $buildConf = (& $exe -hide_banner -buildconf) -join " "
    if ($buildConf -match "--enable-gpl" -or $buildConf -match "--enable-nonfree") {
        throw "Downloaded FFmpeg is a GPL/non-free build; refusing to bundle it."
    }
    @"
FFmpeg $version
License: GNU Lesser General Public License v2.1 or later (see FFMPEG-LICENSE.txt).
Binary: $base/$Asset (SHA-256 $actual)
Corresponding source code: https://github.com/FFmpeg/FFmpeg and build scripts https://github.com/BtbN/FFmpeg-Builds
MyDownloadManager runs ffmpeg.exe as a separate program and does not link to it.
"@ | Set-Content (Join-Path $Destination "FFMPEG-SOURCE.txt") -Encoding UTF8
    Write-Host "FFmpeg ready in $Destination"
}
finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
