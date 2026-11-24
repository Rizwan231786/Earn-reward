"""MCP server tests: real stdio startup (as Claude Desktop launches it) and tool registration."""
from __future__ import annotations

import json
import os
import sys

import anyio

from conftest import ROOT

REQUIRED = {"get_system_status", "import_video", "import_voiceover", "analyze_media", "transcribe_voiceover",
            "analyze_video_content", "create_editing_plan", "execute_video_edit", "generate_captions", "add_graphics",
            "add_background_music", "add_sound_effects", "render_video", "get_render_status", "export_project",
            "list_projects", "load_editing_profile", "update_editing_profile", "preview_video", "cancel_render"}


def test_stdio_server_tools(studio_home, media_dir):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def run():
        params = StdioServerParameters(command=sys.executable, args=["-m", "studio.server"], cwd=str(ROOT),
                                       env={**os.environ})
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                init = await s.initialize()
                assert init.instructions and "PREMIUM COMMERCIAL" in init.instructions
                names = {t.name for t in (await s.list_tools()).tools}
                assert REQUIRED <= names, REQUIRED - names
                res = await s.call_tool("get_system_status", {})
                data = json.loads(res.content[0].text)
                assert data["ok"] and data["ffmpeg"]
                res = await s.call_tool("create_project", {"name": "mcp", "aspect": "1:1"})
                pid = json.loads(res.content[0].text)["project"]["id"]
                res = await s.call_tool("import_video", {"project_id": pid, "paths": [str(media_dir / "clip_a.mp4")]})
                assert json.loads(res.content[0].text)["imported"][0]["resolution"] == "640x360"
                res = await s.call_tool("import_voiceover", {"project_id": pid, "path": "C:/Windows/../../etc/passwd"})
                assert json.loads(res.content[0].text)["ok"] is False
                res = await s.call_tool("analyze_media", {"project_id": pid, "wait_seconds": 30})
                assert json.loads(res.content[0].text)["status"] == "completed"
                res = await s.call_tool("analyze_video_content", {"project_id": pid, "asset_id": "vid_01"})
                assert any(c.type == "image" for c in res.content)
    anyio.run(run)
