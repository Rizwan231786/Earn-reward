// Pure, browser-independent logic shared by the background script. Unit-tested with `node --test`.

export const HOST_NAME = "com.mydownloadmanager.host";

export const DEFAULT_SETTINGS = Object.freeze({
  interceptDownloads: true,
  // Space-separated extensions to intercept. Empty = intercept every download above minSizeBytes.
  extensions: "zip rar 7z gz tar iso exe msi apk dmg pdf mp3 mp4 mkv webm avi mov flac m4a",
  minSizeBytes: 1024 * 1024,
  showVideoOverlay: true,
  excludedHosts: "",
});

const SEGMENT_EXTENSIONS = new Set(["ts", "m4s", "m4f", "m4a", "m4v", "aac", "cmfv", "cmfa", "vtt", "webvtt", "key"]);
const DIRECT_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "ogv", "ogg", "mp3", "flac", "wav", "m4v"]);

export function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Lower-case extension of a URL path or file name, without the dot ("" if none). */
export function extensionOf(nameOrUrl) {
  if (!nameOrUrl) return "";
  let path = nameOrUrl;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(nameOrUrl)) path = new URL(nameOrUrl).pathname;
  } catch { /* use as-is */ }
  path = path.split(/[\\/]/).pop() || "";
  const dot = path.lastIndexOf(".");
  return dot > 0 ? path.slice(dot + 1).toLowerCase() : "";
}

export function parseExtensionList(text) {
  return new Set(String(text || "").toLowerCase().split(/[\s,;]+/).map((e) => e.replace(/^\./, "")).filter(Boolean));
}

export function hostMatches(url, excludedHosts) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return String(excludedHosts || "").toLowerCase().split(/[\s,;]+/).filter(Boolean)
    .some((h) => host === h || host.endsWith("." + h));
}

/**
 * Decides whether a browser download should be handed to MyDownloadManager.
 * @param {{url:string, finalUrl?:string, filename?:string, fileSize?:number, totalBytes?:number, mime?:string, byExtensionId?:string}} item
 */
export function shouldIntercept(item, settings, ownExtensionId) {
  if (!settings.interceptDownloads) return false;
  if (item.byExtensionId && item.byExtensionId === ownExtensionId) return false;
  const url = item.finalUrl || item.url;
  if (!isHttpUrl(url)) return false; // blob:, data:, file: stay in the browser
  if (hostMatches(url, settings.excludedHosts)) return false;
  const size = Math.max(item.fileSize || 0, item.totalBytes || 0);
  const ext = extensionOf(item.filename) || extensionOf(url);
  const list = parseExtensionList(settings.extensions);
  if (list.size > 0 && !list.has(ext)) return false;
  // Unknown size (0/-1) is accepted when the extension matched explicitly.
  if (size > 0 && size < settings.minSizeBytes) return false;
  if (size <= 0 && list.size === 0) return false;
  return true;
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name && x.name.toLowerCase() === name);
  return h ? (h.value || "") : "";
}

/**
 * Classifies an observed network response as a downloadable media resource.
 * Returns null for non-media, media segments (parts of a stream) and partial range responses.
 * @returns {{url:string, kind:'hls'|'dash'|'direct', mime:string, size:number}|null}
 */
export function classifyResponse(details) {
  if (!isHttpUrl(details.url)) return null;
  if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 300)) return null;
  const mime = header(details.responseHeaders, "content-type").split(";")[0].trim().toLowerCase();
  const size = parseInt(header(details.responseHeaders, "content-length"), 10) || 0;
  const range = header(details.responseHeaders, "content-range");
  const ext = extensionOf(details.url);

  if (mime.includes("mpegurl") || ext === "m3u8") return { url: details.url, kind: "hls", mime, size };
  if (mime === "application/dash+xml" || ext === "mpd") return { url: details.url, kind: "dash", mime, size };
  if (SEGMENT_EXTENSIONS.has(ext) || mime === "video/mp2t" || mime === "video/iso.segment") return null;

  const isAv = mime.startsWith("video/") || mime.startsWith("audio/");
  if (!isAv && !DIRECT_EXTENSIONS.has(ext)) return null;
  if (isAv && mime === "audio/mp4" && !DIRECT_EXTENSIONS.has(ext)) return null; // likely a fragment
  // For ranged responses, the total size is after the slash.
  let total = size;
  const m = /\/(\d+)\s*$/.exec(range);
  if (m) total = parseInt(m[1], 10);
  if (total > 0 && total < 256 * 1024) return null; // UI sounds, previews, tracking pixels
  return { url: details.url, kind: "direct", mime, size: total };
}

/** Adds a media entry to a per-tab list (newest first, de-duplicated, capped). */
export function addMedia(list, entry, max = 30) {
  const key = normalizeForDedupe(entry.url);
  const rest = (list || []).filter((e) => normalizeForDedupe(e.url) !== key);
  return [{ ...entry, seenAt: Date.now() }, ...rest].slice(0, max);
}

function normalizeForDedupe(url) {
  try {
    const u = new URL(url);
    // Byte-range query parameters used by some players do not identify a different resource.
    for (const p of ["range", "rn", "rbuf", "bytestart", "byteend"]) u.searchParams.delete(p);
    return u.origin + u.pathname + "?" + u.searchParams.toString();
  } catch {
    return url;
  }
}

export function cookieHeader(cookies) {
  return (cookies || []).filter((c) => c && c.name).map((c) => `${c.name}=${c.value}`).join("; ");
}

export function buildDownloadMessage({ url, referrer, fileName, fileSize, mime, cookies, userAgent }) {
  return {
    type: "download",
    url,
    referrer: isHttpUrl(referrer) ? referrer : undefined,
    fileName: fileName ? fileName.split(/[\\/]/).pop() : undefined,
    fileSize: fileSize > 0 ? fileSize : undefined,
    mime: mime || undefined,
    cookies: cookies || undefined,
    userAgent: userAgent || undefined,
  };
}

export function buildMediaMessage({ url, kind, pageUrl, pageTitle, cookies, userAgent }) {
  return {
    type: "media",
    url,
    mediaKind: kind,
    referrer: isHttpUrl(pageUrl) ? pageUrl : undefined,
    pageUrl: isHttpUrl(pageUrl) ? pageUrl : undefined,
    pageTitle: pageTitle ? String(pageTitle).slice(0, 300) : undefined,
    cookies: cookies || undefined,
    userAgent: userAgent || undefined,
  };
}

/** Human-readable label for a detected media entry. */
export function describeMedia(entry) {
  const kind = entry.kind === "hls" ? "HLS stream" : entry.kind === "dash" ? "DASH stream" : (extensionOf(entry.url) || "media").toUpperCase();
  const size = entry.size > 0 ? ` · ${(entry.size / 1048576).toFixed(1)} MB` : "";
  let name = "";
  try { name = decodeURIComponent(new URL(entry.url).pathname.split("/").pop() || ""); } catch { /* ignore */ }
  return `${kind}${size}${name ? " · " + name : ""}`;
}
