"""Project management: folders, project.json state, SQLite history, safe asset import."""
from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import (AUDIO_EXTS, IMAGE_EXTS, LUT_EXTS, PROJECT_SUBDIRS, VIDEO_EXTS, PathSecurityError,
                     get_settings, is_within, resolve_input_path, safe_filename, unique_path)
from .ffmpeg_utils import FFmpegError, media_info

log = logging.getLogger("studio.projects")
_lock = threading.RLock()

ASSET_KINDS = {
    "video": ("source", VIDEO_EXTS),
    "voiceover": ("audio", AUDIO_EXTS | VIDEO_EXTS),
    "music": ("music", AUDIO_EXTS),
    "sfx": ("sfx", AUDIO_EXTS),
    "image": ("references", IMAGE_EXTS),
    "logo": ("brand", IMAGE_EXTS),
    "broll": ("broll", VIDEO_EXTS | IMAGE_EXTS),
    "lut": ("work", LUT_EXTS),
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------
@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    s = get_settings()
    con = sqlite3.connect(s.db_path, timeout=30)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript("""
            CREATE TABLE IF NOT EXISTS projects(
                id TEXT PRIMARY KEY, name TEXT, path TEXT, profile TEXT, aspect TEXT,
                status TEXT, created_at TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS jobs(
                id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, status TEXT, stage TEXT,
                progress REAL, message TEXT, result TEXT, error TEXT, cancel_requested INTEGER DEFAULT 0,
                pid INTEGER, created_at TEXT, updated_at TEXT);
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
        """)
        yield con
        con.commit()
    finally:
        con.close()


def get_setting(key: str, default: Any = None) -> Any:
    with db() as con:
        row = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_setting(key: str, value: Any) -> None:
    with db() as con:
        con.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (key, json.dumps(value)))


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------
class ProjectError(ValueError):
    pass


class Project:
    def __init__(self, root: Path):
        self.root = root
        self.file = root / "project.json"
        if not self.file.exists():
            raise ProjectError(f"Not a project folder: {root}")
        self.data: dict[str, Any] = json.loads(self.file.read_text(encoding="utf-8"))

    # -- basic props --------------------------------------------------
    @property
    def id(self) -> str:
        return self.data["id"]

    def path(self, *parts: str) -> Path:
        p = (self.root.joinpath(*parts)).resolve()
        if not is_within(p, self.root):
            raise PathSecurityError(f"Path escapes project folder: {p}")
        return p

    def rel(self, p: Path) -> str:
        return Path(os.path.relpath(p.resolve(), self.root)).as_posix()

    def save(self) -> None:
        with _lock:
            self.data["updated_at"] = now_iso()
            tmp = self.file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.data, indent=2, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self.file)
            with db() as con:
                con.execute("UPDATE projects SET name=?, profile=?, aspect=?, status=?, updated_at=? WHERE id=?",
                            (self.data["name"], self.data.get("profile"), self.data.get("aspect"),
                             self.data.get("status"), self.data["updated_at"], self.id))

    def log_event(self, msg: str) -> None:
        self.data.setdefault("history", []).append({"at": now_iso(), "event": msg})
        self.data["history"] = self.data["history"][-200:]

    # -- assets -------------------------------------------------------
    def assets(self, kind: str | None = None) -> list[dict]:
        a = self.data.setdefault("assets", [])
        return [x for x in a if kind is None or x["kind"] == kind]

    def asset(self, asset_id: str) -> dict:
        for a in self.assets():
            if a["id"] == asset_id:
                return a
        raise ProjectError(f"Asset '{asset_id}' not found in project {self.id}")

    def asset_path(self, asset_or_id: dict | str) -> Path:
        a = self.asset(asset_or_id) if isinstance(asset_or_id, str) else asset_or_id
        if a.get("stored") == "reference":
            return Path(a["original_path"])
        return self.path(a["path"])

    def voiceover(self) -> dict | None:
        v = self.assets("voiceover")
        return v[-1] if v else None

    # -- json side files ---------------------------------------------
    def read_json(self, rel: str, default: Any = None) -> Any:
        p = self.path(rel)
        if not p.exists():
            return default
        return json.loads(p.read_text(encoding="utf-8"))

    def write_json(self, rel: str, obj: Any) -> Path:
        p = self.path(rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, p)
        return p

    def summary(self) -> dict:
        return {
            "id": self.id, "name": self.data["name"], "path": str(self.root),
            "profile": self.data.get("profile"), "aspect": self.data.get("aspect"),
            "status": self.data.get("status"), "created_at": self.data.get("created_at"),
            "updated_at": self.data.get("updated_at"),
            "assets": [{"id": a["id"], "kind": a["kind"], "name": a["name"],
                        "duration": (a.get("info") or {}).get("duration")} for a in self.assets()],
            "has_transcript": self.path("audio", "transcript.json").exists(),
            "has_plan": self.path("editing_timeline.json").exists(),
            "exports": [self.rel(p) for p in sorted(self.path("exports").glob("*.mp4"))],
        }


def _next_project_id() -> str:
    s = get_settings()
    existing = [p.name for p in s.projects_dir.glob("project_*") if p.is_dir()]
    nums = [int(n.split("_")[1]) for n in existing if n.split("_")[1].isdigit()]
    return f"project_{(max(nums) + 1) if nums else 1:03d}"


