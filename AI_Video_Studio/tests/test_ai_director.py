"""AI Director: the dashboard runs Claude Code headlessly with only the studio's MCP tools.
Uses tests/fake_claude.py instead of the real CLI (no model calls)."""
from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent


@pytest.fixture()
def fake_claude(tmp_path, monkeypatch, studio_home):
    if os.name == "nt":
        exe = tmp_path / "claude.cmd"
        exe.write_text(f'@"{sys.executable}" "{HERE / "fake_claude.py"}" %*\r\n')
    else:
        exe = tmp_path / "claude"
        exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{HERE / "fake_claude.py"}" "$@"\n')
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("AIVS_CLAUDE_PATH", str(exe))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-be-stripped")
    root = str(HERE.parent)
    monkeypatch.setenv("PYTHONPATH", root + os.pathsep + os.environ.get("PYTHONPATH", ""))
    return exe


def test_status_reports_subscription(fake_claude):
    from studio import ai_director
    st = ai_director.claude_status()
    assert st["ok"] and st["subscription"] and st["auth_method"] == "claude.ai"


def test_prompt_contains_only_supplied_facts():
    from studio import ai_director
    p = ai_director.build_prompt({"files": [{"name": "clip.mp4", "role": "video (voice inside the video)"}],
                                  "instructions": "Reel banao", "facts": {"Speaker name": "Dr. Test", "Other facts": ""},
                                  "allow_download": False})
    assert "clip.mp4" in p and "Dr. Test" in p and "Other facts" not in p
    assert "NOT allowed" in p and "roman_urdu_via_urdu" in p and "motion_explainer" in p
    f = ai_director.build_prompt({"session_id": "s1", "project_id": "project_002", "instructions": "captions bigger"})
    assert "captions bigger" in f and "project_002" in f


def test_run_and_resume_end_to_end(fake_claude, studio_home):
    from studio import ai_director, jobs
    r = ai_director.start({"files": [{"name": "a.mp4", "role": "video"}], "instructions": "make a reel"})
    assert r["ok"], r
    j = jobs.wait_for(r["job_id"], 120)
    state = ai_director.run_state(r["job_id"])
    assert j["status"] == "completed", (j, state["lines"])
    assert state["session_id"] == "sess-123"
    assert state["project_id"] == "project_001"  # learned from the real create_project tool result
    assert state["result"]["project_id"] == "project_001"
    joined = "\n".join(state["lines"])
    assert "studio tools: connected" in joined and "▶ create_project" in joined and "✅ Done" in joined
    assert (studio_home / "projects" / "project_001" / "project.json").exists()  # real MCP server did the work
    # follow-up resumes the same session
    r2 = ai_director.start({"session_id": "sess-123", "project_id": "project_001", "instructions": "captions bigger"})
    j2 = jobs.wait_for(r2["job_id"], 120)
    assert j2["status"] == "completed"
    assert ai_director.run_state(r2["job_id"])["session_id"] == "sess-123"


def test_not_logged_in_is_reported(monkeypatch, studio_home, tmp_path):
    from studio import ai_director
    monkeypatch.setenv("AIVS_CLAUDE_PATH", str(tmp_path / "missing-claude"))
    monkeypatch.setattr(ai_director.shutil, "which", lambda *_: None)
    st = ai_director.claude_status()
    assert not st["ok"]
    assert "error" in ai_director.start({"instructions": "x"})


def test_run_without_render_warns(fake_claude, studio_home):
    from studio import ai_director, jobs
    r = ai_director.start({"files": [], "instructions": "make a reel"})
    jobs.wait_for(r["job_id"], 120)
    st = ai_director.run_state(r["job_id"])
    assert st["outputs"] == []
    assert any("did not render a new video" in ln for ln in st["lines"])


def test_tag_claude_outputs_only_marks_this_runs_renders(studio_home):
    from studio import ai_director, projects
    p = projects.create_project("tag test")
    p.data["renders"] = [{"at": "2000-01-01T00:00:00+00:00", "quality": "preview", "output": "previews/old_manual.mp4"}]
    p.save()
    state = {"project_id": p.id, "session_id": "s9", "started_iso": projects.now_iso()}
    p = projects.load_project(p.id)
    p.data["renders"].append({"at": projects.now_iso(), "quality": "preview", "output": "previews/claude.mp4"})
    p.save()
    outs = ai_director.tag_claude_outputs(state)
    assert [o["output"] for o in outs] == ["previews/claude.mp4"]
    p = projects.load_project(p.id)
    by = {r["output"]: r.get("by") for r in p.data["renders"]}
    assert by == {"previews/old_manual.mp4": None, "previews/claude.mp4": "claude"}
    assert p.summary()["made_by_claude"] is True
