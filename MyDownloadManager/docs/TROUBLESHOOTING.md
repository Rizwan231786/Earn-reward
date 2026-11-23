# Troubleshooting

Logs: `%LOCALAPPDATA%\MyDownloadManager\logs\app-YYYYMMDD.log` (7 days kept), native host:
`%LOCALAPPDATA%\MyDownloadManager\logs\nativehost.log`. The **Logs** entry in the app's sidebar shows download events.

## Browser integration

| Symptom | Fix |
|---|---|
| Popup says **not connected** / "Native host unavailable" | Open MyDownloadManager → Settings → Browser → **Repair registration**, then restart the browser completely (all windows; check the tray). |
| Still not connected | Check the extension ID on `chrome://extensions` is `jepeaacjobbkicoofllleimejjcjebge` (Firefox: `mydownloadmanager@mydownloadmanager.app`). A store-installed copy has another ID — see [BROWSER_EXTENSIONS.md](BROWSER_EXTENSIONS.md). |
| | Check `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.mydownloadmanager.host` (Edge: `...\Microsoft\Edge\...`, Firefox: `...\Mozilla\...`) points to an existing JSON file whose `path` is the installed `MyDownloadManager.NativeHost.exe`. |
| | Group policy may block native messaging (`NativeMessagingBlocklist`, `NativeMessagingUserLevelHosts=false`). Ask your administrator, or install "for all users". |
| Downloads are not taken over | The type is not in the list or the file is smaller than the minimum (extension options), the site is excluded, or *Accept downloads from the browser extension* is off in the app. Downloads started by `blob:`/`data:` URLs always stay in the browser. |
| Firefox detects no videos | Grant *Access your data for all websites* in `about:addons` → MyDownloadManager → Permissions. |
| No **Download This Video** button | Start playback first (the manifest is detected when the player requests it). DRM-protected videos show *Protected (DRM)* by design. Check the overlay option in the popup. |

## Downloads

| Symptom / message | Meaning and fix |
|---|---|
| **HTTP 403 / 401** | The link expired or needs your browser session. Start it again from the browser (the extension forwards cookies). For HTTP Basic auth, enter credentials in *Add URL → Advanced*. |
| **Cannot resume: server does not support resuming** | The server ignores Range requests; the file is downloaded again from the start with one connection. |
| **Cannot resume: remote ETag/size changed** | The file on the server changed since the download started; it restarts automatically so you never get a mixed file. |
| **Gave up after N retries** | The connection kept failing. Check network/proxy, raise *Retries per connection*, then Resume. Progress is kept. |
| **Integrity check failed** | The downloaded data did not match the checksum you entered; the file was discarded. Verify the checksum value. |
| **Not enough disk space to allocate** | Space is reserved up front for the whole file; free space or choose another folder. |
| Slow speed | Increase connections per download (some servers limit per-connection speed) and check the global speed limit in the status bar. Some servers throttle many connections — reduce them. |
| Corporate proxy | Settings → Connection → Proxy: *System* uses Windows settings; *Manual* accepts `host:port` and credentials (stored encrypted). |

## Video / streams

| Message | Meaning |
|---|---|
| **This stream is protected by DRM (…)** | Widevine/PlayReady/FairPlay/CENC or HLS SAMPLE-AES. Not supported — intentionally. |
| **This is a live stream** | Only complete (VOD) playlists can be downloaded. |
| **The decryption key for this stream is not available to this session** | The key URL requires a session the app does not have (e.g. the site checks headers the browser adds). Access controls are not bypassed. |
| **…must be merged with FFmpeg** | DASH and HLS with separate audio need FFmpeg. Install it or set Settings → Media / FFmpeg; then Resume — finished segments are kept. |
| **MP4 remux failed; retrying with Matroska** | Some codec combinations are not allowed in MP4; the file is saved as `.mkv` instead. |

## App

| Symptom | Fix |
|---|---|
| Nothing happens when starting the app | It is probably running in the tray (closing the window keeps it running if *Keep running in the notification area* is on). Starting it again brings the window to the front. |
| Downloads resume after restart even though I closed the app | By design: running downloads are paused with a checkpoint on exit and resumed on next start. Pause them first if you don't want that. |
| Reset everything | Exit the app, delete `%LOCALAPPDATA%\MyDownloadManager` (history, settings, logs). Downloaded files are not touched. |
| "Database schema is newer than this app" | A newer version created the database; install that version again. |
