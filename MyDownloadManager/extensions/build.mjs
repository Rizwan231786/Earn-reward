// Builds the browser extensions without third-party dependencies:
//   dist/chromium/   unpacked extension for Chrome & Edge ("Load unpacked")
//   dist/firefox/    unpacked extension for Firefox
//   dist/MyDownloadManager-chromium.zip, dist/MyDownloadManager-firefox.zip (store / sideload packages)
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "src");
const dist = join(here, "dist");

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal ZIP writer (deflate), deterministic timestamps. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x5821, 12); // 2024-01-01
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x5821, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + compressed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const base = JSON.parse(readFileSync(join(here, "manifest.base.json"), "utf8"));
rmSync(dist, { recursive: true, force: true });
for (const target of ["chromium", "firefox"]) {
  const manifest = { ...base, ...JSON.parse(readFileSync(join(here, `manifest.${target}.json`), "utf8")) };
  const out = join(dist, target);
  const files = [];
  for (const file of walk(src)) {
    const rel = relative(src, file).split("\\").join("/");
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    copyFileSync(file, join(out, rel));
    files.push({ name: rel, data: readFileSync(file) });
  }
  const manifestJson = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(out, "manifest.json"), manifestJson);
  files.push({ name: "manifest.json", data: manifestJson });
  files.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(join(dist, `MyDownloadManager-${target}.zip`), zip(files));
  console.log(`built ${target}: ${files.length} files`);
}
