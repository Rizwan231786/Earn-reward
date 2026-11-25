"""Unit/integration tests: import, metadata, security, transcription utilities, captions, timeline, profiles."""
from __future__ import annotations

import hashlib
import json

import pytest

from conftest import SCRIPT


def _sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_project_structure(project):
    for d in ("source", "audio", "thumbnails", "captions", "graphics", "broll", "previews", "exports"):
        assert (project.root / d).is_dir()
    assert (project.root / "project.json").exists()
    assert project.id == "project_001"


def test_import_metadata_and_originals_untouched(studio_home, media_dir):
    from studio import projects
    src = media_dir / "clip_a.mp4"
    before = _sha(src)
    p = projects.create_project("Meta")
    a = projects.import_asset(p, str(src), "video")
    assert a["info"]["has_video"] and a["info"]["has_audio"]
    vs = a["info"]["video_streams"][0]
    assert (vs["width"], vs["height"]) == (640, 360) and vs["fps"] == 25
    assert abs(a["info"]["duration"] - 9.0) < 0.2
    assert _sha(src) == before
    again = projects.import_asset(p, str(src), "video")
    assert again.get("already_imported")
    vo = projects.import_asset(p, str(media_dir / "voiceover.wav"), "voiceover")
    assert vo["info"]["audio_streams"][0]["sample_rate"] == 48000


def test_import_rejections(studio_home, media_dir, tmp_path):
    from studio import projects
    from studio.config import PathSecurityError
    p = projects.create_project("Reject")
    with pytest.raises(projects.ProjectError):
        projects.import_asset(p, str(media_dir / "notes.txt"), "video")
    with pytest.raises(PathSecurityError):
        projects.import_asset(p, "/etc/hostname", "video")
    with pytest.raises(projects.ProjectError):
        projects.import_asset(p, str(media_dir / "voiceover.wav"), "video")
    with pytest.raises(projects.ProjectError):
        projects.load_project("../etc")


def test_inbox_lookup(studio_home, media_dir):
    import shutil
    from studio import projects
    from studio.config import get_settings
    shutil.copy(media_dir / "voiceover.wav", get_settings().inbox_dir / "vo.wav")
    assert any(f["name"] == "vo.wav" for f in projects.list_inbox())
    p = projects.create_project("Inbox")
    a = projects.import_asset(p, "vo.wav", "voiceover")
    assert a["kind"] == "voiceover"


def test_scene_detection_and_metrics(project):
    from studio import media
    a = project.asset("vid_01")
    scenes = media.detect_scenes(project, a)
    assert len(scenes) == 3, scenes
    assert abs(scenes[1]["start"] - 3.0) < 0.15 and abs(scenes[2]["start"] - 6.0) < 0.15
    scenes = media.analyze_scenes(project, a, scenes)
    m = scenes[0]["metrics"]
    for k in ("brightness", "color_cast", "motion", "sharpness", "subject_focus", "dominant_colors"):
        assert k in m
    assert (project.root / scenes[0]["thumbnail"]).exists()
    sheet = media.contact_sheet(project, a, scenes)
    assert sheet.exists() and sheet.stat().st_size > 5000


def test_speech_regions_and_script_alignment(project):
    from studio import transcription
    tr = transcription.align_script(project, SCRIPT, "roman_urdu")
    assert tr["alignment_method"] == "proportional_over_speech_regions"
    assert " ".join(w["word"] for w in tr["words"]) == " ".join(SCRIPT.split())  # verbatim, never rewritten
    regions = tr["speech_regions"]
    assert len(regions) == 2
    # words only inside speech regions
    for w in tr["words"]:
        assert any(a - 0.05 <= w["start"] <= b + 0.05 for a, b in regions)
    assert "95%" in [w["word"] for w in tr["words"]][0:20] or any("95" in w["word"] for w in tr["words"])
    assert any(s["tone"] == "call_to_action" for s in tr["segments"])


