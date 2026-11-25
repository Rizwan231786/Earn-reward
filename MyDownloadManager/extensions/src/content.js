// MyDownloadManager — "Download This Video" overlay.
// Shows a button over <video> elements when a legitimately downloadable source is known:
//  * the element plays a plain http(s) file (MP4/WebM), or
//  * the page loaded an HLS/DASH manifest (seen by the background script's network observer).
// Elements whose playback uses Encrypted Media Extensions (DRM) get an explanatory, disabled badge instead.
(() => {
  if (window.__mdmOverlayLoaded) return;
  window.__mdmOverlayLoaded = true;
  const api = globalThis.browser ?? globalThis.chrome;

  let detected = [];
  let enabled = true;
  let current = null; // video under the pointer

  const host = document.createElement("mdm-overlay-host");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0;display:none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .wrap{font:600 12px/1.2 "Segoe UI",system-ui,sans-serif;position:relative}
      button{all:unset;cursor:pointer;display:flex;align-items:center;gap:6px;padding:7px 11px;border-radius:7px;
        background:#1f6feb;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.35)}
      button:hover{background:#1858c4}
      button.drm{background:#6e7681;cursor:help}
      .menu{position:absolute;right:0;top:34px;min-width:260px;max-width:420px;background:#fff;color:#1f2328;border-radius:8px;
        box-shadow:0 6px 24px rgba(0,0,0,.3);padding:4px;display:none}
      .menu div{padding:7px 9px;border-radius:5px;cursor:pointer;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .menu div:hover{background:#eef4ff}
      .toast{margin-top:6px;padding:6px 9px;border-radius:6px;background:#1f2328;color:#fff;font-weight:500;display:none;max-width:320px}
      svg{width:14px;height:14px}
    </style>
    <div class="wrap">
      <button id="btn"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M7 1h2v7.6l2.6-2.6 1.4 1.4L8 12.4 3 7.4 4.4 6 7 8.6z"/><rect x="2" y="13.5" width="12" height="1.5" rx=".75"/></svg><span id="label">Download This Video</span></button>
      <div class="menu" id="menu"></div>
      <div class="toast" id="toast"></div>
    </div>`;
  const btn = root.getElementById("btn");
  const label = root.getElementById("label");
  const menu = root.getElementById("menu");
  const toast = root.getElementById("toast");
  (document.documentElement || document.body).appendChild(host);

  function candidatesFor(video) {
    const src = video.currentSrc || video.src || "";
    const list = [];
    if (/^https?:/i.test(src)) list.push({ url: src, kind: /\.m3u8(\?|$)/i.test(src) ? "hls" : /\.mpd(\?|$)/i.test(src) ? "dash" : "direct" });
    for (const m of detected) if (!list.some((x) => x.url === m.url)) list.push(m);
    // Streams first (they carry the full quality ladder), then direct files.
    return list.sort((a, b) => (a.kind === "direct") - (b.kind === "direct"));
  }

  function describe(m) {
    const kind = m.kind === "hls" ? "HLS" : m.kind === "dash" ? "DASH" : "File";
    let name = "";
    try { name = decodeURIComponent(new URL(m.url).pathname.split("/").pop() || ""); } catch { /* ignore */ }
    const size = m.size > 0 ? ` (${(m.size / 1048576).toFixed(1)} MB)` : "";
    return `${kind}: ${name || m.url}${size}`;
  }

  function position(video) {
    const r = video.getBoundingClientRect();
    if (r.width < 160 || r.height < 90 || r.bottom < 0 || r.top > innerHeight) { hide(); return; }
    host.style.top = `${Math.max(4, r.top + 8)}px`;
    host.style.left = `${Math.min(innerWidth - 200, r.right - 190)}px`;
  }

  function show(video) {
    if (!enabled) return;
    const drm = !!video.mediaKeys;
    const cands = candidatesFor(video);
    if (!drm && cands.length === 0) { hide(); return; }
    current = video;
    btn.classList.toggle("drm", drm);
    label.textContent = drm ? "Protected (DRM) — cannot download" : "Download This Video";
    btn.title = drm
      ? "This video uses Encrypted Media Extensions (DRM). MyDownloadManager does not circumvent DRM or other access controls."
      : "Send this video to MyDownloadManager";
    host.style.display = "block";
    position(video);
  }

  function hide() {
    host.style.display = "none";
    menu.style.display = "none";
    current = null;
  }

  function flash(text) {
    toast.textContent = text;
    toast.style.display = "block";
    setTimeout(() => { toast.style.display = "none"; }, 3500);
  }

  async function send(item) {
    menu.style.display = "none";
    const reply = await api.runtime.sendMessage({ cmd: "download-media", item });
    flash(reply?.ok ? "Sent to MyDownloadManager" : `Could not start download: ${reply?.error || "unknown error"}`);
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!current || current.mediaKeys) return;
    const cands = candidatesFor(current);
    if (cands.length === 1) { send(cands[0]); return; }
    menu.replaceChildren(...cands.slice(0, 10).map((c) => {
      const d = document.createElement("div");
      d.textContent = describe(c);
      d.title = c.url;
      d.addEventListener("click", () => send(c));
      return d;
    }));
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  });

  document.addEventListener("mouseover", (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (path.includes(host)) return;
    const video = path.find((n) => n instanceof HTMLVideoElement)
      || [...document.querySelectorAll("video")].find((v) => {
        const r = v.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      });
    if (video) show(video);
    else if (current && menu.style.display !== "block") hide();
  }, { passive: true, capture: true });

  addEventListener("scroll", () => { if (current) position(current); }, { passive: true, capture: true });
  addEventListener("resize", () => { if (current) position(current); }, { passive: true });

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "mdm-media") detected = msg.items || [];
  });
  api.runtime.sendMessage({ cmd: "get-media" }).then((r) => {
    detected = r?.items || [];
    enabled = r?.settings?.showVideoOverlay !== false;
  }).catch(() => { /* extension reloaded */ });
})();
