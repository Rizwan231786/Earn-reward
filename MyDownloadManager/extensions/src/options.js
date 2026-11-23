import { DEFAULT_SETTINGS } from "./lib/core.js";

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function load() {
  const s = { ...DEFAULT_SETTINGS, ...((await api.storage.local.get("settings")).settings || {}) };
  $("interceptDownloads").checked = s.interceptDownloads;
  $("extensions").value = s.extensions;
  $("minSizeMb").value = (s.minSizeBytes / 1048576).toString();
  $("excludedHosts").value = s.excludedHosts;
  $("showVideoOverlay").checked = s.showVideoOverlay;
}

$("save").addEventListener("click", async () => {
  const mb = Math.max(0, parseFloat($("minSizeMb").value) || 0);
  await api.storage.local.set({
    settings: {
      interceptDownloads: $("interceptDownloads").checked,
      extensions: $("extensions").value.trim(),
      minSizeBytes: Math.round(mb * 1048576),
      excludedHosts: $("excludedHosts").value.trim(),
      showVideoOverlay: $("showVideoOverlay").checked,
    },
  });
  $("saved").textContent = "Saved.";
  setTimeout(() => { $("saved").textContent = ""; }, 2000);
});

load();
