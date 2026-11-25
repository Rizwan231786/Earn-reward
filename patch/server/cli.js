// Owner tools. Stop the server first — it keeps the community data in memory.
//   node server/cli.js create-admin <username>
//   node server/cli.js set-role <username> <admin|moderator|user>
//   node server/cli.js reset-password <username>
//   node server/cli.js reset-2fa <username>
import readline from 'node:readline';
import { loadState, saveState, emptyState } from './db.js';
import * as A from './auth.js';
import { COLORS, USERNAME_RE, ROLE_LABEL } from '../public/shared.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}
async function newPassword(username) {
  for (;;) {
    const pw = await askHidden('New password: ');
    const problem = A.passwordProblem(pw, username);
    if (problem) { console.log(`✗ ${problem}`); continue; }
    if ((await askHidden('Repeat password: ')) !== pw) { console.log('✗ Passwords do not match'); continue; }
    return pw;
  }
}
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const [cmd, rawName, extra] = process.argv.slice(2);
const username = String(rawName || '').toLowerCase();
const state = loadState() || emptyState();

if (cmd === 'create-admin') {
  if (!USERNAME_RE.test(username)) die('Usage: create-admin <username>  (3–20 lowercase letters, numbers or _)');
  if (A.getAccountByUsername(username) || state.users.some((u) => u.handle === username)) die('That username exists — use set-role instead');
  const pw = await newPassword(username);
  const recovery = A.newRecoveryCode();
  const id = A.uid();
  A.insertAccount({ userId: id, username, passHash: await A.hashPassword(pw), recoveryHash: recovery.hash });
  state.users.push({ id, name: username, handle: username, bio: 'Patch admin', skills: [], openToWork: false, isPublic: true, color: COLORS[state.users.length % COLORS.length], joinedAt: Date.now(), following: [], role: 'admin', banned: false, verified: true });
  saveState(state);
  console.log(`✓ Admin @${username} created.\n  Recovery code (save it somewhere safe, shown once): ${recovery.code}\n  Open /admin/ to sign in — you will set up two-factor on first login.`);
} else if (cmd === 'set-role') {
  const u = state.users.find((x) => x.handle === username) || die('No such user');
  if (!ROLE_LABEL[extra]) die('Role must be admin, moderator or user');
  u.role = extra; if (extra !== 'user') u.banned = false;
  saveState(state);
  A.revokeAllSessions(u.id);
  console.log(`✓ @${username} is now ${ROLE_LABEL[extra]} (logged out everywhere).`);
} else if (cmd === 'reset-password') {
  const acct = A.getAccountByUsername(username) || die('No such account');
  const pw = await newPassword(username);
  A.updateAccount(acct.user_id, { pass_hash: await A.hashPassword(pw) });
  A.revokeAllSessions(acct.user_id);
  console.log(`✓ Password reset for @${username} (logged out everywhere).`);
} else if (cmd === 'reset-2fa') {
  const acct = A.getAccountByUsername(username) || die('No such account');
  A.updateAccount(acct.user_id, { totp_enabled: 0, totp_secret: null, backup_codes: '[]' });
  A.revokeAllSessions(acct.user_id);
  console.log(`✓ Two-factor turned off for @${username}. Staff will be asked to set it up again at the next admin login.`);
} else {
  console.log('Commands:\n  create-admin <username>\n  set-role <username> <admin|moderator|user>\n  reset-password <username>\n  reset-2fa <username>');
}
