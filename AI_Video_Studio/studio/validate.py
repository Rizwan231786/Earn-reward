"""Output validation: existence, container sanity, dimensions, streams, duration, decode errors."""
from __future__ import annotations

from pathlib import Path

from .ffmpeg_utils import ffmpeg_bin, media_info, run


def validate_output(path: Path, width: int | None = None, height: int | None = None, duration: float | None = None,
                    expect_audio: bool = True, full_decode: bool = True, tolerance: float = 0.25) -> dict:
    checks: dict = {}
    problems: list[str] = []
    if not path.exists() or path.stat().st_size < 1024:
        return {"ok": False, "problems": ["output file missing or empty"], "checks": {}}
    checks["size_mb"] = round(path.stat().st_size / 1e6, 2)
    try:
        info = media_info(path)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "problems": [f"file does not open: {e}"], "checks": checks}
    checks["opens"] = True
    v = info["video_streams"][0] if info["video_streams"] else None
    if not v:
        problems.append("no video stream")
    else:
        checks.update({"width": v["width"], "height": v["height"], "fps": v["fps"], "codec": v["codec"],
                       "pix_fmt": v["pix_fmt"], "color_space": v.get("color_space")})
        if width and height and (v["width"], v["height"]) != (width, height):
            problems.append(f"dimensions {v['width']}x{v['height']} != expected {width}x{height}")
    a = info["audio_streams"][0] if info["audio_streams"] else None
    checks["audio"] = bool(a)
    if a:
        checks.update({"audio_codec": a["codec"], "sample_rate": a["sample_rate"], "channels": a["channels"]})
    if expect_audio and not a:
        problems.append("no audio stream")
    checks["duration"] = round(info["duration"] or 0, 3)
    if duration is not None and abs((info["duration"] or 0) - duration) > max(tolerance, duration * 0.01):
        problems.append(f"duration {info['duration']:.2f}s differs from expected {duration:.2f}s")
    if full_decode:
        proc = run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-v", "error", "-i", str(path), "-f", "null", "-"],
                   check=False, timeout=7200)
        errs = [ln for ln in proc.stderr.splitlines() if ln.strip()]
        checks["decode_errors"] = len(errs)
        if proc.returncode != 0 or errs:
            problems.append(f"decode errors: {errs[:3]}")
    return {"ok": not problems, "problems": problems, "checks": checks}
