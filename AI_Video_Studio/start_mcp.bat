@echo off
rem Starts the MCP server on stdio (Claude Desktop normally launches it automatically).
rem Run manually only for troubleshooting: the window will wait for MCP messages.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (echo Run install.bat first. & pause & exit /b 1)
set PYTHONIOENCODING=utf-8
".venv\Scripts\python.exe" -m studio.server %*
