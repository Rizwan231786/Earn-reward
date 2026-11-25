"""Optional local dashboard (http://127.0.0.1:8765). Standard library only.

It reuses the same functions as the MCP tools, so both interfaces share projects, jobs and profiles.
It binds to localhost only.
"""
from __future__ import annotations

import json
import mimetypes
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .. import ai_director
from .. import jobs as jobs_mod
from .. import profiles, projects
from .. import server as tools
from ..config import get_settings, is_within, safe_filename, unique_path

STATIC = Path(__file__).parent / "static"


def _call(tool_fn, **kw):
    fn = getattr(tool_fn, "__wrapped__", tool_fn)
    try:
        return fn(**kw)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)}


class Handler(BaseHTTPRequestHandler):
    server_version = "AIVideoStudio"

    def log_message(self, fmt, *args):  # quiet
        pass

    # -- helpers --------------------------------------------------------
    def _json(self, obj, status=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n) or b"{}")

    def _origin_ok(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = urllib.parse.urlparse(origin).hostname
        return host in ("127.0.0.1", "localhost")

    # -- routes ---------------------------------------------------------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        path = u.path
        if path in ("/", "/index.html"):
            return self._static("index.html")
        if path == "/api/status":
            return self._json(_call(tools.get_system_status))
        if path == "/api/projects":
            return self._json({"ok": True, "projects": projects.list_projects()})
        m = re.fullmatch(r"/api/projects/([\w-]+)", path)
        if m:
            res = _call(tools.get_project, project_id=m.group(1))
            if res.get("ok"):
                p = projects.load_project(m.group(1))
                res["plan"] = p.read_json("editing_timeline.json")
                res["previews"] = [p.rel(x) for x in sorted(p.path("previews").glob("*.mp4"))]
                tr = p.read_json("audio/transcript.json")
                res["transcript"] = tools._transcript_view(tr, 300) if tr else None
            return self._json(res)
        if path == "/api/profiles":
            return self._json({"ok": True, "profiles": profiles.list_profiles()})
        if path == "/api/inbox":
            return self._json(_call(tools.list_inbox))
        if path == "/api/ai/status":
            return self._json(ai_director.claude_status())
        if path == "/api/ai/log":
            return self._json(ai_director.run_state(q.get("job", ""), int(q.get("since", 0) or 0)))
        if path == "/api/jobs":
            return self._json({"ok": True, "jobs": jobs_mod.list_jobs(q.get("project") or None, 15)})
        m = re.fullmatch(r"/files/([\w-]+)/(.+)", path)
        if m:
            return self._file(m.group(1), urllib.parse.unquote(m.group(2)))
        self._json({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        if not self._origin_ok():
            return self._json({"ok": False, "error": "forbidden origin"}, 403)
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        path = u.path
        if path == "/api/upload":
            return self._upload(q.get("name", "upload.bin"))
        b = self._body()
        if path == "/api/projects":
            return self._json(_call(tools.create_project, name=b.get("name", "Untitled"), aspect=b.get("aspect", ""),
                                    profile=b.get("profile", "")))
        if path == "/api/ai/run":
            return self._json(ai_director.start(b))
        if path == "/api/profiles/active":
            return self._json(_call(tools.set_active_profile, name=b["name"]))
        m = re.fullmatch(r"/api/jobs/([\w-]+)/cancel", path)
        if m:
            return self._json(jobs_mod.cancel_job(m.group(1)))
        m = re.fullmatch(r"/api/projects/([\w-]+)/(\w+)", path)
        if not m:
            return self._json({"ok": False, "error": "not found"}, 404)
        pid, action = m.groups()
        if action == "import":
            kind = b.get("kind", "video")
            if kind == "video":
                return self._json(_call(tools.import_video, project_id=pid, paths=b.get("paths", [])))
            if kind == "voiceover":
                return self._json(_call(tools.import_voiceover, project_id=pid, path=b["paths"][0]))
            return self._json(_call(tools.import_asset, project_id=pid, path=b["paths"][0], kind=kind))
        if action == "analyze":
            return self._json(_call(tools.analyze_media, project_id=pid, wait_seconds=0))
        if action == "transcribe":
            return self._json(_call(tools.transcribe_voiceover, project_id=pid, language_mode=b.get("language_mode", "roman_urdu"),
                                    allow_model_download=bool(b.get("allow_model_download")), wait_seconds=0))
        if action == "script":
            return self._json(_call(tools.align_script, project_id=pid, script=b.get("script", ""),
                                    language_mode=b.get("language_mode", "roman_urdu")))
        if action == "plan":
            return self._json(_call(tools.create_editing_plan, project_id=pid, aspect=b.get("aspect", ""),
                                    profile=b.get("profile", ""), brief=b.get("brief") or {}))
        if action == "preview":
            return self._json(_call(tools.preview_video, project_id=pid, wait_seconds=0))
        if action == "render":
            return self._json(_call(tools.render_video, project_id=pid, wait_seconds=0))
        if action == "export":
            return self._json(_call(tools.export_project, project_id=pid))
        self._json({"ok": False, "error": f"unknown action {action}"}, 404)

    # -- uploads (streamed to the inbox, never overwriting) -------------
    def _upload(self, name: str):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return self._json({"ok": False, "error": "empty upload"}, 400)
        dest = unique_path(get_settings().inbox_dir / safe_filename(Path(name).name))
        tmp = dest.with_suffix(dest.suffix + ".uploading")
        remaining = n
        with open(tmp, "xb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(8 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        if remaining:
            tmp.unlink(missing_ok=True)
            return self._json({"ok": False, "error": "upload interrupted"}, 400)
        tmp.rename(dest)
        self._json({"ok": True, "name": dest.name, "path": str(dest)})

    # -- static & media with HTTP Range (video seeking) -----------------
    def _static(self, name: str):
        p = STATIC / name
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(name)[0] or "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _file(self, pid: str, rel: str):
        try:
            p = projects.load_project(pid)
            f = p.path(rel)
        except Exception:  # noqa: BLE001
            return self._json({"ok": False, "error": "not found"}, 404)
        if not f.is_file() or not is_within(f, p.root):
            return self._json({"ok": False, "error": "not found"}, 404)
        size = f.stat().st_size
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        status = 200
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a) if a else max(0, size - int(b))
            end = int(b) if (a and b) else size - 1
            end = min(end, size - 1)
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(f, "rb") as fh:
            fh.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = fh.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    s = get_settings()
    host, port = s["dashboard"]["host"], int(s["dashboard"]["port"])
    if host not in ("127.0.0.1", "localhost"):
        print("Refusing to bind the dashboard to a non-local address.", file=sys.stderr)
        host = "127.0.0.1"
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"AI Video Studio dashboard: http://{host}:{port}  (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
