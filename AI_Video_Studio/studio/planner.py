"""Editing planner: turns voiceover + analysed footage + profile into an editable JSON timeline.

Strategy
--------
* The voiceover is the spine. Shots are cut on word boundaries and sized by the profile's pacing.
* **Sync mode**: when the voiceover is the audio of one of the imported videos (talking head or
  presenter), that video stays lip-synced. Pauses are tightened identically on picture and sound,
  and other clips are used only as cut-aways (B-roll) where they genuinely match the narration.
* **Voice-led mode** (a separate voiceover): each shot gets the best-matching scene. A scene's
  score combines meaning (scene descriptions/tags vs. the spoken words), image quality, forward
  continuity and a penalty for reuse.
* Nothing is invented. When no footage matches a spoken idea (and descriptions exist to judge
  this), the gap is listed under `missing_visuals` with a suggestion. Graphics only display text
  supplied in the brief or spoken in the voiceover.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from . import color as color_mod
from .audio import TimeMap, keep_intervals
from .models import (AudioSettings, CaptionSettings, Graphic, MissingVisual, MusicSettings, OutputFormat,
                     Reframe, SoundEffect, Timeline, Transition, VideoSegment)
from .profiles import load_profile
from .projects import Project
from .transcription import STOPWORDS

log = logging.getLogger("studio.planner")

SYNONYMS = {
    "doctor": {"doctor", "dr", "physician", "dermatologist", "specialist", "sahab", "consultant"},
    "clinic": {"clinic", "hospital", "reception", "center", "centre", "waiting"},
    "skin": {"skin", "jild", "face", "chehra", "chehray", "complexion", "glow", "glowing"},
    "treatment": {"treatment", "ilaj", "procedure", "therapy", "laser", "session", "facial", "peel"},
    "consultation": {"consultation", "consult", "mashwara", "checkup", "assessment"},
    "result": {"result", "results", "natija", "nataij", "outcome", "after"},
    "hair": {"hair", "baal", "scalp"},
    "product": {"product", "bottle", "cream", "serum", "packaging", "box"},
    "phone": {"phone", "mobile", "app", "whatsapp", "call", "booking", "book", "appointment"},
    "house": {"house", "home", "ghar", "villa", "apartment", "flat", "property", "plot"},
    "room": {"room", "kamra", "bedroom", "kitchen", "lounge", "bathroom", "living"},
    "outside": {"exterior", "outside", "bahar", "street", "building", "facade", "garden"},
    "team": {"team", "staff", "people", "log", "group", "office", "colleagues"},
    "city": {"city", "shehar", "location", "area", "lahore", "karachi", "islamabad", "map"},
}
_SYN_INDEX = {w: k for k, ws in SYNONYMS.items() for w in ws}


def _tokens(text: str) -> set[str]:
    toks = {t for t in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(t) > 2 and t not in STOPWORDS}
    toks |= {_SYN_INDEX[t] for t in toks if t in _SYN_INDEX}
    stems = {t[:-1] for t in toks if t.endswith("s") and len(t) > 4}
    return toks | stems


def _scene_tokens(sc: dict) -> set[str]:
    return _tokens((sc.get("description") or "") + " " + " ".join(sc.get("tags") or []))


def load_scenes(project: Project) -> dict[str, list[dict]]:
    out = {}
    for a in project.assets("video") + project.assets("broll"):
        data = project.read_json(f"work/analysis_{a['id']}.json")
        if data and data.get("scenes"):
            out[a["id"]] = data["scenes"]
        else:
            dur = float((a.get("info") or {}).get("duration") or 0)
            if dur > 0 and (a.get("info") or {}).get("has_video"):
                out[a["id"]] = [{"index": 0, "start": 0.0, "end": dur, "duration": dur, "metrics": {},
                                 "continuous_take": True}]
    return out


# ---------------------------------------------------------------------------
# Shots (timeline beats)
# ---------------------------------------------------------------------------
def _shots_from_transcript(words: list[dict], tmap, offset: float, total: float, pacing: dict) -> list[dict]:
    """Return shots [{t0,t1,text,seg}] in timeline time, cut on word starts."""
    if not words:
        n = max(1, round(total / pacing["target_shot"]))
        step = total / n
        return [{"t0": i * step, "t1": (i + 1) * step, "text": "", "seg": None} for i in range(n)]
    mapped = [{"w": w["word"], "s": offset + tmap(w["start"]), "e": offset + tmap(w["end"])} for w in words]
    # sentence groups: punctuation or pause >= 0.5s
    groups, cur = [], [mapped[0]]
    for prev, w in zip(mapped, mapped[1:]):
        if prev["w"].rstrip().endswith((".", "?", "!", "۔")) or w["s"] - prev["e"] >= 0.5:
            groups.append(cur)
            cur = []
        cur.append(w)
    groups.append(cur)
    shots = []
    tgt, mx, mn = pacing["target_shot"], pacing["max_shot"], pacing["min_shot"]
    for gi, g in enumerate(groups):
        g0 = 0.0 if gi == 0 else max(0.0, g[0]["s"] - 0.08)
        g1 = (groups[gi + 1][0]["s"] - 0.08) if gi + 1 < len(groups) else total
        dur = g1 - g0
        n = max(1, round(dur / tgt)) if dur > mx else 1
        cuts = [g0]
        for k in range(1, n):
            ideal = g0 + dur * k / n
            cand = min(g, key=lambda w: abs(w["s"] - ideal))["s"] - 0.06
            if cand - cuts[-1] >= mn and g1 - cand >= mn:
                cuts.append(cand)
        cuts.append(g1)
        for a, b in zip(cuts, cuts[1:]):
            text = " ".join(w["w"] for w in g if a - 0.1 <= w["s"] < b)
            shots.append({"t0": a, "t1": b, "text": text, "group": gi})
    # merge shots shorter than min_shot into neighbours
    merged: list[dict] = []
    for s in shots:
        if merged and (s["t1"] - s["t0"] < mn * 0.6):
            merged[-1]["t1"] = s["t1"]
            merged[-1]["text"] += " " + s["text"]
        else:
            merged.append(dict(s))
    return merged


# ---------------------------------------------------------------------------
# Scene scoring
# ---------------------------------------------------------------------------
def _quality(sc: dict) -> float:
    m = sc.get("metrics") or {}
    if not m:
        return 0.5
    q = min(1.0, m.get("sharpness", 8) / 14.0) * 0.5
    b = m.get("brightness", 0.45)
    q += 0.3 * (1 - min(1.0, abs(b - 0.47) / 0.4))
    q += 0.2 * (1 - min(1.0, m.get("highlights_clipped", 0) * 10 + m.get("shadows_crushed", 0) * 5))
    return q


def _score(sc: dict, shot_tokens: set[str], usage: dict, last_pos: tuple[str, float] | None, aid: str,
           need: float, have_desc: bool) -> tuple[float, float]:
    sem = 0.0
    st = _scene_tokens(sc)
    if have_desc and shot_tokens and st:
        sem = len(shot_tokens & st) / max(3, len(shot_tokens) ** 0.7)
    used = usage.get((aid, sc["index"]), 0.0)
    avail = sc["duration"] - used
    s = 2.2 * sem + 0.6 * _quality(sc)
    s -= 1.2 * min(1.0, used / max(0.5, sc["duration"]))  # avoid repeats
    if avail < min(need, 1.0):
        s -= 2.0
    if last_pos and last_pos[0] == aid:
        s += 0.25 if sc["start"] >= last_pos[1] - 0.01 else -0.15  # forward continuity
    if avail >= need:
        s += 0.15
    return s, sem


def _pick_range(sc: dict, used: float, need: float) -> tuple[float, float]:
    """Choose a fresh sub-range of the scene, skipping the first moments after a cut."""
    start = sc["start"] + min(0.2, sc["duration"] * 0.1) + used
    end = sc["end"] - 0.05
    if end - start >= need:
        if used == 0 and sc["duration"] > need * 1.6:  # centre the action when there is slack
            start = sc["start"] + (sc["duration"] - need) * 0.35
        return round(start, 3), round(start + need, 3)
    s = max(sc["start"], end - need)
    return round(s, 3), round(min(sc["end"], s + need), 3)


# ---------------------------------------------------------------------------
# Plan creation
# ---------------------------------------------------------------------------
def create_plan(project: Project, aspect: str | None = None, profile_name: str | None = None,
                brief: dict | None = None) -> tuple[Timeline, dict]:
    brief = brief or {}
    profile = load_profile(profile_name or project.data.get("profile"))
    aspect = aspect or project.data.get("aspect") or profile.get("default_aspect", "16:9")
    pacing = profile["pacing"]
    videos = project.assets("video")
    if not videos:
        raise ValueError("No video imported. Use import_video first.")
    scenes = load_scenes(project)
    primary = videos[0]
    pv = (primary.get("info") or {}).get("video_streams", [{}])[0]
    out = OutputFormat.from_aspect(aspect, fps=pv.get("fps"), fps_fraction=pv.get("fps_fraction"))
    if brief.get("fps"):
        out.fps, out.fps_fraction = float(brief["fps"]), None

    tr = project.read_json("audio/transcript.json") or {}
    words = tr.get("words") or []
    vo = project.voiceover()
    ap = profile.get("audio", {})
    audio = AudioSettings(voice_enhance=ap.get("voice_enhance", True), denoise=ap.get("denoise", "auto"),
                          target_lufs=ap.get("target_lufs", -14.0),
                          tighten_pauses=brief.get("tighten_pauses", ap.get("tighten_pauses", False)),
                          max_pause=brief.get("max_pause", ap.get("max_pause", 0.6)))
    notes: list[str] = []
    missing: list[MissingVisual] = []

    sync_asset = None
    if vo:
        for v in videos:
            if v.get("original_path") == vo.get("original_path") or brief.get("sync_video") == v["id"]:
                sync_asset = v
                break

    if vo:
        vo_dur = float((vo.get("info") or {}).get("duration") or tr.get("duration") or 0)
        keep = keep_intervals(words, vo_dur, audio.max_pause) if audio.tighten_pauses and words else [(0.0, vo_dur)]
        tmap = TimeMap(keep)
        lead = 0.0 if sync_asset else float(brief.get("lead_in", pacing.get("lead_in", 0.4)))
        has_cta = bool(brief.get("cta"))
        tail = max(float(pacing.get("tail", 0.8)), 3.5 if has_cta else 0.0)
        total = round(lead + tmap.total + tail, 3)
    else:
        keep, tmap, lead = [], TimeMap.identity(0), 0.0
        total = float(brief.get("target_duration") or sum(sc["duration"] for sc in scenes.get(primary["id"], [])))
        total = min(total, float((primary.get("info") or {}).get("duration") or total))
        audio.keep_source_audio = True
        audio.source_audio_volume_db = 0.0
        notes.append("No voiceover imported: the edit uses the footage's own audio in chronological order.")

    segments: list[VideoSegment] = []
    have_desc = any(sc.get("description") or sc.get("tags") for scs in scenes.values() for sc in scs)
    if not have_desc:
        notes.append("Scenes have no visual descriptions yet. Footage was matched on order, quality and variety, "
                     "not on meaning. Run analyze_video_content and describe_scenes for meaning-based matching.")
    reframe_cfg = profile.get("reframe", {})
    shots = _shots_from_transcript(words, tmap, lead, total, pacing) if vo else []

    if sync_asset:
        # --- lip-synced base track following kept voice intervals ---------------------------------
        notes.append(f"Sync mode: {sync_asset['id']} carries the voiceover, so picture and sound stay in sync.")
        t = 0.0
        for i, (a, b) in enumerate(keep):
            segments.append(VideoSegment(id=f"seg_{len(segments)+1:03d}", asset_id=sync_asset["id"], src_in=a, src_out=b,
                                         timeline_start=round(t, 3), reason="lip-synced main footage",
                                         reframe=Reframe(mode=reframe_cfg.get("mode", "auto"))))
            t += b - a
        # Tail (CTA / breathing room): the renderer holds the last frame - never replay used footage.
        # Long unbroken takes get subtle alternating punch-ins on sentence boundaries (classic
        # talking-head pacing without visible jump cuts).
        punch = float(brief.get("punch_in", 1.08))
        if punch > 1.0 and shots:
            split: list[VideoSegment] = []
            k = 0
            for seg in segments:
                bounds = [sh["t0"] for sh in shots
                          if seg.timeline_start + pacing["min_shot"] < sh["t0"] < seg.timeline_start + seg.duration - pacing["min_shot"]]
                pts = [seg.timeline_start] + bounds + [seg.timeline_start + seg.duration]
                for a, b in zip(pts, pts[1:]):
                    off = a - seg.timeline_start
                    z = punch if k % 2 == 1 else 1.0
                    split.append(seg.model_copy(update={
                        "id": f"seg_{len(split)+1:03d}", "src_in": round(seg.src_in + off, 3),
                        "src_out": round(seg.src_in + off + (b - a), 3), "timeline_start": round(a, 3),
                        "reframe": seg.reframe.model_copy(update={"zoom": z}),
                        "reason": "lip-synced main footage" + (" (subtle punch-in)" if z > 1 else "")}))
                    k += 1
            segments = split
        # cut-aways from other clips where they match the narration
        others = {k: v for k, v in scenes.items() if k != sync_asset["id"]}
        if others and have_desc:
            usage: dict = {}
            for sh in shots:
                tok = _tokens(sh["text"])
                best = None
                for aid, scs in others.items():
                    for sc in scs:
                        sc_s, sem = _score(sc, tok, usage, None, aid, sh["t1"] - sh["t0"], True)
                        if sem >= 0.34 and (best is None or sc_s > best[0]):
                            best = (sc_s, aid, sc)
                if best and sh["t1"] - sh["t0"] >= pacing["min_shot"]:
                    _, aid, sc = best
                    need = min(sh["t1"] - sh["t0"], pacing["max_shot"])
                    a, b = _pick_range(sc, usage.get((aid, sc["index"]), 0.0), need)
                    usage[(aid, sc["index"])] = usage.get((aid, sc["index"]), 0.0) + (b - a)
                    segments = _insert_cutaway(segments, sh["t0"], sh["t0"] + (b - a), aid, a, sc, sh["text"])
    else:
        # --- voice-led edit --------------------------------------------------------------------------
        if not shots:  # no voiceover: chronological scenes from primary video
            t = 0.0
            for sc in scenes.get(primary["id"], []):
                if t >= total:
                    break
                d = min(sc["duration"], total - t)
                segments.append(VideoSegment(id=f"seg_{len(segments)+1:03d}", asset_id=primary["id"], src_in=sc["start"],
                                             src_out=sc["start"] + d, timeline_start=round(t, 3), scene_index=sc["index"],
                                             reason="chronological (no voiceover)", keep_source_audio=True))
                t += d
        usage: dict = {}
        last: tuple[str, float] | None = None
        for sh in shots:
            need = sh["t1"] - sh["t0"]
            tok = _tokens(sh["text"])
            t_cursor, remaining = sh["t0"], need
            guard = 0
            while remaining > 0.04 and guard < 6:
                guard += 1
                cands = []
                for aid, scs in scenes.items():
                    for sc in scs:
                        sc_s, sem = _score(sc, tok, usage, last, aid, remaining, have_desc)
                        cands.append((sc_s, sem, aid, sc))
                if not cands:
                    break
                cands.sort(key=lambda x: -x[0])
                sc_s, sem, aid, sc = cands[0]
                used = usage.get((aid, sc["index"]), 0.0)
                avail = sc["duration"] - used - 0.25
                take = remaining if avail < 0.4 else min(remaining, avail)
                if remaining - take < pacing["min_shot"] * 0.5:
                    take = remaining
                a, b = _pick_range(sc, used, take)
                usage[(aid, sc["index"])] = used + (b - a)
                m = sc.get("metrics") or {}
                fx, fy = (m.get("subject_focus") or [0.5, 0.5])
                motion = "slow_push" if (reframe_cfg.get("motion") == "slow_push" and m.get("motion", 10) < 3.0) else "none"
                why = (f"matches narration ({', '.join(sorted(tok & _scene_tokens(sc)))})" if sem > 0
                       else "best available footage by quality, continuity and variety")
                segments.append(VideoSegment(id=f"seg_{len(segments)+1:03d}", asset_id=aid, src_in=a, src_out=b,
                                             timeline_start=round(t_cursor, 3), scene_index=sc["index"], reason=why,
                                             matched_text=sh["text"][:160],
                                             reframe=Reframe(mode=reframe_cfg.get("mode", "auto"), focus_x=fx, focus_y=fy,
                                                             motion=motion, zoom=1.0)))
                if have_desc and sem == 0 and len(tok) >= 3 and remaining == need:
                    missing.append(MissingVisual(at=round(sh["t0"], 2), duration=round(need, 2), text=sh["text"][:160],
                                                 suggestion="No footage was found that shows this. Consider shooting or supplying "
                                                            "B-roll of: " + ", ".join(sorted(tok)[:5]) +
                                                            " (stock or AI-generated B-roll must be clearly labelled)."))
                t_cursor += b - a
                remaining -= b - a
                last = (aid, b)

    # ---- transitions -------------------------------------------------------------------------------
    tcfg = profile.get("transitions", {})
    default_tr = tcfg.get("default", "cut")
    max_ratio = float(tcfg.get("max_non_cut_ratio", 0.25))
    budget = int(len(segments) * max_ratio)
    for i, s in enumerate(segments[1:], start=1):
        prev = segments[i - 1]
        new_section = shots and any(abs(sh["t0"] - s.timeline_start) < 0.12 and sh.get("group") is not None
                                    and i > 0 for sh in shots) and s.asset_id != prev.asset_id
        typ = default_tr
        if default_tr == "cut" and new_section and budget > 0 and tcfg.get("section_change", "cut") != "cut":
            typ = tcfg.get("section_change")
        if typ != "cut" and budget > 0 and not (sync_asset and s.asset_id == prev.asset_id):
            s.transition_in = Transition(type=typ, duration=float(tcfg.get("duration", 0.35)))
            budget -= 1

    # ---- colour -------------------------------------------------------------------------------------
    stats = []
    for s in segments:
        a = project.asset(s.asset_id)
        try:
            stats.append(color_mod.measure(project.asset_path(a), s.src_in, s.src_out))
        except Exception as e:  # noqa: BLE001
            log.warning("colour measure failed: %s", e)
            stats.append({})
    for s, cs in zip(segments, color_mod.auto_settings(stats, profile)):
        s.color = cs
    luts = project.assets("lut")
    if luts and brief.get("use_lut", True):
        for s in segments:
            s.color.lut = luts[-1]["path"]
            s.color.lut_intensity = float(brief.get("lut_intensity", 0.6))
        notes.append(f"LUT {luts[-1]['name']} applied at {int(float(brief.get('lut_intensity', 0.6))*100)}% strength.")

    # ---- graphics, sfx, music, captions ---------------------------------------------------------------
    graphics, sfx = _auto_graphics(project, profile, brief, segments, shots, tr, total, lead, tmap, out)
    cap = CaptionSettings(**{k: v for k, v in profile.get("captions", {}).items() if k in CaptionSettings.model_fields})
    for k, v in (brief.get("captions") or {}).items():
        if k in CaptionSettings.model_fields:
            setattr(cap, k, v)
    if not words:
        cap.enabled = False
        if vo:
            notes.append("Captions are disabled: there is no transcript text. Run transcribe_voiceover or align_script.")
    cap.highlight_keywords = list(dict.fromkeys(cap.highlight_keywords + (tr.get("key_terms") or [])[:6]))
    music = MusicSettings(volume_db=ap.get("music_volume_db", -21.0), duck_amount_db=ap.get("duck_amount_db", -10.0))
    mus_assets = project.assets("music")
    if mus_assets:
        music.asset_id = mus_assets[-1]["id"]
    elif brief.get("music") == "generated":
        music.asset_id = "generated_ambient"
        notes.append("Music: royalty-free ambient bed generated locally.")
    else:
        notes.append("No music: import a licensed track with add_background_music, or ask for the generated ambient bed.")
    if not vo:
        music.duck_under_voice = False

    tl = Timeline(project_id=project.id, profile=profile["name"], output=out, duration=total,
                  voiceover_asset_id=vo["id"] if vo else None, voiceover_offset=lead, segments=segments,
                  graphics=graphics, sfx=sfx, music=music, captions=cap, audio=audio, missing_visuals=missing,
                  notes=notes)
    if sync_asset:
        tl.audio.keep_source_audio = False  # voice comes from the processed voiceover (same recording)
    project.write_json("editing_timeline.json", tl.model_dump())
    project.data["status"] = "planned"
    project.data["aspect"] = aspect
    project.data["profile"] = profile["name"]
    project.log_event(f"editing plan created: {len(segments)} segments, {len(graphics)} graphics")
    project.save()
    return tl, summarize(tl)


def _insert_cutaway(segments: list[VideoSegment], t0: float, t1: float, aid: str, src_in: float, sc: dict,
                    text: str) -> list[VideoSegment]:
    out: list[VideoSegment] = []
    for s in segments:
        s_end = s.timeline_start + s.duration
        if s_end <= t0 or s.timeline_start >= t1 or s.is_broll:
            out.append(s)
            continue
        if s.timeline_start < t0:
            out.append(s.model_copy(update={"src_out": s.src_in + (t0 - s.timeline_start)}))
        m = sc.get("metrics") or {}
        fx, fy = m.get("subject_focus") or [0.5, 0.5]
        a0 = max(t0, s.timeline_start)
        b0 = min(t1, s_end)
        out.append(VideoSegment(id="tmp", asset_id=aid, src_in=src_in + (a0 - t0), src_out=src_in + (b0 - t0),
                                timeline_start=round(a0, 3), is_broll=True, scene_index=sc["index"],
                                reason=f"B-roll cut-away matching: {(sc.get('description') or '')[:80]}",
                                matched_text=text[:160], reframe=Reframe(focus_x=fx, focus_y=fy)))
        if s_end > t1:
            off = t1 - s.timeline_start
            out.append(s.model_copy(update={"src_in": s.src_in + off, "timeline_start": round(t1, 3)}))
    for i, s in enumerate(out):
        s.id = f"seg_{i+1:03d}"
    return out


def _auto_graphics(project: Project, profile: dict, brief: dict, segments, shots, tr: dict, total: float, lead: float,
                   tmap, out: OutputFormat) -> tuple[list[Graphic], list[SoundEffect]]:
    gp = profile.get("graphics", {})
    density = profile.get("audio", {}).get("sfx_density", "subtle")
    sfx_vol = float(profile.get("audio", {}).get("sfx_volume_db", -17.0))
    graphics: list[Graphic] = []
    sfx: list[SoundEffect] = []
    gid = lambda: f"gfx_{len(graphics)+1:02d}"  # noqa: E731

    def add(g: Graphic):
        graphics.append(g)
        if g.sfx and density != "none":
            sfx.append(SoundEffect(id=f"sfx_{len(sfx)+1:02d}", name=g.sfx, time=round(max(0.0, g.start - 0.05), 3),
                                   volume_db=sfx_vol, reason=f"entrance of {g.type}"))

    if brief.get("title") and gp.get("title_card", True):
        add(Graphic(id=gid(), type="title_card", start=0.15, duration=min(3.2, max(2.0, total * 0.12)),
                    params={"title": brief["title"], "subtitle": brief.get("subtitle", ""), "fullscreen": False},
                    animation="rise", sfx="impact_soft"))
    sp = brief.get("speaker") or {}
    if sp.get("name") and gp.get("lower_third", True):
        st = 3.6 if brief.get("title") else 1.0
        add(Graphic(id=gid(), type="lower_third", start=min(st, max(0.0, total - 5)), duration=4.5,
                    params={"name": sp["name"], "role": sp.get("role", "")}, animation="slide", sfx="whoosh_soft"))
    # stat cards from spoken numbers (verbatim)
    budget = max(1, int(gp.get("max_graphics_per_minute", 6) * total / 60))
    if gp.get("info_cards", True) and tr.get("segments"):
        used_t = [g.start for g in graphics]
        for seg in tr["segments"]:
            if sum(1 for g in graphics if g.type == "stat_card") >= budget:
                break
            m = re.search(r"(\d[\d,.]*\s*(%|percent|fisad|years|saal|minutes|minute|sessions|k|lakh|hazaar|plus|\+)?)",
                          seg["text"], re.I)
            if not m:
                continue
            t = lead + tmap(seg["start"])
            if any(abs(t - u) < 5 for u in used_t) or t + 3 > total:
                continue
            label = seg["text"].replace(m.group(0), "").strip(" ,.-")
            label = " ".join(label.split()[:7])
            add(Graphic(id=gid(), type="stat_card", start=round(t + 0.1, 2), duration=min(4.0, max(2.5, seg["end"] - seg["start"])),
                        params={"value": m.group(0).strip(), "label": label, "side": "right"}, animation="slide",
                        sfx="whoosh_soft"))
            used_t.append(t)
    for item in brief.get("graphics", []) or []:  # explicit requests from the brief
        try:
            g = Graphic(id=gid(), **item)
            if g.sfx is None:
                g.sfx = {"notification": "notification_chime", "callout": "pop", "cta": "shimmer",
                         "kinetic_text": None, "logo_bug": None}.get(g.type, "whoosh_soft")
            add(g)
        except Exception as e:  # noqa: BLE001
            log.warning("ignored invalid graphic in brief: %s", e)
    if brief.get("steps"):
        add(Graphic(id=gid(), type="process_steps", start=round(total * 0.45, 2), duration=4.5,
                    params={"steps": brief["steps"]}, animation="rise", sfx="whoosh_soft"))
    if brief.get("location"):
        loc = brief["location"]
        add(Graphic(id=gid(), type="location_pin", start=round(max(0.0, total - 9.5), 2), duration=4.0,
                    params={"name": loc.get("name", ""), "address": loc.get("address", "")}, animation="slide",
                    sfx="whoosh_soft"))
    cta = brief.get("cta")
    if cta and gp.get("cta_end_card", True):
        add(Graphic(id=gid(), type="cta", start=round(max(0.0, total - 3.4), 2), duration=3.4,
                    params={"headline": cta.get("headline", ""), "subtitle": cta.get("subtitle", ""),
                            "button": cta.get("button", ""), "contact": cta.get("contact", []), "fullscreen": True},
                    animation="fade", sfx="shimmer"))
    logos = project.assets("logo")
    if logos and brief.get("logo_bug", True):
        graphics.append(Graphic(id=gid(), type="logo_bug", start=0.0, duration=max(0.1, total - (3.4 if cta else 0)),
                                params={"image": logos[-1]["path"], "scale": 1.0}, animation="fade"))
    # subtle transition whooshes on dissolves (only when density allows)
    if density in ("medium", "rich"):
        for s in segments:
            if s.transition_in.type != "cut":
                sfx.append(SoundEffect(id=f"sfx_{len(sfx)+1:02d}", name="whoosh_soft",
                                       time=round(max(0.0, s.timeline_start - 0.3), 3), volume_db=sfx_vol - 3,
                                       reason="transition"))
    return graphics, sfx


def summarize(tl: Timeline) -> dict:
    return {
        "duration": round(tl.duration, 2),
        "output": f"{tl.output.width}x{tl.output.height} ({tl.output.aspect}) @ {tl.output.fps or 'source'} fps",
        "profile": tl.profile,
        "segments": [{"id": s.id, "at": round(s.timeline_start, 2), "dur": round(s.duration, 2), "asset": s.asset_id,
                      "src": f"{s.src_in:.2f}-{s.src_out:.2f}", "broll": s.is_broll,
                      "transition": s.transition_in.type, "why": s.reason, "text": s.matched_text[:80]}
                     for s in tl.segments],
        "graphics": [{"id": g.id, "type": g.type, "at": g.start, "dur": g.duration,
                      "content": {k: v for k, v in g.params.items() if k != "image"}} for g in tl.graphics],
        "sfx": [{"name": x.name, "at": x.time} for x in tl.sfx],
        "music": tl.music.asset_id or "none",
        "captions": tl.captions.mode if tl.captions.enabled else "off",
        "tighten_pauses": tl.audio.tighten_pauses,
        "missing_visuals": [m.model_dump() for m in tl.missing_visuals],
        "notes": tl.notes,
    }


# ---------------------------------------------------------------------------
# Plan editing
# ---------------------------------------------------------------------------
def apply_plan_changes(project: Project, changes: list[dict]) -> Timeline:
    data = project.read_json("editing_timeline.json")
    if not data:
        raise ValueError("No editing plan yet. Run create_editing_plan first.")
    tl = Timeline(**data)
    for ch in changes:
        op = ch.get("op")
        if op == "update_segment":
            s = next((x for x in tl.segments if x.id == ch["id"]), None)
            if not s:
                raise ValueError(f"segment {ch['id']} not found")
            upd = _merge_model(s.model_dump(), ch.get("fields", {}))
            tl.segments[tl.segments.index(s)] = VideoSegment(**upd)
        elif op == "remove_segment":
            tl.segments = [x for x in tl.segments if x.id != ch["id"]]
        elif op == "add_segment":
            tl.segments.append(VideoSegment(**ch["segment"]))
            tl.segments.sort(key=lambda x: x.timeline_start)
        elif op == "add_graphic":
            g = dict(ch["graphic"])
            g.setdefault("id", f"gfx_{len(tl.graphics)+1:02d}")
            tl.graphics.append(Graphic(**g))
        elif op == "update_graphic":
            g = next((x for x in tl.graphics if x.id == ch["id"]), None)
            if not g:
                raise ValueError(f"graphic {ch['id']} not found")
            tl.graphics[tl.graphics.index(g)] = Graphic(**_merge_model(g.model_dump(), ch.get("fields", {})))
        elif op == "remove_graphic":
            tl.graphics = [x for x in tl.graphics if x.id != ch["id"]]
        elif op == "add_sfx":
            s = dict(ch["sfx"])
            s.setdefault("id", f"sfx_{len(tl.sfx)+1:02d}")
            tl.sfx.append(SoundEffect(**s))
        elif op == "remove_sfx":
            tl.sfx = [x for x in tl.sfx if x.id != ch["id"]]
        elif op in ("captions", "music", "audio", "output", "color_grade_global"):
            cur = getattr(tl, op)
            setattr(tl, op, type(cur)(**_merge_model(cur.model_dump(), ch.get("fields", {}))))
        elif op == "set_all_segments_color":
            for s in tl.segments:
                s.color = type(s.color)(**_merge_model(s.color.model_dump(), ch.get("fields", {})))
        elif op == "replace_timeline":
            tl = Timeline(**ch["timeline"])
        elif op == "set":
            if ch.get("field") not in ("duration", "voiceover_offset", "approved", "notes"):
                raise ValueError("set supports: duration, voiceover_offset, approved, notes")
            setattr(tl, ch["field"], ch["value"])
        else:
            raise ValueError(f"Unknown op '{op}'. Supported: update_segment, remove_segment, add_segment, add_graphic, "
                             "update_graphic, remove_graphic, add_sfx, remove_sfx, captions, music, audio, output, "
                             "color_grade_global, set_all_segments_color, replace_timeline, set")
    ids = {a["id"] for a in project.assets()}
    problems = tl.validate_against(ids)
    if problems:
        raise ValueError("Plan has problems: " + "; ".join(problems))
    tl.approved = any(c.get("op") == "set" and c.get("field") == "approved" and c.get("value") for c in changes)
    project.write_json("editing_timeline.json", tl.model_dump())
    project.log_event(f"plan edited ({len(changes)} changes)")
    project.save()
    return tl


def _merge_model(base: dict, patch: dict) -> dict:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge_model(out[k], v)
        else:
            out[k] = v
    return out
