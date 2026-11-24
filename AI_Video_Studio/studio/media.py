"""Media analysis: metadata, thumbnails, scene detection, representative frames and
objective per-scene visual measurements (brightness, colour cast, motion, sharpness, skin
presence, subject position). Nothing here *invents* content: semantic descriptions come
only from a vision model (Claude itself via returned frames, or a configured local model).
"""
from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Callable

import numpy as np
from PIL import Image, ImageDraw

from .ffmpeg_utils import extract_frame, read_frames_rgb, run_ffmpeg_with_progress
from .fonts import pil_font
from .projects import Project

log = logging.getLogger("studio.media")


def detect_scenes(project: Project, asset: dict, threshold: float = 0.3, min_scene: float = 1.0,
                  on_progress: Callable[[float], None] | None = None, cancel_event=None) -> list[dict]:
    src = project.asset_path(asset)
    dur = float(asset["info"]["duration"] or 0)
    out_rel = f"work/scenes_{asset['id']}.txt"
    out_abs = project.path(out_rel)
    if out_abs.exists():
        out_abs.unlink()
    # Downscale before scene scoring: fast and memory-light even for 4K/long files.
    vf = f"scale=320:-2,select='gt(scene,{threshold})',metadata=print:file={out_rel}"
    run_ffmpeg_with_progress(["-i", str(src), "-an", "-sn", "-vf", vf, "-f", "null", "-"], dur,
                             on_progress=on_progress, cancel_event=cancel_event, cwd=project.root)
    cuts = []
    if out_abs.exists():
        for line in out_abs.read_text(encoding="utf-8", errors="replace").splitlines():
            if "pts_time:" in line:
                try:
                    cuts.append(float(line.split("pts_time:")[1].split()[0]))
                except (IndexError, ValueError):
                    pass
    bounds = [0.0]
    for c in sorted(cuts):
        if c - bounds[-1] >= min_scene and dur - c >= min_scene * 0.5:
            bounds.append(c)
    bounds.append(dur)
    scenes = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        if b - a < 0.05:
            continue
        scenes.append({"index": len(scenes), "start": round(a, 3), "end": round(b, 3), "duration": round(b - a, 3)})
    # Split very long scenes (e.g. one long take) into ~6s analysable chunks so the planner can
    # choose sub-sections; they are marked as continuous so no hard visual cut is implied.
    final = []
    for sc in scenes:
        if sc["duration"] > 12:
            n = math.ceil(sc["duration"] / 6.0)
            step = sc["duration"] / n
            for k in range(n):
                a = sc["start"] + k * step
                final.append({"start": round(a, 3), "end": round(a + step, 3), "duration": round(step, 3),
                              "continuous_take": True, "parent_scene": sc["index"]})
        else:
            final.append(sc | {"continuous_take": False})
    for i, sc in enumerate(final):
        sc["index"] = i
    return final


