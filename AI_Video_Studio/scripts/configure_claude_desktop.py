"""Register the AI Video Studio MCP server in Claude Desktop's config, safely.

* Backs up the existing claude_desktop_config.json (timestamped) before any change.
* Shows exactly what will be added and asks for confirmation (unless --yes).
* Keeps every other MCP server and setting untouched.
* Uses absolute paths and the virtual-environment Python interpreter.

Usage:
  python scripts/configure_claude_desktop.py            (interactive)
  python scripts/configure_claude_desktop.py --print    (only print the JSON snippet)
  python scripts/configure_claude_desktop.py --yes      (no prompt)
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
SERVER_NAME = "ai-video-studio"


def venv_python() -> Path:
    for cand in (APP_DIR / ".venv" / "Scripts" / "python.exe", APP_DIR / ".venv" / "bin" / "python"):
        if cand.exists():
            return cand
    return Path(sys.executable)


def config_path() -> Path:
    if os.environ.get("LOCALAPPDATA"):  # Microsoft Store (MSIX) build
        hits = list((Path(os.environ["LOCALAPPDATA"]) / "Packages").glob("Claude_*/LocalCache/Roaming/Claude"))
        if hits:
            return hits[0] / "claude_desktop_config.json"
    if os.environ.get("APPDATA"):
        return Path(os.environ["APPDATA"]) / "Claude" / "claude_desktop_config.json"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/Claude/claude_desktop_config.json"
    return Path.home() / ".config/Claude/claude_desktop_config.json"


def server_entry(home: str | None) -> dict:
    env = {"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    if home:
        env["AIVS_HOME"] = home
    return {"command": str(venv_python()), "args": ["-m", "studio.server"], "env": env}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--print", action="store_true")
    ap.add_argument("--home", default=os.environ.get("AIVS_HOME"))
    ap.add_argument("--config", default=None)
    a = ap.parse_args()
    entry = server_entry(a.home)
    snippet = {"mcpServers": {SERVER_NAME: entry}}
    if a.print:
        print(json.dumps(snippet, indent=2))
        return 0
    path = Path(a.config) if a.config else config_path()
    print(f"Claude Desktop config: {path}")
    cfg: dict = {}
    if path.exists():
        raw = path.read_text(encoding="utf-8").strip()
        try:
            cfg = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            print("ERROR: the existing config is not valid JSON. Fix it manually; nothing was changed.")
            print("Add this block yourself:\n" + json.dumps(snippet, indent=2))
            return 2
    servers = cfg.setdefault("mcpServers", {})
    old_home = ((servers.get(SERVER_NAME) or {}).get("env") or {}).get("AIVS_HOME")
    if old_home and not a.home:  # keep a previously chosen studio folder
        entry["env"]["AIVS_HOME"] = old_home
    if SERVER_NAME in servers:
        print("An 'ai-video-studio' entry already exists:\n" + json.dumps(servers[SERVER_NAME], indent=2))
        if servers[SERVER_NAME] == entry:
            print("It is already up to date. Nothing to do.")
            return 0
        print("It will be REPLACED with:")
    else:
        print(f"Existing MCP servers kept as-is: {list(servers) or 'none'}\nThis entry will be ADDED:")
    print(json.dumps({SERVER_NAME: entry}, indent=2))
    if not a.yes:
        ans = input("Apply this change? A backup is made first. [y/N]: ").strip().lower()
        if ans not in ("y", "yes"):
            print("Cancelled - nothing changed.")
            return 1
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_name(f"claude_desktop_config.backup_{time.strftime('%Y%m%d_%H%M%S')}.json")
        shutil.copy2(path, backup)
        print(f"Backup saved: {backup}")
    servers[SERVER_NAME] = entry
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    os.replace(tmp, path)
    print("Done. Fully quit Claude Desktop (tray icon > Quit) and start it again to load the studio tools.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
