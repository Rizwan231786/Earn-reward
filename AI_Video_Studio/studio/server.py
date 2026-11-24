"""AI Video Studio - MCP server for Claude Desktop.

Run:  python -m studio.server      (stdio transport, launched by Claude Desktop)
"""
from __future__ import annotations

import base64
import functools
import json
import logging
import shutil
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Optional

import anyio

try:  # MCP Python SDK 2.x
    from mcp.server.mcpserver import MCPServer as _Server
except ImportError:  # MCP Python SDK 1.x
    from mcp.server.fastmcp import FastMCP as _Server  # type: ignore
from mcp.types import ImageContent, TextContent

from . import __version__
from . import jobs as jobs_mod
from . import media, planner, profiles, projects, renderer, transcription
from .audio import SFX_NAMES, sfx_library
from .captions import build_captions
from .config import APP_DIR, PathSecurityError, get_settings, setup_logging
from .ffmpeg_utils import ffmpeg_bin, ffprobe_bin, tool_version
from .models import FORMATS, Graphic, SoundEffect, Timeline

log = setup_logging()

INSTRUCTIONS = """AI Video Studio: a professional, local video editing workstation driven through these tools.

DEFAULT WORKFLOW when the user says "edit this video professionally" (no long prompt needed):
 1. get_system_status (first time per conversation) -> list_inbox to find the user's files (or use the paths they give).
 2. create_project (aspect: 9:16 Reels/Shorts/TikTok, 16:9 YouTube/corporate, 1:1 square; profile defaults to the active profile).
 3. import_video (one or many clips), import_voiceover, optional import_asset for music/logo/LUT/sfx/images.
    If the voice is inside the video (talking head), import the same video file as the voiceover: the planner then keeps lip-sync.
 4. analyze_media -> analyze_video_content (look at the returned frames!) -> describe_scenes with ONLY what is visible.
 5. transcribe_voiceover (language_mode roman_urdu | english | mixed). Show uncertain words to the user; fix with correct_transcript,
    or align_script if the user has the exact script. Never translate Roman Urdu; never output Hindi/Devanagari.
 6. create_editing_plan with a brief (title, speaker name/role exactly as the user gave it, cta, steps, location, music:"generated").
    Present the plan summary + missing_visuals. Ask for approval or changes (update_editing_plan).
 7. preview_video for review, then render_video (final). Poll get_render_status until completed; report the MP4 path.
 8. export_project to bundle final MP4, SRT, timeline JSON and settings.

PERMANENT STYLE: the active editing profile (default PREMIUM COMMERCIAL: turquoise/white/ice-blue/navy, Inter/Manrope/Montserrat,
clean lower thirds, kinetic typography, elegant transitions, natural skin tones, subtle motion, voice always dominant).
Use load_editing_profile to read it; update_editing_profile to change preferences permanently.

RULES: never delete or overwrite originals; never fabricate medical qualifications, testimonials, results or before/after visuals;
never change a real person's identity or replace the original voice with synthetic speech; use only user-supplied, licensed or
locally generated music/SFX; ask before downloading models (transcribe_voiceover allow_model_download) or any paid API;
never upload or publish anything. Long tasks run in the background - use get_render_status / cancel_render.
"""

mcp = _Server("ai-video-studio", instructions=INSTRUCTIONS)


def _ok(**kw) -> dict:
    return {"ok": True, **kw}


def tool(fn):
    """Register a tool: runs blocking work in a worker thread and converts exceptions to structured errors."""
    @functools.wraps(fn)
    async def wrapper(*args, **kwargs):
        try:
            return await anyio.to_thread.run_sync(functools.partial(fn, *args, **kwargs))
        except (PathSecurityError, projects.ProjectError, ValueError, FileNotFoundError, PermissionError) as e:
            return {"ok": False, "error": str(e), "error_type": type(e).__name__}
        except Exception as e:  # noqa: BLE001
            log.error("tool %s failed: %s\n%s", fn.__name__, e, traceback.format_exc())
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "error_type": type(e).__name__,
                    "log": str(get_settings().logs_dir / "studio.log")}
    return mcp.tool()(wrapper)


def _run_job(kind: str, project_id: str | None, fn, wait_seconds: float) -> dict:
    job_id = jobs_mod.start_job(kind, project_id, fn)
    j = jobs_mod.wait_for(job_id, max(0.0, min(wait_seconds, 50.0)))
    if j.get("status") == "running":
        return _ok(job_id=job_id, status="running", stage=j.get("stage"), progress_percent=j.get("progress_percent"),
                   message="Still working in the background. Call get_render_status with this job_id to follow progress.")
    if j.get("status") == "completed":
        return _ok(job_id=job_id, status="completed", result=j.get("result"))
    return {"ok": False, "job_id": job_id, "status": j.get("status"), "error": j.get("error")}


