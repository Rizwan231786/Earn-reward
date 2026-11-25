# MyDownloadManager

An original, open download manager for **Windows 10 and Windows 11 (x64)**: segmented multi-connection downloads with
pause/resume and crash recovery, a WPF desktop app, browser integration for Chrome, Edge and Firefox, and downloading
of HLS/DASH video that the site lets you play (DRM-protected content is never downloaded).

> Built with C# / .NET 10, WPF (MVVM), SQLite, a native messaging host, Manifest V3 browser extensions,
> FFmpeg (stream copy only) and Inno Setup. No code, branding or assets from any other download manager are used.

## Features

| Area | What it does |
|---|---|
| **Download engine** | HTTP/HTTPS, up to 32 connections per file using HTTP Range requests, dynamic re-segmentation (idle connections split the largest remaining part), automatic fallback to one connection when a server does not support ranges, unknown-size (chunked) downloads, redirects (each hop validated), cookies, custom headers, HTTP Basic auth (sent only to the original site), system/manual proxy with credentials, retries with exponential backoff, per-download and global speed limits, optional SHA-256/SHA-1/MD5/SHA-512 verification. |
| **Integrity** | All connections write into one pre-allocated temp file at their own offsets — there is no "join parts" step that could duplicate or drop bytes. Progress checkpoints are taken *before* flushing to disk, so recovered progress never claims bytes that were not written. Resumes use `If-Range`; if the file changed on the server the download restarts cleanly instead of mixing versions. The finished file is moved into place atomically and never overwrites an existing file. |
| **Recovery** | Paused, interrupted (network loss) and crashed downloads (app killed, PC restarted) resume from the last checkpoint automatically on next start. |
| **Queue** | Concurrency limit, queue order, start/pause all, scheduled start times and a daily schedule window (incl. overnight windows), categories with automatic sub-folders. |
| **Desktop app** | Downloads list with categories, search, progress, speed, ETA, size, status; details pane with a live per-segment map; logs view; settings; system tray with notifications; drag-and-drop of links; batch add (paste any text); opt-in clipboard monitoring; start with Windows; single instance. |
| **Browser integration** | Chrome / Edge / Brave / Chromium and Firefox extensions (Manifest V3) talking to a native messaging host. Takes over matching browser downloads (with cookies and referrer so signed-in downloads work), context-menu "Download with MyDownloadManager" / "Download all links", configurable file types / size / excluded sites. |
| **Video** | Detects MP4/WebM files and HLS (`.m3u8`) / DASH (`.mpd`) streams that a page loads and shows a **Download This Video** button on the player. Lists qualities, downloads segments in parallel (resumable), decrypts standard HLS AES-128 when the key is available to your session, and merges audio + video with FFmpeg without re-encoding. **DRM (Widevine, PlayReady, FairPlay, CENC/SAMPLE-AES) and live streams are refused with an explanation.** |
| **Security** | Only `http`/`https` URLs are accepted everywhere; Windows-safe file names (reserved names, traversal, bidi tricks); every write is confined to the chosen folder; cookies/passwords/auth headers encrypted at rest with DPAPI; credentials never forwarded across origins; per-user named pipe (`CurrentUserOnly`); size-limited, validated IPC messages; FFmpeg run without a shell, argument list only, `file` protocol only; Mark-of-the-Web on downloaded files so SmartScreen still applies. |

## Install

1. Run **`MyDownloadManager_Setup.exe`** (per-user install, no admin rights needed; "all users" is offered in the dialog).
2. Add the browser extension — browsers do not allow installers to add extensions silently:
   see **[docs/BROWSER_EXTENSIONS.md](docs/BROWSER_EXTENSIONS.md)**.

The installer registers the native messaging host for Chrome, Edge, Chromium, Brave and Firefox under `HKCU`,
optionally bundles an LGPL FFmpeg build, and removes the registration again on uninstall. Your download history and
settings (`%LOCALAPPDATA%\MyDownloadManager`) and downloaded files are kept on uninstall.

## Build from source

```powershell
# Windows: tests + publish + extensions + installer → artifacts\installer\MyDownloadManager_Setup.exe
pwsh build\build.ps1 -BundleFfmpeg
```

Requirements, Linux/macOS builds and CI details: **[docs/BUILD.md](docs/BUILD.md)**.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — layers, download engine design, data model, IPC protocol
- [Build instructions](docs/BUILD.md)
- [Browser extensions](docs/BROWSER_EXTENSIONS.md) — installation for Chrome, Edge, Firefox
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [FFmpeg integration and licensing](docs/FFMPEG.md)
- [Test report](docs/TEST_REPORT.md)
- [Known limitations / TODO](docs/TODO.md)

## What it deliberately does not do

- It does not decrypt or circumvent DRM, paywalls, sign-in requirements or other access controls. Streams that need a
  license server are reported as "Protected (DRM)".
- It does not download live streams (only complete, on-demand playlists).
- It does not bypass site restrictions: downloads use the cookies your browser already has for that site, nothing else.

## License

MIT — see [LICENSE.txt](LICENSE.txt). Third-party components: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
