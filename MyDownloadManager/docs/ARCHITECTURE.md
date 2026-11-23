# Architecture

## Layers and projects

```
                        ┌──────────────────────────────────────────────┐
  Browser extension ──► │ MyDownloadManager.NativeHost (console, stdio)│
  (MV3, JS)  stdio JSON └───────────────┬──────────────────────────────┘
                                        │ named pipe (per user, CurrentUserOnly), length-prefixed JSON
┌───────────────────────────────────────▼──────────────────────────────────────────────────────────┐
│ MyDownloadManager.App  (WPF, MVVM, net10.0-windows)                                               │
│   Views (XAML) ─ ViewModels (CommunityToolkit.Mvvm) ─ Services (tray, clipboard, dialogs,         │
│   native-host registration, start-with-Windows)                                                   │
└───────────────────────────────────────┬──────────────────────────────────────────────────────────┘
┌───────────────────────────────────────▼──────────────────────────────────────────────────────────┐
│ MyDownloadManager.Application  (composition root, settings service, browser request handler,      │
│                                 clipboard URL filter, file logging) — UI independent, tested       │
└──────┬──────────────────┬──────────────────────┬──────────────────────┬──────────────────────────┘
┌──────▼───────┐ ┌────────▼─────────┐ ┌──────────▼──────────┐ ┌─────────▼──────────┐
│ Engine       │ │ Media            │ │ Persistence         │ │ Integration        │
│ HTTP engine, │ │ HLS/DASH parsers,│ │ SQLite repositories,│ │ native messaging   │
│ queue manager│ │ media engine,    │ │ settings, event log,│ │ framing, IPC,      │
│ rate limiter │ │ FFmpeg runner    │ │ DPAPI secrets       │ │ validation,        │
└──────┬───────┘ └────────┬─────────┘ └──────────┬──────────┘ │ host manifests     │
       └──────────────────┴──────────┬───────────┘            └─────────┬──────────┘
                              ┌──────▼─────────────────────────────────▼──┐
                              │ Core: models, abstractions, URL/file-name/ │
                              │ path validation, Mark-of-the-Web           │
                              └────────────────────────────────────────────┘
```

Dependencies point inwards only. `Core`, `Engine`, `Media`, `Persistence`, `Integration`, `Application` and
`NativeHost` target plain `net10.0` and are fully tested on Windows and Linux; only `App` is Windows-specific.

## Download engine (`Engine/DownloadRun.cs`)

1. **Probe** — `GET` with `Range: bytes=0-` (servers that reject `HEAD` still work). Redirects are followed manually
   (max 10); every hop is validated as http(s). `206` + `Content-Range` ⇒ ranges supported and size known; `200` ⇒ no
   range support. `416` on an empty file ⇒ retried without a Range header.
2. **Resume check** — if a segment table exists, the stored size, strong ETag / Last-Modified and the temp file length
   must match; otherwise the download restarts from zero with a logged reason.
3. **Plan** — `n = min(connections, ceil(size / 1 MiB))` equal segments. Without range support: one connection, and
   every reconnect restarts from byte 0. Unknown size: one open-ended segment closed at end-of-stream.
