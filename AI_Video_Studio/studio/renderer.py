"""Render engine: executes an editing timeline with FFmpeg.

Pipeline
  1. Voice processing (enhance, denoise, optional pause tightening, loudness).
  2. Per-segment intermediates (trim, reframe, motion, colour): cached by content hash, so a
     re-render after a small change, or after an interruption, only re-encodes what changed.
  3. Graphics PNGs, ASS captions and the music bed.
  4. Final composite: joins (cuts and xfades), animated overlays, burned captions, audio mix with
     ducking, H.264/AAC 48 kHz Rec.709 MP4 with +faststart.
  5. Validation of the output file.

Every ffmpeg call runs with cwd set to the project folder and uses relative paths inside filter
strings. That avoids the Windows drive-letter escaping problems in filtergraphs.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import shutil
import time
from pathlib import Path
from typing import Any

from . import audio as audio_mod
from . import color as color_mod
from .captions import build_captions
from .config import FONTS_DIR, IMAGE_EXTS, get_settings, unique_path
from .ffmpeg_utils import filter_script_args, media_info, run_ffmpeg_with_progress
from .graphics import Placed, render_graphic
from .jobs import JobContext
from .models import Timeline, VideoSegment
from .profiles import load_profile
from .projects import Project, now_iso
from .validate import validate_output

log = logging.getLogger("studio.renderer")

XFADE = {"dissolve": "fade", "fade_black": "fadeblack", "slide_left": "slideleft", "slide_up": "slideup",
         "wipe": "wipeleft", "smooth_zoom": "zoomin"}


def ensure_fonts() -> Path:
    """Copy bundled fonts next to the projects so libass can use a short relative fontsdir."""
    dest = get_settings().home / "fonts"
    dest.mkdir(parents=True, exist_ok=True)
    for f in FONTS_DIR.glob("*.ttf"):
        t = dest / f.name
        if not t.exists() or t.stat().st_size != f.stat().st_size:
            shutil.copy2(f, t)
    return dest


def _rel(project: Project, p: Path) -> str:
    return os.path.relpath(p, project.root).replace("\\", "/")


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def _fps(tl: Timeline) -> str:
    if tl.output.fps_fraction:
        return tl.output.fps_fraction
    if tl.output.fps:
        return f"{tl.output.fps:.3f}".rstrip("0").rstrip(".")
    return "30"


def _fps_float(fps: str) -> float:
    if "/" in fps:
        a, b = fps.split("/")
        return float(a) / float(b)
    return float(fps)


# ---------------------------------------------------------------------------
# Segment rendering
# ---------------------------------------------------------------------------
def reframe_filter(seg: VideoSegment, sw: int, sh: int, W: int, H: int, fps: str, dur: float) -> str:
    rf = seg.reframe
    tgt = W / H
    src = sw / sh
    if src > tgt:
        cw, ch = sh * tgt, sh
    else:
        cw, ch = sw, sw / tgt
    z = max(1.0, rf.zoom)
    cw, ch = cw / z, ch / z
    retained = (cw * ch) / (sw * sh)
    mode = rf.mode
    if mode == "auto":
        mode = "crop" if retained >= 0.30 else "blur_fill"
    if abs(src - tgt) < 0.01 and z == 1.0:
        mode = "crop"
    if mode == "crop":
        x = min(max(0.0, rf.focus_x * sw - cw / 2), sw - cw)
        y = min(max(0.0, rf.focus_y * sh - ch / 2), sh - ch)
        if src > tgt:
            y = (sh - ch) / 2
        base = f"crop={_even(cw)}:{_even(ch)}:{int(x)}:{int(y)},scale={W}:{H}:flags=lanczos"
    elif mode == "blur_fill":
        base = (f"split=2[rf_a][rf_b];[rf_a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
                f"scale=iw/4:-2,gblur=sigma=12,scale={W}:{H},eq=brightness=-0.06:saturation=0.85[rf_bg];"
                f"[rf_b]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[rf_fg];"
                f"[rf_bg][rf_fg]overlay=(W-w)/2:(H-h)/2")
    else:  # fit
        base = (f"scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos,"
                f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=0x0B1E3A")
    if rf.motion in ("slow_push", "slow_pull"):
        n = max(1, int(round(dur * _fps_float(fps))))
        p = 0.04
        zexpr = f"1+{p}*on/{n}" if rf.motion == "slow_push" else f"{1+p}-{p}*on/{n}"
        base += (f",scale={W*2}:{H*2}:flags=bicubic,zoompan=z='{zexpr}':x='iw/2-(iw/zoom/2)':"
                 f"y='ih/2-(ih/zoom/2)':d=1:s={W}x{H}:fps={fps}")
    return base


def render_segment(project: Project, tl: Timeline, seg: VideoSegment, W: int, H: int, fps: str, extra: float,
                   quality: str, look: str, out_dir: Path, ctx: JobContext | None, lo: float, hi: float) -> Path:
    asset = project.asset(seg.asset_id)
    src = project.asset_path(asset)
    is_image = src.suffix.lower() in IMAGE_EXTS
    dur = seg.duration + extra
    key = json.dumps([seg.model_dump(), W, H, fps, extra, quality, look, str(src),
                      src.stat().st_mtime if src.exists() else 0], sort_keys=True, default=str)
    h = hashlib.sha1(key.encode()).hexdigest()[:12]
    dest = out_dir / f"{seg.id}_{h}.mp4"
    if dest.exists() and dest.stat().st_size > 1000:
        return dest
    if is_image:
        from PIL import Image
        with Image.open(src) as im:
            sw, sh = im.size
        inputs = ["-loop", "1", "-framerate", fps, "-t", f"{dur:.3f}", "-i", str(src)]
    else:
        vs = asset["info"]["video_streams"][0]
        sw, sh = vs["width"], vs["height"]
        inputs = ["-ss", f"{seg.src_in:.3f}", "-i", str(src)]
    vf = reframe_filter(seg, sw, sh, W, H, fps, dur)
    lut_rel = seg.color.lut
    cchain = color_mod.filter_chain(seg.color, look, lut_rel)
    if cchain and cchain != "null":
        vf += "," + cchain
    vf += f",fps={fps},tpad=stop_mode=clone:stop_duration={max(1.0, extra + 0.5):.2f},format=yuv420p,setsar=1"
    rc = get_settings()["render"]
    enc = (["-c:v", "libx264", "-preset", "ultrafast", "-crf", "26"] if quality == "preview"
           else ["-c:v", "libx264", "-preset", "fast", "-crf", str(rc.get("intermediate_crf", 14))])
    tmp = dest.with_suffix(".part.mp4")
    run_ffmpeg_with_progress([*inputs, "-an", "-sn", "-dn", "-vf", vf, "-t", f"{dur:.3f}", "-r", fps, *enc,
                              "-pix_fmt", "yuv420p", "-video_track_timescale", "90000", str(tmp)],
                             dur, on_progress=ctx.progress_cb(lo, hi, f"rendering {seg.id}") if ctx else None,
                             cancel_event=ctx.cancel_event if ctx else None, cwd=project.root)
    os.replace(tmp, dest)
    return dest


def _source_audio_bed(project: Project, tl: Timeline, out_dir: Path, ctx: JobContext | None) -> Path | None:
    segs = [s for s in tl.segments if (s.keep_source_audio or tl.audio.keep_source_audio)]
    segs = [s for s in segs if (project.asset(s.asset_id).get("info") or {}).get("has_audio")]
    if not segs:
        return None
    dest = out_dir / "source_audio_bed.wav"
    inputs, fc = [], []
    for i, s in enumerate(segs):
        inputs += ["-ss", f"{s.src_in:.3f}", "-t", f"{s.duration:.3f}", "-i", str(project.asset_path(s.asset_id))]
        ms = int(round(s.timeline_start * 1000))
        fc.append(f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo,afade=t=in:d=0.02,"
                  f"afade=t=out:st={max(0.0, s.duration-0.03):.3f}:d=0.03,adelay={ms}|{ms}[sa{i}]")
    fc.append("".join(f"[sa{i}]" for i in range(len(segs))) +
              f"amix=inputs={len(segs)}:normalize=0:duration=longest,apad,atrim=0:{tl.duration:.3f}[out]")
    script = out_dir / "source_audio.fc"
    script.write_text(";\n".join(fc), encoding="utf-8")
    run_ffmpeg_with_progress([*inputs, *filter_script_args(_rel(project, script)), "-map", "[out]",
                              "-c:a", "pcm_s16le", "-ar", "48000", str(dest)], tl.duration,
                             cancel_event=ctx.cancel_event if ctx else None, cwd=project.root)
    return dest


# ---------------------------------------------------------------------------
# Overlay animation
# ---------------------------------------------------------------------------
def _overlay_exprs(pl: Placed, anim: str, start: float, s: float, W: int) -> tuple[str, str]:
    e = f"min(1,max(0,(t-{start:.3f})/0.45))"
    ease = f"(1-pow(1-{e},3))"
    if pl.fullscreen:
        return "0", "0"
    if anim == "slide":
        direction = -1 if pl.x + pl.w / 2 < W / 2 else 1  # enter from the nearest edge
        dist = 70 * s
        return f"{pl.x}+{direction*dist:.1f}*(1-{ease})", f"{pl.y}"
    if anim in ("rise", "pop"):
        dist = (40 if anim == "rise" else 18) * s
        return f"{pl.x}", f"{pl.y}+{dist:.1f}*(1-{ease})"
    return f"{pl.x}", f"{pl.y}"


# ---------------------------------------------------------------------------
# Main render
# ---------------------------------------------------------------------------
def render(project: Project, quality: str = "final", ctx: JobContext | None = None, output_name: str | None = None,
           overwrite: bool = False) -> dict:
    data = project.read_json("editing_timeline.json")
    if not data:
        raise ValueError("No editing plan. Run create_editing_plan first.")
    tl = Timeline(**data)
    problems = tl.validate_against({a["id"] for a in project.assets()})
    if problems:
        raise ValueError("Plan has problems: " + "; ".join(problems))
    profile = load_profile(tl.profile)
    look = profile.get("color", {}).get("look", "clean_commercial")
    t_start = time.time()
    W, H = tl.output.width, tl.output.height
    if quality == "preview":
        k = 540 / min(W, H)
        W, H = _even(W * k), _even(H * k)
    fps = _fps(tl)
    work = project.path("work", f"render_{quality}")
    work.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {"quality": quality, "width": W, "height": H, "fps": fps, "stages": {}}
    upd = (lambda st, p: ctx.update(stage=st, progress=p, force=True)) if ctx else (lambda st, p: None)

    # 1. voice ------------------------------------------------------------------------------------
    upd("processing voiceover", 0.01)
    tr = project.read_json("audio/transcript.json") or {}
    words = tr.get("words") or []
    voice_path, tmap = None, None
    if tl.voiceover_asset_id:
        vo = project.asset(tl.voiceover_asset_id)
        a = tl.audio
        key = hashlib.sha1(json.dumps([a.model_dump(), [(w["start"], w["end"]) for w in words],
                                       vo["id"], vo.get("size")]).encode()).hexdigest()[:10]
        voice_path = project.path("audio", f"voice_processed_{key}.wav")
        meta_path = voice_path.with_suffix(".json")
        if voice_path.exists() and meta_path.exists():
            vrep = json.loads(meta_path.read_text(encoding="utf-8"))
        else:
            vrep = audio_mod.process_voice(project.asset_path(vo), voice_path, words, enhance=a.voice_enhance,
                                           denoise=a.denoise, target_lufs=a.target_lufs, tighten=a.tighten_pauses,
                                           max_pause=a.max_pause, cancel_check=ctx.check_cancel if ctx else None)
            meta_path.write_text(json.dumps(vrep), encoding="utf-8")
        tmap = audio_mod.TimeMap([tuple(k) for k in vrep["keep"]])
        report["stages"]["voice"] = {k: vrep[k] for k in ("denoise", "cuts", "noise_floor_db", "edited_duration")}
    if ctx:
        ctx.check_cancel()

    # 2. segments ---------------------------------------------------------------------------------
    segs = sorted(tl.segments, key=lambda s: s.timeline_start)
    total_seg = sum(s.duration for s in segs) or 1
    files: list[Path] = []
    p0 = 0.04
    for i, s in enumerate(segs):
        nxt = segs[i + 1] if i + 1 < len(segs) else None
        extra = nxt.transition_in.duration if (nxt and nxt.transition_in.type != "cut") else 0.0
        span = 0.5 * s.duration / total_seg
        files.append(render_segment(project, tl, s, W, H, fps, extra, quality, look, work, ctx, p0, p0 + span))
        p0 += span
        if ctx:
            ctx.check_cancel()
    report["stages"]["segments"] = len(files)

    # 3. graphics / captions / music --------------------------------------------------------------
    upd("rendering graphics", 0.56)
    gdir = project.path("graphics", f"{quality}_{W}x{H}")
    gdir.mkdir(parents=True, exist_ok=True)
    placed: list[tuple[Any, Placed]] = []
    kinetic = []
    for g in tl.graphics:
        if g.type == "kinetic_text":
            kinetic.append(g)
            continue
        try:
            pl = render_graphic(g, W, H, profile, gdir, project.root)
            if pl:
                placed.append((g, pl))
        except Exception as e:  # noqa: BLE001
            log.warning("graphic %s skipped: %s", g.id, e)
            report.setdefault("warnings", []).append(f"graphic {g.id} skipped: {e}")

    # keep graphics clear of the caption safe zone
    if tl.captions.enabled and words:
        from .captions import _layout, auto_font_size
        align, mv = _layout(tl.captions, W, H)
        fs = tl.captions.font_size or auto_font_size(W, H)
        if align == 2:
            zone_top = H - mv - int(fs * 1.3 * tl.captions.max_lines) - int(0.02 * H)
            zone_bot = H - mv + int(0.01 * H)
        elif align == 5:
            zone_top, zone_bot = H // 2 - int(fs * 1.4), H // 2 + int(fs * 1.4)
        else:
            zone_top, zone_bot = mv - int(0.01 * H), mv + int(fs * 1.3 * tl.captions.max_lines)
        for g, pl in placed:
            if pl.fullscreen or g.type in ("logo_bug",):
                continue
            if pl.y < zone_bot and pl.y + pl.h > zone_top:
                pl.y = max(int(0.04 * H), zone_top - pl.h) if pl.y + pl.h / 2 < zone_bot else pl.y
                if pl.y < zone_bot and pl.y + pl.h > zone_top:  # still overlapping: move below
                    pl.y = min(H - pl.h, zone_bot)

    fonts_dir = ensure_fonts()
    ass_rel = None
    cap_report = None
    if (tl.captions.enabled and words) or kinetic:
        off = tl.voiceover_offset
        tm = tmap or (lambda t: t)
        cw = words if (tl.captions.enabled and words) else []
        caps = build_captions(cw, tl.captions, W, H, time_map=lambda t: off + tm(t), kinetic=kinetic)
        ass_p = project.path("captions", f"captions_{quality}.ass")
        ass_p.write_text(caps["ass"], encoding="utf-8")
        ass_rel = _rel(project, ass_p)
        if cw:
            project.path("captions", "captions.srt").write_text(caps["srt"], encoding="utf-8")
        cap_report = {k: caps[k] for k in ("groups", "words", "dropped_non_roman_words")}
        report["stages"]["captions"] = cap_report

    music_path = None
    if tl.music.asset_id == "generated_ambient":
        music_path = audio_mod.generated_ambient(get_settings().library_dir / "music" / "generated_ambient_calm.wav")
    elif tl.music.asset_id:
        music_path = project.asset_path(tl.music.asset_id)
    sfx_lib = audio_mod.sfx_library()
    src_bed = _source_audio_bed(project, tl, work, ctx)

    # 4. final composite ---------------------------------------------------------------------------
    upd("compositing", 0.6)
    inputs: list[str] = []
    fc: list[str] = []
    n_in = 0
    has_tr = any(s.transition_in.type != "cut" for s in segs[1:])
    if not has_tr:
        lst = work / "concat.txt"
        lst.write_text("".join(f"file '{f.name}'\n" for f in files), encoding="utf-8")
        inputs += ["-f", "concat", "-safe", "0", "-i", _rel(project, lst)]
        fc.append(f"[0:v]setpts=PTS-STARTPTS,fps={fps}[vb]")
        n_in = 1
    else:
        for f in files:
            inputs += ["-i", _rel(project, f)]
        for i in range(len(files)):
            fc.append(f"[{i}:v]setpts=PTS-STARTPTS,settb=AVTB[s{i}]")
        cur = "s0"
        for i in range(1, len(files)):
            s = segs[i]
            out = f"j{i}"
            if s.transition_in.type == "cut":
                fc.append(f"[{cur}][s{i}]concat=n=2:v=1:a=0[{out}]")
            else:
                fc.append(f"[{cur}][s{i}]xfade=transition={XFADE.get(s.transition_in.type, 'fade')}:"
                          f"duration={s.transition_in.duration:.3f}:offset={s.timeline_start:.3f}[{out}]")
            cur = out
        fc.append(f"[{cur}]fps={fps}[vb]")
        n_in = len(files)
    vcur = "vb"
    if tl.duration > sum(s.duration for s in segs) + 0.04:
        fc.append(f"[{vcur}]tpad=stop_mode=clone:stop_duration={tl.duration:.3f}[vpad]")
        vcur = "vpad"
    sc = min(W, H) / 1080
    for k, (g, pl) in enumerate(placed):
        idx = n_in
        n_in += 1
        gd = max(0.2, min(g.duration, tl.duration - g.start))
        inputs += ["-loop", "1", "-framerate", fps, "-t", f"{gd:.3f}", "-i", _rel(project, pl.path)]
        fd = 0.35 if g.type != "logo_bug" else 0.6
        fc.append(f"[{idx}:v]format=rgba,fade=t=in:st=0:d={fd}:alpha=1,fade=t=out:st={max(0.0, gd-fd):.3f}:d={fd}:alpha=1,"
                  f"setpts=PTS-STARTPTS+{g.start:.3f}/TB[gf{k}]")
        x, y = _overlay_exprs(pl, g.animation, g.start, sc, W)
        fc.append(f"[{vcur}][gf{k}]overlay=x='{x}':y='{y}':eof_action=pass:eval=frame:"
                  f"enable='between(t,{g.start:.3f},{g.start+gd:.3f})'[vo{k}]")
        vcur = f"vo{k}"
    if ass_rel:
        fonts_rel = os.path.relpath(fonts_dir, project.root).replace("\\", "/")
        fc.append(f"[{vcur}]ass=filename='{ass_rel}':fontsdir='{fonts_rel}'[vass]")
        vcur = "vass"
    fc.append(f"[{vcur}]format=yuv420p,setsar=1[vout]")

    # audio
    amix: list[str] = []
    if voice_path:
        vi = n_in
        n_in += 1
        inputs += ["-i", _rel(project, voice_path)]
        ms = int(round(tl.voiceover_offset * 1000))
        fc.append(f"[{vi}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms},apad[voice]")
        if music_path and tl.music.duck_under_voice:
            fc.append("[voice]asplit=2[vmix][vkey]")
            amix.append("[vmix]")
        else:
            amix.append("[voice]")
    if music_path:
        mi = n_in
        n_in += 1
        inputs += ["-stream_loop", "-1", "-i", str(music_path)]
        fo = tl.music.fade_out
        chain = (f"[{mi}:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:{tl.duration:.3f},asetpts=PTS-STARTPTS,"
                 f"volume={tl.music.volume_db}dB,afade=t=in:d={tl.music.fade_in},"
                 f"afade=t=out:st={max(0.0, tl.duration-fo):.3f}:d={fo}")
        if voice_path and tl.music.duck_under_voice:
            ratio = max(2.0, min(20.0, abs(tl.music.duck_amount_db) / 1.5))
            fc.append(chain + "[mus0]")
            fc.append(f"[mus0][vkey]sidechaincompress=threshold=0.015:ratio={ratio:.1f}:attack=25:release=450:"
                      f"makeup=1[mus]")
        else:
            fc.append(chain + "[mus]")
        amix.append("[mus]")
    for k, fx in enumerate(tl.sfx):
        p = sfx_lib.get(fx.name)
        if p is None:
            cand = project.path(fx.name) if not os.path.isabs(fx.name) else None
            p = cand if cand and cand.exists() else None
        if p is None:
            report.setdefault("warnings", []).append(f"sfx '{fx.name}' not found - skipped")
            continue
        si = n_in
        n_in += 1
        inputs += ["-i", str(p)]
        ms = int(round(fx.time * 1000))
        fc.append(f"[{si}:a]aresample=48000,aformat=channel_layouts=stereo,volume={fx.volume_db}dB,adelay={ms}|{ms}[fx{k}]")
        amix.append(f"[fx{k}]")
    if src_bed:
        bi = n_in
        n_in += 1
        inputs += ["-i", _rel(project, src_bed)]
        vol = tl.audio.source_audio_volume_db if voice_path else 0.0
        fc.append(f"[{bi}:a]volume={vol}dB[bed]")
        amix.append("[bed]")
    if amix:
        fc.append("".join(amix) + f"amix=inputs={len(amix)}:normalize=0:duration=longest,"
                  f"atrim=0:{tl.duration:.3f},alimiter=limit=0.95:level=false[aout]")
    else:
        fc.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{tl.duration:.3f}[aout]")
    script = work / "final.fc"
    script.write_text(";\n".join(fc), encoding="utf-8")

    rc = get_settings()["render"]
    if quality == "preview":
        dest = unique_path(project.path("previews", f"preview_{time.strftime('%Y%m%d_%H%M%S')}.mp4"))
        venc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28"]
    else:
        name = output_name or f"{project.id}_{tl.output.aspect.replace(':', 'x')}_final.mp4"
        from .config import safe_filename
        dest = project.path("exports", safe_filename(name))
        if dest.exists() and not overwrite:
            dest = unique_path(dest)
        venc = ["-c:v", rc.get("video_codec", "libx264"), "-preset", rc.get("preset", "medium"), "-crf", str(rc.get("crf", 18)),
                "-profile:v", "high", "-x264-params", "aq-mode=3"]
    tmp_out = dest.with_name(dest.stem + ".part.mp4")
    args = [*inputs, *filter_script_args(_rel(project, script)), "-map", "[vout]", "-map", "[aout]",
            *venc, "-pix_fmt", "yuv420p", "-r", fps,
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
            "-c:a", "aac", "-b:a", rc.get("audio_bitrate", "192k"), "-ar", "48000", "-ac", "2",
            "-t", f"{tl.duration:.3f}", "-movflags", "+faststart",
            *(["-threads", str(rc["threads"])] if rc.get("threads") else []), str(tmp_out)]
    run_ffmpeg_with_progress(args, tl.duration, on_progress=ctx.progress_cb(0.6, 0.95, "encoding final video") if ctx else None,
                             cancel_event=ctx.cancel_event if ctx else None, cwd=project.root)
    os.replace(tmp_out, dest)

    # 5. validate ----------------------------------------------------------------------------------
    upd("validating output", 0.96)
    val = validate_output(dest, W, H, tl.duration, expect_audio=True, full_decode=(quality == "final"))
    report.update({"output": str(dest), "relative": project.rel(dest), "duration": tl.duration,
                   "render_seconds": round(time.time() - t_start, 1), "validation": val,
                   "graphics_rendered": len(placed), "kinetic_text": len(kinetic), "sfx": len(tl.sfx),
                   "music": str(music_path.name) if music_path else None})
    project.data.setdefault("renders", []).append({"at": now_iso(), "quality": quality, "output": project.rel(dest),
                                                   "valid": val["ok"]})
    project.data["status"] = "preview_ready" if quality == "preview" else "rendered"
    project.log_event(f"{quality} render -> {project.rel(dest)} (valid={val['ok']})")
    project.save()
    if not val["ok"]:
        raise RuntimeError(f"Render finished but validation failed: {val['problems']}")
    return report
