"""Audio engine: voice enhancement, pause tightening (with time remapping), loudness,
procedurally generated royalty-free SFX and ambient music beds, and mix graph helpers.

Generated sounds are synthesised locally from oscillators and noise, so no third-party
copyright applies. Music is only ever user-supplied or this generated ambient bed.
"""
from __future__ import annotations

import bisect
import json
import logging
import wave
from pathlib import Path
from typing import Callable

import numpy as np

from .config import get_settings
from .ffmpeg_utils import ffmpeg, media_info, run
from .ffmpeg_utils import ffmpeg_bin, filter_script_args

log = logging.getLogger("studio.audio")
SR = 48000


# ---------------------------------------------------------------------------
# Pause tightening
# ---------------------------------------------------------------------------
def keep_intervals(words: list[dict], duration: float, max_pause: float, pad: float = 0.12) -> list[tuple[float, float]]:
    """Intervals of the voice to keep so that no pause exceeds `max_pause` seconds."""
    if not words:
        return [(0.0, duration)]
    cuts = []
    for a, b in zip(words, words[1:]):
        gap = b["start"] - a["end"]
        if gap > max_pause + 2 * pad:
            excess_start = a["end"] + pad + max_pause / 2
            excess_end = b["start"] - pad - max_pause / 2
            if excess_end - excess_start > 0.05:
                cuts.append((excess_start, excess_end))
    keep, t = [], 0.0
    for a, b in cuts:
        keep.append((t, a))
        t = b
    keep.append((t, duration))
    return [(round(a, 4), round(b, 4)) for a, b in keep if b - a > 0.01]


class TimeMap:
    """Piecewise-linear map from original voice time to edited voice time."""

    def __init__(self, keep: list[tuple[float, float]]):
        self.keep = keep
        self.starts = [a for a, _ in keep]
        self.offsets = []
        acc = 0.0
        for a, b in keep:
            self.offsets.append(acc - a)
            acc += b - a
        self.total = acc

    def __call__(self, t: float) -> float:
        i = bisect.bisect_right(self.starts, t) - 1
        if i < 0:
            return 0.0
        a, b = self.keep[i]
        return min(t, b) + self.offsets[i]

    def to_json(self) -> list:
        return self.keep

    @classmethod
    def identity(cls, duration: float) -> "TimeMap":
        return cls([(0.0, duration)])


# ---------------------------------------------------------------------------
# Voice processing
# ---------------------------------------------------------------------------
def _noise_floor(src: Path) -> float | None:
    proc = run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-i", str(src), "-vn", "-af",
                "astats=metadata=0:reset=0:measure_overall=RMS_trough", "-f", "null", "-"], check=False, timeout=3600)
    for line in proc.stderr.splitlines():
        if "RMS trough dB" in line:
            try:
                v = float(line.split(":")[-1])
                return v if v > -200 else None
            except ValueError:
                pass
    return None


