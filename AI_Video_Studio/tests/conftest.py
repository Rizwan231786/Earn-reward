"""Shared fixtures: an isolated studio home and small synthetic media (generated with FFmpeg)."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _ff(*args):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True,
                   stdin=subprocess.DEVNULL)


@pytest.fixture(scope="session")
def media_dir(tmp_path_factory) -> Path:
    d = tmp_path_factory.mktemp("media")
    # 3 visually distinct scenes, 640x360 @ 25 fps, with its own audio
    _ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=25:d=3", "-f", "lavfi", "-i", "smptebars=s=640x360:r=25:d=3",
        "-f", "lavfi", "-i", "color=c=0x305070:s=640x360:r=25:d=3", "-f", "lavfi", "-i", "sine=f=500:d=9",
        "-filter_complex", "[0][1][2]concat=n=3:v=1:a=0[v]", "-map", "[v]", "-map", "3:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", str(d / "clip_a.mp4"))
    _ff("-f", "lavfi", "-i", "mandelbrot=s=480x480:r=30,trim=0:4", "-c:v", "libx264", "-preset", "ultrafast",
        str(d / "clip_b.mov"))
    # "voiceover": tone bursts separated by silences (speech-like regions)
    _ff("-f", "lavfi", "-i", "sine=f=220:d=1.5", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1.2",
        "-f", "lavfi", "-i", "sine=f=330:d=2.0", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=0.5",
        "-filter_complex", "[0]aresample=48000,aformat=channel_layouts=mono,volume=0.5[a];"
                           "[2]aresample=48000,aformat=channel_layouts=mono,volume=0.5[c];[a][1][c][3]concat=n=4:v=0:a=1",
        str(d / "voiceover.wav"))
    (d / "notes.txt").write_text("not media")
    return d


@pytest.fixture()
def studio_home(tmp_path, media_dir, monkeypatch) -> Path:
    home = tmp_path / "studio_home"
    monkeypatch.setenv("AIVS_HOME", str(home))
    monkeypatch.setenv("AIVS_ALLOWED_DIRS", os.pathsep.join([str(media_dir), str(tmp_path)]))
    from studio import config
    config.reset_settings_cache()
    yield home
    config.reset_settings_cache()


@pytest.fixture()
def project(studio_home, media_dir):
    from studio import projects
    p = projects.create_project("Test", aspect="9:16")
    projects.import_asset(p, str(media_dir / "clip_a.mp4"), "video")
    projects.import_asset(p, str(media_dir / "clip_b.mov"), "video")
    projects.import_asset(p, str(media_dir / "voiceover.wav"), "voiceover")
    return p


SCRIPT = ("Assalam o alaikum! Aaj hum baat karenge skin care ke baare mein. "
          "Hamari clinic mein 95% patients khush hain. Abhi appointment book karein.")
