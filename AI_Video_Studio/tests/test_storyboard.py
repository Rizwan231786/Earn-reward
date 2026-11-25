"""Motion-explainer style: storyboard timing, scenes in the picture track, layered overlays, pill captions,
Urdu-script romanization."""
from __future__ import annotations

import subprocess

import numpy as np
import pytest

SCRIPT = ("Assalam o alaikum. Aaj hum baat karenge skin care ke baare mein. "
          "Hamari clinic mein first consultation bilkul FREE hai. Abhi appointment book karein.")


def _frame(path, t, w, h):
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out[: w * h * 3], np.uint8).reshape(h, w, 3)


def test_find_phrase():
    from studio.planner import find_phrase
    words = [{"word": w} for w in "Aaj hum baat karenge, skin care ke baare mein.".split()]
    assert find_phrase(words, "skin care ke")[:2] == (4, 6)
    a, b, score = find_phrase(words, "skin kare ke baare")  # fuzzy
    assert a == 4 and 0.6 <= score < 1
    assert find_phrase(words, "totally different words here")[0] is None


@pytest.fixture()
def storyboarded(project):
    from studio import planner, transcription
    transcription.align_script(project, SCRIPT)
    planner.create_plan(project, profile_name="motion_explainer")
    items = [
        {"type": "scene_headline", "at_text": "Assalam o alaikum", "end_text": "skin care ke baare mein",
         "params": {"title": "SKIN\n*CARE*", "decor": "cards"}},
        {"type": "label_pill", "at_text": "Assalam o alaikum", "duration": 6, "params": {"text": "Dermatologist"}},
        {"type": "counter", "at_text": "Hamari clinic mein", "duration": 2.5, "params": {"from": 12, "to": 17, "suffix": "+",
                                                                                         "label": "Years"}},
        {"type": "scene_cta", "at_text": "Abhi appointment book", "until_end": True,
         "params": {"headline": "BOOK YOUR *FREE*\nCONSULTATION", "button": "WhatsApp now", "phone": "0300 0000000",
                    "photo": {"asset_id": "vid_01", "time": 1.0}}},
        {"type": "scene_flow", "at_text": "words that were never spoken anywhere", "params": {}},
    ]
    tl, report = planner.set_storyboard(project, items)
    return project, tl, report


def test_set_storyboard_timing(storyboarded):
    project, tl, report = storyboarded
    assert len(report["items"]) == 4
    assert any("not found" in w for w in report["warnings"])
    sb = {g.id: g for g in tl.graphics if g.id.startswith("sb_")}
    hook, pill, counter, cta = (sb[f"sb_0{i}"] for i in range(1, 5))
    tr = project.read_json("audio/transcript.json")
    first = tr["words"][0]["start"] + tl.voiceover_offset
    assert hook.start == pytest.approx(max(0.0, first - 0.12), abs=0.02)
    assert hook.start + hook.duration <= counter.start + 0.5
    assert cta.start + cta.duration == pytest.approx(tl.duration, abs=0.01)  # until_end
    assert tl.captions.background == "pill" and tl.captions.position == "lower_middle"
    assert any(x.reason.startswith("storyboard") for x in tl.sfx)  # subtle whoosh on scenes
    # replacing the storyboard removes the old items
    from studio import planner
    tl2, rep2 = planner.set_storyboard(project, items=[{"type": "label_pill", "start": 1.0, "params": {"text": "x"}}])
    assert [g.id for g in tl2.graphics if g.id.startswith("sb_")] == ["sb_01"]


def test_apply_scenes_keeps_sync():
    from studio.models import Graphic, VideoSegment
    from studio.renderer import apply_scenes
    segs = [VideoSegment(id="s1", asset_id="v", src_in=0, src_out=10, timeline_start=0)]
    g = Graphic(id="sc", type="scene_headline", start=3, duration=2, params={})
    out = apply_scenes(segs, [g], 10)
    assert [(s.scene_id, s.timeline_start, round(s.duration, 3)) for s in out] == [(None, 0, 3), ("sc", 3, 2), (None, 5, 5)]
    assert out[2].src_in == pytest.approx(5)  # footage after the scene is still in sync with the voice
    assert out[1].transition_in.type == "slide_left" and out[2].transition_in.type == "slide_left"


def test_render_with_scenes_overlays_and_pill_captions(storyboarded):
    from studio import renderer
    project, tl, _ = storyboarded
    rep = renderer.render(project, "preview")
    assert rep["validation"]["ok"], rep
    assert rep["stages"]["scenes"] == 2
    W, H = rep["width"], rep["height"]
    sb = {g.id: g for g in tl.graphics}
    hook, cta = sb["sb_01"], sb["sb_04"]
    f = _frame(rep["output"], hook.start + hook.duration / 2, W, H).astype(int)
    # navy designed background, not the test footage
    assert f[: H // 10].mean(axis=(0, 1))[2] > f[: H // 10].mean(axis=(0, 1))[0] + 15
    # the label pill (an overlay) must not be drawn over the scene: top-left area stays background-like
    tl_area = f[int(H * 0.05):int(H * 0.1), int(W * 0.05):int(W * 0.5)]
    assert (tl_area.min(axis=2) > 215).mean() < 0.002  # no white pill text
    g = _frame(rep["output"], cta.start + cta.duration / 2, W, H).astype(int)
    assert g[: int(H * 0.04)].mean(axis=(0, 1))[1] > 120  # teal band at the top of the CTA


def test_preview_graphic_returns_image(storyboarded):
    from studio import server
    project, tl, _ = storyboarded
    res = server.preview_graphic.__wrapped__(project.id, graphic_id="sb_01")
    assert any(getattr(c, "type", "") == "image" for c in res)
    res = server.preview_graphic.__wrapped__(project.id, graphic={"type": "scene_steps", "start": 1,
                                                                   "params": {"items": ["One", "Two"]}})
    assert any(getattr(c, "type", "") == "image" for c in res)


def test_romanize_and_translation_warning(project):
    from studio import transcription
    words = [{"word": w, "start": i * 0.4, "end": i * 0.4 + 0.3, "prob": 0.9}
             for i, w in enumerate("آج ہم بات کریں گے۔ آپ کی جلد".split())]
    project.write_json("audio/transcript.json", {"engine": "faster-whisper", "duration": 5.2,
                                                 "language_mode": "roman_urdu_via_urdu", "words": words})
    tr = transcription._finalise(project, project.read_json("audio/transcript.json"))
    assert tr["needs_review"] and "arabic_script_detected" in tr["segments"][0]["flags"]
    seg_ids = [s["id"] for s in tr["segments"]]
    with pytest.raises(ValueError):
        transcription.romanize_transcript(project, [{"id": seg_ids[0], "text": "آج ہم"}])
    out = transcription.romanize_transcript(project, [{"id": seg_ids[0], "text": "Aaj hum baat karenge."},
                                                      {"id": seg_ids[1], "text": "Aap ki jild"}])
    assert " ".join(w["word"] for w in out["words"]) == "Aaj hum baat karenge. Aap ki jild"
    assert out["words"][0]["start"] == 0.0 and out["still_in_urdu_script"] == []
    english = {"language_mode": "roman_urdu", "segments": [
        {"text": "This is a long English sentence that has no Urdu words at all here."} for _ in range(6)]}
    assert transcription.looks_translated(english)
    assert not transcription.looks_translated({"language_mode": "roman_urdu", "segments": [
        {"text": "Aaj hum baat karenge skin care ke baare mein aur aap ko batayenge."} for _ in range(6)]})
