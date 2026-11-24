"""Optional local vision model (Ollama) for scene descriptions.

The default provider is "claude": analyze_video_content returns contact sheets to Claude
Desktop, Claude looks at the frames and saves what it sees with describe_scenes. If a local
Ollama vision model is configured, it can describe scenes without Claude's help. Every
description is limited to what is visible; the prompt forbids guessing.
"""
from __future__ import annotations

import base64
import json
import urllib.request

from .config import get_settings
from .projects import Project

PROMPT = ("Describe ONLY what is clearly visible in this video frame in one short sentence (people, actions, "
          "setting, objects, on-screen text). Do not guess identities, professions or events that are not visible. "
          "Then give 3-6 lowercase tags. Answer as JSON: {\"description\": \"...\", \"tags\": [\"...\"]}")


def ollama_available() -> bool:
    v = get_settings()["vision"]
    try:
        with urllib.request.urlopen(v["ollama_url"].rstrip("/") + "/api/tags", timeout=2) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def describe_with_ollama(project: Project, scenes: list[dict], cancel_check=None) -> list[dict]:
    v = get_settings()["vision"]
    out = []
    for sc in scenes:
        if cancel_check:
            cancel_check()
        if not sc.get("thumbnail"):
            out.append(sc)
            continue
        img = base64.b64encode(project.path(sc["thumbnail"]).read_bytes()).decode()
        body = json.dumps({"model": v["ollama_model"], "prompt": PROMPT, "images": [img], "stream": False,
                           "format": "json"}).encode()
        req = urllib.request.Request(v["ollama_url"].rstrip("/") + "/api/generate", data=body,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.loads(json.loads(r.read())["response"])
            sc = sc | {"description": str(resp.get("description", ""))[:300],
                       "tags": [str(t).lower() for t in resp.get("tags", [])][:8], "description_source": "ollama"}
        except Exception as e:  # noqa: BLE001
            sc = sc | {"description_error": str(e)}
        out.append(sc)
    return out