def test_script_alignment_with_recognised_words(project):
    from studio import transcription
    project.write_json("audio/transcript.json", {
        "engine": "faster-whisper", "duration": 5.2, "language_mode": "roman_urdu",
        "words": [{"word": w, "start": i * 0.3, "end": i * 0.3 + 0.25, "prob": 0.9}
                  for i, w in enumerate("assalam alaikum aaj hum baat karenge skin care".split())]})
    tr = transcription.align_script(project, "Assalam o alaikum aaj hum baat karenge skin care")
    assert tr["alignment_method"].startswith("sequence_alignment")
    w = {x["word"]: x for x in tr["words"]}
    assert w["karenge"]["start"] == pytest.approx(1.5)
    assert w["o"]["start"] >= w["Assalam"]["end"] - 1e-6  # interpolated between anchors


def test_correction_and_script_guard(project):
    from studio import transcription
    project.write_json("audio/transcript.json", {
        "engine": "faster-whisper", "duration": 5.2, "language_mode": "roman_urdu",
        "words": [{"word": "clinik", "start": 0.0, "end": 0.4, "prob": 0.3},
                  {"word": "mein", "start": 0.5, "end": 0.8, "prob": 0.95},
                  {"word": "इलाज", "start": 0.9, "end": 1.3, "prob": 0.8}]})
    tr = transcription._finalise(project, project.read_json("audio/transcript.json"))
    assert tr["needs_review"]
    assert "devanagari_detected" in tr["segments"][0]["flags"]
    assert tr["uncertain_words"][0]["word"] == "clinik"
    tr = transcription.correct_transcript(project, replacements=[{"from": "clinik", "to": "clinic"}])
    assert tr["words"][0]["word"] == "clinic"
    tr = transcription.correct_transcript(project, segment_id=0, new_text="clinic mein ilaj")
    assert [w["word"] for w in tr["words"]] == ["clinic", "mein", "ilaj"]
    assert tr["words"][1]["start"] == 0.5  # timing kept when word count matches


def test_model_download_requires_permission(project, monkeypatch):
    from studio import transcription
    monkeypatch.setattr(transcription, "pick_engine", lambda: "faster-whisper")
    monkeypatch.setattr(transcription, "model_cached", lambda e, m: False)
    with pytest.raises(PermissionError):
        transcription.transcribe(project, "roman_urdu")


def test_captions_srt_ass(studio_home):
    from studio.captions import build_captions
    from studio.models import CaptionSettings
    words = [{"word": w, "start": i * 0.4, "end": i * 0.4 + 0.3} for i, w in enumerate(
        "Aaj hum baat karenge. Skin care 95% zaroori hai".split())]
    words.append({"word": "नमस्ते", "start": 4.0, "end": 4.3})
    for mode in ("phrase", "word_highlight", "word_by_word", "karaoke"):
        res = build_captions(words, CaptionSettings(mode=mode), 1080, 1920, time_map=lambda t: t + 1.0)
        assert res["dropped_non_roman_words"][0]["word"] == "नमस्ते"
        assert "नमस्ते" not in res["ass"] and "नमस्ते" not in res["srt"]
        assert "PlayResX: 1080" in res["ass"] and "Dialogue:" in res["ass"]
    srt = res["srt"]
    assert srt.startswith("1\n00:00:01,000 --> ")
    assert "Aaj hum baat karenge." in srt


def test_profiles(studio_home):
    from studio import profiles
    p = profiles.load_profile()
    assert p["name"] == "premium_commercial"
    assert p["title"] == "PREMIUM COMMERCIAL EDITING PROFILE"
    assert set(p["typography"].values()) >= {"Montserrat", "Inter", "Manrope"}
    names = {x["name"] for x in profiles.list_profiles()}
    assert {"healthcare_dermatology", "real_estate", "product_ad", "corporate", "youtube", "reels_shorts",
            "educational", "cinematic"} <= names
    up = profiles.update_profile("premium_commercial", {"captions": {"uppercase": True}})
    assert up["captions"]["uppercase"] is True and up["captions"]["font"] == "Montserrat"
    custom = profiles.update_profile("my_brand", {"palette": {"turquoise": "#00AAAA"}}, set_active=True,
                                     base="healthcare_dermatology")
    assert custom["palette"]["turquoise"] == "#00AAAA"
    assert profiles.active_profile_name() == "my_brand"
    with pytest.raises(ValueError):
        profiles.update_profile("x", {"not_a_key": 1})


