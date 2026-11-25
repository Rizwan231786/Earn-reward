// Storage: SQLite (built into Node 22.13+). Secrets live in their own tables;
// community content lives in the `state` table, one JSON document per collection.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.PATCH_DATA_DIR || 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const sql = new DatabaseSync(path.join(DATA_DIR, 'patch.db'));
sql.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS accounts (
    user_id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    pass_hash TEXT NOT NULL,
    recovery_hash TEXT NOT NULL,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    totp_last INTEGER NOT NULL DEFAULT -1,
    backup_codes TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    ua TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

export const COLLECTIONS = ['users', 'communities', 'posts', 'projects', 'tools', 'champ', 'notifications', 'messages', 'reports', 'settings', 'audit', 'playlists'];

export function emptyState() {
  return {
    users: [], communities: [], posts: [], projects: [], tools: [], notifications: [], messages: [], reports: [], audit: [], playlists: [],
    champ: { submissions: [], votes: [], winners: [], closed: [] },
    settings: { communityMinAgeDays: 3, toolApproval: true, announcement: '' },
  };
}

const lastSaved = {};
export function loadState() {
  const rows = sql.prepare('SELECT key, value FROM state').all();
  if (!rows.length) return null;
  const s = emptyState();
  for (const r of rows) { s[r.key] = JSON.parse(r.value); lastSaved[r.key] = r.value; }
  return s;
}

// Writes only the collections that changed, in one transaction.
export function saveState(s) {
  const up = sql.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const changed = [];
  for (const k of COLLECTIONS) {
    const v = JSON.stringify(s[k]);
    if (lastSaved[k] !== v) changed.push([k, v]);
  }
  if (!changed.length) return;
  sql.exec('BEGIN');
  try {
    for (const [k, v] of changed) up.run(k, v);
    sql.exec('COMMIT');
  } catch (e) {
    sql.exec('ROLLBACK');
    throw e;
  }
  for (const [k, v] of changed) lastSaved[k] = v;
}
