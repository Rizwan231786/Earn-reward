// Accounts, password hashing, sessions, TOTP two-factor auth and rate limiting.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { sql } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const uid = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

/* ---------- passwords ---------- */
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const key = await scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), 64, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    const expected = Buffer.from(hash, 'base64');
    return expected.length === key.length && crypto.timingSafeEqual(expected, key);
  } catch {
    return false;
  }
}
let dummyHash;
// Spend the same time on unknown usernames so attackers can't probe which accounts exist.
export async function dummyVerify(pw) {
  dummyHash ||= await hashPassword('patch-dummy-password');
  await verifyPassword(String(pw || ''), dummyHash);
  return false;
}
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', '11111111', '00000000', 'iloveyou', 'admin123', 'letmein1', 'welcome1', 'patch123', 'abcd1234', 'abc12345', 'football', 'baseball', 'sunshine', 'princess', 'dragon123', 'monkey123']);
export function passwordProblem(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 128) return 'Password is too long (max 128)';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common — pick something harder to guess';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain your username';
  if (new Set(pw).size < 5) return 'Password is too simple';
  return null;
}

/* ---------- base32 + TOTP (RFC 6238, works with Google Authenticator, Authy, 1Password…) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = ((val << 8) | b) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function b32decode(str) {
  const s = String(str).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('bad base32');
    val = ((val << 5) | i) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// Returns the matched time-step (so it can't be replayed) or null.
export function verifyTotp(secret, code, lastCounter = -1) {
  code = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code) || !secret) return null;
  const now = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const c = now + d;
    if (c <= lastCounter) continue;
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secret, c)), Buffer.from(code))) return c;
  }
  return null;
}
export const newTotpSecret = () => b32encode(crypto.randomBytes(20));
export const otpauthUrl = (secret, username, issuer = 'Patch') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

const codeChars = (n) => b32encode(crypto.randomBytes(n)).toLowerCase();
export function newBackupCodes() {
  const codes = Array.from({ length: 10 }, () => { const c = codeChars(6).slice(0, 8); return `${c.slice(0, 4)}-${c.slice(4)}`; });
  return { codes, hashes: codes.map((c) => sha256(c)) };
}
export function newRecoveryCode() {
  const c = b32encode(crypto.randomBytes(13)).slice(0, 20);
  const code = c.match(/.{5}/g).join('-');
  return { code, hash: sha256(normalizeCode(code)) };
}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ---------- accounts ---------- */
export const getAccount = (userId) => sql.prepare('SELECT * FROM accounts WHERE user_id = ?').get(userId);
export const getAccountByUsername = (username) => sql.prepare('SELECT * FROM accounts WHERE username = ?').get(String(username || '').toLowerCase());
export function insertAccount({ userId, username, passHash, recoveryHash }) {
  sql.prepare('INSERT INTO accounts (user_id, username, pass_hash, recovery_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, username.toLowerCase(), passHash, recoveryHash, Date.now());
}
export function updateAccount(userId, fields) {
  const keys = Object.keys(fields);
  sql.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`).run(...keys.map((k) => fields[k]), userId);
}
// Accepts a 6-digit TOTP code or an unused backup code. Records use so codes can't be replayed.
export function checkSecondFactor(acct, code) {
  const step = verifyTotp(acct.totp_secret, code, acct.totp_last);
  if (step !== null) { updateAccount(acct.user_id, { totp_last: step }); return true; }
  const h = sha256(String(code || '').trim().toLowerCase());
  const codes = JSON.parse(acct.backup_codes || '[]');
  const i = codes.indexOf(h);
  if (i >= 0) { codes.splice(i, 1); updateAccount(acct.user_id, { backup_codes: JSON.stringify(codes) }); return true; }
  return false;
}

/* ---------- sessions ---------- */
const SECURE = process.env.COOKIE_SECURE === '1';
export const SESSION = {
  app: { cookie: 'patch_sid', path: '/', ttl: 30 * 864e5, idle: 30 * 864e5 },
  admin: { cookie: 'patch_admin', path: '/api/admin', ttl: 8 * 3600e3, idle: 30 * 60e3 },
};
export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export const clientIp = (req) => (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
function cookie(name, value, { path, maxAge }) {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict${SECURE ? '; Secure' : ''}; Max-Age=${maxAge}`;
}
function appendCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), c]);
}
export function createSession(req, res, userId, kind) {
  const cfg = SESSION[kind], t = randomToken(), now = Date.now();
  sql.prepare('INSERT INTO sessions (token_hash, user_id, kind, created_at, last_seen, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(t), userId, kind, now, now, now + cfg.ttl, clientIp(req), String(req.headers['user-agent'] || '').slice(0, 200));
  appendCookie(res, cookie(cfg.cookie, t, { path: cfg.path, maxAge: Math.floor(cfg.ttl / 1000) }));
}
export function readSession(req, kind) {
  const cfg = SESSION[kind];
  const t = parseCookies(req)[cfg.cookie];
  if (!t || t.length > 100) return null;
  const h = sha256(t);
  const row = sql.prepare('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?').get(h, kind);
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now || now - row.last_seen > cfg.idle) {
    sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h);
    return null;
  }
  if (now - row.last_seen > 30e3) sql.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(now, h);
  return row;
}
export function destroySession(req, res, kind) {
  const cfg = SESSION[kind];
  const t = parseCookies(req)[cfg.cookie];
  if (t) sql.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(t));
  appendCookie(res, cookie(cfg.cookie, '', { path: cfg.path, maxAge: 0 }));
}
export const listSessions = (userId) => sql.prepare('SELECT token_hash, kind, created_at, last_seen, ip, ua FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(userId);
export const revokeAllSessions = (userId, exceptHash = '') => sql.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptHash);
export const revokeSessionById = (userId, idPrefix) => sql.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(token_hash, 1, 16) = ?").run(userId, String(idPrefix).slice(0, 16));
export function pruneSessions() { sql.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); }

/* ---------- rate limiting (in memory, per process) ---------- */
const buckets = new Map();
export function hit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
export const isLimited = (key, max) => { const b = buckets.get(key); return !!b && b.reset > Date.now() && b.n >= max; };
export const clearLimit = (key) => buckets.delete(key);
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60e3).unref();

/* ---------- short-lived login tickets for the 2FA step ---------- */
const tickets = new Map();
export function newTicket(data) {
  const t = randomToken(24);
  tickets.set(t, { ...data, exp: Date.now() + 5 * 60e3, tries: 0 });
  return t;
}
export function useTicket(t) {
  const d = tickets.get(String(t || ''));
  if (!d || d.exp < Date.now()) { tickets.delete(t); return null; }
  if (++d.tries > 5) { tickets.delete(t); return null; }
  return d;
}
export const dropTicket = (t) => tickets.delete(t);
setInterval(() => { const now = Date.now(); for (const [k, d] of tickets) if (d.exp < now) tickets.delete(k); }, 60e3).unref();
