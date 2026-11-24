"""Thin, Windows-safe wrappers around ffmpeg / ffprobe.

* stdout of child processes is always captured - the MCP stdio channel must stay clean.
* No console windows are opened on Windows.
* Long-running encodes report progress through a callback and can be cancelled.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Callable, Iterable, Sequence

import numpy as np

from .config import get_settings

log = logging.getLogger("studio.ffmpeg")

_CREATE_FLAGS = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


class FFmpegError(RuntimeError):
    def __init__(self, message: str, stderr: str = ""):
        super().__init__(message)
        self.stderr = stderr


class CancelledError(RuntimeError):
    pass


def ffmpeg_bin() -> str:
    return get_settings()["ffmpeg_path"]


def ffprobe_bin() -> str:
    return get_settings()["ffprobe_path"]


def which(binary: str) -> str | None:
    p = Path(binary)
    if p.is_file():
        return str(p)
    return shutil.which(binary)


def tool_version(binary: str) -> str | None:
    exe = which(binary)
    if not exe:
        return None
    try:
        out = subprocess.run([exe, "-hide_banner", "-version"], capture_output=True, text=True,
                             timeout=20, creationflags=_CREATE_FLAGS, stdin=subprocess.DEVNULL)
        return out.stdout.splitlines()[0] if out.stdout else None
    except (OSError, subprocess.SubprocessError):
        return None


def run(args: Sequence[str], *, cwd: Path | None = None, timeout: float | None = None,
        check: bool = True, text: bool = True) -> subprocess.CompletedProcess:
    log.debug("run: %s", " ".join(map(str, args)))
    proc = subprocess.run(list(map(str, args)), capture_output=True, text=text, cwd=cwd,
                          timeout=timeout, creationflags=_CREATE_FLAGS, stdin=subprocess.DEVNULL,
                          **({"encoding": "utf-8", "errors": "replace"} if text else {}))
    if check and proc.returncode != 0:
        err = proc.stderr if text else proc.stderr.decode("utf-8", "replace")
        raise FFmpegError(f"{Path(args[0]).name} failed (exit {proc.returncode}): {_tail(err)}", err)
    return proc


def _tail(text: str, n: int = 12) -> str:
    lines = [ln for ln in (text or "").splitlines() if ln.strip()]
    return "\n".join(lines[-n:])


_MAJOR: dict[str, int] = {}


def ffmpeg_major() -> int:
    exe = ffmpeg_bin()
    if exe not in _MAJOR:
        import re
        v = tool_version(exe) or ""
        m = re.search(r"version\s+n?(\d+)\.", v)
        _MAJOR[exe] = int(m.group(1)) if m else 6  # git builds ("N-xxxxx") are modern
        if not m and "version N-" in v:
            _MAJOR[exe] = 8
    return _MAJOR[exe]


def filter_script_args(script: str) -> list[str]:
    """FFmpeg >= 7 reads filtergraphs from files via '-/filter_complex'; older via -filter_complex_script."""
    return ["-/filter_complex", script] if ffmpeg_major() >= 7 else ["-filter_complex_script", script]


def ffmpeg(args: Sequence[str], **kw) -> subprocess.CompletedProcess:
    return run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-y", *args], **kw)


def run_ffmpeg_with_progress(args: Sequence[str], total_seconds: float,
                             on_progress: Callable[[float], None] | None = None,
                             cancel_event: threading.Event | None = None,
                             cwd: Path | None = None) -> None:
    """Run ffmpeg, parsing `-progress pipe:1` output. Raises CancelledError if cancelled."""
    cmd = [ffmpeg_bin(), "-hide_banner", "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-loglevel", "error", *map(str, args)]
    log.info("ffmpeg: %s", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                            cwd=cwd, creationflags=_CREATE_FLAGS, text=True, encoding="utf-8",
                            errors="replace", bufsize=1)
    stderr_chunks: list[str] = []

    def _drain_stderr():
        assert proc.stderr
        for line in proc.stderr:
            stderr_chunks.append(line)
            if len(stderr_chunks) > 400:
                del stderr_chunks[:200]

    t = threading.Thread(target=_drain_stderr, daemon=True)
    t.start()

    def _watch_cancel():
        while proc.poll() is None:
            if cancel_event is not None and cancel_event.is_set():
                proc.terminate()
                try:
                    proc.wait(5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                return
            time.sleep(0.2)

    w = threading.Thread(target=_watch_cancel, daemon=True)
    w.start()
    assert proc.stdout
    for line in proc.stdout:
        line = line.strip()
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                us = int(line.split("=", 1)[1])
                if on_progress and total_seconds > 0:
                    on_progress(min(1.0, us / 1e6 / total_seconds))
            except ValueError:
                pass
    proc.wait()
    t.join(2)
    if cancel_event is not None and cancel_event.is_set():
        raise CancelledError("Render cancelled by user")
    if proc.returncode != 0:
        err = "".join(stderr_chunks)
        raise FFmpegError(f"ffmpeg failed (exit {proc.returncode}): {_tail(err)}", err)
    if on_progress:
        on_progress(1.0)


# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------
@dataclass
class StreamInfo:
    width: int | None = None
    height: int | None = None
    fps: float | None = None
    fps_fraction: str | None = None
    codec: str | None = None
    duration: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    rotation: int = 0


def probe(path: Path) -> dict:
    out = run([ffprobe_bin(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams",
               str(path)], timeout=120)
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError as e:
        raise FFmpegError(f"Could not parse ffprobe output for {path}") from e


def _rate(r: str | None) -> tuple[float | None, str | None]:
    if not r or r in ("0/0", "0"):
        return None, None
    try:
        f = Fraction(r)
        if f <= 0:
            return None, None
        return float(f), f"{f.numerator}/{f.denominator}"
    except (ValueError, ZeroDivisionError):
        return None, None


def media_info(path: Path) -> dict:
    """Return a compact, JSON-friendly description of a media file."""
    data = probe(path)
    fmt = data.get("format", {})
    video, audio = [], []
    for s in data.get("streams", []):
        if s.get("codec_type") == "video":
            if s.get("disposition", {}).get("attached_pic"):
                continue
            fps, frac = _rate(s.get("avg_frame_rate") or s.get("r_frame_rate"))
            rot = 0
            for sd in s.get("side_data_list", []) or []:
                if "rotation" in sd:
                    rot = int(sd["rotation"])
            if "rotate" in (s.get("tags") or {}):
                rot = int(s["tags"]["rotate"])
            w, h = s.get("width"), s.get("height")
            if rot % 180 != 0 and w and h:
                w, h = h, w  # report display orientation
            video.append({
                "index": s.get("index"), "codec": s.get("codec_name"), "width": w, "height": h,
                "fps": round(fps, 3) if fps else None, "fps_fraction": frac,
                "pix_fmt": s.get("pix_fmt"), "rotation": rot,
                "color_space": s.get("color_space"), "color_transfer": s.get("color_transfer"),
                "duration": float(s["duration"]) if s.get("duration") else None,
                "bit_rate": int(s["bit_rate"]) if s.get("bit_rate") else None,
            })
        elif s.get("codec_type") == "audio":
            audio.append({
                "index": s.get("index"), "codec": s.get("codec_name"),
                "sample_rate": int(s["sample_rate"]) if s.get("sample_rate") else None,
                "channels": s.get("channels"), "channel_layout": s.get("channel_layout"),
                "duration": float(s["duration"]) if s.get("duration") else None,
            })
    duration = float(fmt["duration"]) if fmt.get("duration") else None
    if duration is None:
        durs = [x["duration"] for x in video + audio if x.get("duration")]
        duration = max(durs) if durs else None
    return {
        "path": str(path), "format_name": fmt.get("format_name"), "duration": duration,
        "size_bytes": int(fmt["size"]) if fmt.get("size") else path.stat().st_size,
        "bit_rate": int(fmt["bit_rate"]) if fmt.get("bit_rate") else None,
        "video_streams": video, "audio_streams": audio,
        "has_video": bool(video), "has_audio": bool(audio),
    }


# ---------------------------------------------------------------------------
# Frame / audio extraction helpers (streamed - never load whole files)
# ---------------------------------------------------------------------------
def extract_frame(src: Path, t: float, dest: Path, width: int = 480) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg(["-ss", f"{max(0.0, t):.3f}", "-i", str(src), "-frames:v", "1",
            "-vf", f"scale={width}:-2", "-q:v", "3", str(dest)], timeout=120)
    return dest


def read_frames_rgb(src: Path, times: Iterable[float], width: int = 160, height: int = 90) -> list[np.ndarray]:
    """Decode single small RGB frames at the given timestamps (fast input seeking)."""
    frames = []
    for t in times:
        proc = run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-loglevel", "error", "-ss", f"{max(0.0, t):.3f}",
                    "-i", str(src), "-frames:v", "1", "-vf", f"scale={width}:{height}",
                    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], text=False, check=False, timeout=120)
        buf = proc.stdout
        if proc.returncode == 0 and len(buf) >= width * height * 3:
            frames.append(np.frombuffer(buf[: width * height * 3], np.uint8).reshape(height, width, 3))
    return frames


def silence_intervals(src: Path, noise_db: float = -35.0, min_dur: float = 0.25) -> list[tuple[float, float]]:
    """Detect silences with ffmpeg's silencedetect (streamed)."""
    proc = run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-i", str(src), "-vn",
                "-af", f"silencedetect=noise={noise_db}dB:d={min_dur}", "-f", "null", "-"], check=False, timeout=3600)
    starts, out = [], []
    for line in proc.stderr.splitlines():
        if "silence_start:" in line:
            try:
                starts.append(float(line.split("silence_start:")[1].split()[0]))
            except (IndexError, ValueError):
                pass
        elif "silence_end:" in line and starts:
            try:
                end = float(line.split("silence_end:")[1].split("|")[0].strip())
                out.append((max(0.0, starts.pop()), end))
            except (IndexError, ValueError):
                pass
    if starts:  # silence running to end of file
        s0 = starts.pop()
        dur = media_info(src).get("duration") or s0
        if dur > s0:
            out.append((s0, dur))
    return out


def audio_loudness_stats(src: Path) -> dict:
    proc = run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-i", str(src), "-vn",
                "-af", "astats=metadata=0:reset=0,ebur128=framelog=quiet", "-f", "null", "-"], check=False, timeout=3600)
    stats: dict = {}
    for line in proc.stderr.splitlines():
        line = line.strip()
        for key, name in (("RMS level dB:", "rms_db"), ("Peak level dB:", "peak_db"),
                          ("Noise floor dB:", "noise_floor_db"), ("I:", "integrated_lufs"), ("LRA:", "lra")):
            if line.startswith(key):
                try:
                    stats[name] = float(line.split(":", 1)[1].split()[0])
                except (ValueError, IndexError):
                    pass
    return stats
