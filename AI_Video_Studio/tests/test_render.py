"""End-to-end rendering tests: output validity, dimensions, audio, duration, burned captions, A/V sync, export."""
from __future__ import annotations

import subprocess

import numpy as np
import pytest

from conftest import SCRIPT


def _frame(path, t, w, h):
    out = subprocess.run(["ffmpeg", "-loglevel", "error", "-ss", str(t), "-i", str(path), "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(out[: w * h * 3], np.uint8).reshape(h, w, 3)


def _first_sound(path) -> float:
    err = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path), "-vn", "-af", "silencedetect=noise=-45dB:d=0.1",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    for line in err.splitlines():
        if "silence_end:" in line:
            return float(line.split("silence_end:")[1].split("|")[0])
    return 0.0


@pytest.fixture()
def planned(project):
    from studio import media, planner, transcription
    for a in project.assets("video"):
        sc = media.analyze_scenes(project, a, media.detect_scenes(project, a))
        project.write_json(f"work/analysis_{a['id']}.json", {"scenes": sc})
    transcription.align_script(project, SCRIPT)
    planner.create_plan(project, brief={"title": "Glow Clinic", "speaker": {"name": "Dr. Test", "role": "Dermatologist"},
                                        "cta": {"headline": "Book your visit", "button": "Call now"},
                                        "music": "generated", "steps": ["Consult", "Treat"]})
    return project


def test_preview_and_final_render(planned):
    from studio import renderer
    from studio.models import Timeline
    tl = Timeline(**planned.read_json("editing_timeline.json"))
    prev = renderer.render(planned, "preview")
    assert prev["validation"]["ok"], prev
    assert (prev["width"], prev["height"]) == (540, 960)
    rep = renderer.render(planned, "final")
    v = rep["validation"]
    assert v["ok"], v
    c = v["checks"]
    assert (c["width"], c["height"]) == (1080, 1920)
    assert c["codec"] == "h264" and c["pix_fmt"] == "yuv420p" and c["color_space"] == "bt709"
    assert c["audio"] and c["sample_rate"] == 48000 and c["audio_codec"] == "aac"
    assert c["fps"] == 25.0  # original frame rate preserved
    assert c["duration"] == pytest.approx(tl.duration, abs=0.1)
    assert c["decode_errors"] == 0
    assert (planned.root / "captions" / "captions.srt").exists()
    # never overwrite: second final render gets a new name
    rep2 = renderer.render(planned, "final")
    assert rep2["output"] != rep["output"]


def test_captions_burned_and_av_sync(project):
    """Render with only the voice (no music/SFX/graphics); check sync and burned captions by pixels."""
    from studio import planner, renderer, transcription
    transcription.align_script(project, SCRIPT)
    tl, _ = planner.create_plan(project, brief={"lead_in": 1.0})
    planner.apply_plan_changes(project, [{"op": "music", "fields": {"asset_id": None}},
                                         {"op": "captions", "fields": {"mode": "phrase", "position": "center",
                                                                        "enabled": True}}]
                               + [{"op": "remove_graphic", "id": g.id} for g in tl.graphics]
                               + [{"op": "remove_sfx", "id": s.id} for s in tl.sfx])
    with_caps = renderer.render(project, "preview")
    # voice starts at the lead-in offset (1.0 s) in the rendered file
    assert _first_sound(with_caps["output"]) == pytest.approx(1.0, abs=0.08)
    planner.apply_plan_changes(project, [{"op": "captions", "fields": {"enabled": False}}])
    no_caps = renderer.render(project, "preview")
    tr = project.read_json("audio/transcript.json")
    t = 1.0 + (tr["words"][1]["start"] + tr["words"][1]["end"]) / 2
    W, H = with_caps["width"], with_caps["height"]
    a = _frame(with_caps["output"], t, W, H).astype(int)
    b = _frame(no_caps["output"], t, W, H).astype(int)
    band = slice(int(H * 0.4), int(H * 0.6))
    changed_center = (np.abs(a[band] - b[band]).max(-1) > 40).mean()
    changed_top = (np.abs(a[: int(H * 0.2)] - b[: int(H * 0.2)]).max(-1) > 40).mean()
    assert changed_center > 0.02 and changed_top < 0.001, (changed_center, changed_top)  # captions where expected


def test_cancel_render(planned):
    import time
    from studio import jobs, renderer
    jid = jobs.start_job("render_final", planned.id, lambda ctx: renderer.render(planned, "final", ctx))
    time.sleep(1.0)
    assert jobs.cancel_job(jid)["ok"]
    j = jobs.wait_for(jid, 60)
    assert j["status"] in ("cancelled", "completed")
    assert not list((planned.root / "exports").glob("*.part.mp4")) or j["status"] == "cancelled"


def test_export_package(planned):
    from studio import renderer, server
    renderer.render(planned, "final")
    res = server.export_project.__wrapped__(planned.id)
    assert res["ok"]
    names = set(res["files"])
    assert {"final_video.mp4", "captions.srt", "editing_timeline.json", "project_settings.json"} <= names
