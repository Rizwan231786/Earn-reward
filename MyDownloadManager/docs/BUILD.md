# Building MyDownloadManager

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| .NET SDK | 10.0 (tested with 10.0.115) | everything |
| Node.js | 18+ (tested with 22) | building and testing the browser extensions |
| Inno Setup | 6.x (`winget install JRSoftware.InnoSetup`) | the Windows installer (Windows only) |
| FFmpeg + ffprobe on PATH | any recent | media tests (they generate their own test videos); optional at runtime |
| PowerShell 7 | | `build\build.ps1` |
| Python 3 | | test report generation, CI helper scripts |

## One-command build (Windows)

```powershell
pwsh build\build.ps1 -BundleFfmpeg          # tests, publish, extensions, LGPL FFmpeg, installer
pwsh build\build.ps1 -SkipTests -SkipInstaller
```

Output:

| Path | Content |
|---|---|
| `artifacts\installer\MyDownloadManager_Setup.exe` | the installer |
| `artifacts\publish\app\` | self-contained app + native host (xcopy-deployable) |
| `extensions\dist\chromium\`, `extensions\dist\firefox\` | unpacked extensions |
| `extensions\dist\MyDownloadManager-*.zip` | extension packages |
| `artifacts\test-results\results.trx` | test results |

## Step by step

```bash
dotnet build MyDownloadManager.slnx -c Release
dotnet test tests/MyDownloadManager.Tests -c Release          # MDM_SKIP_LARGE=1 skips the 4 GB test
(cd extensions && npm test && node build.mjs)
dotnet publish src/MyDownloadManager.App        -c Release -r win-x64 --self-contained true -o artifacts/publish/app -p:DebugType=None
dotnet publish src/MyDownloadManager.NativeHost -c Release -r win-x64 --self-contained true -o artifacts/publish/app -p:DebugType=None
pwsh build/fetch-ffmpeg.ps1                                   # optional, LGPL FFmpeg into artifacts/ffmpeg
iscc installer/MyDownloadManager.iss                          # Windows
```

The app and the native host are published into the **same folder**, so they share one copy of the .NET runtime.

## Linux / macOS

`build/build.sh` builds everything, runs all tests, publishes the win-x64 folder and the extension packages
(`EnableWindowsTargeting` lets the WPF project compile on any OS). The WPF app itself and Inno Setup need Windows —
use `build\build.ps1` there or the CI workflow.

## Continuous integration

`.github/workflows/mydownloadmanager.yml` (repository root) runs on every push that touches `MyDownloadManager/`:

- **windows-latest**: build; all C# tests including the 4 GB download; extension tests; publish; fetch LGPL FFmpeg with
  checksum verification; **smoke test** that launches the real WPF app (`--smoke-test`) with an isolated data folder,
  downloads 48 MB from a local range-capable server, verifies the SHA-256 and the Mark-of-the-Web stream and saves a
  screenshot; compiles the installer; **silently installs** it, checks the files and the Chrome/Edge/Firefox
  native-host registry entries, talks to the installed native host like a browser, then **uninstalls** and checks
  clean-up. Artifacts: `MyDownloadManager_Setup`, `browser-extensions`, `test-results-windows`.
- **ubuntu-latest**: build and the cross-platform test suite.

## Versioning

Pass `-Version 1.2.3` to `build.ps1` (sets assembly versions and `/DAppVersion` for the installer). Also bump
`extensions/manifest.base.json` and `extensions/package.json`.

## Regenerating icons

`python3 tools/generate_icons.py` (needs Pillow) re-creates `assets/MyDownloadManager.ico`, `assets/icon256.png`
and the extension icons.