def process_voice(src: Path, dest: Path, words: list[dict], *, enhance: bool = True, denoise: str = "auto",
                  target_lufs: float = -14.0, tighten: bool = False, max_pause: float = 0.6,
                  cancel_check: Callable[[], None] | None = None) -> dict:
    """Render the processed voice to a 48 kHz stereo WAV. Returns report incl. the time map."""
    dur = float(media_info(src)["duration"] or 0)
    keep = keep_intervals(words, dur, max_pause) if tighten else [(0.0, dur)]
    tm = TimeMap(keep)
    pre = []
    nf = _noise_floor(src)
    level = denoise
    if denoise == "auto":
        level = "off" if nf is None or nf < -62 else ("light" if nf < -48 else "medium")
    if enhance:
        pre.append("highpass=f=75")
        if level == "light":
            pre.append("afftdn=nr=8:nf=-50:tn=1")
        elif level == "medium":
            pre.append("afftdn=nr=14:nf=-44:tn=1")
        pre += ["equalizer=f=220:t=q:w=1.0:g=-2", "equalizer=f=3200:t=q:w=1.2:g=2",
                "equalizer=f=9000:t=q:w=0.8:g=1",
                "acompressor=threshold=-21dB:ratio=2.5:attack=12:release=200:makeup=1.6:knee=4"]
    chain = ",".join(pre) if pre else "anull"
    tmp = dest.with_name(dest.stem + "_pre.wav")
    if len(keep) > 1:
        n = len(keep)
        fc = []
        for i, (a, b) in enumerate(keep):
            fc.append(f"[0:a]atrim={a:.4f}:{b:.4f},asetpts=PTS-STARTPTS,afade=t=in:d=0.008,"
                      f"afade=t=out:st={max(0.0, b - a - 0.012):.4f}:d=0.012[k{i}]")
        fc.append("".join(f"[k{i}]" for i in range(n)) + f"concat=n={n}:v=0:a=1,{chain}[out]")
        script = dest.with_name(dest.stem + "_trim.txt")
        script.write_text(";\n".join(fc), encoding="utf-8")
        ffmpeg(["-i", str(src), *filter_script_args(str(script)), "-map", "[out]", "-ac", "2", "-ar", str(SR),
                "-c:a", "pcm_s24le", str(tmp)], timeout=7200)
    else:
        ffmpeg(["-i", str(src), "-vn", "-af", chain, "-ac", "2", "-ar", str(SR), "-c:a", "pcm_s24le", str(tmp)], timeout=7200)
    if cancel_check:
        cancel_check()
    # two-pass loudness normalisation (EBU R128), linear when possible -> no pumping
    m = run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-i", str(tmp), "-af",
             f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"], check=False, timeout=7200)
    meas = _parse_loudnorm(m.stderr)
    if meas:
        ln = (f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11:measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:"
              f"measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}:offset={meas['target_offset']}:"
              "linear=true")
    else:
        ln = f"loudnorm=I={target_lufs}:TP=-1.5:LRA=11"
    ffmpeg(["-i", str(tmp), "-af", f"{ln},aresample={SR},alimiter=limit=0.89:level=false", "-ar", str(SR), "-ac", "2",
            "-c:a", "pcm_s24le", str(dest)], timeout=7200)
    tmp.unlink(missing_ok=True)
    return {"path": str(dest), "original_duration": dur, "edited_duration": tm.total, "noise_floor_db": nf,
            "denoise": level, "cuts": max(0, len(keep) - 1), "keep": keep,
            "input_lufs": float(meas["input_i"]) if meas else None}


