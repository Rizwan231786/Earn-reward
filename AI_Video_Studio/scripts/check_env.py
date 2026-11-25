"""Stage-1 environment inspection: prints what is installed and what is missing.

Usage:  python scripts/check_env.py      (works before or after installation)
"""
from __future__ import annotations

import importlib
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path


def ver(cmd: list[str]) -> str | None:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        return (out.stdout or out.stderr).splitlines()[0].strip() if out.returncode == 0 else None
    except (OSError, subprocess.SubprocessError, IndexError):
        return None


def claude_configs() -> list[Path]:
    c = []
    if os.environ.get("APPDATA"):
        c.append(Path(os.environ["APPDATA"]) / "Claude" / "claude_desktop_config.json")
    if os.environ.get("LOCALAPPDATA"):
        for pkg in (Path(os.environ["LOCALAPPDATA"]) / "Packages").glob("Claude_*"):
            print(f"Claude Desktop: Microsoft Store version detected ({pkg.name})")
            c.append(pkg / "LocalCache" / "Roaming" / "Claude" / "claude_desktop_config.json")
    c.append(Path.home() / "Library/Application Support/Claude/claude_desktop_config.json")
    return c


def main() -> int:
    ok = True
    print("=" * 64)
    print(" AI Video Studio - environment check")
    print("=" * 64)
    print(f"OS            : {platform.platform()}")
    py_ok = sys.version_info >= (3, 10)
    ok &= py_ok
    print(f"Python        : {sys.version.split()[0]} ({sys.executable}) {'OK' if py_ok else 'NEEDS 3.10+ (3.12 recommended)'}")
    for b in ("ffmpeg", "ffprobe"):
        exe = os.environ.get(f"AIVS_{b.upper()}") or shutil.which(b)
        v = ver([exe, "-hide_banner", "-version"]) if exe else None
        ok &= bool(v)
        print(f"{b:<14}: {v or 'MISSING  ->  winget install --id Gyan.FFmpeg -e   (then reopen the terminal)'}")
    gpu = ver(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"])
    print(f"NVIDIA GPU    : {gpu or 'not detected (CPU transcription will be used - fine, just slower)'}")
    for mod in ("mcp", "pydantic", "PIL", "numpy", "faster_whisper"):
        try:
            m = importlib.import_module(mod)
            print(f"{mod:<14}: {getattr(m, '__version__', 'installed')}")
        except Exception:  # noqa: BLE001
            print(f"{mod:<14}: not installed{' (run install.bat)' if mod != 'faster_whisper' else ' (optional: speech-to-text)'}")
            if mod in ("mcp", "pydantic", "PIL", "numpy"):
                ok = False
    home = Path(os.environ.get("AIVS_HOME") or (Path(os.environ.get("USERPROFILE", Path.home())) / "Documents" / "AI_Video_Studio"))
    try:
        du = shutil.disk_usage(home if home.exists() else home.anchor or "/")
        print(f"Studio home   : {home}  ({du.free / 1e9:.1f} GB free)")
    except OSError:
        print(f"Studio home   : {home}")
    found = [p for p in claude_configs() if p.exists()]
    if found:
        for p in found:
            try:
                cfg = json.loads(p.read_text(encoding="utf-8") or "{}")
                servers = list((cfg.get("mcpServers") or {}).keys())
            except (OSError, json.JSONDecodeError):
                servers = ["<unreadable>"]
            print(f"Claude Desktop: {p}\n                MCP servers: {servers or 'none'}")
    else:
        print("Claude Desktop: config not found (install Claude Desktop, open it once, then run setup_claude_desktop.bat)")
    print("=" * 64)
    print("RESULT: " + ("ready" if ok else "missing requirements - see above"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
