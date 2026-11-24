"""Background job runner with progress, persistence (SQLite) and cancellation.

Jobs run in daemon threads inside the current process. Status is persisted to SQLite so the
MCP server and the optional dashboard (separate processes) can both observe and cancel jobs.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import traceback
import uuid
from typing import Any, Callable

from .ffmpeg_utils import CancelledError
from .projects import db, now_iso

log = logging.getLogger("studio.jobs")


class JobContext:
    def __init__(self, job_id: str):
        self.id = job_id
        self.cancel_event = threading.Event()
        self._last_write = 0.0
        self.stage = ""
        self.progress = 0.0

    def update(self, stage: str | None = None, progress: float | None = None, message: str | None = None,
               force: bool = False) -> None:
        if stage is not None:
            self.stage = stage
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))
        now = time.time()
        if not force and now - self._last_write < 0.5:
            return
        self._last_write = now
        with db() as con:
            con.execute("UPDATE jobs SET stage=?, progress=?, message=COALESCE(?, message), updated_at=? WHERE id=?",
                        (self.stage, self.progress, message, now_iso(), self.id))
            row = con.execute("SELECT cancel_requested FROM jobs WHERE id=?", (self.id,)).fetchone()
        if row and row["cancel_requested"]:
            self.cancel_event.set()

    def check_cancel(self) -> None:
        if not self.cancel_event.is_set():
            with db() as con:
                row = con.execute("SELECT cancel_requested FROM jobs WHERE id=?", (self.id,)).fetchone()
            if row and row["cancel_requested"]:
                self.cancel_event.set()
        if self.cancel_event.is_set():
            raise CancelledError("Cancelled by user")

    def progress_cb(self, lo: float, hi: float, stage: str) -> Callable[[float], None]:
        def _cb(frac: float) -> None:
            self.update(stage=stage, progress=lo + (hi - lo) * frac)
        return _cb


_active: dict[str, JobContext] = {}


def start_job(kind: str, project_id: str | None, fn: Callable[[JobContext], Any]) -> str:
    job_id = f"{kind}_{uuid.uuid4().hex[:8]}"
    with db() as con:
        con.execute("INSERT INTO jobs(id, project_id, kind, status, stage, progress, pid, created_at, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (job_id, project_id, kind, "running", "starting", 0.0, os.getpid(), now_iso(), now_iso()))
    ctx = JobContext(job_id)
    _active[job_id] = ctx

    def _runner():
        try:
            result = fn(ctx)
            _finish(job_id, "completed", result=result)
        except CancelledError as e:
            _finish(job_id, "cancelled", error=str(e))
        except Exception as e:  # noqa: BLE001 - report every failure to the user
            log.error("job %s failed: %s\n%s", job_id, e, traceback.format_exc())
            _finish(job_id, "failed", error=f"{type(e).__name__}: {e}")
        finally:
            _active.pop(job_id, None)

    threading.Thread(target=_runner, name=job_id, daemon=True).start()
    return job_id


def _finish(job_id: str, status: str, result: Any = None, error: str | None = None) -> None:
    with db() as con:
        con.execute("UPDATE jobs SET status=?, progress=CASE WHEN ?='completed' THEN 1.0 ELSE progress END, "
                    "result=?, error=?, updated_at=? WHERE id=?",
                    (status, status, json.dumps(result, default=str) if result is not None else None, error,
                     now_iso(), job_id))


def get_job(job_id: str) -> dict | None:
    with db() as con:
        row = con.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["result"] = json.loads(d["result"]) if d.get("result") else None
    d["progress_percent"] = round((d.pop("progress") or 0) * 100, 1)
    d.pop("cancel_requested", None)
    if d["status"] == "running" and d.get("pid") != os.getpid() and not _pid_alive(d.get("pid")):
        d["status"] = "interrupted"
        d["error"] = "The process running this job stopped. Re-run the step (completed segments are cached)."
    return d


def _pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    if os.name == "nt":
        import ctypes
        h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(h)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def list_jobs(project_id: str | None = None, limit: int = 20) -> list[dict]:
    with db() as con:
        if project_id:
            rows = con.execute("SELECT id FROM jobs WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
                               (project_id, limit)).fetchall()
        else:
            rows = con.execute("SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return [j for j in (get_job(r["id"]) for r in rows) if j]


def cancel_job(job_id: str) -> dict:
    job = get_job(job_id)
    if not job:
        return {"ok": False, "error": f"Job '{job_id}' not found"}
    if job["status"] != "running":
        return {"ok": False, "error": f"Job is not running (status: {job['status']})"}
    with db() as con:
        con.execute("UPDATE jobs SET cancel_requested=1, message='cancel requested' WHERE id=?", (job_id,))
    if job_id in _active:
        _active[job_id].cancel_event.set()
    return {"ok": True, "job_id": job_id, "message": "Cancellation requested; ffmpeg will be stopped safely."}


def wait_for(job_id: str, seconds: float) -> dict:
    """Block up to `seconds` for a job; returns its status either way."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        j = get_job(job_id)
        if j and j["status"] != "running":
            return j
        time.sleep(0.4)
    return get_job(job_id) or {"id": job_id, "status": "unknown"}
