#!/usr/bin/env python3
"""Stand-in for the Claude Code CLI used in tests (no model calls, no cost).

`fake_claude auth status` reports a subscription login. `fake_claude -p ...` checks the flags the dashboard
passes, starts the real studio MCP server from --mcp-config, calls real tools, and prints stream-json events
in the same shape as Claude Code.
"""
import asyncio
import json
import os
import sys


def emit(ev):
    print(json.dumps(ev), flush=True)


def main():
    a = sys.argv[1:]
    if a[:2] == ["auth", "status"]:
        print(json.dumps({"loggedIn": True, "authMethod": "claude.ai"}))
        return 0
    assert "-p" in a and a[a.index("--output-format") + 1] == "stream-json" and "--verbose" in a
    assert "--strict-mcp-config" in a and a[a.index("--tools") + 1] == ""
    assert a[a.index("--permission-mode") + 1] == "dontAsk"
    assert a[a.index("--allowedTools") + 1] == "mcp__ai-video-studio__*"
    assert os.path.isfile(a[a.index("--append-system-prompt-file") + 1])
    assert "ANTHROPIC_API_KEY" not in os.environ, "API key must be stripped"
    prompt = sys.stdin.read()
    resume = a[a.index("--resume") + 1] if "--resume" in a else None
    cfg = json.load(open(a[a.index("--mcp-config") + 1], encoding="utf-8"))
    srv = cfg["mcpServers"]["ai-video-studio"]
    sid = resume or "sess-123"
    emit({"type": "system", "subtype": "init", "session_id": sid, "model": "fake",
          "mcp_servers": [{"name": "ai-video-studio", "status": "connected"}]})

    async def run():
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        params = StdioServerParameters(command=srv["command"], args=srv["args"], env={**os.environ, **srv["env"]})
        async with stdio_client(params) as (r, w):
            async with ClientSession(r, w) as s:
                await s.initialize()
                calls = [("get_system_status", {})]
                if os.environ.get("FAKE_RENDER_PROJECT"):  # manual UI check: really render a preview
                    calls.append(("preview_video", {"project_id": os.environ["FAKE_RENDER_PROJECT"], "wait_seconds": 50}))
                elif resume:
                    calls.append(("list_projects", {}))
                else:
                    calls.append(("create_project", {"name": "AI test", "aspect": "9:16", "profile": "motion_explainer"}))
                pid = None
                for i, (name, args) in enumerate(calls):
                    tid = f"t{i}"
                    emit({"type": "assistant", "session_id": sid, "message": {"content": [
                        {"type": "text", "text": f"Step {i + 1}"},
                        {"type": "tool_use", "id": tid, "name": f"mcp__ai-video-studio__{name}", "input": args}]}})
                    res = await s.call_tool(name, args)
                    text = res.content[0].text
                    d = json.loads(text)
                    if name == "create_project":
                        pid = d["project"]["id"]
                    if name == "preview_video":
                        pid = args["project_id"]
                    emit({"type": "user", "session_id": sid, "message": {"content": [
                        {"type": "tool_result", "tool_use_id": tid, "content": [{"type": "text", "text": text}]}]}})
                return pid
    pid = asyncio.run(run()) or "project_001"
    final = f"Video tayyar hai.\nRESULT_JSON: {json.dumps({'project_id': pid, 'preview': None, 'final': None})}"
    emit({"type": "assistant", "session_id": sid, "message": {"content": [{"type": "text", "text": final}]}})
    emit({"type": "result", "subtype": "success", "session_id": sid, "is_error": False, "num_turns": 3,
          "result": final, "total_cost_usd": 0.0, "prompt_seen": prompt[:50]})
    return 0


if __name__ == "__main__":
    sys.exit(main())
