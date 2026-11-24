"""Colour correction: measured, gentle, skin-safe.

Steps: white balance (partial gray-world), exposure, contrast, highlight/shadow balancing,
saturation limits, shot matching toward a shared reference, then an optional creative look whose
strength can be set. LUTs are applied only when requested, also with adjustable strength. No
skin smoothing or beauty filters are ever applied.
"""
from __future__ import annotations

import statistics
from pathlib import Path

import numpy as np

from .ffmpeg_utils import read_frames_rgb
from .models import ColorSettings


def measure(src: Path, a: float, b: float) -> dict:
    times = [a + (b - a) * f for f in (0.25, 0.5, 0.75)]
    frames = read_frames_rgb(src, times, 128, 72)
    if not frames:
        return {}
    arr = np.stack(frames).astype(np.float32) / 255.0
    luma = 0.2126 * arr[..., 0] + 0.7152 * arr[..., 1] + 0.0722 * arr[..., 2]
    # gray-world over mid-tones only (ignore clipped / very dark pixels)
    mask = (luma > 0.12) & (luma < 0.9)
    rgb = arr[mask] if mask.sum() > 50 else arr.reshape(-1, 3)
    m = rgb.mean(0)
    return {
        "brightness": float(np.median(luma)),
        "mean": float(luma.mean()),
        "p02": float(np.percentile(luma, 2)), "p98": float(np.percentile(luma, 98)),
        "std": float(luma.std()),
        "rgb": [float(x) for x in m],
        "sat": float((arr.max(-1) - arr.min(-1)).mean()),
    }


def auto_settings(stats: list[dict], profile: dict) -> list[ColorSettings]:
    """Per-shot corrections + shot matching toward a shared reference."""
    cp = profile.get("color", {})
    target_b = float(cp.get("target_brightness", 0.47))
    valid = [s for s in stats if s]
    ref_b = statistics.median([s["brightness"] for s in valid]) if valid else target_b
    ref_b = 0.5 * ref_b + 0.5 * target_b  # match shots to each other AND toward a clean exposure
    out = []
    for s in stats:
        cs = ColorSettings(look_intensity=float(cp.get("look_intensity", 0.35)))
        if not s:
            out.append(cs)
            continue
        # white balance: move 55% of the way to neutral, clamp to keep it natural
        r, g, b = s["rgb"]
        avg = (r + g + b) / 3 + 1e-6
        k = 0.55
        cs.wb_r = float(np.clip(1 + k * (avg / max(r, 1e-6) - 1), 0.9, 1.1))
        cs.wb_g = float(np.clip(1 + k * (avg / max(g, 1e-6) - 1), 0.94, 1.06))
        cs.wb_b = float(np.clip(1 + k * (avg / max(b, 1e-6) - 1), 0.9, 1.12))
        # exposure via gamma (protects highlights) + small offset
        diff = ref_b - s["brightness"]
        cs.gamma = float(np.clip(1 + diff * 1.6, 0.82, 1.3))
        cs.exposure = float(np.clip(diff * 0.15, -0.05, 0.05))
        # contrast: lift flat footage slightly, calm harsh footage
        base_c = float(cp.get("contrast", 1.05))
        cs.contrast = float(np.clip(base_c + (0.2 - s["std"]) * 0.4, 0.95, 1.15))
        # highlight / shadow balancing
        cs.highlights_roll = float(np.clip((s["p98"] - 0.95) * 0.8, 0.0, 0.05))
        cs.shadows_lift = float(np.clip((0.03 - s["p02"]) * 0.5, 0.0, 0.025))
        # saturation: never push past profile max; tame over-saturated shots
        max_sat = float(cp.get("max_saturation", 1.08))
        cs.saturation = float(np.clip(1.0 + (0.22 - s["sat"]) * 0.6, 0.88, max_sat))
        out.append(cs)
    return out


def _look(name: str, i: float) -> str:
    if i <= 0.001:
        return ""
    if name == "cinematic_teal":
        return (f"colorbalance=rs={-0.06*i:.4f}:gs={0.0:.4f}:bs={0.08*i:.4f}:"
                f"rh={0.05*i:.4f}:gh={0.01*i:.4f}:bh={-0.04*i:.4f}")
    # clean_commercial: neutral mids (skin safe), slightly navy shadows, clean ice-blue highlights
    return (f"colorbalance=rs={-0.025*i:.4f}:bs={0.045*i:.4f}:"
            f"rh={-0.02*i:.4f}:gh={0.008*i:.4f}:bh={0.025*i:.4f}")


def filter_chain(cs: ColorSettings, look: str = "clean_commercial", lut_rel: str | None = None,
                 label_in: str = "", label_out: str = "") -> str:
    """Build a comma-separated ffmpeg filter chain (no labels unless LUT blending is needed)."""
    if not cs.enabled:
        return "null"
    parts = []
    if abs(cs.wb_r - 1) > 0.003 or abs(cs.wb_g - 1) > 0.003 or abs(cs.wb_b - 1) > 0.003:
        parts.append(f"colorchannelmixer=rr={cs.wb_r:.4f}:gg={cs.wb_g:.4f}:bb={cs.wb_b:.4f}")
    parts.append(f"eq=brightness={cs.exposure:.4f}:contrast={cs.contrast:.4f}:gamma={cs.gamma:.4f}:"
                 f"saturation={cs.saturation:.4f}")
    if cs.shadows_lift > 0.001 or cs.highlights_roll > 0.001:
        lo, hi = cs.shadows_lift, 1 - cs.highlights_roll
        parts.append(f"curves=all='0/{lo:.4f} 0.5/0.5 1/{hi:.4f}'")
    lk = _look(look, cs.look_intensity)
    if lk:
        parts.append(lk)
    chain = ",".join(parts)
    lut = lut_rel or cs.lut
    if lut:
        i = max(0.0, min(1.0, cs.lut_intensity))
        lut_esc = lut.replace("\\", "/").replace(":", "\\:")
        return (f"{chain},split[cg_a][cg_b];[cg_b]lut3d=file='{lut_esc}'[cg_l];"
                f"[cg_a][cg_l]blend=all_expr='A*{1-i:.3f}+B*{i:.3f}'")
    return chain