# =============================================================================
# System
# =============================================================================
@tool
def get_system_status() -> dict:
    """Check FFmpeg/FFprobe, Python packages, transcription engine + model cache, vision provider, disk space and
    folder locations. Call this first in a new conversation."""
    s = get_settings()
    ff, fp = tool_version(ffmpeg_bin()), tool_version(ffprobe_bin())
    du = shutil.disk_usage(s.home)
    pkgs = {}
    for name in ("mcp", "pydantic", "PIL", "numpy", "faster_whisper", "whisper"):
        try:
            mod = __import__(name)
            pkgs[name] = getattr(mod, "__version__", "installed")
        except Exception:  # noqa: BLE001
            pkgs[name] = None
    eng = transcription.pick_engine()
    model = s["transcription"]["model"]
    problems = []
    if not ff or not fp:
        problems.append("FFmpeg/FFprobe not found. Install FFmpeg (winget install Gyan.FFmpeg) or set ffmpeg_path in config.json.")
    if not eng:
        problems.append("No speech engine: run install.bat (installs faster-whisper) or use align_script with the exact script.")
    elif not transcription.model_cached(eng, model):
        problems.append(f"Whisper model '{model}' not downloaded yet - it will be downloaded on first transcription "
                        "after you approve (transcribe_voiceover allow_model_download=true).")
    if du.free < 5e9:
        problems.append(f"Low disk space: {du.free/1e9:.1f} GB free.")
    claude_cfg = None
    for c in _claude_config_candidates():
        if c.exists():
            claude_cfg = str(c)
            break
    return _ok(version=__version__, python=sys.version.split()[0], platform=sys.platform, ffmpeg=ff, ffprobe=fp,
               packages=pkgs, transcription_engine=eng, whisper_model=model,
               whisper_model_cached=bool(eng and transcription.model_cached(eng, model)),
               vision_provider=s["vision"]["provider"], studio_home=str(s.home), inbox=str(s.inbox_dir),
               projects_dir=str(s.projects_dir), allowed_input_dirs=[str(r) for r in s.allowed_roots()],
               disk_free_gb=round(du.free / 1e9, 1), claude_desktop_config=claude_cfg,
               active_profile=profiles.active_profile_name(), problems=problems, ready=not problems or bool(ff and fp))


def _claude_config_candidates() -> list[Path]:
    import os
    c = []
    if os.environ.get("APPDATA"):
        c.append(Path(os.environ["APPDATA"]) / "Claude" / "claude_desktop_config.json")
    if os.environ.get("LOCALAPPDATA"):
        c += list((Path(os.environ["LOCALAPPDATA"]) / "Packages").glob("Claude_*/LocalCache/Roaming/Claude/claude_desktop_config.json"))
    c.append(Path.home() / "Library/Application Support/Claude/claude_desktop_config.json")
    c.append(Path.home() / ".config/Claude/claude_desktop_config.json")
    return c


@tool
def list_inbox() -> dict:
    """List media files in the studio inbox folder. Users can drop videos/voiceovers/music/logos there and refer to
    them by file name. (Files attached in the Claude chat are NOT on disk - ask the user to save them to the inbox.)"""
    s = get_settings()
    return _ok(inbox=str(s.inbox_dir), files=projects.list_inbox())


# =============================================================================
# Projects & import
# =============================================================================
@tool
def create_project(name: str, aspect: str = "", profile: str = "") -> dict:
    """Create a new editing project with its folder structure.
    aspect: '9:16' (Reels/Shorts/TikTok 1080x1920), '16:9' (YouTube 1920x1080), '1:1' (1080x1080), '4:5'. Empty = profile default.
    profile: editing profile name (empty = active profile, default premium_commercial)."""
    prof = profiles.load_profile(profile or None)
    aspect = aspect or prof.get("default_aspect", "16:9")
    if aspect not in FORMATS:
        raise ValueError(f"aspect must be one of {list(FORMATS)}")
    p = projects.create_project(name, prof["name"], aspect)
    return _ok(project=p.summary(), next="import_video / import_voiceover")


@tool
def list_projects() -> dict:
    """List all editing projects (newest last) with status and exports."""
    return _ok(projects=projects.list_projects())


@tool
def get_project(project_id: str) -> dict:
    """Full details of one project: assets, status, renders and history."""
    p = projects.load_project(project_id)
    return _ok(project=p.summary(), renders=p.data.get("renders", []), history=p.data.get("history", [])[-20:])


