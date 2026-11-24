@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AI Video Studio - Installer
cd /d "%~dp0"
echo ================================================================
echo   AI Video Studio - Windows installer
echo ================================================================

rem ---- 1. Python ----------------------------------------------------
set "PY="
where py >nul 2>&1 && (py -3.12 -c "import sys" >nul 2>&1 && set "PY=py -3.12")
if not defined PY (where py >nul 2>&1 && (py -3 -c "import sys; assert sys.version_info>=(3,10)" >nul 2>&1 && set "PY=py -3"))
if not defined PY (where python >nul 2>&1 && (python -c "import sys; assert sys.version_info>=(3,10)" >nul 2>&1 && set "PY=python"))
if not defined PY (
  echo [X] Python 3.10+ not found. Install Python 3.12 from https://www.python.org/downloads/
  echo     ^(tick "Add python.exe to PATH"^) or run:  winget install -e --id Python.Python.3.12
  pause & exit /b 1
)
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])"') do echo [OK] Python %%v  ^(%PY%^)

rem ---- 2. FFmpeg ----------------------------------------------------
where ffmpeg >nul 2>&1
if errorlevel 1 (
  echo [!] FFmpeg was not found on PATH.
  where winget >nul 2>&1 && (
    set /p ANS="    Install FFmpeg now with winget (Gyan.FFmpeg)? [Y/n]: "
    if /i not "!ANS!"=="n" (
      winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
      echo     FFmpeg installed. Close this window, open a NEW terminal and run install.bat again.
      pause & exit /b 0
    )
  )
  echo     Install FFmpeg manually ^(https://www.gyan.dev/ffmpeg/builds/^) and add its bin folder to PATH,
  echo     or set AIVS_FFMPEG / AIVS_FFPROBE in .env. Continuing without it...
) else (
  for /f "tokens=1-3" %%a in ('ffmpeg -hide_banner -version ^| findstr /b "ffmpeg"') do echo [OK] %%a %%b %%c
)

rem ---- 3. Virtual environment + dependencies ------------------------
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  %PY% -m venv .venv || (echo [X] venv creation failed & pause & exit /b 1)
)
set "VPY=%~dp0.venv\Scripts\python.exe"
"%VPY%" -m pip install --upgrade pip >nul
echo Installing AI Video Studio and dependencies (this can take a few minutes)...
"%VPY%" -m pip install -e ".[transcribe,dev]" || (
  echo [!] Full install failed - retrying without speech-to-text extras...
  "%VPY%" -m pip install -e ".[dev]" || (echo [X] pip install failed & pause & exit /b 1)
)

rem ---- 4. Folders, self-test ----------------------------------------
"%VPY%" -c "from studio.config import get_settings; from studio.renderer import ensure_fonts; s=get_settings(); ensure_fonts(); print('[OK] Studio home:', s.home); print('     Inbox      :', s.inbox_dir)" || (echo [X] studio import failed & pause & exit /b 1)
if not exist ".env" copy ".env.example" ".env" >nul
"%VPY%" -m studio.server --check || (echo [X] MCP server self-check failed & pause & exit /b 1)
echo [OK] MCP server starts correctly.
"%VPY%" scripts\check_env.py

rem ---- 5. Claude Desktop ----------------------------------------------
echo.
set /p ANS2="Register the studio in Claude Desktop now? (backup is made first) [Y/n]: "
if /i not "!ANS2!"=="n" "%VPY%" scripts\configure_claude_desktop.py
echo.
echo Installation finished. See README.md for the 2-minute quick start.
pause
