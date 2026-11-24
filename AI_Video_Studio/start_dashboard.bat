@echo off
rem Optional local dashboard at http://127.0.0.1:8765
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (echo Run install.bat first. & pause & exit /b 1)
start "" http://127.0.0.1:8765
".venv\Scripts\python.exe" -m studio.dashboard.server