@tool
def import_video(project_id: str, paths: list[str]) -> dict:
    """Import one or more video clips (MP4, MOV, MKV, AVI, WEBM, M4V, MTS...). Paths may be absolute or inbox file names.
    Originals are never modified (hard-link or copy into project/source)."""
    p = projects.load_project(project_id)
    out, errors = [], []
    for raw in paths:
        try:
            a = projects.import_asset(p, raw, "video")
            vs = a["info"]["video_streams"][0]
            out.append({"asset_id": a["id"], "name": a["name"], "duration": round(a["info"]["duration"] or 0, 2),
                        "resolution": f"{vs['width']}x{vs['height']}", "fps": vs["fps"], "has_audio": a["info"]["has_audio"],
                        "stored": a["stored"]})
        except Exception as e:  # noqa: BLE001
            errors.append({"path": raw, "error": str(e)})
    return {"ok": not errors, "imported": out, "errors": errors}


@tool
def import_voiceover(project_id: str, path: str) -> dict:
    """Import the voiceover (MP3, WAV, M4A, AAC, FLAC, OGG...). You can also pass a video file to use its audio as the
    voice track (talking-head); if it is the same file as an imported video, the edit stays lip-synced."""
    p = projects.load_project(project_id)
    a = projects.import_asset(p, path, "voiceover")
    au = a["info"]["audio_streams"][0]
    return _ok(asset_id=a["id"], duration=round(a["info"]["duration"] or 0, 2), sample_rate=au["sample_rate"],
               channels=au["channels"], codec=au["codec"], next="transcribe_voiceover")


@tool
def import_asset(project_id: str, path: str, kind: str, label: str = "") -> dict:
    """Import a supporting asset. kind: music | sfx | logo | image | broll | lut (.cube).
    Only import music/SFX the user owns or has licensed."""
    p = projects.load_project(project_id)
    a = projects.import_asset(p, path, kind, label or None)
    return _ok(asset={k: a[k] for k in ("id", "kind", "name", "path", "stored")})


# =============================================================================
# Analysis
# =============================================================================
@tool
def analyze_media(project_id: str, asset_ids: list[str] = [], scene_threshold: float = 0.3,  # noqa: B006
                  wait_seconds: float = 45) -> dict:
    """Analyse video assets: duration, resolution, fps, audio tracks, scene-change detection, representative
    thumbnails and objective per-scene measurements (brightness, colour cast, motion, sharpness, likely people,
    subject position). Runs in the background for long files."""
    p = projects.load_project(project_id)
    targets = [p.asset(a) for a in asset_ids] if asset_ids else p.assets("video") + [x for x in p.assets("broll")
                                                                                   if (x.get("info") or {}).get("has_video")]
    if not targets:
        raise ValueError("No videos to analyse. Import videos first.")

    def work(ctx: jobs_mod.JobContext):
        res = []
        total = sum(float(a["info"]["duration"] or 1) for a in targets)
        done = 0.0
        for a in targets:
            d = float(a["info"]["duration"] or 1)
            lo, hi = done / total, (done + d * 0.8) / total
            sc = media.detect_scenes(p, a, scene_threshold, on_progress=ctx.progress_cb(lo, hi, f"scene detection {a['id']}"),
                                     cancel_event=ctx.cancel_event)
            old = {s["index"]: s for s in (p.read_json(f"work/analysis_{a['id']}.json") or {}).get("scenes", [])}
            sc = media.analyze_scenes(p, a, sc, on_progress=ctx.progress_cb(hi, (done + d) / total, f"measuring {a['id']}"))
            for s in sc:  # keep earlier descriptions if boundaries unchanged
                o = old.get(s["index"])
                if o and abs(o["start"] - s["start"]) < 0.05 and o.get("description"):
                    s["description"], s["tags"] = o["description"], o.get("tags", [])
            overview = media.generate_overview_thumbnails(p, a)
            p.write_json(f"work/analysis_{a['id']}.json", {"asset_id": a["id"], "scenes": sc, "overview": overview})
            vs = a["info"]["video_streams"][0]
            res.append({"asset_id": a["id"], "duration": a["info"]["duration"], "resolution": f"{vs['width']}x{vs['height']}",
                        "fps": vs["fps"], "audio_tracks": len(a["info"]["audio_streams"]), "scene_count": len(sc),
                        "scenes": [{"i": s["index"], "start": s["start"], "end": s["end"],
                                    "brightness": s["metrics"].get("brightness"), "cast": s["metrics"].get("color_cast"),
                                    "motion": s["metrics"].get("motion"), "people_likely": s["metrics"].get("likely_people")}
                                   for s in sc[:60]]})
            done += d
        p.data["status"] = "analyzed"
        p.save()
        return {"videos": res, "next": "analyze_video_content to look at the scenes"}
    return _run_job("analyze", project_id, work, wait_seconds)