def _parse_loudnorm(stderr: str) -> dict | None:
    try:
        s = stderr[stderr.rindex("{"): stderr.rindex("}") + 1]
        d = json.loads(s)
        return d if "input_i" in d and d["input_i"] not in ("-inf", "inf") else None
    except (ValueError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------
# Procedural, royalty-free sound effects
# ---------------------------------------------------------------------------
def _env(n: int, attack: float, release: float, curve: float = 2.0) -> np.ndarray:
    t = np.linspace(0, 1, n)
    a = max(1e-4, attack)
    env = np.where(t < a, (t / a) ** 0.6, ((1 - t) / max(1e-4, 1 - a)) ** curve)
    if release < 1:
        env *= np.clip((1 - t) / max(1e-4, release), 0, 1) ** 0.5
    return env


def _lowpass(x: np.ndarray, alpha: np.ndarray | float) -> np.ndarray:
    if np.isscalar(alpha):  # vectorised one-pole via truncated exponential kernel
        k = np.arange(int(6 / max(float(alpha), 1e-3)))
        kernel = float(alpha) * (1 - float(alpha)) ** k
        return np.convolve(x, kernel)[: len(x)]
    y = np.empty_like(x)
    acc = 0.0
    al = np.broadcast_to(alpha, x.shape)
    for i in range(len(x)):
        acc += al[i] * (x[i] - acc)
        y[i] = acc
    return y


def _write_wav(path: Path, stereo: np.ndarray) -> None:
    stereo = np.clip(stereo, -1, 1)
    data = (stereo * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())


def _stereo(mono: np.ndarray, pan_from: float = 0.0, pan_to: float = 0.0) -> np.ndarray:
    pan = np.linspace(pan_from, pan_to, len(mono))
    l = mono * np.sqrt((1 - pan) / 2)
    r = mono * np.sqrt((1 + pan) / 2)
    return np.stack([l, r], 1) * 1.41


def _norm(x: np.ndarray, peak: float = 0.8) -> np.ndarray:
    m = np.abs(x).max()
    return x / m * peak if m > 0 else x


def synth_sfx(name: str, rng: np.random.Generator) -> np.ndarray:
    if name.startswith("whoosh"):
        fast = name == "whoosh_fast"
        dur = 0.45 if fast else 0.8
        n = int(SR * dur)
        t = np.linspace(0, 1, n)
        noise = rng.standard_normal(n)
        sweep = 0.02 + 0.25 * np.sin(np.pi * t) ** 2
        x = _lowpass(noise, sweep) - _lowpass(noise, sweep * 0.08)
        x *= _env(n, 0.55 if not fast else 0.4, 1.0, 1.6)
        return _stereo(_norm(x, 0.7), -0.6, 0.6)
    if name in ("ui_click", "ui_tap"):
        dur = 0.09 if name == "ui_click" else 0.14
        n = int(SR * dur)
        t = np.arange(n) / SR
        f = 1800 if name == "ui_click" else 1100
        x = np.sin(2 * np.pi * f * t) * np.exp(-t * 60) + 0.3 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t * 90)
        x += 0.15 * rng.standard_normal(n) * np.exp(-t * 300)
        return _stereo(_norm(x, 0.6))
    if name == "notification_chime":
        n = int(SR * 0.9)
        t = np.arange(n) / SR
        x = np.zeros(n)
        for f, st in ((1318.5, 0.0), (1760.0, 0.12)):
            tt = np.clip(t - st, 0, None)
            x += np.where(t >= st, (np.sin(2 * np.pi * f * tt) + 0.25 * np.sin(2 * np.pi * 2 * f * tt)) * np.exp(-tt * 6), 0)
        return _stereo(_norm(x, 0.55))
    if name in ("impact_soft", "impact_cinematic"):
        big = name == "impact_cinematic"
        n = int(SR * (1.8 if big else 0.9))
        t = np.arange(n) / SR
        f = 55 * np.exp(-t * 3) + 38
        phase = 2 * np.pi * np.cumsum(f) / SR
        x = np.sin(phase) * np.exp(-t * (2.2 if big else 4.5))
        noise = _lowpass(rng.standard_normal(n), 0.05) * np.exp(-t * 18)
        x += 0.6 * noise
        return _stereo(_norm(np.tanh(x * 1.6), 0.75))
    if name == "shimmer":
        n = int(SR * 1.2)
        t = np.arange(n) / SR
        x = np.zeros(n)
        for k, f in enumerate((2093, 2637, 3136, 4186)):
            st = k * 0.07
            tt = np.clip(t - st, 0, None)
            x += np.where(t >= st, np.sin(2 * np.pi * f * tt) * np.exp(-tt * 4), 0)
        return _stereo(_norm(x, 0.35), -0.4, 0.4)
    if name == "riser":
        n = int(SR * 1.6)
        t = np.arange(n) / SR
        f = 200 + 900 * (t / t[-1]) ** 2
        x = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.4 + _lowpass(rng.standard_normal(n), 0.02 + 0.3 * t / t[-1]) * 0.6
        x *= (t / t[-1]) ** 1.5
        x[-int(SR * 0.03):] *= np.linspace(1, 0, int(SR * 0.03))
        return _stereo(_norm(x, 0.6))
    if name == "pop":
        n = int(SR * 0.12)
        t = np.arange(n) / SR
        f = 900 * np.exp(-t * 25) + 300
        x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 40)
        return _stereo(_norm(x, 0.6))
    raise ValueError(f"Unknown generated SFX '{name}'")


