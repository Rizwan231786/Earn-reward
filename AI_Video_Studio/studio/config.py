"""Configuration, directory layout and path-safety helpers.

Settings are resolved in this order (later wins):
  1. Built-in defaults
  2. <studio_home>/config.json
  3. Environment variables (AIVS_*) / .env file next to the package
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

PACKAGE_DIR = Path(__file__).resolve().parent
APP_DIR = PACKAGE_DIR.parent  # AI_Video_Studio/
ASSETS_DIR = APP_DIR / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".m4v", ".webm", ".mts", ".m2ts", ".wmv", ".mxf", ".3gp"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aiff", ".aif"}
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".svg"}
LUT_EXTS = {".cube"}

PROJECT_SUBDIRS = [
    "source", "audio", "thumbnails", "captions", "graphics", "broll",
    "previews", "exports", "work", "sfx", "music", "brand", "references",
]

DEFAULTS: dict[str, Any] = {
    "studio_home": None,  # resolved below
    "allowed_input_dirs": [],  # empty => user's home directory + inbox
    "import_mode": "link_or_copy",  # link_or_copy | copy | reference
    "ffmpeg_path": "ffmpeg",
    "ffprobe_path": "ffprobe",
    "transcription": {
        "engine": "auto",  # auto | faster-whisper | openai-whisper | none
        "model": "small",
        "device": "auto",  # auto | cpu | cuda
        "compute_type": "auto",
        "allow_model_download": False,
        "low_confidence_threshold": 0.55,
    },
    "vision": {
        "provider": "claude",  # claude (frames returned to Claude Desktop) | ollama | none
        "ollama_url": "http://127.0.0.1:11434",
        "ollama_model": "llava",
    },
    "render": {
        "video_codec": "libx264",
        "preset": "medium",
        "crf": 18,
        "audio_bitrate": "192k",
        "audio_rate": 48000,
        "threads": 0,
        "intermediate_crf": 14,
    },
    "dashboard": {"host": "127.0.0.1", "port": 8765},
    "log_level": "INFO",
}


def _default_home() -> Path:
    env = os.environ.get("AIVS_HOME")
    if env:
        return Path(env).expanduser().resolve()
    if sys.platform == "win32":
        base = Path(os.environ.get("USERPROFILE", Path.home()))
        docs = base / "Documents"
        return (docs if docs.exists() else base) / "AI_Video_Studio"
    return Path.home() / "AI_Video_Studio"


def _load_dotenv() -> None:
    env_file = APP_DIR / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def _deep_merge(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


class Settings:
    def __init__(self, data: dict[str, Any]):
        self.data = data
        self.home = Path(data["studio_home"]).expanduser().resolve()

    def __getitem__(self, key: str) -> Any:
        return self.data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    # ---- directories -------------------------------------------------
    @property
    def projects_dir(self) -> Path:
        return self.home / "projects"

    @property
    def inbox_dir(self) -> Path:
        return self.home / "inbox"

    @property
    def profiles_dir(self) -> Path:
        return self.home / "profiles"

    @property
    def library_dir(self) -> Path:
        return self.home / "library"

    @property
    def logs_dir(self) -> Path:
        return self.home / "logs"

    @property
    def db_path(self) -> Path:
        return self.home / "studio.db"

    @property
    def models_dir(self) -> Path:
        return self.home / "models"

    def ensure_dirs(self) -> None:
        for d in (self.home, self.projects_dir, self.inbox_dir, self.profiles_dir,
                  self.library_dir / "music", self.library_dir / "sfx", self.library_dir / "luts",
                  self.library_dir / "brand", self.logs_dir, self.models_dir):
            d.mkdir(parents=True, exist_ok=True)

    def allowed_roots(self) -> list[Path]:
        roots = [Path(p).expanduser().resolve() for p in self.data.get("allowed_input_dirs") or []]
        if not roots:
            roots = [Path.home().resolve()]
        roots += [self.home, ASSETS_DIR]
        return roots


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    _load_dotenv()
    home = _default_home()
    data = dict(DEFAULTS)
    data["studio_home"] = str(home)
    cfg_file = home / "config.json"
    if cfg_file.exists():
        try:
            data = _deep_merge(data, json.loads(cfg_file.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as e:  # pragma: no cover - defensive
            logging.getLogger(__name__).warning("Ignoring invalid config.json: %s", e)
    if os.environ.get("AIVS_FFMPEG"):
        data["ffmpeg_path"] = os.environ["AIVS_FFMPEG"]
    if os.environ.get("AIVS_FFPROBE"):
        data["ffprobe_path"] = os.environ["AIVS_FFPROBE"]
    if os.environ.get("AIVS_WHISPER_MODEL"):
        data["transcription"] = {**data["transcription"], "model": os.environ["AIVS_WHISPER_MODEL"]}
    if os.environ.get("AIVS_ALLOWED_DIRS"):
        data["allowed_input_dirs"] = [p for p in os.environ["AIVS_ALLOWED_DIRS"].split(os.pathsep) if p]
    s = Settings(data)
    s.ensure_dirs()
    return s


def reset_settings_cache() -> None:
    get_settings.cache_clear()


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------
class PathSecurityError(ValueError):
    pass


def is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def resolve_input_path(raw: str, settings: Settings | None = None) -> Path:
    """Resolve a user supplied input path. Bare filenames are looked up in the inbox.

    Raises PathSecurityError if the path is outside the configured allowed roots.
    """
    s = settings or get_settings()
    if not raw or "\x00" in raw:
        raise PathSecurityError("Empty or invalid path")
    raw = raw.strip().strip('"').strip("'")
    p = Path(os.path.expandvars(raw)).expanduser()
    if not p.is_absolute():
        cand = s.inbox_dir / p
        p = cand if cand.exists() else Path.cwd() / p
    p = p.resolve()
    if not any(is_within(p, r) for r in s.allowed_roots()):
        raise PathSecurityError(
            f"Access denied: '{p}' is outside the allowed folders "
            f"({', '.join(str(r) for r in s.allowed_roots())}). "
            "Add the folder to 'allowed_input_dirs' in config.json or move the file into the inbox.")
    return p


def safe_filename(name: str, max_len: int = 80) -> str:
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._") or "file"
    ext = re.sub(r"[^A-Za-z0-9]+", "", ext).lower()
    stem = stem[:max_len]
    return f"{stem}.{ext}" if ext else stem


def unique_path(path: Path) -> Path:
    """Return a path that does not exist yet (never overwrite)."""
    if not path.exists():
        return path
    i = 2
    while True:
        cand = path.with_name(f"{path.stem}_{i}{path.suffix}")
        if not cand.exists():
            return cand
        i += 1


def setup_logging() -> logging.Logger:
    s = get_settings()
    logger = logging.getLogger("studio")
    if logger.handlers:
        return logger
    logger.setLevel(s.get("log_level", "INFO"))
    fh = logging.FileHandler(s.logs_dir / "studio.log", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(fh)
    # stderr only - stdout is reserved for the MCP stdio protocol
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.WARNING)
    logger.addHandler(sh)
    return logger


_SECRET_RE = re.compile(r"(api[_-]?key|token|secret|password)(\"?\s*[:=]\s*\"?)([^\s\",]+)", re.I)


def redact(text: str) -> str:
    return _SECRET_RE.sub(lambda m: m.group(1) + m.group(2) + "***", text)