@tool
def analyze_video_content(project_id: str, asset_id: str, first_scene: int = 0, max_scenes: int = 24):
    """Return contact-sheet images of the detected scenes (labelled #index and time) so YOU can see the footage.
    Look carefully, then call describe_scenes with what is actually visible (people, actions, setting, objects).
    Never invent events that are not visible. If a local Ollama vision model is configured, descriptions are
    generated automatically as well."""
    try:
        p = projects.load_project(project_id)
        a = p.asset(asset_id)
        data = p.read_json(f"work/analysis_{asset_id}.json")
        if not data:
            raise ValueError("Run analyze_media first.")
        scenes = data["scenes"]
        s = get_settings()
        auto = None
        if s["vision"]["provider"] == "ollama":
            from .vision import describe_with_ollama, ollama_available
            if ollama_available():
                scenes = describe_with_ollama(p, scenes)
                data["scenes"] = scenes
                p.write_json(f"work/analysis_{asset_id}.json", data)
                auto = "ollama"
        sheet = media.contact_sheet(p, a, scenes, first=first_scene, max_tiles=min(max_scenes, 24))
        meta = {"ok": True, "asset_id": asset_id, "scenes_total": len(scenes), "showing": f"{first_scene}-{min(len(scenes), first_scene+max_scenes)-1}",
                "scenes": [{"i": x["index"], "t": f"{x['start']:.1f}-{x['end']:.1f}s", "people_likely": x["metrics"].get("likely_people"),
                            "description": x.get("description")} for x in scenes[first_scene:first_scene + max_scenes]],
                "auto_described_by": auto,
                "next": "describe_scenes(project_id, asset_id, [{index, description, tags}]) - only what is visible"}
        b64 = base64.b64encode(sheet.read_bytes()).decode()
        return [TextContent(type="text", text=json.dumps(meta, ensure_ascii=False)),
                ImageContent(type="image", data=b64, mimeType="image/jpeg")]
    except Exception as e:  # noqa: BLE001
        return [TextContent(type="text", text=json.dumps({"ok": False, "error": str(e)}))]


@tool
def describe_scenes(project_id: str, asset_id: str, descriptions: list[dict]) -> dict:
    """Save visual descriptions for scenes: [{"index": 0, "description": "woman at clinic reception smiling", "tags": ["clinic","reception","people"]}].
    Used by the planner to match footage to narration. Describe only what is visible."""
    p = projects.load_project(project_id)
    data = p.read_json(f"work/analysis_{asset_id}.json")
    if not data:
        raise ValueError("Run analyze_media first.")
    by = {s["index"]: s for s in data["scenes"]}
    n = 0
    for d in descriptions:
        sc = by.get(int(d.get("index", -1)))
        if sc is None:
            continue
        sc["description"] = str(d.get("description", ""))[:400]
        sc["tags"] = [str(t).lower() for t in d.get("tags", [])][:12]
        sc["description_source"] = "claude"
        n += 1
    p.write_json(f"work/analysis_{asset_id}.json", data)
    return _ok(updated=n, total_scenes=len(data["scenes"]))


# =============================================================================
# Transcription
# =============================================================================
@tool
def transcribe_voiceover(project_id: str, language_mode: str = "roman_urdu", model: str = "",
                         allow_model_download: bool = False, wait_seconds: float = 45) -> dict:
    """Transcribe the voiceover with word-level timestamps. language_mode: roman_urdu | mixed (Roman Urdu + English) |
    english | auto. Roman Urdu stays in Latin script, never translated, never Devanagari. Low-confidence words are flagged.
    If the Whisper model is not downloaded, ask the user before passing allow_model_download=true."""
    p = projects.load_project(project_id)
    if language_mode not in ("roman_urdu", "mixed", "english", "auto"):
        raise ValueError("language_mode must be roman_urdu, mixed, english or auto")
    eng = transcription.pick_engine()
    m = model or get_settings()["transcription"]["model"]
    if eng and not transcription.model_cached(eng, m) and not allow_model_download:
        return {"ok": False, "needs_permission": True, "model": m,
                "error": f"Whisper model '{m}' must be downloaded first (small≈490MB, base≈145MB, medium≈1.5GB). "
                         "Ask the user; if they agree call again with allow_model_download=true."}

    def work(ctx: jobs_mod.JobContext):
        tr = transcription.transcribe(p, language_mode, m, allow_model_download,
                                      on_progress=ctx.progress_cb(0.05, 0.98, "transcribing"), cancel_check=ctx.check_cancel)
        return _transcript_view(tr)
    return _run_job("transcribe", project_id, work, wait_seconds)


