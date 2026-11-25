// Patch server: static files, JSON API, media uploads/streaming, share pages, admin API.
// Zero dependencies — needs Node.js 22.13 or newer (built-in SQLite).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { sql, loadState, saveState, emptyState, UPLOADS_DIR } from './db.js';
import * as A from './auth.js';
import { userActions, adminActions, HttpError, isStaff, isAdmin, autoCloseMonths } from './actions.js';
import { appState, adminState } from './view.js';
import { seedDemo } from './seed.js';
import { COLORS, LIMITS, USERNAME_RE, RESERVED_USERNAMES, POST_TYPES } from '../public/shared.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const SECURE = process.env.COOKIE_SECURE === '1';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

/* ---------- state ---------- */
let state = loadState();
if (!state) {
  if (process.env.SEED_DEMO === '1') {
    state = seedDemo();
    const pw = process.env.DEMO_PASSWORD || 'patch-demo-2026';
    const passHash = await A.hashPassword(pw);
    for (const u of state.users) A.insertAccount({ userId: u.id, username: u.handle, passHash, recoveryHash: A.newRecoveryCode().hash });
    console.log(`[patch] Seeded demo data. Demo accounts (${state.users.map((u) => u.handle).join(', ')}) use password: ${pw}`);
  } else {
    state = emptyState();
  }
  saveState(state);
}

function makeCtx(s, me) {
  const now = Date.now();
  return {
    s, me,
    notify(userId, text, link = '') {
      if (!userId || (me && userId === me.id) || !s.users.some((u) => u.id === userId)) return;
      s.notifications.unshift({ id: A.uid(), userId, text: String(text).slice(0, 300), link, read: false, createdAt: now });
    },
    audit(action, detail = '') { s.audit.unshift({ id: A.uid(), actorId: me?.id || null, action, detail: String(detail).slice(0, 200), createdAt: now }); },
    media: (id) => sql.prepare('SELECT * FROM media WHERE id = ?').get(String(id)),
  };
}
// Runs an action against a copy of the state, so a failed action changes nothing.
function mutate(fn, meId) {
  const draft = structuredClone(state);
  const me = meId ? draft.users.find((u) => u.id === meId) : null;
  const result = fn(makeCtx(draft, me), me);
  if (draft.notifications.length > 20000) draft.notifications.length = 20000;
  if (draft.audit.length > 5000) draft.audit.length = 5000;
  state = draft;
  saveState(state);
  return result;
}
function runAction(map, name, args, meId, { staff = false } = {}) {
  const entry = typeof name === 'string' && Object.hasOwn(map, name) ? map[name] : null;
  if (!entry) throw new HttpError(400, 'Unknown action');
  const fn = typeof entry === 'function' ? entry : entry.run;
  return mutate((ctx, me) => {
    if (!me) throw new HttpError(401, 'Please log in');
    if (staff) {
      if (!isStaff(me) || me.banned) throw new HttpError(403, 'Staff only');
      if (entry.admin && !isAdmin(me)) throw new HttpError(403, 'Admins only');
    } else if (me.banned && !entry.open) {
      throw new HttpError(403, 'Your account is suspended');
    }
    return fn(ctx, args && typeof args === 'object' && !Array.isArray(args) ? args : {}) ?? {};
  }, meId);
}

