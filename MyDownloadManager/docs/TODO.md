# Known limitations and TODO

Status of the requested features, kept honest. "Verified" means covered by automated tests (see TEST_REPORT.md) and,
for Windows-only parts, by the Windows CI job (smoke test + installer test).

## Implemented and verified

- Segmented HTTP/HTTPS engine: ranges, fallback, redirects, cookies, Basic auth, custom headers, proxy settings,
  retries, pause/resume, cancel, crash recovery, unknown size, If-Range change detection, checksums, speed limits,
  4 GB+ files.
- SQLite persistence (downloads, segments, settings, event log), DPAPI-encrypted secrets.
- Queue: concurrency, ordering, schedule window and scheduled start times, batch add.
- HLS (TS, fMP4, AES-128, master playlists, alternate audio) and DASH (template/timeline/list/base) with FFmpeg
  remux; DRM and live detection with explanations.
- Native messaging host + IPC (validated, size-limited, per-user pipe), host manifests and registration.
- MV3 extensions for Chromium and Firefox: download take-over, context menus, media detection, overlay, popup/options.
- WPF app, installer (per-user, registers/unregisters browsers, optional LGPL FFmpeg), Mark-of-the-Web.

## Not verified automatically (manual check recommended)

- **Extension behaviour inside real browsers** — logic is unit-tested and the native host is tested end-to-end with a
  browser-identical stdio client, but no automated test drives Chrome/Edge/Firefox UI (would need Playwright with an
  unpacked extension and a registered host on Windows).
- **UI interactions** beyond the smoke test (window renders, download completes, screenshot) — dialogs, tray menu,
  clipboard notifications and drag-and-drop were reviewed but not UI-automated.
- **HTTP proxy authentication** against a real proxy (configuration path is implemented; no proxy in the test rig).

## Limitations by design

- No DRM circumvention, no live-stream recording, no bypassing of sign-in or paywalls.
- Authentication: HTTP Basic and browser cookies. NTLM/Kerberos/Digest server auth is not implemented
  (system proxy authentication uses default Windows credentials).
- FTP, BitTorrent and other protocols are not supported (http/https only).
- Multi-period DASH (e.g. server-side ads) is reported as unsupported.
- Browser stores: the extensions are not published; Chrome/Edge need "Load unpacked", Firefox needs AMO signing for
  permanent installation (see BROWSER_EXTENSIONS.md).
- The installer is not code-signed (needs a certificate); Windows SmartScreen will warn on first run.

## Ideas for later

- Code signing for the app, host and installer; auto-update.
- Per-site connection limits and credentials manager UI.
- Optional dark theme; localisation.
- "Refresh download address" flow (re-capture an expired link from the browser while keeping progress).
- Playwright-based end-to-end tests for the extensions on Windows CI.