def _transcript_view(tr: dict, max_segments: int = 80) -> dict:
    return {
        "engine": tr.get("engine"), "language_mode": tr.get("language_mode"), "duration": tr.get("duration"),
        "word_count": len(tr.get("words", [])), "needs_review": tr.get("needs_review"),
        "message": tr.get("message"), "warnings": tr.get("warnings"),
        "segments": [{"id": s["id"], "t": f"{s['start']:.2f}-{s['end']:.2f}", "text": s["text"], "flags": s.get("flags", []),
                      "tone": s.get("tone")} for s in tr.get("segments", [])[:max_segments]],
        "uncertain_words": tr.get("uncertain_words", [])[:40], "key_terms": tr.get("key_terms", [])[:12],
        "long_pauses": [x for x in tr.get("pauses", []) if x["duration"] > 0.6][:30],
    }


@tool
def get_transcript(project_id: str) -> dict:
    """Return the current transcript (segments, flags, uncertain words, pauses, key terms)."""
    p = projects.load_project(project_id)
    tr = p.read_json("audio/transcript.json")
    if not tr:
        raise ValueError("No transcript yet.")
    return _ok(transcript=_transcript_view(tr, 400))


@tool
def correct_transcript(project_id: str, segment_id: int = -1, new_text: str = "", replacements: list[dict] = []) -> dict:  # noqa: B006
    """Manually correct the transcript. Either replace a whole segment's text (segment_id + new_text, timing is kept),
    and/or apply word replacements everywhere: [{"from": "clinik", "to": "clinic"}]."""
    p = projects.load_project(project_id)
    tr = transcription.correct_transcript(p, segment_id if segment_id >= 0 else None, new_text or None, replacements or None)
    return _ok(transcript=_transcript_view(tr))


@tool
def align_script(project_id: str, script: str, language_mode: str = "roman_urdu") -> dict:
    """Use the user's exact spoken script (verbatim) and time-align it to the voiceover. Best accuracy for captions;
    works even without a speech engine."""
    p = projects.load_project(project_id)
    tr = transcription.align_script(p, script, language_mode)
    return _ok(alignment=tr.get("alignment_method"), transcript=_transcript_view(tr))


# =============================================================================
# Planning
# =============================================================================
@tool
def create_editing_plan(project_id: str, aspect: str = "", profile: str = "", brief: dict = {}) -> dict:  # noqa: B006
    """Create the editable JSON timeline: voice-led shot selection matched to scenes, cuts, transitions, reframing,
    colour correction, graphics, SFX, music and captions according to the editing profile.
    brief (all optional, use ONLY facts the user supplied):
      title, subtitle, speaker {name, role}, cta {headline, subtitle, button, contact:[..]}, steps [..],
      location {name, address}, music: "generated" (royalty-free ambient) , tighten_pauses: bool, max_pause,
      captions {mode: phrase|word_highlight|word_by_word|karaoke, position, uppercase, font_size, highlight_keywords},
      graphics: [{type, start, duration, params, position, animation}], lut_intensity (0-1), fps, lead_in.
    Present the returned summary and missing_visuals to the user for approval."""
    p = projects.load_project(project_id)
    if aspect and aspect not in FORMATS:
        raise ValueError(f"aspect must be one of {list(FORMATS)}")
    tl, summary = planner.create_plan(p, aspect or None, profile or None, brief)
    return _ok(plan_file=str(p.path("editing_timeline.json")), summary=summary,
               next="Show the plan, apply changes with update_editing_plan, then preview_video.")


@tool
def get_editing_plan(project_id: str, full: bool = False) -> dict:
    """Return the current editing plan (summary, or the full JSON timeline with full=true)."""
    p = projects.load_project(project_id)
    data = p.read_json("editing_timeline.json")
    if not data:
        raise ValueError("No plan yet.")
    tl = Timeline(**data)
    return _ok(summary=planner.summarize(tl), timeline=data if full else None)


@tool
def update_editing_plan(project_id: str, changes: list[dict]) -> dict:
    """Edit the timeline with operations, e.g.
    {"op":"update_segment","id":"seg_003","fields":{"src_in":12.0,"src_out":15.5,"reframe":{"focus_x":0.3}}}
    {"op":"remove_segment","id":"seg_004"} | {"op":"add_segment","segment":{...}}
    {"op":"add_graphic","graphic":{"type":"lower_third","start":2,"duration":4,"params":{"name":"..","role":".."}}}
    {"op":"update_graphic","id":"gfx_01","fields":{...}} | {"op":"remove_graphic","id":"gfx_02"}
    {"op":"add_sfx","sfx":{"name":"whoosh_soft","time":3.2}} | {"op":"remove_sfx","id":"sfx_01"}
    {"op":"captions","fields":{"mode":"phrase","position":"bottom"}} | {"op":"music","fields":{"volume_db":-18}}
    {"op":"audio","fields":{"tighten_pauses":true}} | {"op":"set_all_segments_color","fields":{"look_intensity":0.2}}
    {"op":"set","field":"approved","value":true}"""
    p = projects.load_project(project_id)
    tl = planner.apply_plan_changes(p, changes)
    return _ok(summary=planner.summarize(tl))


