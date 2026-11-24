@echo off
rem Adds the AI Video Studio MCP server to Claude Desktop (backs up the existing config and asks first).
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (echo Run install.bat first. & pause & exit /b 1)
".venv\Scripts\python.exe" scripts\configure_claude_desktop.py %*
pause
