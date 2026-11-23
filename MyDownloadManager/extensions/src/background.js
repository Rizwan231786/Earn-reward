// MyDownloadManager browser integration — background (MV3 service worker on Chromium, event page on Firefox).
import {
  HOST_NAME, DEFAULT_SETTINGS, shouldIntercept, classifyResponse, addMedia, cookieHeader,
  buildDownloadMessage, buildMediaMessage, isHttpUrl,
} from "./lib/core.js";

const api = globalThis.browser ?? globalThis.chrome;

// ---------------------------------------------------------------- settings

async function getSettings() {
  const stored = await api.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

// ---------------------------------------------------------------- native messaging

async function sendNative(message) {
  try {
    const reply = await api.runtime.sendNativeMessage(HOST_NAME, message);
    return reply || { ok: false, error: "No reply from MyDownloadManager." };
  } catch (e) {
    return { ok: false, error: `Native host unavailable: ${e && e.message ? e.message : e}. Is MyDownloadManager installed?`, hostMissing: true };
  }
}

async function cookiesFor(url) {
  if (!isHttpUrl(url) || !api.cookies) return "";
  try {
    const list = await api.cookies.getAll({ url });
    return cookieHeader(list);
  } catch {
    return ""; // no host permission for this site
  }
}

// ---------------------------------------------------------------- download interception

const handled = new Set();

api.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (handled.has(item.id) || !shouldIntercept(item, settings, api.runtime.id)) return;
  handled.add(item.id);
  const url = item.finalUrl || item.url;
  // Pause first so the browser does not race us; only cancel once the app has accepted the download.
  try { await api.downloads.pause(item.id); } catch { /* may already be complete or not pausable */ }
  const reply = await sendNative(buildDownloadMessage({
    url,
    referrer: item.referrer,
    fileName: item.filename,
    fileSize: item.fileSize || item.totalBytes,
    mime: item.mime,
    cookies: await cookiesFor(url),
    userAgent: navigator.userAgent,
  }));
  if (reply.ok) {
    try { await api.downloads.cancel(item.id); } catch { /* ignore */ }
    try { await api.downloads.erase({ id: item.id }); } catch { /* ignore */ }
  } else {
    try { await api.downloads.resume(item.id); } catch { /* ignore */ }
    console.warn("MyDownloadManager did not take the download:", reply.error);
  }
  setTimeout(() => handled.delete(item.id), 60_000);
});

// ---------------------------------------------------------------- media detection

const memoryMedia = new Map(); // fallback when storage.session is unavailable

async function getTabMedia(tabId) {
  if (api.storage.session) {
    const key = `media:${tabId}`;
    const v = await api.storage.session.get(key);
    return v[key] || [];
  }
  return memoryMedia.get(tabId) || [];
}

async function setTabMedia(tabId, list) {
  if (api.storage.session) await api.storage.session.set({ [`media:${tabId}`]: list });
  else memoryMedia.set(tabId, list);
  const text = list.length ? String(list.length) : "";
  try {
    await api.action.setBadgeText({ tabId, text });
    await api.action.setBadgeBackgroundColor({ tabId, color: "#1f6feb" });
  } catch { /* tab gone */ }
}

async function clearTabMedia(tabId) {
  if (api.storage.session) await api.storage.session.remove(`media:${tabId}`);
  memoryMedia.delete(tabId);
}

api.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const media = classifyResponse(details);
    if (!media) return;
    (async () => {
      const list = addMedia(await getTabMedia(details.tabId), media);
      await setTabMedia(details.tabId, list);
      try { await api.tabs.sendMessage(details.tabId, { type: "mdm-media", items: list }); } catch { /* no content script */ }
    })();
  },
  { urls: ["http://*/*", "https://*/*"], types: ["media", "xmlhttprequest", "other", "object"] },
  ["responseHeaders"],
);

api.tabs.onRemoved.addListener((tabId) => { clearTabMedia(tabId); });
api.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading" && info.url) setTabMedia(tabId, []);
});

// ---------------------------------------------------------------- context menus

function createMenus() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({ id: "mdm-link", title: "Download with MyDownloadManager", contexts: ["link"] });
    api.contextMenus.create({ id: "mdm-media", title: "Download media with MyDownloadManager", contexts: ["video", "audio"] });
    api.contextMenus.create({ id: "mdm-all", title: "Download all links with MyDownloadManager", contexts: ["page"] });
  });
}
api.runtime.onInstalled.addListener(createMenus);
api.runtime.onStartup?.addListener(createMenus);

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "mdm-link" && isHttpUrl(info.linkUrl)) {
    await sendNative(buildDownloadMessage({
      url: info.linkUrl, referrer: info.pageUrl, cookies: await cookiesFor(info.linkUrl), userAgent: navigator.userAgent,
    }));
  } else if (info.menuItemId === "mdm-media") {
    if (isHttpUrl(info.srcUrl)) {
      await downloadMedia({ url: info.srcUrl, kind: "direct" }, tab);
    } else {
      // blob:/MediaSource playback: use the most recent stream manifest seen on this tab.
      const list = await getTabMedia(tab.id);
      const best = list.find((m) => m.kind === "hls" || m.kind === "dash") || list[0];
      if (best) await downloadMedia(best, tab);
    }
  } else if (info.menuItemId === "mdm-all" && tab?.id >= 0) {
    const [res] = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Array.from(document.links, (a) => a.href),
    });
    const urls = [...new Set((res?.result || []).filter((u) => /^https?:/i.test(u)))].slice(0, 2000);
    if (urls.length) await sendNative({ type: "batch", urls, referrer: tab.url });
  }
});

async function downloadMedia(entry, tab) {
  return sendNative(buildMediaMessage({
    url: entry.url, kind: entry.kind, pageUrl: tab?.url, pageTitle: tab?.title,
    cookies: await cookiesFor(entry.url), userAgent: navigator.userAgent,
  }));
}

// ---------------------------------------------------------------- messages from content script & popup

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.cmd) {
      case "get-media": {
        const tabId = msg.tabId ?? sender.tab?.id;
        sendResponse({ items: tabId >= 0 ? await getTabMedia(tabId) : [], settings: await getSettings() });
        break;
      }
      case "download-media": {
        const tab = sender.tab ?? (msg.tabId >= 0 ? await api.tabs.get(msg.tabId) : undefined);
        if (!msg.item || !isHttpUrl(msg.item.url)) { sendResponse({ ok: false, error: "Not a downloadable URL." }); break; }
        sendResponse(await downloadMedia(msg.item, tab));
        break;
      }
      case "ping":
        sendResponse(await sendNative({ type: "ping" }));
        break;
      default:
        sendResponse({ ok: false, error: "Unknown command." });
    }
  })();
  return true; // async response
});