@tool
def generate_captions(project_id: str, mode: str = "", position: str = "", uppercase: Optional[bool] = None,
                      font_size: int = 0, highlight_color: str = "", background: str = "") -> dict:
    """Generate synchronized captions (SRT + styled ASS) from the transcript and update caption style in the plan.
    mode: phrase | word_highlight | word_by_word | karaoke. position: bottom | lower_third | center | top.
    background: none | box | soft_box. Captions use the spoken words verbatim (no translation)."""
    p = projects.load_project(project_id)
    data = p.read_json("editing_timeline.json")
    if not data:
        raise ValueError("Create an editing plan first (captions are timed to the edited timeline).")
    fields = {k: v for k, v in {"mode": mode, "position": position, "font_size": font_size or None,
                                "highlight_color": highlight_color, "background": background}.items() if v}
    if uppercase is not None:
        fields["uppercase"] = uppercase
    fields["enabled"] = True
    tl = planner.apply_plan_changes(p, [{"op": "captions", "fields": fields}])
    tr = p.read_json("audio/transcript.json") or {}
    if not tr.get("words"):
        raise ValueError("Transcript has no words. Run transcribe_voiceover or align_script first.")
    from .audio import TimeMap, keep_intervals
    vo = p.voiceover()
    dur = float(vo["info"]["duration"])
    tm = TimeMap(keep_intervals(tr["words"], dur, tl.audio.max_pause)) if tl.audio.tighten_pauses else TimeMap.identity(dur)
    caps = build_captions(tr["words"], tl.captions, tl.output.width, tl.output.height,
                          time_map=lambda t: tl.voiceover_offset + tm(t))
    srt = p.path("captions", "captions.srt")
    srt.write_text(caps["srt"], encoding="utf-8")
    p.path("captions", "captions_final.ass").write_text(caps["ass"], encoding="utf-8")
    return _ok(srt=str(srt), caption_groups=caps["groups"], words=caps["words"],
               dropped_non_roman_words=caps["dropped_non_roman_words"], style=tl.captions.model_dump(),
               note="Burned-in captions are applied at render time.")


@tool
def add_graphics(project_id: str, graphics: list[dict]) -> dict:
    """Add motion graphics to the plan. Types: title_card, lower_third, info_card, stat_card, callout, cta,
    notification, phone_mockup, process_steps, checklist, location_pin, kinetic_text, logo_bug, image_card, line_accent.
    Example: {"type":"lower_third","start":2.0,"duration":4,"params":{"name":"Dr. Sara Ali","role":"Dermatologist"}}.
    params by type: title_card{title,subtitle,fullscreen}, info_card{title,text,icon}, stat_card{value,label},
    callout{text,x,y}, cta{headline,subtitle,button,contact[]}, notification{app,title,text}, phone_mockup{app_title,items[],button,image},
    process_steps{steps[]}, checklist{title,items[]}, location_pin{name,address}, kinetic_text{text,highlight[]},
    logo_bug/image_card{image (project-relative path)}. Icons: check, medical, pin, phone, star, clock, shield, calendar, sparkle, chat.
    Only show names/credentials/claims exactly as the user supplied them."""
    p = projects.load_project(project_id)
    tl = planner.apply_plan_changes(p, [{"op": "add_graphic", "graphic": g} for g in graphics])
    return _ok(graphics=[g.model_dump() for g in tl.graphics])


@tool
def add_background_music(project_id: str, path: str = "", generated: bool = False, volume_db: float = -20.0,
                         duck_under_voice: bool = True, i_confirm_license: bool = False) -> dict:
    """Add background music: either a user-supplied/licensed track (path + i_confirm_license=true after the user confirms
    they own or licensed it) or generated=true for a locally generated royalty-free ambient bed. Music is automatically
    ducked under the voice with smooth fades. Never download copyrighted music."""
    p = projects.load_project(project_id)
    if generated:
        asset_id = "generated_ambient"
    else:
        if not path:
            raise ValueError("Give a path to a licensed track, or generated=true.")
        if not i_confirm_license:
            return {"ok": False, "needs_confirmation": True,
                    "error": "Please confirm with the user that they own or have licensed this music, then call again with i_confirm_license=true."}
        asset_id = projects.import_asset(p, path, "music")["id"]
    tl = planner.apply_plan_changes(p, [{"op": "music", "fields": {"asset_id": asset_id, "volume_db": volume_db,
                                                                    "duck_under_voice": duck_under_voice}}])
    return _ok(music=tl.music.model_dump())


