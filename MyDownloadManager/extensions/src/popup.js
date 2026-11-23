import { DEFAULT_SETTINGS, describeMedia } from "./lib/core.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function settings() {
  const s = await api.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
}

async function save(patch) {
  await api.storage.local.set({ settings: { ...(await settings()), ...patch } });
}

async function init() {
  const s = await settings();
  $("intercept").checked = s.interceptDownloads;
  $("overlay").checked = s.showVideoOverlay;
  $("intercept").addEventListener("change", (e) => save({ interceptDownloads: e.target.checked }));
  $("overlay").addEventListener("change", (e) => save({ showVideoOverlay: e.target.checked }));
  $("options").addEventListener("click", (e) => { e.preventDefault(); api.runtime.openOptionsPage(); });
  $("help").addEventListener("click", (e) => {
    e.preventDefault();
    api.tabs.create({ url: api.runtime.getURL("options.html#troubleshooting") });
  });

  const ping = await api.runtime.sendMessage({ cmd: "ping" });
  const status = $("status");
  if (ping?.ok && ping.appRunning !== false) { status.textContent = "connected"; status.className = "pill ok"; }
  else if (ping?.ok) { status.textContent = "app not running"; status.className = "pill warn"; status.title = "It will start automatically when you download."; }
  else { status.textContent = "not connected"; status.className = "pill err"; status.title = ping?.error || ""; }

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const { items } = await api.runtime.sendMessage({ cmd: "get-media", tabId: tab?.id });
  if (items?.length) {
    const box = $("media");
    box.replaceChildren(...items.map((m) => {
      const row = document.createElement("div");
      row.className = "item";
      const text = document.createElement("span");
      text.textContent = describeMedia(m);
      text.title = m.url;
      const btn = document.createElement("button");
      btn.textContent = "Download";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const r = await api.runtime.sendMessage({ cmd: "download-media", item: m, tabId: tab.id });
        btn.textContent = r?.ok ? "Sent ✓" : "Failed";
        btn.title = r?.error || "";
      });
      row.append(text, btn);
      return row;
    }));
  }
}

init();
