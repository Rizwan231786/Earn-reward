"""Font resolution for Pillow graphics and libass captions.

Bundled OFL fonts (Inter, Manrope, Montserrat) live in assets/fonts and are always preferred so
renders look identical on every machine. System fonts are a fallback.
"""
from __future__ import annotations

import os
import sys
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from .config import FONTS_DIR

WEIGHTS = ["Regular", "Medium", "SemiBold", "Bold", "ExtraBold"]
FAMILIES = ["Inter", "Manrope", "Montserrat"]


def _system_font_dirs() -> list[Path]:
    dirs = []
    if sys.platform == "win32":
        dirs.append(Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts")
        dirs.append(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts")
    elif sys.platform == "darwin":
        dirs += [Path("/Library/Fonts"), Path.home() / "Library/Fonts", Path("/System/Library/Fonts")]
    else:
        dirs += [Path("/usr/share/fonts"), Path.home() / ".fonts", Path.home() / ".local/share/fonts"]
    return [d for d in dirs if d.exists()]


@lru_cache(maxsize=64)
def font_file(family: str = "Inter", weight: str = "SemiBold") -> str:
    family = family if family in FAMILIES else family.strip()
    cand = FONTS_DIR / f"{family}-{weight}.ttf"
    if cand.exists():
        return str(cand)
    # nearest bundled weight
    for w in (weight, "Bold", "SemiBold", "Regular"):
        cand = FONTS_DIR / f"{family}-{w}.ttf"
        if cand.exists():
            return str(cand)
    # system fallback
    names = [f"{family}-{weight}", f"{family}{weight}", family, "segoeuib", "segoeui", "arialbd", "Arial",
             "DejaVuSans-Bold", "DejaVuSans"]
    for d in _system_font_dirs():
        for n in names:
            for ext in (".ttf", ".otf", ".TTF"):
                hits = list(d.rglob(n + ext))
                if hits:
                    return str(hits[0])
    bundled = FONTS_DIR / "Inter-SemiBold.ttf"
    if bundled.exists():
        return str(bundled)
    raise FileNotFoundError("No usable font found. Reinstall the studio (assets/fonts is missing).")


@lru_cache(maxsize=256)
def pil_font(family: str = "Inter", weight: str = "SemiBold", size: int = 32) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(font_file(family, weight), size)
    except (OSError, FileNotFoundError):
        return ImageFont.load_default(size)


def ass_font_name(family: str, weight: str) -> str:
    """Name libass should request. Bundled statics expose '<Family> <Weight>' legacy names."""
    if weight in ("Regular",):
        return family
    if weight == "Bold":
        return family  # with \b1 / Bold=-1 style flag
    return f"{family} {weight}"
