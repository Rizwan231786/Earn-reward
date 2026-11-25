import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  shouldIntercept, classifyResponse, addMedia, cookieHeader, extensionOf, buildDownloadMessage,
  buildMediaMessage, DEFAULT_SETTINGS, isHttpUrl, hostMatches, describeMedia,
} from "../src/lib/core.js";

const S = { ...DEFAULT_SETTINGS };
const H = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

test("extensionOf handles URLs, queries and file names", () => {
  assert.equal(extensionOf("https://x.com/a/b/File.ZIP?x=1#y"), "zip");
  assert.equal(extensionOf("C:\\Users\\me\\Downloads\\setup.exe"), "exe");
  assert.equal(extensionOf("https://x.com/download"), "");
  assert.equal(extensionOf(".bashrc"), "");
});

test("isHttpUrl only accepts http(s)", () => {
  assert.ok(isHttpUrl("https://a.com"));
  for (const u of ["blob:https://a.com/1", "data:text/plain,x", "file:///c:/x", "javascript:alert(1)", "nonsense"]) assert.ok(!isHttpUrl(u), u);
});

test("shouldIntercept respects type list, size, scheme, exclusions and self-originated downloads", () => {
  assert.ok(shouldIntercept({ url: "https://x.com/f.zip", fileSize: 5e6 }, S, "me"));
  assert.ok(shouldIntercept({ url: "https://x.com/get?id=1", filename: "C:\\dl\\movie.mkv", fileSize: -1 }, S, "me"));
  assert.ok(!shouldIntercept({ url: "https://x.com/f.zip", fileSize: 1000 }, S, "me"), "too small");
  assert.ok(!shouldIntercept({ url: "https://x.com/page.html", fileSize: 5e6 }, S, "me"), "type not listed");
  assert.ok(!shouldIntercept({ url: "blob:https://x.com/123", filename: "a.zip", fileSize: 5e6 }, S, "me"));
  assert.ok(!shouldIntercept({ url: "https://x.com/f.zip", fileSize: 5e6, byExtensionId: "me" }, S, "me"));
  assert.ok(!shouldIntercept({ url: "https://x.com/f.zip", fileSize: 5e6 }, { ...S, interceptDownloads: false }, "me"));
  assert.ok(!shouldIntercept({ url: "https://cdn.intra.net/f.zip", fileSize: 5e6 }, { ...S, excludedHosts: "intra.net" }, "me"));
  assert.ok(shouldIntercept({ url: "https://x.com/f.bin", fileSize: 5e6 }, { ...S, extensions: "" }, "me"), "empty list = all types");
  assert.ok(!shouldIntercept({ url: "https://x.com/f.bin", fileSize: 0 }, { ...S, extensions: "" }, "me"), "unknown size + all types");
});

test("hostMatches matches subdomains only on label boundaries", () => {
  assert.ok(hostMatches("https://a.example.com/x", "example.com"));
  assert.ok(!hostMatches("https://notexample.com/x", "example.com"));
});

test("classifyResponse detects HLS, DASH and direct media; ignores segments and small files", () => {
  assert.equal(classifyResponse({ url: "https://v.com/master.m3u8", statusCode: 200, responseHeaders: [] }).kind, "hls");
  assert.equal(classifyResponse({ url: "https://v.com/api/s", statusCode: 200, responseHeaders: H({ "Content-Type": "application/vnd.apple.mpegurl" }) }).kind, "hls");
  assert.equal(classifyResponse({ url: "https://v.com/m.mpd", statusCode: 200, responseHeaders: H({ "content-type": "application/dash+xml" }) }).kind, "dash");
  const mp4 = classifyResponse({ url: "https://v.com/clip.mp4", statusCode: 206, responseHeaders: H({ "Content-Type": "video/mp4", "Content-Length": "65536", "Content-Range": "bytes 0-65535/52428800" }) });
  assert.equal(mp4.kind, "direct");
  assert.equal(mp4.size, 52428800);
  assert.equal(classifyResponse({ url: "https://v.com/seg_001.ts", statusCode: 200, responseHeaders: H({ "Content-Type": "video/mp2t" }) }), null);
  assert.equal(classifyResponse({ url: "https://v.com/chunk-5.m4s", statusCode: 200, responseHeaders: H({ "Content-Type": "video/mp4" }) }), null);
  assert.equal(classifyResponse({ url: "https://v.com/click.mp3", statusCode: 200, responseHeaders: H({ "Content-Type": "audio/mpeg", "Content-Length": "2000" }) }), null);
  assert.equal(classifyResponse({ url: "https://v.com/page", statusCode: 200, responseHeaders: H({ "Content-Type": "text/html" }) }), null);
  assert.equal(classifyResponse({ url: "https://v.com/x.m3u8", statusCode: 404, responseHeaders: [] }), null);
});

test("addMedia de-duplicates (ignoring byte-range params) and caps the list", () => {
  let list = [];
  list = addMedia(list, { url: "https://v.com/a.mp4?range=0-100", kind: "direct" });
  list = addMedia(list, { url: "https://v.com/a.mp4?range=100-200", kind: "direct" });
  assert.equal(list.length, 1);
  for (let i = 0; i < 50; i++) list = addMedia(list, { url: `https://v.com/${i}.m3u8`, kind: "hls" });
  assert.equal(list.length, 30);
  assert.equal(list[0].url, "https://v.com/49.m3u8");
});

test("cookieHeader and messages", () => {
  assert.equal(cookieHeader([{ name: "a", value: "1" }, { name: "b", value: "2" }]), "a=1; b=2");
  const d = buildDownloadMessage({ url: "https://x.com/f.zip", referrer: "javascript:x", fileName: "C:\\dl\\f.zip", fileSize: -1 });
  assert.deepEqual(d, { type: "download", url: "https://x.com/f.zip", referrer: undefined, fileName: "f.zip", fileSize: undefined, mime: undefined, cookies: undefined, userAgent: undefined });
  const m = buildMediaMessage({ url: "https://x.com/m.m3u8", kind: "hls", pageUrl: "https://x.com/watch", pageTitle: "T".repeat(1000) });
  assert.equal(m.type, "media");
  assert.equal(m.mediaKind, "hls");
  assert.equal(m.pageTitle.length, 300);
  assert.match(describeMedia({ url: "https://x.com/m.m3u8", kind: "hls" }), /HLS stream/);
});

test("manifests are valid and consistent", () => {
  const base = JSON.parse(readFileSync(new URL("../manifest.base.json", import.meta.url)));
  const chromium = JSON.parse(readFileSync(new URL("../manifest.chromium.json", import.meta.url)));
  const firefox = JSON.parse(readFileSync(new URL("../manifest.firefox.json", import.meta.url)));
  assert.equal(base.manifest_version, 3);
  assert.ok(base.permissions.includes("nativeMessaging"));
  assert.ok(chromium.key.length > 300);
  assert.equal(chromium.background.service_worker, "background.js");
  assert.equal(firefox.browser_specific_settings.gecko.id, "mydownloadmanager@mydownloadmanager.app");
});
