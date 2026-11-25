/* Patch admin panel — separate login (password + mandatory 2FA) and separate session. */
import { CHAMP_CATEGORIES, POST_TYPES, ROLE_LABEL, PLAYLIST_VISIBILITY, monthKey, monthLabel, shortMonth } from '/shared.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w, pl = w + 's') => `${n} ${n === 1 ? w : pl}`;
function ago(t) {
  const s = Math.max(1, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
async function api(path, body) {
  const res = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: { 'X-Patch': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }
function modal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; setTimeout(() => $('#modal input, #modal textarea')?.focus(), 0); }
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

/* ---------- login ---------- */
function loginScreen(step = { kind: 'password' }) {
  $('#adminUser').innerHTML = '<a class="btn btn-sm" href="/">← Back to Patch</a>';
  let body;
  if (step.kind === 'password') {
    body = `<h1>Staff sign-in</h1><p class="small muted">This panel is separate from the main site. Use your Patch username and password — two-factor is required.</p>
      <form id="lf"><div class="field"><label for="l-u">Username</label><input id="l-u" name="username" type="text" autocomplete="username" autocapitalize="none" required></div>
      <div class="field"><label for="l-p">Password</label><input id="l-p" name="password" type="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary" style="width:100%">Continue</button></form>`;
  } else if (step.kind === 'code') {
    body = `<h1>Two-factor check</h1><p class="small muted">Enter the 6-digit code from your authenticator app, or a backup code.</p>
      <form id="lf"><div class="field"><input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="9" required aria-label="Code"></div><button class="btn btn-primary" style="width:100%">Verify</button></form>`;
  } else {
    body = `<h1>Set up two-factor</h1><p class="small muted">Staff accounts must use an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator).</p>
      <ol class="small"><li>In your app, add an account → “enter a setup key”.</li><li>Type this key:</li></ol>
      <div class="secret-box mono">${esc(step.secret.match(/.{1,4}/g).join(' '))}</div>
      <p class="small"><a class="link" href="${esc(step.otpauth)}">Or open it in your authenticator app</a></p>
      <form id="lf"><div class="field"><label for="l-c">6-digit code from the app</label><input id="l-c" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div><button class="btn btn-primary" style="width:100%">Turn on 2FA & sign in</button></form>`;
  }
  $('#admin').innerHTML = `<div class="card admin-login">${body}</div>`;
  const f = $('#lf'); f.querySelector('input').focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button'); btn.disabled = true;
    try {
      if (step.kind === 'password') {
        const r = await api('/api/admin/login', { username: f.username.value, password: f.password.value });
        if (r.need2fa) return loginScreen({ kind: 'code', ticket: r.ticket });
        if (r.setup2fa) return loginScreen({ kind: 'setup', ticket: r.ticket, secret: r.secret, otpauth: r.otpauth });
      } else {
        const r = await api('/api/admin/login/2fa', { ticket: step.ticket, code: f.code.value });
        if (r.backupCodes) {
          modal(`<h2>2FA is on ✓</h2><p class="small muted">Save these backup codes somewhere safe. Each works once if you lose your phone.</p><div class="secret-box mono">${r.backupCodes.map(esc).join('<br>')}</div><button class="btn btn-primary" style="margin-top:12px" id="ok">I saved them</button>`);
          $('#ok').onclick = closeModal;
        }
        await load();
      }
    } catch (err) {
      toast(err.message); btn.disabled = false;
      if (/expired/i.test(err.message)) loginScreen();
    }
  };
}

/* ---------- data ---------- */
let S = null;
const me = () => S.users.find((u) => u.id === S.me.id);
const isAdmin = () => S.me.role === 'admin';
const user = (id) => S.users.find((u) => u.id === id);
const post = (id) => S.posts.find((p) => p.id === id);
const project = (id) => S.projects.find((p) => p.id === id);
const community = (id) => S.communities.find((c) => c.id === id);
const catName = (id) => CHAMP_CATEGORIES.find((c) => c.id === id)?.name || id;
const catIcon = (id) => CHAMP_CATEGORIES.find((c) => c.id === id)?.icon || '🏆';
const userLink = (u) => (u ? `<a class="link" href="/#/u/${esc(u.handle)}" target="_blank" rel="noopener">${esc(u.name)}</a> <span class="muted small">@${esc(u.handle)}</span>` : '<span class="muted">deleted</span>');
const avatar = (u) => (u ? `<span class="avatar sm" style="background:${esc(u.color)}">${esc(u.name[0])}</span>` : '');
async function load() {
  try { S = await api('/api/admin/state'); render(); }
  catch (e) { if (e.status === 401) loginScreen(); else toast(e.message); }
}
async function act(name, args = {}, okMsg) {
  try { const r = await api('/api/admin/action', { name, args }); S = r.state; render(); if (okMsg) toast(okMsg); return true; }
  catch (e) { if (e.status === 401) { loginScreen(); toast('Session ended — sign in again'); } else toast(e.message); return false; }
}

/* ---------- views ---------- */
const st = { tab: 'overview', q: '', rstatus: 'open' };
function reportTarget(r) {
  if (r.kind === 'post') { const p = post(r.targetId); return p ? `📝 Post: <a class="link" href="/#/post/${esc(p.id)}" target="_blank" rel="noopener">${esc(p.title)}</a> by ${userLink(user(p.authorId))}${(p.media || []).length ? ` · ${plural(p.media.length, 'media file')}` : ''}` : '<span class="muted">Post (already removed)</span>'; }
  if (r.kind === 'comment') { const [pid, cid] = r.targetId.split('|'); const p = post(pid); const c = p?.comments.find((x) => x.id === cid); return c ? `💬 Comment by ${userLink(user(c.authorId))} on <a class="link" href="/#/post/${esc(p.id)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="quote">${esc(c.body.slice(0, 300))}</div>` : '<span class="muted">Comment (already removed)</span>'; }
  if (r.kind === 'user') { const u = user(r.targetId); return u ? `👤 User: ${userLink(u)} ${u.banned ? '<span class="pill pill-warn">Suspended</span>' : ''}` : '<span class="muted">User (deleted)</span>'; }
  if (r.kind === 'project') { const p = project(r.targetId); return p ? `🗄️ Project: <a class="link" href="/#/vault/${esc(p.id)}" target="_blank" rel="noopener">${esc(p.name)}</a> by ${userLink(user(p.ownerId))}` : '<span class="muted">Project (already removed)</span>'; }
  if (r.kind === 'playlist') { const p = S.playlists.find((x) => x.id === r.targetId); return p ? `🎞️ Playlist: <a class="link" href="/#/playlist/${esc(p.id)}" target="_blank" rel="noopener">${esc(p.name)}</a> by ${userLink(user(p.ownerId))}` : '<span class="muted">Playlist (already removed)</span>'; }
  return '';
}
const auditRow = (a) => { const u = user(a.actorId); return `<div class="notif">${avatar(u)}<span style="flex:1;min-width:0"><strong>${esc(u?.name || 'System')}</strong> ${esc(a.action)} <span class="muted">${esc(a.detail || '')}</span><div class="small muted">${ago(a.createdAt)}</div></span></div>`; };
const search = (ph) => `<input type="text" id="adminQ" placeholder="${ph}" value="${esc(st.q)}" style="margin-bottom:12px" autocomplete="off">`;

function render() {
  const m = me();
  $('#adminUser').innerHTML = `<span class="small muted">${esc(m.name)} · ${ROLE_LABEL[m.role]}</span><a class="btn btn-sm" href="/" target="_blank" rel="noopener">Open site ↗</a><button class="btn btn-sm" id="logout">Sign out</button>`;
  $('#logout').onclick = async () => { try { await api('/api/admin/logout', {}); } catch {} S = null; loginScreen(); };
  const openReports = S.reports.filter((r) => r.status === 'open').length;
  const pendingTools = S.tools.filter((t) => t.status === 'pending').length;
  const tabs = [['overview', '📊 Overview'], ['reports', `⚑ Reports${openReports ? ` (${openReports})` : ''}`], ['content', '📝 Content'], ['tools', `🧰 Tools${pendingTools ? ` (${pendingTools})` : ''}`], ['championship', '🏆 Championship'],
    ...(isAdmin() ? [['users', '👥 Users'], ['communities', '🏘️ Communities'], ['settings', '⚙️ Settings']] : []), ['audit', '📜 Audit log']];
  if (!tabs.some(([k]) => k === st.tab)) st.tab = 'overview';
  const t = st.tab, q = st.q.toLowerCase();
  let body = '';

  if (t === 'overview') {
    const weekAgo = Date.now() - 7 * 864e5, mk = monthKey();
    const media = S.posts.reduce((n, p) => n + (p.media || []).length, 0);
    const stats = [['Members', S.users.length], ['New this week', S.users.filter((u) => u.joinedAt > weekAgo).length], ['Posts', S.posts.length], ['Posts this week', S.posts.filter((p) => p.createdAt > weekAgo).length],
      ['Photos & videos', media], ['Playlists', S.playlists.length], ['Communities', S.communities.length], ['Vault projects', S.projects.length],
      ['Open reports', openReports], ['Pending tools', pendingTools], ['Suspended', S.users.filter((u) => u.banned).length], ['2FA enabled', `${S.users.filter((u) => u.twoFactor).length}/${S.users.length}`], [`${shortMonth(mk)} entries`, S.champ.submissions.filter((x) => x.month === mk).length]];
    body = `<div class="stat-grid">${stats.map(([l, v]) => `<div class="card stat"><div class="stat-v">${esc(v)}</div><div class="small muted">${esc(l)}</div></div>`).join('')}</div>
      <div class="grid-2" style="margin-top:14px">
        <div class="card"><h3>Needs attention</h3>${openReports || pendingTools ? `<div class="row">${openReports ? `<button class="btn btn-sm btn-danger" data-tab="reports">Review ${plural(openReports, 'report')}</button>` : ''}${pendingTools ? `<button class="btn btn-sm" data-tab="tools">Approve ${plural(pendingTools, 'tool')}</button>` : ''}</div>` : '<p class="small muted">All clear 🎉</p>'}</div>
        <div class="card"><h3>Recent staff activity</h3>${S.audit.slice(0, 5).map(auditRow).join('') || '<p class="small muted">Nothing yet.</p>'}</div>
      </div>`;
  }
  if (t === 'reports') {
    const list = S.reports.filter((r) => st.rstatus === 'all' || r.status === st.rstatus).sort((a, b) => b.createdAt - a.createdAt);
    body = `<div class="chips" style="margin-bottom:12px">${['open', 'resolved', 'dismissed', 'all'].map((x) => `<button class="chip ${st.rstatus === x ? 'active' : ''}" data-rstatus="${x}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div>`
      + (list.map((r) => `<div class="card"><div class="row between"><div class="row"><span class="pill pill-warn">⚑ ${esc(r.reason)}</span><span class="small muted">by ${userLink(user(r.reporterId))} · ${ago(r.createdAt)}</span></div><span class="pill ${r.status === 'open' ? 'pill-accent' : 'pill-good'}">${esc(r.status)}</span></div>
        <div style="margin-top:8px">${reportTarget(r)}</div>
        ${r.note ? `<p class="small muted" style="margin-top:6px">Reporter's note: “${esc(r.note)}”</p>` : ''}
        ${r.status === 'open' ? `<div class="row" style="margin-top:10px">${r.kind === 'user' && !isAdmin() ? '<span class="small muted">Only admins can suspend accounts.</span>' : `<button class="btn btn-sm btn-danger" data-do="reportRemove" data-id="${esc(r.id)}" data-confirm="${r.kind === 'user' ? 'Suspend this user?' : `Remove this ${esc(r.kind)}? The author will be notified.`}">${r.kind === 'user' ? '⛔ Suspend user' : '🗑 Remove ' + esc(r.kind)}</button>`}<button class="btn btn-sm" data-do="reportDismiss" data-id="${esc(r.id)}">Dismiss</button></div>`
          : `<div class="small muted" style="margin-top:6px">${r.status === 'resolved' ? 'Actioned' : 'Dismissed'} by ${esc(user(r.handledBy)?.name || 'staff')}${r.handledAt ? ' · ' + ago(r.handledAt) : ''}</div>`}
      </div>`).join('') || '<div class="card empty">No reports here. 🎉</div>');
  }
  if (t === 'content') {
    const list = S.posts.filter((p) => !q || `${p.title} ${p.body} @${user(p.authorId)?.handle}`.toLowerCase().includes(q)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    body = search('Search posts by title, text or @author…') + `<div class="card table-wrap"><table class="table"><thead><tr><th>Post</th><th>Author</th><th>Community</th><th>Activity</th><th></th></tr></thead><tbody>${list.map((p) => {
      const c = community(p.communityId);
      return `<tr><td><a class="link" href="/#/post/${esc(p.id)}" target="_blank" rel="noopener">${esc(p.title.slice(0, 80))}</a>${p.pinned ? ' 📌' : ''}${(p.media || []).length ? ` <span class="tag">📸 ${p.media.length}</span>` : ''}<div class="small muted">${esc(POST_TYPES[p.type]?.label || p.type)} · ${ago(p.createdAt)}</div></td><td>${userLink(user(p.authorId))}</td><td class="small">${c ? `p/${esc(c.slug)}` : '—'}</td><td class="small nowrap">♥ ${p.likes.length} · 💬 ${p.comments.length}</td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm" data-do="pinPost" data-arg="postId" data-id="${esc(p.id)}">${p.pinned ? 'Unpin' : 'Pin'}</button><button class="btn btn-sm btn-danger" data-do="deletePost" data-arg="postId" data-id="${esc(p.id)}" data-confirm="Remove this post? The author will be notified.">Remove</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No posts match.</td></tr>'}</tbody></table></div>`;
  }
  if (t === 'tools') {
    const pending = S.tools.filter((x) => x.status === 'pending'), live = S.tools.filter((x) => x.status !== 'pending');
    body = `<div class="row between"><h3>Waiting for approval</h3><span class="small muted">Approval is ${S.settings.toolApproval ? 'ON' : 'OFF'}</span></div>
      ${pending.map((x) => `<div class="card"><div class="row between"><strong>${esc(x.name)}</strong><span class="tag">${esc(x.category)}</span></div>${x.isOffer ? '<span class="pill pill-warn">🎁 Offer</span>' : ''}<p class="small" style="margin-top:6px">${esc(x.desc)}</p><div class="small muted mono" style="word-break:break-all">${esc(x.url)}</div><div class="small muted">submitted by ${userLink(user(x.addedBy))} ${ago(x.createdAt)}</div><div class="row" style="margin-top:10px"><button class="btn btn-sm btn-primary" data-do="approveTool" data-id="${esc(x.id)}">✓ Approve</button><button class="btn btn-sm btn-danger" data-do="rejectTool" data-id="${esc(x.id)}">Reject</button></div></div>`).join('') || '<div class="card empty small">No tools waiting.</div>'}
      <h3 style="margin-top:18px">Live tools (${live.length})</h3>
      <div class="card table-wrap"><table class="table"><tbody>${live.map((x) => `<tr><td><strong>${esc(x.name)}</strong><div class="small muted">${esc(x.category)}${x.isOffer ? ' · 🎁 offer' : ''}</div></td><td class="small">${userLink(user(x.addedBy))}</td><td class="small nowrap">▲ ${x.upvotes.length}</td><td><button class="btn btn-sm btn-danger" data-do="removeTool" data-id="${esc(x.id)}" data-confirm="Remove ${esc(x.name)}?">Remove</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  if (t === 'championship') {
    const mk = monthKey(), closed = S.champ.closed.includes(mk);
    const entries = CHAMP_CATEGORIES.flatMap((c) => S.champ.submissions.filter((x) => x.month === mk && x.category === c.id).map((x) => ({ ...x, votes: S.champ.counts[x.id] || 0 })).sort((a, b) => b.votes - a.votes));
    const votes = S.champ.votes.filter((v) => v.month === mk);
    const fresh = votes.filter((v) => { const u = user(v.voterId); return !u || u.banned || Date.now() - u.joinedAt < S.settings.communityMinAgeDays * 864e5; }).length;
    body = `<div class="card"><div class="row between"><div><strong>${esc(monthLabel(mk))}</strong><div class="small muted">${closed ? 'Voting closed — champions crowned' : 'Voting open · closes automatically at month end'} · ${plural(entries.length, 'entry', 'entries')} · ${plural(votes.length, 'vote')}</div></div>${closed ? '<span class="pill pill-good">Closed</span>' : isAdmin() ? '<button class="btn btn-gold btn-sm" data-do="closeMonth" data-confirm="Close voting now and crown champions?">🏆 Close voting now</button>' : ''}</div>
      ${fresh ? `<div class="notice" style="margin-top:10px">${plural(fresh, 'vote')} came from suspended or brand-new accounts. Votes from suspended accounts never count.</div>` : ''}</div>
      <div class="card table-wrap"><table class="table"><thead><tr><th>Entry</th><th>Category</th><th>Builder</th><th>Votes</th><th></th></tr></thead><tbody>${entries.map((x) => `<tr><td><a class="link" href="/#/vault/${esc(x.projectId)}" target="_blank" rel="noopener">${esc(project(x.projectId)?.name || 'Deleted project')}</a></td><td class="small">${catIcon(x.category)} ${esc(catName(x.category))}</td><td>${userLink(user(x.userId))}</td><td class="mono">${x.votes}</td><td>${closed ? '' : `<button class="btn btn-sm btn-danger" data-do="disqualify" data-id="${esc(x.id)}" data-confirm="Disqualify this entry? Its votes are removed.">Disqualify</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No entries yet.</td></tr>'}</tbody></table></div>`;
  }
  if (t === 'users') {
    const list = S.users.filter((u) => !q || `${u.name} ${u.handle}`.toLowerCase().includes(q)).sort((a, b) => b.joinedAt - a.joinedAt);
    body = search('Search members by name or username…') + `<div class="card table-wrap"><table class="table"><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th>Posts</th><th>Security</th><th>Status</th><th></th></tr></thead><tbody>${list.map((u) => `<tr>
        <td><div class="row" style="flex-wrap:nowrap">${avatar(u)}<div style="min-width:0">${userLink(u)}${u.verified ? ' <span class="verified">✔</span>' : ''}</div></div></td>
        <td><select data-role-for="${esc(u.id)}" ${u.id === S.me.id ? 'disabled title="You cannot change your own role"' : ''} style="width:auto;padding:5px 8px">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td class="small nowrap">${ago(u.joinedAt)}</td><td class="small">${S.posts.filter((p) => p.authorId === u.id).length}</td>
        <td class="small nowrap">${u.twoFactor ? '🔐 2FA' : '<span class="muted">no 2FA</span>'} · ${plural(u.sessions, 'device')}</td>
        <td>${u.banned ? '<span class="pill pill-warn">Suspended</span>' : '<span class="pill pill-good">Active</span>'}</td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm" data-do="verifyUser" data-arg="userId" data-id="${esc(u.id)}">${u.verified ? 'Unverify' : '✔ Verify'}</button>${u.id === S.me.id ? '' : `<button class="btn btn-sm" data-do="revokeSessions" data-arg="userId" data-id="${esc(u.id)}" data-confirm="Log @${esc(u.handle)} out of every device?">Log out</button><button class="btn btn-sm ${u.banned ? '' : 'btn-danger'}" data-do="banUser" data-arg="userId" data-id="${esc(u.id)}" ${u.banned ? '' : `data-confirm="Suspend @${esc(u.handle)}? They can browse but not post, comment, message or vote."`}>${u.banned ? 'Restore' : 'Suspend'}</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
  }
  if (t === 'communities') {
    body = `<div class="card table-wrap"><table class="table"><thead><tr><th>Community</th><th>Members</th><th>Posts</th><th>Owner & mods</th><th></th></tr></thead><tbody>${S.communities.map((c) => `<tr><td><a class="link" href="/#/c/${esc(c.slug)}" target="_blank" rel="noopener">${esc(c.icon)} p/${esc(c.slug)}</a><div class="small muted">${esc(c.name)} · ${ago(c.createdAt)}</div></td><td>${c.members.length}</td><td>${S.posts.filter((p) => p.communityId === c.id).length}</td><td class="small">${userLink(user(c.createdBy))}${(c.mods || []).length ? '<br>mods: ' + c.mods.map((id) => esc('@' + (user(id)?.handle || '?'))).join(', ') : ''}</td>
      <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm" data-edit-comm="${esc(c.id)}">Manage</button><button class="btn btn-sm btn-danger" data-do="deleteCommunity" data-id="${esc(c.id)}" data-confirm="Delete p/${esc(c.slug)} and all its posts? This cannot be undone.">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No communities.</td></tr>'}</tbody></table></div>`;
  }
  if (t === 'settings') {
    const s = S.settings;
    body = `<form id="settingsForm" class="card"><h3>Platform settings</h3>
      <div class="field"><label for="st-age">New-account waiting period (days)</label><input id="st-age" type="number" name="minAge" min="0" max="60" value="${esc(s.communityMinAgeDays)}" style="max-width:140px"><div class="hint">Accounts younger than this can't create communities or enter the Championship (anti-spam).</div></div>
      <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="toolApproval" ${s.toolApproval ? 'checked' : ''}> New tools and offers need staff approval before they appear</label></div>
      <div class="field"><label for="st-ann">Site announcement</label><input id="st-ann" type="text" name="announcement" maxlength="200" value="${esc(s.announcement)}" placeholder="e.g. Championship voting closes Sunday!"><div class="hint">Shown at the top of every page. Leave empty to hide.</div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Save settings</button></div></form>
      <div class="card"><h3>Owner tools</h3><p class="small muted">Run these on the server (with the server stopped): <code>npm run cli -- create-admin &lt;username&gt;</code>, <code>set-role</code>, <code>reset-password</code>, <code>reset-2fa</code>.</p></div>`;
  }
  if (t === 'audit') body = `<div class="card">${S.audit.map(auditRow).join('') || '<div class="empty">No staff actions yet.</div>'}</div>`;

  $('#admin').innerHTML = `<div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${t === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>${body}`;
  bind();
}
function bind() {
  const root = $('#admin');
  $$('[data-tab]', root).forEach((b) => b.onclick = () => { st.tab = b.dataset.tab; st.q = ''; render(); });
  $$('[data-rstatus]', root).forEach((b) => b.onclick = () => { st.rstatus = b.dataset.rstatus; render(); });
  $$('[data-do]', root).forEach((b) => b.onclick = () => {
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    act(b.dataset.do, { [b.dataset.arg || 'id']: b.dataset.id }, 'Done');
  });
  const qi = $('#adminQ', root);
  if (qi) qi.oninput = () => { st.q = qi.value; render(); const n = $('#adminQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  $$('[data-role-for]', root).forEach((sel) => sel.onchange = () => {
    const u = user(sel.dataset.roleFor);
    if (!confirm(`Make @${u.handle} a ${ROLE_LABEL[sel.value]}?`)) return render();
    act('setRole', { userId: u.id, role: sel.value }, 'Role updated');
  });
  $$('[data-edit-comm]', root).forEach((b) => b.onclick = () => {
    const c = community(b.dataset.editComm);
    modal(`<h2>Manage p/${esc(c.slug)}</h2><form id="ecForm">
      <div class="field"><label for="ec-n">Name</label><input id="ec-n" type="text" name="name" maxlength="50" value="${esc(c.name)}" required></div>
      <div class="field"><label for="ec-i">Icon</label><input id="ec-i" type="text" name="icon" maxlength="8" value="${esc(c.icon)}"></div>
      <div class="field"><label for="ec-d">Description</label><textarea id="ec-d" name="desc" maxlength="300">${esc(c.desc)}</textarea></div>
      <div class="field"><label for="ec-r">Rules (one per line)</label><textarea id="ec-r" name="rules">${esc(c.rules.join('\n'))}</textarea></div>
      <div class="field"><label for="ec-m">Moderators (usernames)</label><input id="ec-m" type="text" name="mods" value="${esc((c.mods || []).map((i) => user(i)?.handle).filter(Boolean).join(', '))}"></div>
      <button class="btn btn-primary">Save</button></form>`);
    $('#ecForm').onsubmit = async (e) => { e.preventDefault(); const f = e.target; if (await act('editCommunity', { id: c.id, name: f.name.value, icon: f.icon.value, desc: f.desc.value, rules: f.rules.value, mods: f.mods.value }, 'Community updated')) closeModal(); };
  });
  const sf = $('#settingsForm', root);
  if (sf) sf.onsubmit = (e) => { e.preventDefault(); act('settings', { communityMinAgeDays: sf.minAge.value, toolApproval: sf.toolApproval.checked, announcement: sf.announcement.value }, 'Settings saved'); };
}

// refresh every minute so new reports show up; an expired session drops back to sign-in
setInterval(() => { if (S && $('#modal').hidden && !document.activeElement?.matches('input, textarea, select')) load(); }, 60e3);
load();