SFX_NAMES = ["whoosh_soft", "whoosh_fast", "ui_click", "ui_tap", "notification_chime", "impact_soft",
             "impact_cinematic", "shimmer", "riser", "pop"]


def sfx_library() -> dict[str, Path]:
    """Generate (once) and return the built-in royalty-free SFX library."""
    d = get_settings().library_dir / "sfx" / "generated"
    d.mkdir(parents=True, exist_ok=True)
    out = {}
    for i, n in enumerate(SFX_NAMES):
        p = d / f"{n}.wav"
        if not p.exists():
            _write_wav(p, synth_sfx(n, np.random.default_rng(1234 + i)))
        out[n] = p
    # user-provided licensed sfx in library/sfx (top level) are also available by stem
    for p in (get_settings().library_dir / "sfx").glob("*.*"):
        if p.suffix.lower() in (".wav", ".mp3", ".m4a", ".flac", ".ogg"):
            out.setdefault(p.stem, p)
    return out


# ---------------------------------------------------------------------------
# Generated ambient music bed (royalty-free, loopable)
# ---------------------------------------------------------------------------
def generated_ambient(dest: Path, seconds: float = 32.0, mood: str = "calm") -> Path:
    if dest.exists():
        return dest
    rng = np.random.default_rng(7)
    n = int(SR * seconds)
    t = np.arange(n) / SR
    chords = {"calm": [(220.0, 277.18, 329.63, 415.3), (196.0, 246.94, 293.66, 369.99),
                       (174.61, 220.0, 261.63, 329.63), (196.0, 246.94, 293.66, 392.0)],
              "uplifting": [(261.63, 329.63, 392.0, 493.88), (293.66, 349.23, 440.0, 523.25),
                            (220.0, 261.63, 329.63, 392.0), (246.94, 293.66, 392.0, 493.88)]}[
        "uplifting" if mood == "uplifting" else "calm"]
    seg = n // len(chords)
    left, right = np.zeros(n), np.zeros(n)
    xf = int(SR * 1.5)
    for ci, ch in enumerate(chords):
        a = max(0, ci * seg - xf)
        b = min(n, (ci + 1) * seg + xf)
        tt = t[a:b]
        env = np.ones(b - a)
        ramp = min(xf * 2, (b - a) // 2)
        env[:ramp] = np.linspace(0, 1, ramp) ** 2
        env[-ramp:] = np.linspace(1, 0, ramp) ** 2
        for k, f in enumerate(ch):
            det = 1 + (k - 1.5) * 0.0015
            tone = np.sin(2 * np.pi * f * det * tt) + 0.35 * np.sin(2 * np.pi * f * 2 * tt + k) + 0.12 * np.sin(2 * np.pi * f * 3 * tt)
            trem = 0.85 + 0.15 * np.sin(2 * np.pi * (0.13 + 0.05 * k) * tt + k)
            pan = (k - 1.5) / 2.2
            left[a:b] += tone * trem * env * np.sqrt((1 - pan) / 2)
            right[a:b] += tone * trem * env * np.sqrt((1 + pan) / 2)
        bass = np.sin(2 * np.pi * ch[0] / 2 * tt) * env * 0.6
        left[a:b] += bass
        right[a:b] += bass
    air = _lowpass(rng.standard_normal(n), 0.03) * 0.04
    left += air
    right += air
    # seamless loop: crossfade tail into head
    lf = int(SR * 1.0)
    for ch in (left, right):
        ch[:lf] = ch[:lf] * np.linspace(0, 1, lf) + ch[-lf:] * np.linspace(1, 0, lf)
    st = np.stack([left[:-lf], right[:-lf]], 1)
    _write_wav(dest, _norm(st, 0.5))
    return dest