/* ---------- http helpers ---------- */
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req, max = 256 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw new HttpError(413, 'Request too large'); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
// CSRF defence: cookies are SameSite=Strict, and every write must carry our custom header from our own origin.
function checkWrite(req) {
  if (req.headers['x-patch'] !== '1') throw new HttpError(403, 'Missing request header');
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    let ok = false;
    try { ok = new URL(origin).host === host; } catch {}
    if (!ok) throw new HttpError(403, 'Cross-site request blocked');
  }
}
const limit = (key, max, windowMs, msg = 'Too many requests — please slow down') => { if (A.hit(key, max, windowMs)) throw new HttpError(429, msg); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortUa = (ua) => { ua = String(ua || ''); const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'; const o = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''; return o ? `${b} on ${o}` : b; };

function appUser(req) {
  const sess = A.readSession(req, 'app');
  if (!sess) return { sess: null, user: null };
  const user = state.users.find((u) => u.id === sess.user_id) || null;
  return { sess, user };
}
function staffUser(req) {
  const sess = A.readSession(req, 'admin');
  if (!sess) return null;
  const user = state.users.find((u) => u.id === sess.user_id);
  if (!user || !isStaff(user) || user.banned) { sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sess.token_hash); return null; }
  return user;
}

/* ---------- static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  if (pathname === '/admin') { res.writeHead(301, { Location: '/admin/' }); return res.end(); }
  let rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
  rel = path.normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, '');
  if (rel.split(/[/\\]/).some((seg) => seg.startsWith('.'))) return notFound(res);
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' };
    if (file.endsWith('.html')) headers['Content-Security-Policy'] = CSP;
    if (rel.startsWith('admin')) { headers['Cache-Control'] = 'no-store'; headers['X-Robots-Tag'] = 'noindex, nofollow'; }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }

/* ---------- media ---------- */
function sniff(b) {
  const ascii = (a, z) => b.subarray(a, z).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['image', 'image/jpeg'];
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ['image', 'image/png'];
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return ['image', 'image/gif'];
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return ['image', 'image/webp'];
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand === 'avif' || brand === 'avis') return ['image', 'image/avif'];
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand)) return null; // browsers can't show HEIC
    if (brand.startsWith('qt')) return ['video', 'video/quicktime'];
    return ['video', 'video/mp4'];
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return ['video', 'video/webm'];
  return null;
}
async function handleUpload(req, res, user) {
  if (!user) throw new HttpError(401, 'Please log in');
  if (user.banned) throw new HttpError(403, 'Your account is suspended');
  limit(`upload:${user.id}`, 60, 3600e3, 'Upload limit reached — try again later');
  const declared = Number(req.headers['content-length'] || 0);
  if (!declared) throw new HttpError(411, 'Missing file');
  if (declared > LIMITS.videoBytes) throw new HttpError(413, `File too large (max ${LIMITS.videoBytes / 1048576} MB)`);
  const id = A.uid(12);
  const tmp = path.join(UPLOADS_DIR, `${id}.part`);
  let size = 0;
  try {
    await pipeline(req, async function* (src) {
      for await (const chunk of src) { size += chunk.length; if (size > LIMITS.videoBytes) throw new HttpError(413, 'File too large'); yield chunk; }
    }, fs.createWriteStream(tmp, { flags: 'wx' }));
    const fd = fs.openSync(tmp, 'r'); const head = Buffer.alloc(32); fs.readSync(fd, head, 0, 32, 0); fs.closeSync(fd);
    const kind = sniff(head);
    if (!kind) throw new HttpError(415, 'Unsupported file. Use JPG, PNG, GIF, WebP, AVIF, MP4, WebM or MOV.');
    if (kind[0] === 'image' && size > LIMITS.imageBytes) throw new HttpError(413, `Images can be up to ${LIMITS.imageBytes / 1048576} MB`);
    fs.renameSync(tmp, path.join(UPLOADS_DIR, id));
    sql.prepare('INSERT INTO media (id, owner_id, kind, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, user.id, kind[0], kind[1], size, Date.now());
    json(res, 201, { id, kind: kind[0], mime: kind[1], url: `/media/${id}` });
  } catch (e) {
    fs.rm(tmp, { force: true }, () => {});
    throw e;
  }
}
function serveMedia(req, res, id) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) return notFound(res);
  const row = sql.prepare('SELECT * FROM media WHERE id = ?').get(id);
  if (!row) return notFound(res);
  const file = path.join(UPLOADS_DIR, id);
  let st; try { st = fs.statSync(file); } catch { return notFound(res); }
  const headers = { 'Content-Type': row.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-site' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
    end = Math.min(end, st.size - 1);
    if (!(start >= 0) || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
// Delete uploads that never made it into a post (after a day).
function cleanupMedia() {
  const used = new Set(state.posts.flatMap((p) => (p.media || []).map((m) => m.id)));
  const old = sql.prepare('SELECT id FROM media WHERE created_at < ?').all(Date.now() - 864e5);
  for (const { id } of old) if (!used.has(id)) { fs.rm(path.join(UPLOADS_DIR, id), { force: true }, () => {}); sql.prepare('DELETE FROM media WHERE id = ?').run(id); }
}

/* ---------- share pages (link previews for Discord, WhatsApp, X…) ---------- */
function sharePage(req, res, kind, id) {
  const origin = PUBLIC_URL || `${SECURE ? 'https' : 'http'}://${req.headers.host}`;
  let title = 'Patch', desc = 'A home for builders.', image = '', video = '', target = '/#/';
  if (kind === 'post') {
    const p = state.posts.find((x) => x.id === id);
    if (p) {
      const a = state.users.find((u) => u.id === p.authorId);
      title = p.title; desc = `${POST_TYPES[p.type]?.label || 'Post'} by ${a?.name || 'someone'} on Patch${p.body ? ' — ' + p.body.slice(0, 160) : ''}`;
      const img = (p.media || []).find((m) => m.kind === 'image'), vid = (p.media || []).find((m) => m.kind === 'video');
      if (img) image = `${origin}/media/${img.id}`;
      if (vid) video = `${origin}/media/${vid.id}`;
      target = `/#/post/${encodeURIComponent(p.id)}`;
    }
  } else if (kind === 'playlist') {
    const pl = state.playlists.find((x) => x.id === id && x.visibility !== 'private');
    if (pl) {
      const o = state.users.find((u) => u.id === pl.ownerId);
      title = `${pl.name} — playlist`; desc = `${pl.items.length} posts by ${o?.name || 'someone'} on Patch${pl.description ? ' — ' + pl.description.slice(0, 160) : ''}`;
      const first = pl.items.map((pid) => state.posts.find((p) => p.id === pid)).flatMap((p) => p?.media || []).find((m) => m.kind === 'image');
      if (first) image = `${origin}/media/${first.id}`;
      target = `/#/playlist/${encodeURIComponent(pl.id)}`;
    }
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta property="og:site_name" content="Patch"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(origin + req.url)}"><meta property="og:type" content="${video ? 'video.other' : 'website'}">
${image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
${video ? `<meta property="og:video" content="${esc(video)}">` : ''}
<meta http-equiv="refresh" content="0; url=${esc(target)}"></head>
<body><p><a href="${esc(target)}">Open on Patch →</a></p></body></html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Cache-Control': 'no-cache' });
  res.end(html);
}

/* ---------- auth handlers ---------- */
async function login(req, res, body, kind) {
  const ip = A.clientIp(req);
  const username = String(body.username || '').trim().toLowerCase().slice(0, 40);
  limit(`login-ip:${ip}`, 30, 15 * 60e3, 'Too many login attempts — wait 15 minutes');
  if (A.isLimited(`login-user:${username}`, 8)) throw new HttpError(429, 'This account is temporarily locked after failed attempts — wait 15 minutes');
  const acct = A.getAccountByUsername(username);
  const ok = acct ? await A.verifyPassword(String(body.password || ''), acct.pass_hash) : await A.dummyVerify(body.password);
  if (!ok) { A.hit(`login-user:${username}`, 8, 15 * 60e3); throw new HttpError(401, 'Wrong username or password'); }
  const user = state.users.find((u) => u.id === acct.user_id);
  if (!user) throw new HttpError(401, 'Wrong username or password');
  if (kind === 'admin' && (!isStaff(user) || user.banned)) throw new HttpError(403, 'This account does not have admin access');
  A.clearLimit(`login-user:${username}`);
  if (acct.totp_enabled) return json(res, 200, { need2fa: true, ticket: A.newTicket({ userId: user.id, kind }) });
  if (kind === 'admin') {
    // Staff must turn on two-factor before the admin panel opens.
    const secret = A.newTotpSecret();
    return json(res, 200, { setup2fa: true, ticket: A.newTicket({ userId: user.id, kind, secret }), secret, otpauth: A.otpauthUrl(secret, `${acct.username} (admin)`) });
  }
  finishLogin(req, res, user, kind);
}
function finishLogin(req, res, user, kind, extra = {}) {
  A.createSession(req, res, user.id, kind);
  mutate((ctx) => ctx.notify(user.id, `🔐 New ${kind === 'admin' ? 'admin panel ' : ''}login from ${shortUa(req.headers['user-agent'])}. Not you? Change your password in Settings.`, '#/settings'), null);
  json(res, 200, { ok: true, ...extra });
}
async function login2fa(req, res, body, kind) {
  const t = A.useTicket(body.ticket);
  if (!t || t.kind !== kind) throw new HttpError(401, 'Login expired — start again');
  const user = state.users.find((u) => u.id === t.userId);
  const acct = A.getAccount(t.userId);
  if (!user || !acct) throw new HttpError(401, 'Login expired — start again');
  if (t.secret) {
    // First-time admin 2FA setup
    if (A.verifyTotp(t.secret, body.code) === null) throw new HttpError(401, 'That code is not right — check your authenticator app');
    const backup = A.newBackupCodes();
    A.updateAccount(user.id, { totp_secret: t.secret, totp_enabled: 1, totp_last: Math.floor(Date.now() / 30000), backup_codes: JSON.stringify(backup.hashes) });
    A.dropTicket(body.ticket);
    return finishLogin(req, res, user, kind, { backupCodes: backup.codes });
  }
  if (!A.checkSecondFactor(acct, body.code)) throw new HttpError(401, 'That code is not right');
  A.dropTicket(body.ticket);
  finishLogin(req, res, user, kind);
}

/* ---------- router ---------- */
async function handleApi(req, res, url) {
  const p = url.pathname, m = req.method;
  if (m !== 'GET' && m !== 'HEAD') checkWrite(req);

  // ----- admin API (separate session cookie, scoped to /api/admin) -----
  if (p.startsWith('/api/admin/')) {
    if (p === '/api/admin/login' && m === 'POST') return login(req, res, await readJson(req), 'admin');
    if (p === '/api/admin/login/2fa' && m === 'POST') return login2fa(req, res, await readJson(req), 'admin');
    if (p === '/api/admin/logout' && m === 'POST') { A.destroySession(req, res, 'admin'); return json(res, 200, { ok: true }); }
    const staff = staffUser(req);
    if (!staff) return json(res, 401, { error: 'Admin login required' });
    const security = () => {
      const out = {};
      for (const r of sql.prepare('SELECT user_id, totp_enabled FROM accounts').all()) out[r.user_id] = { totp: !!r.totp_enabled, sessions: 0 };
      for (const r of sql.prepare("SELECT user_id, COUNT(*) AS n FROM sessions WHERE kind = 'app' GROUP BY user_id").all()) (out[r.user_id] ||= {}).sessions = r.n;
      return out;
    };
    if (p === '/api/admin/state' && m === 'GET') return json(res, 200, adminState(state, staff, security()));
    if (p === '/api/admin/action' && m === 'POST') {
      limit(`admin-act:${staff.id}`, 300, 60e3);
      const { name, args } = await readJson(req);
      if (name === 'revokeSessions') {
        if (!isAdmin(staff)) throw new HttpError(403, 'Admins only');
        const target = state.users.find((u) => u.id === args?.userId);
        if (!target) throw new HttpError(404, 'User not found');
        A.revokeAllSessions(target.id);
        mutate((ctx) => ctx.audit('logged out everywhere', '@' + target.handle), staff.id);
        return json(res, 200, { ok: true, state: adminState(state, staff, security()) });
      }
      const result = runAction(adminActions, name, args, staff.id, { staff: true });
      return json(res, 200, { ok: true, result, state: adminState(state, state.users.find((u) => u.id === staff.id), security()) });
    }
    return json(res, 404, { error: 'Not found' });
  }

  const { sess, user } = appUser(req);
  if (p === '/api/state' && m === 'GET') return json(res, 200, appState(state, user));

  if (p === '/api/auth/signup' && m === 'POST') {
    limit(`signup:${A.clientIp(req)}`, 5, 3600e3, 'Too many new accounts from this network — try again later');
    const b = await readJson(req);
    const username = String(b.username || '').trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username: 3–20 lowercase letters, numbers or _');
    if (RESERVED_USERNAMES.includes(username)) throw new HttpError(400, 'That username is reserved');
    if (A.getAccountByUsername(username) || state.users.some((u) => u.handle === username)) throw new HttpError(409, 'That username is taken');
    const name = String(b.name || '').trim().slice(0, 50) || username;
    const problem = A.passwordProblem(b.password, username);
    if (problem) throw new HttpError(400, problem);
    const recovery = A.newRecoveryCode();
    const userId = A.uid();
    A.insertAccount({ userId, username, passHash: await A.hashPassword(b.password), recoveryHash: recovery.hash });
    mutate((ctx) => { ctx.s.users.push({ id: userId, name, handle: username, bio: 'New to Patch 👋', skills: [], openToWork: false, isPublic: true, color: COLORS[ctx.s.users.length % COLORS.length], joinedAt: Date.now(), following: [], role: 'user', banned: false, verified: false }); }, null);
    A.createSession(req, res, userId, 'app');
    return json(res, 201, { ok: true, recoveryCode: recovery.code });
  }
  if (p === '/api/auth/login' && m === 'POST') return login(req, res, await readJson(req), 'app');
  if (p === '/api/auth/login/2fa' && m === 'POST') return login2fa(req, res, await readJson(req), 'app');
  if (p === '/api/auth/logout' && m === 'POST') { A.destroySession(req, res, 'app'); return json(res, 200, { ok: true }); }
  if (p === '/api/auth/recover' && m === 'POST') {
    limit(`recover:${A.clientIp(req)}`, 10, 3600e3, 'Too many recovery attempts — try again later');
    const b = await readJson(req);
    const acct = A.getAccountByUsername(b.username);
    const ok = !!acct && acct.recovery_hash === A.sha256(A.normalizeCode(b.recoveryCode));
    if (!ok) throw new HttpError(401, 'Username or recovery code is wrong');
    const problem = A.passwordProblem(b.newPassword, acct.username);
    if (problem) throw new HttpError(400, problem);
    const fresh = A.newRecoveryCode();
    A.updateAccount(acct.user_id, { pass_hash: await A.hashPassword(b.newPassword), recovery_hash: fresh.hash });
    A.revokeAllSessions(acct.user_id);
    mutate((ctx) => ctx.notify(acct.user_id, '🔐 Your password was reset with your recovery code. All devices were logged out.', '#/settings'), null);
    return json(res, 200, { ok: true, recoveryCode: fresh.code });
  }
  if (p.startsWith('/api/playlists/') && m === 'GET') {
    const pl = state.playlists.find((x) => x.id === decodeURIComponent(p.slice('/api/playlists/'.length)));
    if (!pl || (pl.visibility === 'private' && pl.ownerId !== user?.id)) return json(res, 404, { error: 'Playlist not found' });
    return json(res, 200, { playlist: pl });
  }

  // ----- everything below needs a logged-in member -----
  if (!user) return json(res, 401, { error: 'Please log in' });
  if (p === '/api/media' && m === 'PUT') return handleUpload(req, res, user);
  if (p === '/api/action' && m === 'POST') {
    limit(`act:${user.id}`, 120, 60e3);
    const { name, args } = await readJson(req);
    if (name === 'report') limit(`report:${user.id}`, 20, 3600e3, 'Report limit reached');
    if (name === 'sendMessage') limit(`dm:${user.id}`, 30, 60e3, 'You are sending messages too fast');
    if (name === 'createPost' || name === 'comment') limit(`write:${user.id}`, 30, 600e3, 'You are posting too fast');
    const result = runAction(userActions, name, args, user.id);
    return json(res, 200, { ok: true, result, state: appState(state, state.users.find((u) => u.id === user.id)) });
  }

  // ----- account security -----
  const acct = A.getAccount(user.id);
  const needPassword = async (pw) => { limit(`pw:${user.id}`, 10, 15 * 60e3); if (!(await A.verifyPassword(String(pw || ''), acct.pass_hash))) throw new HttpError(401, 'Current password is wrong'); };
  if (p === '/api/account' && m === 'GET') {
    return json(res, 200, {
      username: acct.username, twoFactor: !!acct.totp_enabled, backupCodesLeft: JSON.parse(acct.backup_codes).length,
      sessions: A.listSessions(user.id).map((x) => ({ id: x.token_hash.slice(0, 16), kind: x.kind, device: shortUa(x.ua), ip: x.ip, createdAt: x.created_at, lastSeen: x.last_seen, current: x.token_hash === sess.token_hash })),
    });
  }
  if (p === '/api/account/password' && m === 'POST') {
    const b = await readJson(req);
    await needPassword(b.current);
    const problem = A.passwordProblem(b.next, acct.username);
    if (problem) throw new HttpError(400, problem);
    A.updateAccount(user.id, { pass_hash: await A.hashPassword(b.next) });
    A.revokeAllSessions(user.id, sess.token_hash);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/account/recovery' && m === 'POST') {
    const b = await readJson(req);
    await needPassword(b.password);
    const fresh = A.newRecoveryCode();
    A.updateAccount(user.id, { recovery_hash: fresh.hash });
    return json(res, 200, { recoveryCode: fresh.code });
  }
  if (p === '/api/account/2fa/setup' && m === 'POST') {
    const b = await readJson(req);
    await needPassword(b.password);
    if (acct.totp_enabled) throw new HttpError(400, 'Two-factor is already on');
    const secret = A.newTotpSecret();
    A.updateAccount(user.id, { totp_secret: secret });
    return json(res, 200, { secret, otpauth: A.otpauthUrl(secret, acct.username) });
  }
  if (p === '/api/account/2fa/enable' && m === 'POST') {
    const b = await readJson(req);
    limit(`2fa:${user.id}`, 10, 15 * 60e3);
    if (acct.totp_enabled || !acct.totp_secret) throw new HttpError(400, 'Start the setup first');
    const step = A.verifyTotp(acct.totp_secret, b.code);
    if (step === null) throw new HttpError(400, 'That code is not right — check your authenticator app');
    const backup = A.newBackupCodes();
    A.updateAccount(user.id, { totp_enabled: 1, totp_last: step, backup_codes: JSON.stringify(backup.hashes) });
    return json(res, 200, { backupCodes: backup.codes });
  }
  if (p === '/api/account/2fa/disable' && m === 'POST') {
    const b = await readJson(req);
    await needPassword(b.password);
    if (isStaff(user)) throw new HttpError(400, 'Staff accounts must keep two-factor on');
    if (!acct.totp_enabled) throw new HttpError(400, 'Two-factor is already off');
    if (!A.checkSecondFactor(acct, b.code)) throw new HttpError(401, 'That code is not right');
    A.updateAccount(user.id, { totp_enabled: 0, totp_secret: null, backup_codes: '[]' });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/account/sessions/revoke' && m === 'POST') {
    const b = await readJson(req);
    if (b.all) A.revokeAllSessions(user.id, sess.token_hash);
    else A.revokeSessionById(user.id, String(b.id || ''));
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  baseHeaders(res);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const media = /^\/media\/([^/]+)$/.exec(url.pathname);
    if (media) return serveMedia(req, res, media[1]);
    const share = /^\/s\/(post|playlist)\/([^/]+)$/.exec(url.pathname);
    if (share) return sharePage(req, res, share[1], decodeURIComponent(share[2]));
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong' : e.message });
    else res.end();
  }
});

function housekeeping() {
  try {
    if (autoCloseMonths(makeCtx(structuredClone(state), null))) mutate((ctx) => autoCloseMonths(ctx), null);
    A.pruneSessions();
    cleanupMedia();
  } catch (e) { console.error('[patch] housekeeping failed', e); }
}
housekeeping();
setInterval(housekeeping, 3600e3).unref();

server.listen(PORT, HOST, () => {
  console.log(`[patch] running at http://${HOST}:${PORT}  (admin panel: /admin/)`);
  if (!state.users.some((u) => u.role === 'admin')) console.log('[patch] No admin yet. Create one with:  npm run create-admin');
});