def create_project(name: str, profile: str = "premium_commercial", aspect: str = "16:9") -> Project:
    s = get_settings()
    with _lock:
        pid = _next_project_id()
        root = s.projects_dir / pid
        root.mkdir(parents=True, exist_ok=False)
        for d in PROJECT_SUBDIRS:
            (root / d).mkdir(exist_ok=True)
        data = {
            "id": pid, "uid": uuid.uuid4().hex, "name": name or pid, "created_at": now_iso(),
            "updated_at": now_iso(), "profile": profile, "aspect": aspect, "status": "created",
            "assets": [], "history": [], "settings_overrides": {},
        }
        (root / "project.json").write_text(json.dumps(data, indent=2), encoding="utf-8")
        with db() as con:
            con.execute("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)",
                        (pid, data["name"], str(root), profile, aspect, "created", data["created_at"], data["updated_at"]))
    p = Project(root)
    p.log_event("project created")
    p.save()
    return p


def load_project(project_id: str) -> Project:
    s = get_settings()
    if not project_id or any(c in project_id for c in "/\\:") or project_id.startswith("."):
        raise ProjectError(f"Invalid project id '{project_id}'")
    root = s.projects_dir / project_id
    if not root.exists():
        raise ProjectError(f"Project '{project_id}' does not exist. Use list_projects to see available projects.")
    return Project(root)


def list_projects() -> list[dict]:
    s = get_settings()
    out = []
    for root in sorted(s.projects_dir.glob("project_*")):
        if (root / "project.json").exists():
            try:
                p = Project(root)
                out.append({k: v for k, v in p.summary().items() if k != "assets"} | {"asset_count": len(p.assets())})
            except (OSError, json.JSONDecodeError):
                continue
    return out


def _copy_chunked(src: Path, dst: Path, chunk: int = 8 * 1024 * 1024) -> None:
    with open(src, "rb") as fi, open(dst, "xb") as fo:  # 'x' => never overwrite
        while True:
            b = fi.read(chunk)
            if not b:
                break
            fo.write(b)
    shutil.copystat(src, dst)


def import_asset(project: Project, raw_path: str, kind: str, label: str | None = None,
                 import_mode: str | None = None) -> dict:
    """Import a file into the project without ever modifying the original."""
    if kind not in ASSET_KINDS:
        raise ProjectError(f"Unknown asset kind '{kind}'. Use one of {list(ASSET_KINDS)}")
    src = resolve_input_path(raw_path)
    if not src.exists():
        raise ProjectError(f"File not found: {src}")
    if not src.is_file():
        raise ProjectError(f"Not a file: {src}")
    subdir, exts = ASSET_KINDS[kind]
    if src.suffix.lower() not in exts:
        raise ProjectError(f"Unsupported file type '{src.suffix}' for {kind}. Supported: {sorted(exts)}")
    for a in project.assets(kind):
        if a.get("original_path") == str(src) and a.get("size") == src.stat().st_size:
            return a | {"already_imported": True}

    info = None
    if src.suffix.lower() in VIDEO_EXTS | AUDIO_EXTS:
        try:
            info = media_info(src)
        except FFmpegError as e:
            raise ProjectError(f"Could not read media file (corrupt or unsupported codec): {e}") from e
        if kind in ("video", "broll") and not info["has_video"]:
            raise ProjectError(f"{src.name} contains no video stream")
        if kind in ("voiceover", "music", "sfx") and not info["has_audio"]:
            raise ProjectError(f"{src.name} contains no audio stream")

    mode = import_mode or get_settings().get("import_mode", "link_or_copy")
    dest = unique_path(project.path(subdir, safe_filename(src.name)))
    stored = "reference"
    if mode != "reference":
        stored = "copy"
        if mode == "link_or_copy":
            try:
                os.link(src, dest)
                stored = "hardlink"
            except OSError:
                pass
        if stored == "copy":
            _copy_chunked(src, dest)

    prefix = {"video": "vid", "voiceover": "vo", "music": "mus", "sfx": "sfx", "image": "img",
              "logo": "logo", "broll": "broll", "lut": "lut"}[kind]
    n = len(project.assets(kind)) + 1
    asset = {
        "id": f"{prefix}_{n:02d}", "kind": kind, "name": label or src.name,
        "original_path": str(src), "path": project.rel(dest) if stored != "reference" else None,
        "stored": stored, "size": src.stat().st_size, "imported_at": now_iso(), "info": info,
    }
    while any(a["id"] == asset["id"] for a in project.assets()):
        n += 1
        asset["id"] = f"{prefix}_{n:02d}"
    project.data["assets"].append(asset)
    project.data["status"] = "media_imported"
    project.log_event(f"imported {kind} {src.name} as {asset['id']} ({stored})")
    project.save()
    return asset


def list_inbox() -> list[dict]:
    s = get_settings()
    out = []
    for p in sorted(s.inbox_dir.rglob("*")):
        if p.is_file():
            ext = p.suffix.lower()
            kind = ("video" if ext in VIDEO_EXTS else "audio" if ext in AUDIO_EXTS else
                    "image" if ext in IMAGE_EXTS else "lut" if ext in LUT_EXTS else "other")
            out.append({"name": p.relative_to(s.inbox_dir).as_posix(), "path": str(p), "type": kind,
                        "size_mb": round(p.stat().st_size / 1e6, 2),
                        "modified": time.strftime("%Y-%m-%d %H:%M", time.localtime(p.stat().st_mtime))})
    return out