def _analyse(project):
    from studio import media
    for a in project.assets("video"):
        sc = media.analyze_scenes(project, a, media.detect_scenes(project, a))
        project.write_json(f"work/analysis_{a['id']}.json", {"scenes": sc})


def test_timeline_voice_led(project):
    from studio import planner, transcription
    from studio.models import Timeline
    _analyse(project)
    transcription.align_script(project, SCRIPT)
    tl, summary = planner.create_plan(project, brief={"title": "Glow", "cta": {"headline": "Book now"},
                                                      "speaker": {"name": "Dr. Test", "role": "Dermatologist"}})
    assert tl.output.width == 1080 and tl.output.height == 1920
    segs = sorted(tl.segments, key=lambda s: s.timeline_start)
    assert segs[0].timeline_start == 0
    end = segs[-1].timeline_start + segs[-1].duration
    assert end == pytest.approx(tl.duration, abs=0.05)
    for a, b in zip(segs, segs[1:]):  # contiguous, no gaps
        assert b.timeline_start == pytest.approx(a.timeline_start + a.duration, abs=0.02)
    types = [g.type for g in tl.graphics]
    assert "title_card" in types and "lower_third" in types and "cta" in types
    lt = next(g for g in tl.graphics if g.type == "lower_third")
    assert lt.params["name"] == "Dr. Test"  # exactly as supplied
    assert not Timeline(**json.loads((project.root / "editing_timeline.json").read_text())).validate_against(
        {a["id"] for a in project.assets()})
    # editing ops
    tl2 = planner.apply_plan_changes(project, [{"op": "captions", "fields": {"mode": "phrase"}},
                                               {"op": "remove_graphic", "id": "gfx_01"}])
    assert tl2.captions.mode == "phrase" and all(g.id != "gfx_01" for g in tl2.graphics)
    with pytest.raises(ValueError):
        planner.apply_plan_changes(project, [{"op": "update_segment", "id": segs[0].id,
                                              "fields": {"asset_id": "nope"}}])


def test_timeline_sync_mode(studio_home, media_dir):
    from studio import planner, projects, transcription
    p = projects.create_project("Sync", aspect="16:9")
    projects.import_asset(p, str(media_dir / "clip_a.mp4"), "video")
    projects.import_asset(p, str(media_dir / "clip_a.mp4"), "voiceover")
    transcription.align_script(p, "one two three four five six seven eight nine ten. eleven twelve thirteen.")
    tl, s = planner.create_plan(p)
    assert any("Sync mode" in n for n in tl.notes)
    for seg in tl.segments:  # lip sync: source time == timeline time
        assert seg.src_in == pytest.approx(seg.timeline_start, abs=0.01)


def test_faster_whisper_gets_samples_not_path(project, monkeypatch):
    """Regression: PyAV >= 19 breaks faster-whisper's file decoder (metadata_errors). We must pass samples."""
    import types

    import numpy as np

    import faster_whisper
    from studio import transcription
    seen = {}

    class FakeModel:
        def __init__(self, *a, **kw):
            seen["compute_type"] = kw.get("compute_type")

        def transcribe(self, audio, **kw):
            seen["audio"] = audio
            w = types.SimpleNamespace(word="Assalam", start=0.1, end=0.5, probability=0.9)
            seg = types.SimpleNamespace(end=0.5, words=[w])
            return iter([seg]), types.SimpleNamespace(language="en")

    monkeypatch.setattr(faster_whisper, "WhisperModel", FakeModel)
    monkeypatch.setattr(transcription, "pick_engine", lambda: "faster-whisper")
    monkeypatch.setattr(transcription, "model_cached", lambda e, m: True)
    tr = transcription.transcribe(project, "roman_urdu")
    assert isinstance(seen["audio"], np.ndarray) and seen["audio"].dtype == np.float32
    assert abs(len(seen["audio"]) / 16000 - 5.2) < 0.05  # whole voiceover, 16 kHz
    assert seen["compute_type"] == "int8"  # CPU-only machine
    assert tr["words"][0]["word"] == "Assalam"
