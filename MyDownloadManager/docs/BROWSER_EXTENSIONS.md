# Browser extensions

The extension sends downloads and videos from your browser to MyDownloadManager through the native messaging host
`com.mydownloadmanager.host`, which the installer registers for Chrome, Edge, Chromium, Brave and Firefox.

Installed copies of the extension are in `<install folder>\extensions` (Start menu → MyDownloadManager →
*Browser extensions folder*). Packages are also published as CI artifacts (`browser-extensions`).

## Google Chrome, Microsoft Edge, Brave

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `<install folder>\extensions\chromium`.
4. The extension ID must be **`jepeaacjobbkicoofllleimejjcjebge`** (fixed by the public key in the manifest).
   The native host only accepts this ID.
5. Optional: pin the extension and open its popup — the status should read *connected* (or *app not running*;
   the app starts automatically on the first download).

**Why "Load unpacked"?** Chrome and Edge only install extensions from their stores, from enterprise policy, or in
developer mode. If you publish the extension to the Chrome Web Store / Edge Add-ons, the store assigns a different ID:
add it to the host manifest's `allowed_origins` (`NativeHostManifest.BuildChromium(..., extraExtensionIds)`) and
re-run *Settings → Browser → Repair registration*.

**Enterprise deployment:** use the `ExtensionInstallForcelist` policy with a self-hosted update URL, or publish to the
store.

## Mozilla Firefox (115 or newer)

Firefox only installs add-ons signed by Mozilla.

- **For permanent use:** sign `extensions\MyDownloadManager-firefox.zip` through addons.mozilla.org (listed or
  self-distributed/unlisted), then install the signed `.xpi`. The add-on ID is
  `mydownloadmanager@mydownloadmanager.app`.
- **For testing:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select
  `<install folder>\extensions\firefox\manifest.json` (removed when Firefox restarts). Firefox Developer Edition /
  Nightly can install unsigned add-ons when `xpinstall.signatures.required` is `false`.
- **Grant site access:** in Firefox, Manifest V3 host permissions are opt-in. Open `about:addons` → MyDownloadManager →
  *Permissions* and enable **Access your data for all websites**. Without it, video detection and cookie forwarding
  do not work.

## What the extension does

| Feature | How |
|---|---|
| Take over downloads | `downloads.onCreated`: if the file type is in the list and larger than the minimum size, the browser download is paused, sent to the app with its cookies and referrer, and cancelled only after the app accepted it. If the app is unavailable the browser download resumes. |
| Context menu | *Download with MyDownloadManager* (links), *Download media with MyDownloadManager* (video/audio), *Download all links with MyDownloadManager* (page; you confirm the list in the app). |
| Video detection | `webRequest.onHeadersReceived` (read-only) classifies responses: HLS (`.m3u8`, `mpegurl`), DASH (`.mpd`, `dash+xml`), direct MP4/WebM/…; stream segments, partial ranges and files under 256 KB are ignored. The toolbar badge shows the count. |
| Download This Video | A button appears over `<video>` elements when a downloadable source is known. Videos using Encrypted Media Extensions show **Protected (DRM) — cannot download** instead. |
| Settings | Popup: on/off switches and detected media for the current tab. Options page: file types, minimum size, excluded sites, overlay on/off, troubleshooting tips. |

## Permissions and privacy

`downloads`, `nativeMessaging`, `contextMenus`, `cookies`, `storage`, `webRequest`, `tabs`, `scripting` and
host access to `http://*/*` and `https://*/*`. Cookies are read only for the exact URL being downloaded and sent only to
the local MyDownloadManager app. The extension makes no network requests of its own and has no analytics.

## Limitations (honest list)

- Videos delivered with DRM (Netflix, Disney+, Prime Video, Spotify, most paid streaming) cannot and will not be downloaded.
- Sites that play video from `blob:` URLs are supported only when they load an HLS/DASH manifest the extension can see.
  Players that assemble media from proprietary APIs or WebSockets cannot be captured.
- Some sites bind media URLs to browser-only headers or short-lived tokens; such downloads may fail with HTTP 403.
- Chrome may suspend the service worker; detected media is kept in `storage.session`, so the list survives that,
  but not a browser restart.