@tool
def add_sound_effects(project_id: str, effects: list[dict] = [], auto: bool = False) -> dict:  # noqa: B006
    """Place sound effects. Built-in royalty-free (locally generated) library: whoosh_soft, whoosh_fast, ui_click, ui_tap,
    notification_chime, impact_soft, impact_cinematic, shimmer, riser, pop. User-licensed SFX placed in library/sfx are
    also available by file name. effects: [{"name":"whoosh_soft","time":4.2,"volume_db":-16}].
    auto=true adds subtle SFX on every graphic entrance and transition that has none yet."""
    p = projects.load_project(project_id)
    lib = sfx_library()
    changes = []
    for e in effects:
        if e.get("name") not in lib:
            raise ValueError(f"Unknown SFX '{e.get('name')}'. Available: {sorted(lib)}")
        changes.append({"op": "add_sfx", "sfx": e})
    if auto:
        tl = Timeline(**p.read_json("editing_timeline.json"))
        have = {round(x.time, 1) for x in tl.sfx}
        for g in tl.graphics:
            t = round(max(0.0, g.start - 0.05), 1)
            if g.type not in ("logo_bug", "kinetic_text") and t not in have:
                changes.append({"op": "add_sfx", "sfx": {"name": g.sfx or "whoosh_soft", "time": t, "reason": f"{g.type} entrance"}})
        for s in tl.segments:
            if s.transition_in.type != "cut":
                changes.append({"op": "add_sfx", "sfx": {"name": "whoosh_soft", "time": max(0.0, s.timeline_start - 0.3),
                                                         "volume_db": -20, "reason": "transition"}})
    tl = planner.apply_plan_changes(p, changes) if changes else Timeline(**p.read_json("editing_timeline.json"))
    return _ok(sfx=[x.model_dump() for x in tl.sfx], library=sorted(lib))


# =============================================================================
# Rendering
# =============================================================================
def _start_render(project_id: str, quality: str, wait_seconds: float, output_name: str = "", overwrite: bool = False) -> dict:
    p = projects.load_project(project_id)
    for j in jobs_mod.list_jobs(project_id, 5):
        if j["status"] == "running" and j["kind"].startswith("render"):
            return {"ok": False, "error": f"A render is already running for this project ({j['id']}).", "job_id": j["id"]}

    def work(ctx: jobs_mod.JobContext):
        return renderer.render(p, quality, ctx, output_name or None, overwrite)
    return _run_job(f"render_{quality}", project_id, work, wait_seconds)


@tool
def preview_video(project_id: str, wait_seconds: float = 45) -> dict:
    """Render a fast low-resolution preview (540p short side) of the current plan for review/approval."""
    return _start_render(project_id, "preview", wait_seconds)


@tool
def execute_video_edit(project_id: str, final: bool = False, wait_seconds: float = 45) -> dict:
    """Execute the editing plan. By default renders a preview first (recommended for major edits); with final=true
    renders the full-quality MP4. Same as preview_video / render_video."""
    return _start_render(project_id, "final" if final else "preview", wait_seconds)


@tool
def render_video(project_id: str, output_name: str = "", overwrite_existing: bool = False, wait_seconds: float = 30) -> dict:
    """Render the final MP4 (H.264 High, AAC 48 kHz stereo, Rec.709, original frame rate, faststart) into the project's
    exports folder. Existing exports are never overwritten unless overwrite_existing=true (ask the user first).
    Returns a job_id - poll get_render_status."""
    return _start_render(project_id, "final", wait_seconds, output_name, overwrite_existing)


@tool
def get_render_status(job_id: str = "", project_id: str = "") -> dict:
    """Progress of a background job (render, transcription, analysis): status, stage, percent, result or error.
    Without job_id, lists recent jobs (optionally for one project)."""
    if job_id:
        j = jobs_mod.get_job(job_id)
        if not j:
            raise ValueError(f"Job '{job_id}' not found")
        return _ok(job=j)
    return _ok(jobs=jobs_mod.list_jobs(project_id or None, 10))


@tool
def cancel_render(job_id: str) -> dict:
    """Safely cancel a running job (ffmpeg is stopped; partial files are discarded; completed segments stay cached)."""
    return jobs_mod.cancel_job(job_id)