4. **Transfer** — N workers take unfinished segments. A finished worker *steals work* by splitting the largest
   remaining segment in half (under that segment's lock). Each write is clamped to the segment's current end inside the
   lock, so segments can never overlap even while being split. The probe response is reused for the first segment
   (one request for small files, important for single-use links). Range requests carry `If-Range`; a `200` reply to a
   ranged request means the file changed ⇒ the run is reset instead of mixing versions.
5. **Retries** — transient errors (network, timeouts, 408/425/429/5xx, early EOF) are retried per segment with
   exponential backoff and jitter. The retry budget resets only after ≥ 256 KB of progress, so a server that drops
   every connection after a few bytes cannot cause an endless loop. Disk errors are never retried.
6. **Checkpoints** (every 2 s and on stop) — snapshot segment counters → `FlushToDisk` → persist the snapshot. Because
   the snapshot is taken first, persisted progress is always ≤ durable data.
7. **Finalize** — size check, optional checksum (mismatch ⇒ file discarded), atomic rename to a unique final name,
   Mark-of-the-Web (`Zone.Identifier`, zone 3, query strings stripped).

## Media engine (`Media/`)

`MediaResolver` fetches the manifest (≤ 16 MB), picks the variant (best by default or the user's choice), resolves an
alternate audio rendition (HLS `EXT-X-MEDIA`) or the best audio representation (DASH) and returns tracks.
DRM signals — HLS `SAMPLE-AES*`, `skd://`, Widevine/PlayReady key formats; DASH `ContentProtection` — and live streams
(`#EXT-X-ENDLIST` missing, `type="dynamic"`) block the download with a user-facing reason. Segments are downloaded in
parallel to `<temp>.work/tN_000123.seg` (written as `.part`, renamed when complete ⇒ resumable), AES-128 segments are
decrypted with the key your session can fetch, tracks are concatenated, then `FfmpegRunner` remuxes with
`-c copy` into MP4 (MKV fallback). Without FFmpeg a single muxed TS track is saved as `.ts`.

## Queue manager (`Engine/Queue/DownloadManager.cs`)

Owns all `DownloadItem`s, starts up to *N* concurrently in queue order, maps cancellation reasons (pause, cancel,
remove, schedule stop, shutdown) to states, applies speed limits live and runs the scheduler tick (every 15 s).
All database writes go through a single FIFO `SerialTaskQueue`, so a late status write can never overwrite a newer one.
On startup, items left in an active state (crash, power loss) are re-queued and resume from their checkpoint.

## Persistence (`Persistence/`)

SQLite in WAL mode (`synchronous=NORMAL`) at `%LOCALAPPDATA%\MyDownloadManager\mydownloadmanager.db`.
Tables: `downloads`, `segments` (resume table), `settings` (JSON), `event_log` (capped at 5 000 rows). Schema version in
`PRAGMA user_version`; newer schemas are refused. Cookies, passwords, custom headers and the proxy password are
encrypted with DPAPI (CurrentUser) on Windows; a secret that cannot be decrypted (database copied to another account)
is dropped instead of crashing.

## Browser integration

```
content.js ──runtime msg──► background.js ──sendNativeMessage──► NativeHost.exe ──pipe──► App (IpcServer)
 overlay button              downloads.onCreated (pause → hand off → cancel only on success)
                             webRequest.onHeadersReceived (media detection per tab)
                             contextMenus, cookies.getAll(url)
```

Message types: `ping`, `config`, `download`, `batch`, `media`, `inspect` (and `activate`, `add-urls` used by a second
app instance). `MessageValidator` enforces http(s)-only URLs, a header allow-list, field/cookie size limits and a
2 000-URL batch cap; frames are capped at 1 MB and must be valid UTF-8. Batches always open a confirmation dialog.
If the app is not running the host starts it (`MyDownloadManager.exe --background`, fixed path, constant argument).

## Security checklist

| Threat | Mitigation |
|---|---|
| Malicious URL schemes (`file:`, `javascript:`, UNC) | `UrlValidator` everywhere (UI, clipboard, IPC, redirects, keys) |
| Path traversal / reserved names / bidi spoofing in server file names | `FileNameSanitizer` + `PathValidator.SafeCombine` on every write |
| Overwriting existing files | Unique-name allocation + `File.Move(overwrite: false)` |
| Credential leakage on redirects | Authorization/Cookie only for the original origin (manual redirects) |
| Secrets at rest | DPAPI; never written to logs (`UrlValidator.Redact` removes user-info and query) |
| Other local users / processes | Pipe created with `PipeOptions.CurrentUserOnly`; HKCU-only registration |
| Command injection via FFmpeg | No shell, `ArgumentList`, absolute local paths inside the work folder, `-protocol_whitelist file`, configured path must be a file named `ffmpeg.exe` |
| XML attacks in DASH manifests | `DtdProcessing.Prohibit`, no resolver, segment-count cap |
| Oversized / malformed IPC input | 1 MB frame cap, strict UTF-8, JSON depth 16, validation before dispatch |
| Running downloaded programs unknowingly | Mark-of-the-Web keeps SmartScreen/Protected View in force |
| Privilege | `asInvoker` manifest, per-user install by default |
