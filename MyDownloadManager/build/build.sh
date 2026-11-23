#!/usr/bin/env bash
# Cross-platform build (Linux/macOS): builds everything, runs all tests and produces the win-x64 publish folder and
# extension packages. The installer itself needs Inno Setup on Windows (see build/build.ps1 and the CI workflow).
set -euo pipefail
cd "$(dirname "$0")/.."
CONFIG="${CONFIG:-Release}"
echo "==> build";            dotnet build MyDownloadManager.slnx -c "$CONFIG"
echo "==> C# tests";         dotnet test tests/MyDownloadManager.Tests -c "$CONFIG" --no-build --logger "trx;LogFileName=results.trx" --results-directory artifacts/test-results
echo "==> extension tests";  (cd extensions && npm test)
echo "==> publish win-x64";  rm -rf artifacts/publish/app
dotnet publish src/MyDownloadManager.App -c "$CONFIG" -r win-x64 --self-contained true -o artifacts/publish/app -p:DebugType=None
dotnet publish src/MyDownloadManager.NativeHost -c "$CONFIG" -r win-x64 --self-contained true -o artifacts/publish/app -p:DebugType=None
echo "==> extensions";       (cd extensions && node build.mjs)
echo "==> test report";      python3 tools/test_report.py artifacts/test-results/results.trx docs/TEST_REPORT.md
echo "Done. Installer: run build/build.ps1 on Windows (needs Inno Setup 6)."