@tool
def export_project(project_id: str, include_intermediates: bool = False) -> dict:
    """Bundle deliverables into exports/package_<time>/: final_video.mp4, captions.srt, editing_timeline.json,
    project_settings.json (profile + project), transcript, and project_assets/ (graphics PNGs).
    Original source files are referenced, not duplicated."""
    p = projects.load_project(project_id)
    finals = sorted(p.path("exports").glob("*.mp4"), key=lambda x: x.stat().st_mtime)
    if not finals:
        raise ValueError("No final render yet. Run render_video first.")
    pkg = p.path("exports", f"package_{time.strftime('%Y%m%d_%H%M%S')}")
    pkg.mkdir()
    final = finals[-1]
    try:
        import os
        os.link(final, pkg / "final_video.mp4")
    except OSError:
        shutil.copy2(final, pkg / "final_video.mp4")
    files = ["final_video.mp4"]
    for src, name in ((p.path("captions", "captions.srt"), "captions.srt"),
                      (p.path("editing_timeline.json"), "editing_timeline.json"),
                      (p.path("audio", "transcript.json"), "transcript.json"),
                      (p.path("audio", "transcript.txt"), "transcript.txt")):
        if src.exists():
            shutil.copy2(src, pkg / name)
            files.append(name)
    tl = p.read_json("editing_timeline.json") or {}
    settings = {"project": {k: v for k, v in p.data.items() if k not in ("history",)},
                "profile": profiles.load_profile(tl.get("profile") or p.data.get("profile")),
                "exported_at": projects.now_iso(), "studio_version": __version__}
    (pkg / "project_settings.json").write_text(json.dumps(settings, indent=2, ensure_ascii=False), encoding="utf-8")
    files.append("project_settings.json")
    assets = pkg / "project_assets"
    assets.mkdir()
    for g in p.path("graphics").rglob("final_*/*.png"):
        shutil.copy2(g, assets / g.name)
    if include_intermediates:
        for f in p.path("audio").glob("voice_processed_*.wav"):
            shutil.copy2(f, assets / f.name)
    p.log_event(f"exported package {pkg.name}")
    p.save()
    return _ok(package=str(pkg), files=files, final_video=str(pkg / "final_video.mp4"),
               validation=renderer.validate_output(pkg / "final_video.mp4", full_decode=False))


# =============================================================================
# Profiles
# =============================================================================
@tool
def load_editing_profile(name: str = "") -> dict:
    """Load an editing profile (default: the active one, PREMIUM COMMERCIAL unless changed) and list all profiles:
    premium_commercial, healthcare_dermatology, real_estate, product_ad, corporate, youtube, reels_shorts, educational, cinematic."""
    return _ok(profile=profiles.load_profile(name or None), available=profiles.list_profiles())


@tool
def update_editing_profile(name: str, changes: dict = {}, set_active: bool = False, base_profile: str = "") -> dict:  # noqa: B006
    """Permanently update saved editing preferences (deep-merged), e.g.
    {"palette":{"turquoise":"#10B5AD"}, "captions":{"position":"bottom","uppercase":true}, "audio":{"music_volume_db":-22},
     "pacing":{"target_shot":2.5}, "color":{"look_intensity":0.2}, "custom_rules":["Always end with the clinic logo"]}.
    A new name creates a custom profile (based on base_profile). set_active=true makes it the default for new projects."""
    prof = profiles.update_profile(name, changes, set_active, base_profile or None)
    return _ok(profile=prof, active=profiles.active_profile_name())


@tool
def set_active_profile(name: str) -> dict:
    """Make a profile the default for all new projects."""
    return _ok(**profiles.set_active_profile(name))


@tool
def list_sound_library() -> dict:
    """List built-in generated (royalty-free) SFX and the user's licensed SFX library."""
    lib = sfx_library()
    return _ok(generated=SFX_NAMES, all=sorted(lib), user_library=str(get_settings().library_dir / "sfx"))


@mcp.prompt()
def edit_video_professionally(video_files: str = "", voiceover_file: str = "", format: str = "9:16", brief: str = "") -> str:
    """One-click professional edit using the saved editing profile."""
    return (f"Edit this video professionally using AI Video Studio and my saved editing profile.\n"
            f"Video file(s): {video_files or '(check the inbox)'}\nVoiceover: {voiceover_file or '(check the inbox)'}\n"
            f"Format: {format}\nBrief / details: {brief or '(ask me only for facts you need: names, titles, CTA, contact)'}\n"
            "Follow the default workflow: analyse, transcribe (Roman Urdu stays Roman Urdu), plan, show me the plan, "
            "render a preview, then the final MP4 and export the package.")


def main() -> None:
    get_settings().ensure_dirs()
    renderer.ensure_fonts()
    log.info("AI Video Studio MCP server %s starting (home=%s)", __version__, get_settings().home)
    if "--check" in sys.argv:
        print(json.dumps({"ok": True, "version": __version__, "home": str(get_settings().home),
                          "ffmpeg": tool_version(ffmpeg_bin())}), file=sys.stderr)
        return
    mcp.run()


if __name__ == "__main__":
    main()
