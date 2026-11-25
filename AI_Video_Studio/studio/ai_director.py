"""AI Director: lets the dashboard hand a whole edit to Claude, using the user's own Claude subscription.

The dashboard starts the Claude Code CLI in headless mode (`claude -p`). That run gets only this studio's MCP
tools: no shell, no file editing, and no other MCP servers. Claude then does what it would do in Claude
Desktop: import, analyse, transcribe, plan, storyboard and render. Progress streams back as JSON events and
is shown live in the dashboard. A follow-up request ("captions bigger") resumes the same Claude session.

Billing: `ANTHROPIC_API_KEY` is removed from the child environment so the run uses the claude.ai
subscription login (`claude auth login`), never pay-per-use API credits by accident.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import jobs as jobs_mod
from .config import get_settings
from .ffmpeg_utils import CancelledError
from .projects import load_project, now_iso

log = logging.getLogger("studio.ai_director")
_CREATE_FLAGS = 0x08000000 if sys.platform == "win32" else 0
SERVER_NAME = "ai-video-studio"

SYSTEM_APPEND = """You are the video editor behind the AI Video Studio dashboard. You work alone: nobody can answer
questions while you run, so never stop to ask - make sensible decisions and keep going.

Rules:
- Use only the ai-video-studio tools. Files are in the studio inbox (pass the file names as given).
- Follow the studio workflow: create_project (or reuse the given project_id) -> import -> analyze_media ->
  analyze_video_content (look at the images) -> describe_scenes with only what is visible -> transcribe_voiceover.
- language_mode roman_urdu_via_urdu: after transcription call romanize_transcript with EVERY segment in Roman Urdu
  (transliterate word for word, English words stay English, never translate or shorten). Use align_script instead
  if the user supplied the exact script.
- create_editing_plan with a brief that uses ONLY the facts the user gave (names, credentials, numbers, phone).
  Never invent credentials, numbers, testimonials or claims.
- For the motion_explainer profile: read load_editing_profile("motion_explainer") storyboard_guide, then call
  set_storyboard (items timed with exact transcript phrases via at_text). Check 2-3 key scenes with preview_graphic
  and fix anything that looks wrong.
- Long jobs (analysis, transcription, renders) return a job_id: call get_render_status(job_id, wait_seconds=240)
  repeatedly until the status is no longer "running". NEVER finish while a job is still running - the studio
  stops when you finish.
- If something blocks you (missing file, model download not allowed, an error you cannot fix), stop and explain.
- Finish with a short summary in simple Roman Urdu for the user, then a last line exactly like:
  RESULT_JSON: {"project_id": "...", "preview": "<path or null>", "final": "<path or null>"}