def _frame_metrics(frames: list[np.ndarray]) -> dict:
    if not frames:
        return {}
    arr = np.stack([f.astype(np.float32) for f in frames])  # n,h,w,3
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mean_rgb = arr.reshape(-1, 3).mean(0)
    # colourfulness (Hasler & Suesstrunk)
    rg, yb = r - g, 0.5 * (r + g) - b
    colorfulness = float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))
    # sharpness: mean abs laplacian of luma
    lap = np.abs(4 * luma[:, 1:-1, 1:-1] - luma[:, :-2, 1:-1] - luma[:, 2:, 1:-1] - luma[:, 1:-1, :-2] - luma[:, 1:-1, 2:])
    sharp = float(lap.mean())
    motion = float(np.abs(np.diff(luma, axis=0)).mean()) if len(frames) > 1 else 0.0
    # skin likelihood in YCbCr (lighting-robust classic ranges)
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    skin = (cb > 77) & (cb < 127) & (cr > 133) & (cr < 173) & (luma > 40)
    skin_ratio = float(skin.mean())
    # subject focus: gradient energy + skin weighting -> horizontal/vertical centroid
    gx = np.abs(np.diff(luma, axis=2))[:, :-1, :]
    gy = np.abs(np.diff(luma, axis=1))[:, :, :-1]
    energy = (gx + gy) * (1.0 + 3.0 * skin[:, :-1, :-1])
    e = energy.mean(0)
    col, row = e.sum(0), e.sum(1)
    w, h = e.shape[1], e.shape[0]
    fx = float((col * np.arange(w)).sum() / max(col.sum(), 1e-6) / w)
    fy = float((row * np.arange(h)).sum() / max(row.sum(), 1e-6) / h)
    # dominant colours (coarse quantisation)
    q = (arr.reshape(-1, 3) // 32).astype(np.int32)
    keys = q[:, 0] * 64 + q[:, 1] * 8 + q[:, 2]
    counts = np.bincount(keys, minlength=512)
    top = np.argsort(counts)[::-1][:4]
    dom = ["#%02x%02x%02x" % (int((k // 64) * 32 + 16), int(((k // 8) % 8) * 32 + 16), int((k % 8) * 32 + 16))
           for k in top if counts[k] > 0]
    return {
        "brightness": round(float(luma.mean()) / 255, 3),
        "contrast": round(float(luma.std()) / 255, 3),
        "highlights_clipped": round(float((luma > 250).mean()), 4),
        "shadows_crushed": round(float((luma < 5).mean()), 4),
        "mean_rgb": [round(float(x), 1) for x in mean_rgb],
        "color_cast": _cast(mean_rgb),
        "colorfulness": round(colorfulness, 1),
        "sharpness": round(sharp, 2),
        "motion": round(motion, 2),
        "skin_ratio": round(skin_ratio, 3),
        "likely_people": skin_ratio > 0.04,
        "subject_focus": [round(fx, 3), round(fy, 3)],
        "dominant_colors": dom,
    }


def _cast(mean_rgb: np.ndarray) -> str:
    r, g, b = mean_rgb
    avg = (r + g + b) / 3 + 1e-6
    if (r - b) / avg > 0.18:
        return "warm"
    if (b - r) / avg > 0.15:
        return "cool"
    if (g - (r + b) / 2) / avg > 0.12:
        return "green"
    if ((r + b) / 2 - g) / avg > 0.12:
        return "magenta"
    return "neutral"


def analyze_scenes(project: Project, asset: dict, scenes: list[dict],
                   on_progress: Callable[[float], None] | None = None) -> list[dict]:
    src = project.asset_path(asset)
    thumbs = project.path("thumbnails")
    out = []
    for i, sc in enumerate(scenes):
        a, b = sc["start"], sc["end"]
        times = [a + (b - a) * f for f in (0.2, 0.5, 0.8)]
        frames = read_frames_rgb(src, times, 192, 108)
        m = _frame_metrics(frames)
        thumb = thumbs / f"{asset['id']}_scene{sc['index']:03d}.jpg"
        if not thumb.exists():
            try:
                extract_frame(src, (a + b) / 2, thumb, 480)
            except Exception as e:  # noqa: BLE001
                log.warning("thumbnail failed: %s", e)
        out.append(sc | {"metrics": m, "thumbnail": project.rel(thumb) if thumb.exists() else None,
                         "description": sc.get("description"), "tags": sc.get("tags", [])})
        if on_progress:
            on_progress((i + 1) / max(1, len(scenes)))
    return out


def contact_sheet(project: Project, asset: dict, scenes: list[dict], cols: int = 4, max_tiles: int = 24,
                  first: int = 0) -> Path:
    """Build a labelled grid of scene thumbnails (sent to Claude for visual understanding)."""
    tiles = [s for s in scenes[first:first + max_tiles] if s.get("thumbnail")]
    tw, th = 320, 180
    rows = max(1, math.ceil(len(tiles) / cols))
    sheet = Image.new("RGB", (cols * tw, rows * (th + 26)), (11, 30, 58))
    draw = ImageDraw.Draw(sheet)
    font = pil_font("Inter", "SemiBold", 16)
    for k, s in enumerate(tiles):
        im = Image.open(project.path(s["thumbnail"])).convert("RGB")
        im.thumbnail((tw, th))
        x, y = (k % cols) * tw, (k // cols) * (th + 26)
        sheet.paste(im, (x + (tw - im.width) // 2, y + 26 + (th - im.height) // 2))
        draw.text((x + 6, y + 4), f"#{s['index']}  {s['start']:.1f}-{s['end']:.1f}s", fill=(46, 230, 214), font=font)
    dest = project.path("thumbnails", f"{asset['id']}_contact_{first:03d}.jpg")
    sheet.save(dest, quality=82)
    return dest


def generate_overview_thumbnails(project: Project, asset: dict, count: int = 6) -> list[str]:
    src = project.asset_path(asset)
    dur = float(asset["info"]["duration"] or 0)
    out = []
    for k in range(count):
        t = dur * (k + 0.5) / count
        dest = project.path("thumbnails", f"{asset['id']}_overview_{k:02d}.jpg")
        if not dest.exists():
            extract_frame(src, t, dest, 640)
        out.append(project.rel(dest))
    return out
