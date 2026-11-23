<#
.SYNOPSIS
  Builds, tests and packages MyDownloadManager on Windows.
.DESCRIPTION
  1. Runs the automated tests (C# + extension JS tests)
  2. Publishes the WPF app and the native messaging host (self-contained win-x64) into artifacts\publish\app
  3. Builds the browser extensions (extensions\dist)
  4. Optionally downloads an LGPL FFmpeg build and verifies its SHA-256 (artifacts\ffmpeg)
  5. Compiles the installer with Inno Setup -> artifacts\installer\MyDownloadManager_Setup.exe
.EXAMPLE
  pwsh build\build.ps1 -BundleFfmpeg
#>
[CmdletBinding()]
param(
    [string]$Configuration = "Release",
    [string]$Version = "1.0.0",
    [switch]$SkipTests,
    [switch]$BundleFfmpeg,
    [switch]$SkipInstaller
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Push-Location $root
try {
    function Step($name) { Write-Host "`n==> $name" -ForegroundColor Cyan }

    Step "Restore & build"
    dotnet build MyDownloadManager.slnx -c $Configuration -p:Version=$Version
    if ($LASTEXITCODE) { throw "build failed" }

    if (-not $SkipTests) {
        Step "C# tests"
        dotnet test tests\MyDownloadManager.Tests -c $Configuration --no-build --logger "trx;LogFileName=results.trx" --results-directory artifacts\test-results
        if ($LASTEXITCODE) { throw "tests failed" }
        Step "Extension tests"
        Push-Location extensions; npm test; $code = $LASTEXITCODE; Pop-Location
        if ($code) { throw "extension tests failed" }
    }

    Step "Publish app + native host (win-x64, self-contained)"
    $out = "artifacts\publish\app"
    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
    dotnet publish src\MyDownloadManager.App -c $Configuration -r win-x64 --self-contained true -o $out -p:DebugType=None -p:Version=$Version
    if ($LASTEXITCODE) { throw "publish app failed" }
    dotnet publish src\MyDownloadManager.NativeHost -c $Configuration -r win-x64 --self-contained true -o $out -p:DebugType=None -p:Version=$Version
    if ($LASTEXITCODE) { throw "publish host failed" }

    Step "Build browser extensions"
    Push-Location extensions; node build.mjs; $code = $LASTEXITCODE; Pop-Location
    if ($code) { throw "extension build failed" }

    if ($BundleFfmpeg) {
        Step "Fetch LGPL FFmpeg"
        & (Join-Path $PSScriptRoot "fetch-ffmpeg.ps1") -Destination "artifacts\ffmpeg"
    }

    if (-not $SkipInstaller) {
        Step "Compile installer"
        $iscc = @(
            "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
            "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
            "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
        ) | Where-Object { Test-Path $_ } | Select-Object -First 1
        if (-not $iscc) { throw "Inno Setup 6 not found. Install it (winget install JRSoftware.InnoSetup) or use -SkipInstaller." }
        & $iscc "/DAppVersion=$Version" installer\MyDownloadManager.iss
        if ($LASTEXITCODE) { throw "ISCC failed" }
        Get-Item artifacts\installer\MyDownloadManager_Setup.exe | Format-List Name, Length, LastWriteTime
    }
}
finally { Pop-Location }