"""

# rough progress by the last studio tool used
_STAGE = {
    "get_system_status": (0.03, "checking the studio"), "list_inbox": (0.04, "looking at the inbox"),
    "create_project": (0.06, "creating the project"), "import_video": (0.08, "importing media"),
    "import_voiceover": (0.09, "importing media"), "import_asset": (0.1, "importing media"),
    "analyze_media": (0.15, "analysing the footage"), "analyze_video_content": (0.2, "looking at the scenes"),
    "describe_scenes": (0.24, "describing scenes"), "transcribe_voiceover": (0.3, "transcribing the voiceover"),
    "romanize_transcript": (0.38, "writing Roman Urdu"), "align_script": (0.38, "aligning the script"),
    "correct_transcript": (0.4, "correcting the transcript"), "get_transcript": (0.4, "reading the transcript"),
    "create_editing_plan": (0.46, "planning the edit"), "load_editing_profile": (0.48, "reading the style guide"),
    "set_storyboard": (0.55, "designing scenes"), "preview_graphic": (0.6, "checking scene designs"),
    "update_editing_plan": (0.62, "adjusting the plan"), "add_graphics": (0.62, "adding graphics"),
    "generate_captions": (0.63, "making captions"), "add_background_music": (0.63, "adding music"),
    "add_sound_effects": (0.63, "adding sound effects"), "preview_video": (0.7, "rendering the preview"),
    "execute_video_edit": (0.7, "rendering"), "render_video": (0.82, "rendering the final video"),
    "export_project": (0.95, "exporting the package"),
}

_runs: dict[str, dict] = {}  # job_id -> live state (log lines, session, project, process)


# ---------------------------------------------------------------------------
# Claude CLI discovery / login state
# ---------------------------------------------------------------------------
def find_claude() -> str | None:
    env = os.environ.get("AIVS_CLAUDE_PATH")
    if env:
        return env if Path(env).is_file() else None
    exe = shutil.which("claude")
    if exe:
        return exe
    for cand in (Path.home() / ".local" / "bin" / "claude.exe", Path.home() / ".local" / "bin" / "claude",
                 Path(os.environ.get("APPDATA", "")) / "npm" / "claude.cmd"):
        if cand.is_file():
            return str(cand)
    return None


def _child_env() -> dict:
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)  # use the subscription login, never API billing by accident
    env["AIVS_HOME"] = str(get_settings().home)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def claude_status() -> dict:
    exe = find_claude()
    if not exe:
        return {"ok": False, "installed": False, "logged_in": False,
                "message": "Claude Code was not found. Install it (PowerShell: irm https://claude.ai/install.ps1 | iex), "
                           "then run 'claude' once and log in with your Claude account."}
    try:
        p = subprocess.run([exe, "auth", "status"], capture_output=True, text=True, timeout=30, env=_child_env(),
                           stdin=subprocess.DEVNULL, creationflags=_CREATE_FLAGS, encoding="utf-8", errors="replace")
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "installed": True, "logged_in": False, "path": exe, "message": f"Could not run Claude Code: {e}"}
    data: dict[str, Any] = {}
    try:
        data = json.loads(p.stdout or "{}")
    except json.JSONDecodeError:
        pass
    method = data.get("authMethod")
    logged = p.returncode == 0 and method not in (None, "none")
    msg = "Ready - Claude will use your Claude subscription." if method == "claude.ai" else (
        "Logged in, but not with a claude.ai subscription - runs may be billed to API credits." if logged else
        "Not logged in. Open PowerShell, run:  claude auth login   and sign in with your Claude account.")
    return {"ok": logged, "installed": True, "logged_in": logged, "auth_method": method, "path": exe, "message": msg,
            "subscription": method == "claude.ai"}


# ---------------------------------------------------------------------------
# Prompt building
# ---------------------------------------------------------------------------
def build_prompt(req: dict) -> str:
    lines = []
    if req.get("session_id"):
        lines.append("The user wants changes to the video you just made.")
        if req.get("project_id"):
            lines.append(f"Project: {req['project_id']}.")
        lines.append(f"Changes requested: {req.get('instructions', '').strip()}")
        lines.append("Apply them (update_editing_plan / set_storyboard / correct_transcript / captions ...), then render a "
                     "new preview" + (" and the final video, and export the project." if req.get("final") else "."))
        return "\n".join(lines)
    files = req.get("files") or []
    lines.append("Make a professional video with AI Video Studio.")
    if req.get("project_id"):
        lines.append(f"Use the existing project {req['project_id']}.")
    if files:
        lines.append("Files in the studio inbox:")
        for f in files:
            lines.append(f"- {f.get('name')} ({f.get('role') or f.get('type') or 'file'})")
        lines.append("If the voice is recorded inside the video (no separate voiceover), import the same video as the "
                     "voiceover so lip-sync is kept.")
    lines.append(f"Format: {req.get('aspect') or '9:16'}. Style profile: {req.get('profile') or 'motion_explainer'}. "
                 f"Voiceover language_mode: {req.get('language_mode') or 'roman_urdu_via_urdu'}.")
    facts = {k: v for k, v in (req.get("facts") or {}).items() if str(v).strip()}
    if facts:
        lines.append("Facts you may show on screen (use exactly as written, never invent others):")
        for k, v in facts.items():
            lines.append(f"- {k}: {v}")
    if req.get("script"):
        lines.append("Exact spoken script (use align_script with it instead of transcribing):\n" + str(req["script"]))
    if req.get("music"):
        lines.append(f"Music: {req['music']}.")
    lines.append(f"What the user wants: {req.get('instructions', '').strip() or 'Edit it professionally in the style profile.'}")
    lines.append("Whisper model download: " + ("allowed (allow_model_download=true)." if req.get("allow_download")
                                               else "NOT allowed - if the model is missing, stop and say so."))
    lines.append("Finish with: " + ("a preview, then the final render and export_project." if req.get("final")
                                    else "a preview render only (the user will review it)."))
    return "\n".join(lines)


def mcp_config_file() -> Path:
    s = get_settings()
    cfg = {"mcpServers": {SERVER_NAME: {"command": sys.executable, "args": ["-m", "studio.server"],
                                        "env": {"AIVS_HOME": str(s.home), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}}}}
    p = s.home / "ai" / "mcp_config.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return p


def build_command(exe: str, req: dict) -> list[str]:
    s = get_settings()
    sys_file = s.home / "ai" / "director_prompt.md"
    sys_file.parent.mkdir(parents=True, exist_ok=True)
    sys_file.write_text(SYSTEM_APPEND, encoding="utf-8")
    cmd = [exe, "-p", "--output-format", "stream-json", "--verbose",
           "--mcp-config", str(mcp_config_file()), "--strict-mcp-config",
           "--tools", "",  # no built-in shell / file tools - studio tools only
           "--permission-mode", "dontAsk", "--allowedTools", f"mcp__{SERVER_NAME}__*",
           "--append-system-prompt-file", str(sys_file),
           "--max-turns", str(int(req.get("max_turns") or 150))]
    if req.get("model"):
        cmd += ["--model", str(req["model"])]
    if req.get("session_id"):
        cmd += ["--resume", str(req["session_id"])]
    return cmd


# ---------------------------------------------------------------------------
# Event parsing
# ---------------------------------------------------------------------------
def _short(v: Any, n: int = 140) -> str:
    t = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
    t = " ".join(t.split())
    return t if len(t) <= n else t[: n - 1] + "…"


def handle_event(state: dict, ev: dict) -> None:
    """Turn one stream-json event into human-readable log lines + progress."""
    t = ev.get("type")
    add = state["lines"].append
    if t == "system" and ev.get("subtype") == "init":
        state["session_id"] = ev.get("session_id") or state.get("session_id")
        servers = {m.get("name"): m.get("status") for m in ev.get("mcp_servers") or []}
        st = servers.get(SERVER_NAME)
        add(f"⚙ Claude started (model {ev.get('model', '?')}); studio tools: {st or 'not loaded'}")
        if st and st not in ("connected", "ok", "running"):
            add(f"⚠ The studio server did not load ({st}). Check the dashboard log.")
    elif t == "system" and ev.get("subtype") == "api_retry":
        add(f"… retrying the Claude request (attempt {ev.get('attempt')})")
    elif t == "assistant":
        for blk in (ev.get("message") or {}).get("content") or []:
            if blk.get("type") == "text" and blk.get("text", "").strip():
                txt = blk["text"].strip()
                for ln in txt.splitlines():
                    if ln.startswith("RESULT_JSON:"):
                        try:
                            state["result_json"] = json.loads(ln.split(":", 1)[1].strip())
                        except json.JSONDecodeError:
                            pass
                add("💬 " + _short(txt.replace("RESULT_JSON:", "").strip(), 400))
            elif blk.get("type") == "tool_use":
                name = str(blk.get("name", "")).replace(f"mcp__{SERVER_NAME}__", "")
                inp = blk.get("input") or {}
                if inp.get("project_id"):
                    state["project_id"] = inp["project_id"]
                stage = _STAGE.get(name)
                if stage:
                    state["progress"] = max(state.get("progress", 0.0), stage[0])
                    state["stage"] = stage[1]
                shown = {k: v for k, v in inp.items() if k not in ("items", "segments", "script", "descriptions", "changes")}
                add(f"▶ {name} {_short(shown, 120) if shown else ''}".rstrip())
    elif t == "user":
        for blk in (ev.get("message") or {}).get("content") or []:
            if blk.get("type") != "tool_result":
                continue
            content = blk.get("content")
            text = ""
            if isinstance(content, list):
                text = " ".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
            elif isinstance(content, str):
                text = content
            try:
                data = json.loads(text)
            except (json.JSONDecodeError, TypeError):
                data = None
            if isinstance(data, dict):
                pid = (data.get("project") or {}).get("id") if isinstance(data.get("project"), dict) else None
                if pid:
                    state["project_id"] = pid
                job = data.get("job") or {}
                if isinstance(job, dict) and job.get("status"):
                    add(f"   ↳ {job.get('kind', 'job')}: {job.get('status')} {job.get('stage') or ''} "
                        f"{job.get('progress_percent', '')}%".rstrip())
                if data.get("ok") is False:
                    add("   ⚠ " + _short(data.get("error", "tool error"), 300))
            elif blk.get("is_error"):
                add("   ⚠ " + _short(text, 300))
    elif t == "result":
        state["session_id"] = ev.get("session_id") or state.get("session_id")
        state["finished"] = True
        state["is_error"] = bool(ev.get("is_error"))
        state["num_turns"] = ev.get("num_turns")
        if ev.get("result"):
            state["result_text"] = ev["result"]
            for ln in str(ev["result"]).splitlines():
                if ln.startswith("RESULT_JSON:"):
                    try:
                        state["result_json"] = json.loads(ln.split(":", 1)[1].strip())
                    except json.JSONDecodeError:
                        pass
        if ev.get("errors"):
            add("⚠ " + _short(ev["errors"], 400))
        add(("✅ Done" if not ev.get("is_error") else "❌ Stopped") + f" ({ev.get('subtype')}, {ev.get('num_turns')} steps)")
    if len(state["lines"]) > 600:
        del state["lines"][:200]


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
def _kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, creationflags=_CREATE_FLAGS)
    else:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()


def start(req: dict) -> dict:
    st = claude_status()
    if not st.get("installed"):
        return {"ok": False, "error": st["message"]}
    if not st.get("logged_in"):
        return {"ok": False, "error": st["message"]}
    if not (req.get("instructions") or "").strip() and not req.get("files") and not req.get("session_id"):
        return {"ok": False, "error": "Choose files and/or write what you want."}
    exe = st["path"]
    prompt = build_prompt(req)
    cmd = build_command(exe, req)
    home = get_settings().home
    state: dict[str, Any] = {"lines": [], "progress": 0.0, "stage": "starting Claude", "session_id": req.get("session_id"),
                             "project_id": req.get("project_id"), "prompt": prompt, "started": time.time(),
                             "started_iso": now_iso()}

    def work(ctx: jobs_mod.JobContext):
        _runs[ctx.id] = state
        logf = home / "logs" / f"{ctx.id}.jsonl"
        state["lines"].append("🚀 " + ("Applying your changes with Claude…" if req.get("session_id") else "Claude is starting the edit…"))
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(home),
                                env=_child_env(), creationflags=_CREATE_FLAGS, text=True, encoding="utf-8",
                                errors="replace", bufsize=1)
        state["pid"] = proc.pid
        assert proc.stdin and proc.stdout and proc.stderr
        proc.stdin.write(prompt)
        proc.stdin.close()
        err_lines: list[str] = []
        threading.Thread(target=lambda: err_lines.extend(proc.stderr), daemon=True).start()

        def watch():
            while proc.poll() is None:
                if ctx.cancel_event.is_set():
                    state["lines"].append("⏹ Cancelling…")
                    _kill_tree(proc)
                    return
                time.sleep(0.5)
        threading.Thread(target=watch, daemon=True).start()
        with open(logf, "a", encoding="utf-8") as fh:
            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                fh.write(line + "\n")
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    state["lines"].append(_short(line, 300))
                    continue
                try:
                    handle_event(state, ev)
                except Exception as e:  # noqa: BLE001
                    log.warning("event parse failed: %s", e)
                ctx.update(stage=state.get("stage"), progress=state.get("progress", 0.0),
                           message=state["lines"][-1] if state["lines"] else None)
                ctx.check_cancel()
        proc.wait()
        if ctx.cancel_event.is_set():
            raise CancelledError("Cancelled by user")
        outputs = tag_claude_outputs(state)
        if not state.get("finished"):
            tail = "".join(err_lines[-15:]).strip()
            raise RuntimeError(f"Claude Code stopped unexpectedly (exit {proc.returncode}). {tail[-800:]}")
        if state.get("is_error"):
            raise RuntimeError(state.get("result_text") or "Claude could not finish the edit - see the log.")
        if outputs:
            state["lines"].append("🎬 Claude made: " + ", ".join(f"{o['quality']} → {o['output']}" for o in outputs))
        else:
            state["lines"].append("⚠ Claude finished but did not render a new video in this run. "
                                  "Ask it below: 'render a preview'.")
        ctx.update(stage="done", progress=1.0, force=True)
        return {"outputs": outputs, "session_id": state.get("session_id"), "project_id": state.get("project_id"),
                "result": state.get("result_json"), "summary": state.get("result_text"), "steps": state.get("num_turns")}

    job_id = jobs_mod.start_job("ai_edit", req.get("project_id"), work)
    _runs[job_id] = state
    return {"ok": True, "job_id": job_id}


def tag_claude_outputs(state: dict) -> list[dict]:
    """Mark the renders produced during this run as made by Claude (so the dashboard can tell them apart)."""
    pid = state.get("project_id") or (state.get("result_json") or {}).get("project_id")
    if not pid:
        return []
    try:
        p = load_project(str(pid))
    except Exception:  # noqa: BLE001
        return []
    out = []
    for r in p.data.get("renders", []):
        if r.get("at", "") >= state.get("started_iso", "9999"):
            r["by"] = "claude"
            r["session_id"] = state.get("session_id")
            out.append({"quality": r.get("quality"), "output": r.get("output"), "at": r.get("at"), "valid": r.get("valid")})
    if out:
        p.data["made_by_claude"] = True
        p.data["claude_session_id"] = state.get("session_id")
        p.log_event(f"Claude rendered {len(out)} video(s)")
        p.save()
    state["outputs"] = out
    return out


def run_state(job_id: str, since: int = 0) -> dict:
    j = jobs_mod.get_job(job_id) or {}
    st = _runs.get(job_id) or {}
    lines = st.get("lines", [])
    return {"ok": bool(j), "job": j, "lines": lines[since:], "next": len(lines), "session_id": st.get("session_id"),
            "project_id": st.get("project_id") or (j.get("result") or {}).get("project_id"),
            "result": st.get("result_json"), "summary": st.get("result_text"),
            "outputs": st.get("outputs") or (j.get("result") or {}).get("outputs") or []}
