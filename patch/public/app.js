/* Patch — browser app. Talks to the Patch server; the server checks every action. */
import { DAY, CHAMP_CATEGORIES, POST_TYPES, TOOL_CATEGORIES, PROJECT_STATUS, REPORT_REASONS, PLAYLIST_VISIBILITY, LIMITS, USERNAME_RE, monthKey, monthLabel, shortMonth, yearlyTitles } from './shared.js';

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const now = () => Date.now();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
function ago(t) {
  const s = Math.max(1, Math.floor((now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
const plural = (n, w, pl = w + 's') => `${n} ${n === 1 ? w : pl}`;

/* ---------- server API ---------- */
let db = null;
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'X-Patch': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}
async function refresh() { db = await api('/api/state'); }
// Runs a server action, updates local data and re-renders. Returns the result, or undefined on error.
async function act(name, args = {}, okMsg) {
  try {
    const r = await api('/api/action', { method: 'POST', body: { name, args } });
    db = r.state; render();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r.result) : okMsg);
    return r.result || {};
  } catch (e) {
    if (e.status === 401) { await refresh().catch(() => {}); render(); openAuth(); }
    toast(e.message);
    return undefined;
  }
}
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', '/api/media');
    x.setRequestHeader('X-Patch', '1');
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} x.status < 300 ? resolve(d) : reject(new Error(d.error || 'Upload failed')); };
    x.onerror = () => reject(new Error('Network error during upload'));
    x.send(file);
  });
}

/* ---------- lookups ---------- */
const me = () => (db?.me ? db.users.find((u) => u.id === db.me.id) : null);
const user = (id) => db.users.find((u) => u.id === id);
const userByHandle = (h) => db.users.find((u) => u.handle === h);
const community = (id) => db.communities.find((c) => c.id === id);
const communityBySlug = (s) => db.communities.find((c) => c.slug === s);
const project = (id) => db.projects.find((p) => p.id === id);
const post = (id) => db.posts.find((p) => p.id === id);
const accountAgeDays = (u) => (now() - u.joinedAt) / DAY;
const minAge = () => db.settings.communityMinAgeDays ?? 3;
const isStaff = (u = me()) => !!u && (u.role === 'admin' || u.role === 'moderator');
const canModerate = (c, u = me()) => !!u && !!c && !u.banned && (c.createdBy === u.id || (c.mods || []).includes(u.id));
const catName = (id) => CHAMP_CATEGORIES.find((c) => c.id === id)?.name || id;
const catIcon = (id) => CHAMP_CATEGORIES.find((c) => c.id === id)?.icon || '🏆';
const yearly = () => yearlyTitles(db.champ.winners, db.champ.closed);
const shareUrl = (kind, id) => `${location.origin}/s/${kind}/${encodeURIComponent(id)}`;
function requireLogin() {
  const m = me();
  if (!m) { openAuth(); return false; }
  if (m.banned) { toast('Your account is suspended'); return false; }
  return true;
}

/* ---------- rendering helpers ---------- */
function avatar(u, size = '') {
  if (!u) return '';
  const initials = u.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `<a href="#/u/${esc(u.handle)}" class="avatar ${size}" style="background:${esc(u.color)}" title="${esc(u.name)}">${esc(initials)}</a>`;
}
function badges(u) {
  let s = '';
  if (u.verified) s += ' <span class="verified" title="Verified builder">✔</span>';
  if (u.role === 'admin') s += ' <span class="pill pill-accent" title="Patch admin">🛡️ Admin</span>';
  else if (u.role === 'moderator') s += ' <span class="pill pill-good" title="Patch moderator">🛡️ Mod</span>';
  const y = yearly().filter((x) => x.userId === u.id).length, w = db.champ.winners.filter((x) => x.userId === u.id).length;
  if (y) s += ` <span class="champ-badge" title="Yearly champion">👑 ${y}</span>`;
  if (w) s += ` <span class="champ-badge" title="Monthly championship trophies">🏆 ${w}</span>`;
  return s;
}
const userLink = (u) => (u ? `<a href="#/u/${esc(u.handle)}"><strong>${esc(u.name)}</strong></a>${badges(u)}` : 'Unknown');
const progressBar = (pct) => `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
const statusPill = (s) => `<span class="pill status-${esc(s)}">${esc(PROJECT_STATUS[s] || s)}</span>`;
const mediaUrl = (m) => `/media/${encodeURIComponent(m.id)}`;
function mediaHtml(p, { full = false } = {}) {
  const items = p.media || [];
  if (!items.length) return '';
  const shown = full ? items : items.slice(0, 4);
  return `<div class="gallery n${Math.min(shown.length, 4)}">${shown.map((m, i) => m.kind === 'video'
    ? `<video class="media" src="${mediaUrl(m)}" controls preload="metadata" playsinline></video>`
    : `<button class="media-btn" data-act="lightbox" data-id="${esc(p.id)}" data-i="${i}" aria-label="Open image"><img class="media" src="${mediaUrl(m)}" alt="" loading="lazy"></button>`).join('')}
    ${!full && items.length > 4 ? `<a class="media-more" href="#/post/${esc(p.id)}">+${items.length - 4} more</a>` : ''}</div>`;
}

function postCard(p, { full = false } = {}) {
  const a = user(p.authorId), c = community(p.communityId), m = me();
  const type = POST_TYPES[p.type] || POST_TYPES.discussion;
  const liked = m && p.likes.includes(m.id), saved = m && p.saves.includes(m.id);
  const proj = p.projectId && project(p.projectId);
  let extra = '';
  if (p.type === 'poll' && p.poll) {
    const total = p.poll.options.reduce((n, o) => n + o.votes.length, 0);
    extra = `<div class="poll">${p.poll.options.map((o, i) => {
      const pct = total ? Math.round((o.votes.length / total) * 100) : 0, mine = m && o.votes.includes(m.id);
      return `<button class="poll-opt ${mine ? 'mine' : ''}" data-act="vote-poll" data-id="${p.id}" data-i="${i}"><div class="fill" style="width:${pct}%"></div><span>${mine ? '✓ ' : ''}${esc(o.text)}</span><span class="muted" style="float:right">${pct}%</span></button>`;
    }).join('')}<div class="hint">${plural(total, 'vote')}</div></div>`;
  }
  if (p.type === 'progress' && p.progress) {
    extra = `<div style="margin:10px 0"><div class="row between small"><strong>${p.progress.percent}% complete</strong>${p.progress.eta ? `<span class="muted">Target: ${esc(new Date(p.progress.eta).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }))}</span>` : ''}</div>${progressBar(p.progress.percent)}</div>`;
  }
  return `<article class="card post">
    <div class="post-meta">
      ${c ? `<a href="#/c/${esc(c.slug)}" class="row" style="gap:4px"><span class="comm-icon" style="width:20px;height:20px;font-size:.75rem">${esc(c.icon)}</span><strong>p/${esc(c.slug)}</strong></a> ·` : ''}
      ${avatar(a, 'sm')} ${userLink(a)} · <span>${ago(p.createdAt)}</span>
      <span class="pill pill-accent">${type.icon} ${type.label}</span>
      ${p.solved ? '<span class="pill pill-good">✓ Solved</span>' : ''}
      ${p.pinned ? '<span class="pill pill-gold">📌 Pinned</span>' : ''}
    </div>
    <div class="post-title"><a href="#/post/${p.id}">${esc(p.title)}</a></div>
    ${p.body ? `<div class="post-body ${full ? '' : 'clamp'}">${esc(p.body)}</div>` : ''}
    ${mediaHtml(p, { full })}
    ${extra}
    ${proj ? `<a href="#/vault/${proj.id}" class="card row" style="padding:10px;margin-top:10px;box-shadow:none;background:var(--surface-2)">🗄️ <span><strong>${esc(proj.name)}</strong> <span class="muted small">— ${esc(proj.tagline)}</span></span> ${statusPill(proj.status)}</a>` : ''}
    ${p.tags?.length ? `<div class="chips" style="margin-top:8px">${p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="actions">
      <button class="act ${liked ? 'on' : ''}" data-act="like" data-id="${p.id}" aria-pressed="${!!liked}">${liked ? '♥' : '♡'} ${p.likes.length}</button>
      <a class="act" href="#/post/${p.id}">💬 ${p.comments.length}</a>
      <button class="act ${saved ? 'on' : ''}" data-act="save" data-id="${p.id}" aria-pressed="${!!saved}">🔖 ${saved ? 'Saved' : 'Save'}</button>
      <button class="act" data-act="add-to-playlist" data-id="${p.id}">🎞️ Playlist</button>
      <button class="act" data-act="share" data-kind="post" data-id="${p.id}">↗ Share</button>
      ${m && m.id === p.authorId && p.type === 'question' ? `<button class="act" data-act="solve" data-id="${p.id}">${p.solved ? 'Mark unsolved' : '✓ Mark solved'}</button>` : ''}
      ${m && m.id !== p.authorId ? `<button class="act" data-act="report" data-kind="post" data-id="${p.id}">⚑ Report</button>` : ''}
      ${canModerate(c) ? `<button class="act" data-act="pin-post" data-id="${p.id}">📌 ${p.pinned ? 'Unpin' : 'Pin'}</button>` : ''}
      ${m && (m.id === p.authorId || canModerate(c)) ? `<button class="act" data-act="delete-post" data-id="${p.id}">🗑 ${m.id === p.authorId ? 'Delete' : 'Remove'}</button>` : ''}
    </div>
  </article>`;
}
function commentActions(p, cm) {
  const m = me(); if (!m) return '';
  const key = `${p.id}|${cm.id}`;
  let s = '';
  if (m.id !== cm.authorId) s += `<button class="act" data-act="report" data-kind="comment" data-id="${key}">⚑ Report</button>`;
  if (m.id === cm.authorId || canModerate(community(p.communityId))) s += `<button class="act" data-act="delete-comment" data-id="${key}">🗑 ${m.id === cm.authorId ? 'Delete' : 'Remove'}</button>`;
  return s ? `<div class="actions" style="margin-top:2px">${s}</div>` : '';
}
function feedFilters(state) {
  return `<div class="tabs">${['hot', 'new', 'top'].map((s) => `<button class="tab ${state.sort === s ? 'active' : ''}" data-sort="${s}">${{ hot: '🔥 For you', new: '🆕 Latest', top: '⬆ Top' }[s]}</button>`).join('')}</div>
  <div class="chips" style="margin-bottom:14px"><button class="chip ${!state.type ? 'active' : ''}" data-type="">All</button>${Object.entries(POST_TYPES).map(([k, v]) => `<button class="chip ${state.type === k ? 'active' : ''}" data-type="${k}">${v.icon} ${v.label}</button>`).join('')}</div>`;
}
function sortPosts(list, sort) {
  const score = (p) => p.likes.length * 2 + p.comments.length * 3;
  const hot = (p) => (score(p) + 1) / Math.pow((now() - p.createdAt) / 3600e3 + 2, 1.2);
  const cmp = sort === 'new' ? (a, b) => b.createdAt - a.createdAt : sort === 'top' ? (a, b) => score(b) - score(a) : (a, b) => hot(b) - hot(a);
  return list.sort(cmp).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}
function bindFeed(root, state) {
  $$('[data-sort]', root).forEach((b) => b.onclick = () => { state.sort = b.dataset.sort; render(); });
  $$('[data-type]', root).forEach((b) => b.onclick = () => { state.type = b.dataset.type; render(); });
}
const lastUpdate = (p) => Math.max(p.createdAt, ...p.updates.map((u) => u.createdAt));
const currentPct = (p) => (p.updates.length ? p.updates[p.updates.length - 1].percent : 0);

/* ---------- views ---------- */
const feedState = { sort: 'hot', type: '', scope: 'all' };
function viewFeed() {
  const m = me();
  let list = db.posts.slice();
  if (m && feedState.scope === 'mine') {
    const joined = db.communities.filter((c) => c.members.includes(m.id)).map((c) => c.id);
    list = list.filter((p) => joined.includes(p.communityId) || m.following.includes(p.authorId) || p.authorId === m.id);
  }
  if (feedState.type) list = list.filter((p) => p.type === feedState.type);
  list = sortPosts(list, feedState.sort);
  const mk = monthKey();
  const daysLeft = Math.ceil((new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1) - now()) / DAY);
  return `<div class="page">
    <div>
      <div class="hero">
        <h1>Build it. Patch it. Show it off.</h1>
        <p class="muted">A home for builders — apps made with AI, tools, agents, automations, games and small experiments. Share your work so it never disappears from the feed.</p>
        <div class="row"><a class="btn btn-primary" href="#/new">＋ Create post</a><a class="btn" href="#/new?type=media">📸 Share photos / videos</a><a class="btn" href="#/vault/new">🗄️ Add a project</a></div>
      </div>
      ${m ? `<div class="chips" style="margin-bottom:10px"><button class="chip ${feedState.scope === 'all' ? 'active' : ''}" data-scope="all">Everything</button><button class="chip ${feedState.scope === 'mine' ? 'active' : ''}" data-scope="mine">My communities & following</button></div>` : ''}
      ${feedFilters(feedState)}
      ${list.length ? list.map((p) => postCard(p)).join('') : `<div class="card empty">Nothing here yet. <a class="link" href="#/communities">Join a community</a> or <a class="link" href="#/new">create a post</a>.</div>`}
    </div>
    <aside class="rail">
      <a class="card trophy" href="#/championship" style="display:block">
        <div class="row"><span class="cup">🏆</span><div><strong>${esc(monthLabel(mk))} Championship</strong><div class="small muted">${daysLeft} days left to vote · ${db.champ.submissions.filter((s) => s.month === mk).length} entries</div></div></div>
      </a>
      <div class="card hide-narrow">
        <h3>Popular communities</h3>
        ${db.communities.slice().sort((a, b) => b.members.length - a.members.length).slice(0, 5).map((c) => `<a href="#/c/${esc(c.slug)}" class="row" style="padding:6px 0"><span class="comm-icon">${esc(c.icon)}</span><span style="flex:1"><strong>p/${esc(c.slug)}</strong><div class="small muted">${plural(c.members.length, 'member')}</div></span></a>`).join('') || '<p class="small muted">No communities yet.</p>'}
        <a class="btn btn-sm" style="width:100%;margin-top:8px" href="#/communities">See all</a>
      </div>
      <div class="card hide-narrow">
        <h3>🎞️ Playlists</h3>
        ${db.playlists.filter((p) => p.visibility === 'public').slice(0, 4).map((pl) => `<a href="#/playlist/${esc(pl.id)}" style="display:block;padding:6px 0"><strong>${esc(pl.name)}</strong><div class="small muted">${plural(pl.items.length, 'post')} · by ${esc(user(pl.ownerId)?.name)}</div></a>`).join('') || '<p class="small muted">No public playlists yet.</p>'}
        <a class="btn btn-sm" style="width:100%;margin-top:8px" href="#/playlists">Browse playlists</a>
      </div>
    </aside>
  </div>`;
}
function afterFeed(root) {
  bindFeed(root, feedState);
  $$('[data-scope]', root).forEach((b) => b.onclick = () => { feedState.scope = b.dataset.scope; render(); });
}

function viewPost(id) {
  const p = post(id);
  if (!p) return notFound();
  const m = me();
  const inPlaylists = db.playlists.filter((pl) => pl.visibility === 'public' && pl.items.includes(p.id));
  return `<div class="page single"><div class="stack">
    ${postCard(p, { full: true })}
    ${inPlaylists.length ? `<div class="card small">🎞️ In playlists: ${inPlaylists.map((pl) => `<a class="link" href="#/playlist/${esc(pl.id)}">${esc(pl.name)}</a>`).join(', ')}</div>` : ''}
    <div class="card">
      <h3>${plural(p.comments.length, 'comment')}</h3>
      ${m ? `<form id="commentForm" class="field"><textarea name="body" placeholder="${p.type === 'question' ? 'Know the fix? Share it…' : 'Add a comment…'}" required maxlength="4000" style="min-height:80px"></textarea><div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn btn-primary btn-sm">Comment</button></div></form>` : `<p class="muted"><button class="link-btn" data-act="login">Log in</button> to comment.</p>`}
      <div>${p.comments.map((c) => { const a = user(c.authorId); return `<div class="comment">${avatar(a, 'sm')}<div style="flex:1;min-width:0"><div class="small">${userLink(a)} <span class="muted">· ${ago(c.createdAt)}</span></div><div class="post-body">${esc(c.body)}</div>${commentActions(p, c)}</div></div>`; }).join('') || '<div class="muted">No comments yet — be the first.</div>'}</div>
    </div>
  </div></div>`;
}
function afterPost(root, id) {
  const f = $('#commentForm', root);
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const body = f.body.value.trim(); if (!body) return;
    f.querySelector('button').disabled = true;
    if (await act('comment', { postId: id, body }) === undefined) f.querySelector('button').disabled = false;
  };
}

/* Create post (with photo & video uploads) */
function viewNewPost(params) {
  if (!me()) return loginWall('create a post');
  const m = me();
  const joined = db.communities.filter((c) => c.members.includes(m.id));
  const myProjects = db.projects.filter((p) => p.ownerId === m.id);
  const pre = params.get('c'), preType = POST_TYPES[params.get('type')] ? params.get('type') : 'discussion';
  if (!db.communities.length) return '<div class="page single"><div class="card empty"><h2>No communities yet</h2><p>A community is needed before posting.</p><a class="btn btn-primary" href="#/communities">Communities</a></div></div>';
  return `<div class="page single"><div class="card">
    <h1>Create a post</h1>
    <form id="postForm" data-type="${preType}">
      <div class="field"><label>Post type</label><div class="chips">${Object.entries(POST_TYPES).map(([k, v]) => `<button type="button" class="chip ${k === preType ? 'active' : ''}" data-ptype="${k}">${v.icon} ${v.label}</button>`).join('')}</div></div>
      <div class="field"><label for="pf-c">Community</label><select id="pf-c" name="communityId" required>${(joined.length ? joined : db.communities).map((c) => `<option value="${c.id}" ${c.slug === pre ? 'selected' : ''}>p/${esc(c.slug)} — ${esc(c.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="pf-t">Title</label><input id="pf-t" type="text" name="title" maxlength="200" required placeholder="What did you build, ask or discover?"></div>
      <div class="field"><label for="pf-b">Details</label><textarea id="pf-b" name="body" maxlength="10000" placeholder="Describe what it does, its features, or the error you are facing…"></textarea></div>
      <div class="field">
        <label for="pf-files">Photos & videos</label>
        <label class="dropzone" id="dropzone"><input id="pf-files" type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif,video/mp4,video/webm,video/quicktime" multiple hidden>
          <span>📎 Click or drop files here</span><span class="hint">Images up to ${LIMITS.imageBytes / 1048576} MB · videos up to ${LIMITS.videoBytes / 1048576} MB · max ${LIMITS.mediaPerPost} per post</span></label>
        <div class="upload-list" id="uploadList"></div>
      </div>
      <div class="field" data-for="poll"><label>Poll options</label><div id="pollOpts"><input type="text" name="opt" placeholder="Option 1" style="margin-bottom:6px"><input type="text" name="opt" placeholder="Option 2" style="margin-bottom:6px"></div><button type="button" class="btn btn-sm" id="addOpt">＋ Add option</button></div>
      <div class="grid-2" data-for="progress">
        <div class="field"><label for="pf-pct">Completion: <span id="pctOut">50</span>%</label><input id="pf-pct" type="range" name="percent" min="0" max="100" value="50"></div>
        <div class="field"><label for="pf-eta">Expected finish</label><input id="pf-eta" type="date" name="eta"></div>
      </div>
      <div class="field" data-for="showcase progress"><label for="pf-proj">Link a Vault project (optional)</label><select id="pf-proj" name="projectId"><option value="">— none —</option>${myProjects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>${myProjects.length ? '' : '<div class="hint">No projects yet. <a class="link" href="#/vault/new">Add one to the Vault</a>.</div>'}</div>
      <div class="field"><label for="pf-tags">Tags</label><input id="pf-tags" type="text" name="tags" placeholder="godot, ai, help (comma separated)"></div>
      <div class="row" style="justify-content:flex-end"><a class="btn" href="#/">Cancel</a><button class="btn btn-primary" id="postBtn">Post</button></div>
    </form>
  </div></div>`;
}
function afterNewPost(root) {
  const f = $('#postForm', root); if (!f) return;
  let type = f.dataset.type;
  const uploads = []; // {file, id, kind, status, progress, preview}
  const sync = () => $$('[data-for]', root).forEach((el) => el.hidden = !el.dataset.for.split(' ').includes(type));
  $$('[data-ptype]', root).forEach((b) => b.onclick = () => { type = b.dataset.ptype; $$('[data-ptype]', root).forEach((x) => x.classList.toggle('active', x === b)); sync(); });
  sync();
  $('#addOpt', root).onclick = () => { const n = $$('#pollOpts input', root).length; if (n >= 6) return; $('#pollOpts', root).insertAdjacentHTML('beforeend', `<input type="text" name="opt" placeholder="Option ${n + 1}" style="margin-bottom:6px">`); };
  f.percent.oninput = () => $('#pctOut', root).textContent = f.percent.value;
  const drawUploads = () => {
    $('#uploadList', root).innerHTML = uploads.map((u, i) => `<div class="upload-item">
      ${u.kind === 'video' ? `<video src="${u.preview}" muted></video>` : `<img src="${u.preview}" alt="">`}
      <div class="upload-meta"><div class="small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(u.file.name)}</div>
      ${u.status === 'error' ? `<div class="small" style="color:var(--bad)">${esc(u.error)}</div>` : u.status === 'done' ? '<div class="small" style="color:var(--good)">✓ Uploaded</div>' : progressBar(Math.round(u.progress * 100))}</div>
      <button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
    $$('[data-rm]', root).forEach((b) => b.onclick = () => { const u = uploads.splice(Number(b.dataset.rm), 1)[0]; URL.revokeObjectURL(u.preview); drawUploads(); });
  };
  const addFiles = (files) => {
    if (!requireLogin()) return;
    for (const file of files) {
      if (uploads.length >= LIMITS.mediaPerPost) { toast(`Up to ${LIMITS.mediaPerPost} files per post`); break; }
      const kind = file.type.startsWith('video/') ? 'video' : 'image';
      const max = kind === 'video' ? LIMITS.videoBytes : LIMITS.imageBytes;
      const u = { file, kind, status: 'uploading', progress: 0, preview: URL.createObjectURL(file) };
      uploads.push(u);
      if (file.size > max) { u.status = 'error'; u.error = `Too large (max ${max / 1048576} MB)`; continue; }
      uploadFile(file, (p) => { u.progress = p; drawUploads(); })
        .then((r) => { u.id = r.id; u.kind = r.kind; u.status = 'done'; drawUploads(); })
        .catch((e) => { u.status = 'error'; u.error = e.message; drawUploads(); });
    }
    if (type === 'discussion' && uploads.length) $('[data-ptype="media"]', root)?.click();
    drawUploads();
  };
  $('#pf-files', root).onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  const dz = $('#dropzone', root);
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (uploads.some((u) => u.status === 'uploading')) return toast('Wait for uploads to finish');
    if (uploads.some((u) => u.status === 'error')) return toast('Remove the failed uploads first');
    const btn = $('#postBtn', root); btn.disabled = true;
    const r = await act('createPost', {
      type, communityId: f.communityId.value, title: f.title.value, body: f.body.value, tags: f.tags.value,
      media: uploads.map((u) => u.id), pollOptions: $$('#pollOpts input', root).map((i) => i.value),
      percent: f.percent.value, eta: f.eta.value, projectId: f.projectId.value,
    }, 'Posted!');
    if (r) location.hash = `#/post/${r.id}`; else btn.disabled = false;
  };
}

/* Communities */
function viewCommunities() {
  const m = me();
  return `<div class="page single">
    <div class="row between" style="margin-bottom:14px"><div><h1>Communities</h1><p class="muted">Join the spaces you care about and your feed fills with what interests you.</p></div><button class="btn btn-primary" data-act="new-community">＋ Create community</button></div>
    <div class="grid-2">${db.communities.map((c) => {
      const joined = m && c.members.includes(m.id);
      return `<div class="card"><div class="row" style="align-items:flex-start"><span class="comm-icon" style="width:44px;height:44px;font-size:1.4rem;border-radius:12px">${esc(c.icon)}</span><div style="flex:1;min-width:0"><a href="#/c/${esc(c.slug)}"><strong>${esc(c.name)}</strong></a><div class="small muted">p/${esc(c.slug)} · ${plural(c.members.length, 'member')} · ${plural(db.posts.filter((p) => p.communityId === c.id).length, 'post')}</div><p class="small" style="margin-top:6px">${esc(c.desc)}</p></div></div><div class="row" style="justify-content:flex-end"><button class="btn btn-sm ${joined ? '' : 'btn-primary'}" data-act="join" data-id="${c.id}">${joined ? 'Joined ✓' : 'Join'}</button></div></div>`;
    }).join('') || '<div class="card empty">No communities yet — create the first one!</div>'}</div>
  </div>`;
}
const commState = { sort: 'hot', type: '' };
function viewCommunity(slug) {
  const c = communityBySlug(slug); if (!c) return notFound();
  const m = me(), joined = m && c.members.includes(m.id);
  let list = db.posts.filter((p) => p.communityId === c.id);
  if (commState.type) list = list.filter((p) => p.type === commState.type);
  list = sortPosts(list, commState.sort);
  return `<div class="page">
    <div>
      <div class="hero row" style="align-items:center"><span class="comm-icon lg">${esc(c.icon)}</span><div style="flex:1;min-width:0"><h1 style="margin:0">${esc(c.name)}</h1><div class="muted">p/${esc(c.slug)} · ${plural(c.members.length, 'member')}</div></div>
        <div class="row"><a class="btn" href="#/new?c=${esc(c.slug)}">＋ Post</a><button class="btn ${joined ? '' : 'btn-primary'}" data-act="join" data-id="${c.id}">${joined ? 'Joined ✓' : 'Join'}</button></div></div>
      ${feedFilters(commState)}
      ${list.length ? list.map((p) => postCard(p)).join('') : '<div class="card empty">No posts yet. Start the first discussion!</div>'}
    </div>
    <aside class="rail">
      <div class="card"><h3>About</h3><p class="small">${esc(c.desc)}</p><div class="small muted">Created ${ago(c.createdAt)} by ${userLink(user(c.createdBy))}</div>
        ${(c.mods || []).length ? `<div class="small" style="margin-top:8px"><strong>Moderators:</strong> ${c.mods.map((id) => userLink(user(id))).join(', ')}</div>` : ''}
        ${canModerate(c) ? `<button class="btn btn-sm" style="margin-top:10px" data-act="edit-community" data-id="${c.id}">⚙ Manage community</button>` : ''}</div>
      <div class="card"><h3>Rules</h3><ol class="small" style="padding-left:18px;margin:0">${c.rules.map((r) => `<li style="margin-bottom:4px">${esc(r)}</li>`).join('') || '<li>Be kind.</li>'}</ol></div>
      <div class="card hide-narrow"><h3>Members</h3><div class="row">${c.members.slice(0, 16).map((id) => avatar(user(id), 'sm')).join('')}</div></div>
    </aside>
  </div>`;
}
function openNewCommunity() {
  if (!requireLogin()) return;
  const m = me(), age = accountAgeDays(m);
  if (age < minAge() && !isStaff(m)) {
    const left = Math.ceil((minAge() - age) * 24);
    return modal(`<h2>Almost there!</h2><p>To keep Patch free of spam accounts, new members can create a community after <strong>${plural(minAge(), 'day')}</strong>.</p><div class="notice">Your account is ${age < 1 ? 'less than a day' : plural(Math.floor(age), 'day')} old. You can create a community in about ${plural(left, 'hour')}.</div><p class="small muted" style="margin-top:10px">Meanwhile you can join communities, post, and add projects to the Vault.</p>`);
  }
  modal(`<h2>Create a community</h2>
    <form id="commForm">
      <div class="grid-2"><div class="field"><label for="cf-n">Name</label><input id="cf-n" type="text" name="name" maxlength="50" required placeholder="Battle Royale Squad"></div>
      <div class="field"><label for="cf-i">Icon (emoji)</label><input id="cf-i" type="text" name="icon" maxlength="8" value="✨"></div></div>
      <div class="field"><label for="cf-s">URL name</label><input id="cf-s" type="text" name="slug" maxlength="30" required pattern="[a-z0-9-]{3,30}" placeholder="battle-royale"><div class="hint">p/your-name — lowercase letters, numbers and dashes.</div></div>
      <div class="field"><label for="cf-d">Description</label><textarea id="cf-d" name="desc" maxlength="300" required style="min-height:70px"></textarea></div>
      <div class="field"><label for="cf-r">Rules (one per line)</label><textarea id="cf-r" name="rules" maxlength="1500" style="min-height:80px" placeholder="Be respectful&#10;No spam"></textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Create</button></div>
    </form>`);
  const f = $('#commForm');
  f.name.oninput = () => { if (!f.slug.dataset.touched) f.slug.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); };
  f.slug.oninput = () => f.slug.dataset.touched = '1';
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await act('createCommunity', { name: f.name.value, icon: f.icon.value, slug: f.slug.value, desc: f.desc.value, rules: f.rules.value }, 'Community created!');
    if (r) { closeModal(); location.hash = `#/c/${r.slug}`; }
  };
}
function openEditCommunity(id) {
  const c = community(id); if (!c || !canModerate(c)) return;
  const owner = c.createdBy === me().id;
  modal(`<h2>Manage p/${esc(c.slug)}</h2><form id="ecForm">
    <div class="grid-2"><div class="field"><label for="ec-n">Name</label><input id="ec-n" type="text" name="name" maxlength="50" required value="${esc(c.name)}"></div>
    <div class="field"><label for="ec-i">Icon (emoji)</label><input id="ec-i" type="text" name="icon" maxlength="8" value="${esc(c.icon)}"></div></div>
    <div class="field"><label for="ec-d">Description</label><textarea id="ec-d" name="desc" maxlength="300" style="min-height:70px">${esc(c.desc)}</textarea></div>
    <div class="field"><label for="ec-r">Rules (one per line)</label><textarea id="ec-r" name="rules" maxlength="1500" style="min-height:90px">${esc(c.rules.join('\n'))}</textarea></div>
    <div class="field"><label for="ec-m">Community moderators</label><input id="ec-m" type="text" name="mods" value="${esc((c.mods || []).map((i) => user(i)?.handle).filter(Boolean).join(', '))}" placeholder="kavya, leo" ${owner ? '' : 'disabled'}><div class="hint">${owner ? 'Usernames, comma separated. They can pin and remove posts and comments here.' : 'Only the community owner can change moderators.'}</div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Save</button></div></form>`);
  $('#ecForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (await act('editCommunity', { id, name: f.name.value, icon: f.icon.value, desc: f.desc.value, rules: f.rules.value, mods: f.mods.value }, 'Community updated')) closeModal();
  };
}

/* Tools */
const toolState = { cat: '', sort: 'top' };
function viewTools() {
  const m = me();
  let list = db.tools.filter((t) => t.status !== 'pending');
  const mine = m ? db.tools.filter((t) => t.status === 'pending' && t.addedBy === m.id) : [];
  if (toolState.cat === 'offers') list = list.filter((t) => t.isOffer);
  else if (toolState.cat) list = list.filter((t) => t.category === toolState.cat);
  list.sort(toolState.sort === 'new' ? (a, b) => b.createdAt - a.createdAt : (a, b) => b.upvotes.length - a.upvotes.length);
  return `<div class="page single">
    <div class="row between" style="margin-bottom:10px"><div><h1>Tools & Offers</h1><p class="muted">Discover AI tools, dev tools, GitHub repos and limited-time deals — shared by the community.</p></div><button class="btn btn-primary" data-act="new-tool">＋ Share a tool</button></div>
    ${mine.length ? `<div class="notice info" style="margin-bottom:12px">⏳ Waiting for moderator approval: ${mine.map((t) => esc(t.name)).join(', ')}</div>` : ''}
    <div class="chips" style="margin-bottom:8px"><button class="chip ${!toolState.cat ? 'active' : ''}" data-cat="">All</button><button class="chip ${toolState.cat === 'offers' ? 'active' : ''}" data-cat="offers">🎁 Offers & deals</button>${TOOL_CATEGORIES.map((c) => `<button class="chip ${toolState.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="tabs"><button class="tab ${toolState.sort === 'top' ? 'active' : ''}" data-tsort="top">Most upvoted</button><button class="tab ${toolState.sort === 'new' ? 'active' : ''}" data-tsort="new">Newest</button></div>
    <div class="grid-2">${list.map((t) => {
      const up = m && t.upvotes.includes(m.id), url = safeUrl(t.url);
      return `<div class="card"><div class="row between"><strong>${esc(t.name)}</strong><span class="tag">${esc(t.category)}</span></div>
        ${t.isOffer ? `<div style="margin-top:4px"><span class="pill pill-warn">🎁 Offer${t.expires ? ` · until ${esc(t.expires)}` : ''}</span></div>` : ''}
        <p class="small" style="margin-top:6px">${esc(t.desc)}</p>
        <div class="row between"><span class="small muted">by ${userLink(user(t.addedBy))}</span><span class="row"><button class="btn btn-sm ${up ? 'btn-primary' : ''}" data-act="upvote-tool" data-id="${t.id}">▲ ${t.upvotes.length}</button>${url ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">Open ↗</a>` : ''}</span></div></div>`;
    }).join('') || '<div class="card empty">No tools in this category yet.</div>'}</div>
  </div>`;
}
function afterTools(root) {
  $$('[data-cat]', root).forEach((b) => b.onclick = () => { toolState.cat = b.dataset.cat; render(); });
  $$('[data-tsort]', root).forEach((b) => b.onclick = () => { toolState.sort = b.dataset.tsort; render(); });
}
function openNewTool() {
  if (!requireLogin()) return;
  modal(`<h2>Share a tool or offer</h2><form id="toolForm">
    <div class="field"><label for="tf-n">Name</label><input id="tf-n" type="text" name="name" required maxlength="80"></div>
    <div class="field"><label for="tf-u">Link</label><input id="tf-u" type="url" name="url" required placeholder="https://"></div>
    <div class="field"><label for="tf-c">Category</label><select id="tf-c" name="category">${TOOL_CATEGORIES.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
    <div class="field"><label for="tf-d">What is it for?</label><textarea id="tf-d" name="desc" required maxlength="300" style="min-height:70px"></textarea></div>
    <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="isOffer"> This is a limited-time offer or deal</label></div>
    <div class="field" id="expWrap" hidden><label for="tf-e">Offer ends</label><input id="tf-e" type="date" name="expires"></div>
    ${db.settings.toolApproval && !isStaff() ? '<p class="hint">New tools appear after a moderator approves them.</p>' : ''}
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Share</button></div></form>`);
  const f = $('#toolForm');
  f.isOffer.onchange = () => $('#expWrap').hidden = !f.isOffer.checked;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await act('createTool', { name: f.name.value, url: f.url.value, category: f.category.value, desc: f.desc.value, isOffer: f.isOffer.checked, expires: f.expires.value },
      (res) => (res.pending ? 'Submitted! It appears once a moderator approves it.' : 'Thanks for sharing!'));
    if (r) { closeModal(); toolState.sort = 'new'; render(); }
  };
}

/* Project Vault */
const vaultState = { status: '' };
function projectCard(p) {
  const o = user(p.ownerId);
  return `<a class="card" href="#/vault/${p.id}" style="display:block">
    <div class="row between"><strong style="font-size:1.05rem">${esc(p.name)}</strong>${statusPill(p.status)}</div>
    <p class="small muted" style="margin:4px 0 8px">${esc(p.tagline)}</p>
    ${progressBar(currentPct(p))}
    <div class="chips" style="margin-top:8px">${p.tech.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${p.visibility === 'closed' ? '<span class="tag">🔒 Closed source</span>' : '<span class="tag">🔓 Open source</span>'}</div>
    <div class="small muted" style="margin-top:8px">by ${esc(o?.name)} · ${plural(p.updates.length, 'update')} · active ${ago(lastUpdate(p))}</div>
  </a>`;
}
function viewVault() {
  let list = db.projects.slice().sort((a, b) => lastUpdate(b) - lastUpdate(a));
  if (vaultState.status) list = list.filter((p) => p.status === vaultState.status);
  return `<div class="page single">
    <div class="row between" style="margin-bottom:10px"><div><h1>🗄️ Project Vault</h1><p class="muted">Every project gets its own permanent page — description, status, tech, links and a full timeline of updates. Your code can stay private.</p></div><a class="btn btn-primary" href="#/vault/new">＋ Add project</a></div>
    <div class="chips" style="margin-bottom:14px"><button class="chip ${!vaultState.status ? 'active' : ''}" data-vstatus="">All</button>${Object.entries(PROJECT_STATUS).map(([k, v]) => `<button class="chip ${vaultState.status === k ? 'active' : ''}" data-vstatus="${k}">${v}</button>`).join('')}</div>
    <div class="grid-2">${list.map(projectCard).join('') || '<div class="card empty">No projects yet.</div>'}</div>
  </div>`;
}
function afterVault(root) { $$('[data-vstatus]', root).forEach((b) => b.onclick = () => { vaultState.status = b.dataset.vstatus; render(); }); }
function viewProject(id) {
  const p = project(id); if (!p) return notFound();
  const o = user(p.ownerId), m = me(), mine = m && m.id === p.ownerId;
  const demo = safeUrl(p.demo), repo = safeUrl(p.repo);
  const related = db.posts.filter((x) => x.projectId === p.id).sort((a, b) => b.createdAt - a.createdAt);
  const wins = db.champ.winners.filter((w) => w.projectId === p.id);
  return `<div class="page">
    <div class="stack">
      <div class="hero">
        <div class="row between"><div class="row">${statusPill(p.status)}${p.visibility === 'closed' ? '<span class="tag">🔒 Closed source</span>' : '<span class="tag">🔓 Open source</span>'}${wins.length ? `<span class="champ-badge">🏆 ${plural(wins.length, 'Championship win')}</span>` : ''}</div>${mine ? `<a class="btn btn-sm" href="#/vault/${p.id}/edit">Edit</a>` : ''}</div>
        <h1 style="margin-top:10px">${esc(p.name)}</h1>
        <p class="muted">${esc(p.tagline)}</p>
        <div class="row small">${avatar(o, 'sm')} ${userLink(o)} <span class="muted">· started ${ago(p.createdAt)}</span></div>
        <div class="row" style="margin-top:12px">${demo ? `<a class="btn btn-primary" href="${esc(demo)}" target="_blank" rel="noopener noreferrer nofollow">▶ Live demo</a>` : ''}${repo ? `<a class="btn" href="${esc(repo)}" target="_blank" rel="noopener noreferrer nofollow">⌥ Source code</a>` : ''}${m && !mine ? `<a class="btn" href="#/messages/${esc(o.handle)}">✉ Contact builder</a><button class="btn" data-act="report" data-kind="project" data-id="${p.id}">⚑ Report</button>` : ''}</div>
      </div>
      <div class="card"><h3>About</h3><div class="post-body">${esc(p.desc)}</div>${p.lookingFor ? `<div class="notice info" style="margin-top:10px">🤝 Looking for: ${esc(p.lookingFor)}</div>` : ''}</div>
      <div class="card">
        <div class="row between"><h3>Development timeline</h3>${mine ? `<button class="btn btn-sm btn-primary" data-act="add-update" data-id="${p.id}">＋ Add update</button>` : ''}</div>
        <div class="row between small" style="margin:6px 0"><strong>${currentPct(p)}% complete</strong><span class="muted">${plural(p.updates.length, 'milestone')}</span></div>
        ${progressBar(currentPct(p))}
        <div class="timeline" style="margin-top:16px">${p.updates.slice().reverse().map((u) => `<div class="tl-item"><div class="row between"><strong>${esc(u.title)}</strong><span class="small muted">${ago(u.createdAt)} · ${u.percent}%</span></div>${u.body ? `<div class="small post-body">${esc(u.body)}</div>` : ''}</div>`).join('') || '<div class="muted">No updates yet.</div>'}</div>
      </div>
      ${related.length ? `<h3>Posts about this project</h3>${related.map((x) => postCard(x)).join('')}` : ''}
    </div>
    <aside class="rail">
      <div class="card"><h3>Tech stack</h3><div class="chips">${p.tech.map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted small">Not listed</span>'}</div></div>
      ${mine ? '<div class="card"><h3>Patch Championship</h3><p class="small muted">Enter this project in this month\'s championship.</p><a class="btn btn-gold btn-sm" href="#/championship">🏆 Submit entry</a></div>' : ''}
      ${wins.length ? `<div class="card"><h3>Trophies</h3>${wins.map((w) => `<div class="small" style="padding:3px 0">🏆 ${esc(catName(w.category))} · ${esc(shortMonth(w.month))}</div>`).join('')}</div>` : ''}
    </aside>
  </div>`;
}
function viewProjectForm(id) {
  if (!me()) return loginWall('add a project');
  const p = id ? project(id) : null;
  if (id && (!p || p.ownerId !== me().id)) return notFound();
  const v = p || { name: '', tagline: '', desc: '', status: 'building', visibility: 'closed', tech: [], demo: '', repo: '', lookingFor: '' };
  return `<div class="page single"><div class="card"><h1>${p ? 'Edit project' : 'Add a project to the Vault'}</h1>
    <p class="muted small">Your project gets a permanent page you can keep updating. It does not have to be open source.</p>
    <form id="projForm">
      <div class="field"><label for="jf-n">Project name</label><input id="jf-n" type="text" name="name" required maxlength="60" value="${esc(v.name)}"></div>
      <div class="field"><label for="jf-t">Tagline</label><input id="jf-t" type="text" name="tagline" required maxlength="120" value="${esc(v.tagline)}" placeholder="One line: what does it do?"></div>
      <div class="field"><label for="jf-d">Description</label><textarea id="jf-d" name="desc" maxlength="5000">${esc(v.desc)}</textarea></div>
      <div class="grid-2">
        <div class="field"><label for="jf-s">Status</label><select id="jf-s" name="status">${Object.entries(PROJECT_STATUS).map(([k, l]) => `<option value="${k}" ${v.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="jf-v">Source</label><select id="jf-v" name="visibility"><option value="closed" ${v.visibility === 'closed' ? 'selected' : ''}>🔒 Closed source (private code)</option><option value="open" ${v.visibility === 'open' ? 'selected' : ''}>🔓 Open source</option></select></div>
      </div>
      <div class="field"><label for="jf-tech">Tech stack</label><input id="jf-tech" type="text" name="tech" value="${esc(v.tech.join(', '))}" placeholder="React, Python, Godot"></div>
      <div class="grid-2">
        <div class="field"><label for="jf-demo">Demo link</label><input id="jf-demo" type="url" name="demo" value="${esc(v.demo)}" placeholder="https://"></div>
        <div class="field"><label for="jf-repo">Repository (optional)</label><input id="jf-repo" type="url" name="repo" value="${esc(v.repo)}" placeholder="https://github.com/…"></div>
      </div>
      <div class="field"><label for="jf-lf">Looking for (optional)</label><input id="jf-lf" type="text" name="lookingFor" maxlength="140" value="${esc(v.lookingFor)}" placeholder="Testers, a co-founder, an artist…"></div>
      ${p ? '' : '<div class="field"><label for="jf-pct">Current progress: <span id="jpOut">20</span>%</label><input id="jf-pct" type="range" name="percent" min="0" max="100" value="20"></div>'}
      <div class="row" style="justify-content:flex-end">${p ? `<button type="button" class="btn btn-danger" data-act="delete-project" data-id="${p.id}">Delete</button>` : ''}<a class="btn" href="${p ? `#/vault/${p.id}` : '#/vault'}">Cancel</a><button class="btn btn-primary">${p ? 'Save' : 'Create project page'}</button></div>
    </form></div></div>`;
}
function afterProjectForm(root, id) {
  const f = $('#projForm', root); if (!f) return;
  if (f.percent) f.percent.oninput = () => $('#jpOut', root).textContent = f.percent.value;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const r = await act('saveProject', { id, name: f.name.value, tagline: f.tagline.value, desc: f.desc.value, status: f.status.value, visibility: f.visibility.value, tech: f.tech.value, demo: f.demo.value, repo: f.repo.value, lookingFor: f.lookingFor.value, percent: f.percent?.value }, id ? 'Saved' : 'Project page created!');
    if (r) location.hash = `#/vault/${r.id}`;
  };
}
function openAddUpdate(id) {
  const p = project(id);
  const comms = db.communities.filter((c) => c.members.includes(me().id)).concat(db.communities.filter((c) => !c.members.includes(me().id)));
  modal(`<h2>Add a milestone</h2><p class="muted small">Added a character? New environment? Log it here so your project's story stays in one place.</p><form id="updForm">
    <div class="field"><label for="uf-t">Title</label><input id="uf-t" type="text" name="title" required maxlength="100" placeholder="Added player movement"></div>
    <div class="field"><label for="uf-b">Details</label><textarea id="uf-b" name="body" maxlength="3000" style="min-height:80px"></textarea></div>
    <div class="field"><label for="uf-p">Progress: <span id="ufOut">${currentPct(p)}</span>%</label><input id="uf-p" type="range" name="percent" min="0" max="100" value="${currentPct(p)}"></div>
    ${comms.length ? `<div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="share" checked> Also share as a progress post in the feed</label></div>
    <div class="field" id="ufComm"><label for="uf-c">Community</label><select id="uf-c" name="communityId">${comms.map((c) => `<option value="${c.id}">p/${esc(c.slug)}</option>`).join('')}</select></div>` : ''}
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Add update</button></div></form>`);
  const f = $('#updForm');
  f.percent.oninput = () => $('#ufOut').textContent = f.percent.value;
  if (f.share) f.share.onchange = () => $('#ufComm').hidden = !f.share.checked;
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (await act('addUpdate', { projectId: id, title: f.title.value, body: f.body.value, percent: f.percent.value, share: !!f.share?.checked, communityId: f.communityId?.value }, 'Milestone added')) closeModal();
  };
}

/* Championship */
const champState = { cat: CHAMP_CATEGORIES[0].id, tab: 'vote' };
function eligibility(u) {
  if (!u) return 'Log in to take part.';
  if (u.banned) return 'Suspended accounts cannot enter.';
  if (accountAgeDays(u) < minAge() && !isStaff(u)) return `Accounts must be at least ${plural(minAge(), 'day')} old to submit.`;
  if (!db.projects.some((p) => p.ownerId === u.id)) return 'Add a project to the Vault first — entries are Vault projects.';
  return null;
}
const tally = (mk, cat) => db.champ.submissions.filter((s) => s.month === mk && s.category === cat).map((s) => ({ ...s, votes: db.champ.counts[s.id] || 0 })).sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt);
function viewChampionship() {
  const m = me(), mk = monthKey(), closed = db.champ.closed.includes(mk);
  const year = String(new Date().getFullYear());
  const tabs = { vote: '🗳️ This month', winners: '🏆 Hall of champions', yearly: '👑 Yearly race' };
  let body = '';
  if (champState.tab === 'vote') {
    const entries = tally(mk, champState.cat);
    const myVote = m && db.champ.votes.find((v) => v.month === mk && v.category === champState.cat && v.voterId === m.id);
    const why = eligibility(m);
    const mySub = m && db.champ.submissions.find((s) => s.month === mk && s.category === champState.cat && s.userId === m.id);
    body = `<div class="chips" style="margin-bottom:12px">${CHAMP_CATEGORIES.map((c) => `<button class="chip ${champState.cat === c.id ? 'active' : ''}" data-ccat="${c.id}">${c.icon} ${c.name}</button>`).join('')}</div>
      <div class="card" style="margin-bottom:12px"><div class="row between"><div><strong>${catIcon(champState.cat)} ${esc(catName(champState.cat))} — ${esc(monthLabel(mk))}</strong><div class="small muted">${plural(entries.length, 'entry', 'entries')} · ${closed ? 'Voting closed' : myVote ? 'You have voted in this category (you can change it)' : 'You have 1 vote in this category'} · Voting closes automatically at month end</div></div>
        ${closed ? '' : mySub ? '<span class="pill pill-good">✓ You entered this category</span>' : `<button class="btn btn-gold btn-sm" data-act="submit-entry" ${why ? 'disabled' : ''}>🏆 Submit my project</button>`}</div>
        ${!closed && why && !mySub ? `<div class="hint">${esc(why)}</div>` : ''}</div>
      ${entries.map((s, i) => {
        const p = project(s.projectId), o = user(s.userId), mine = myVote && myVote.submissionId === s.id, own = m && s.userId === m.id;
        return `<div class="card sub-card"><div class="row" style="align-items:flex-start">
          <div class="votes" style="min-width:44px;text-align:center"><div style="font-size:1.3rem">${s.votes}</div><div class="small muted">votes</div></div>
          <div style="flex:1;min-width:0"><div class="row"><a href="#/vault/${p?.id}"><strong>${esc(p?.name || 'Deleted project')}</strong></a>${i === 0 && s.votes ? '<span class="pill pill-gold">Leading</span>' : ''}${p ? statusPill(p.status) : ''}</div>
            <div class="small muted">${avatar(o, 'sm')} ${userLink(o)}</div>
            <p class="small" style="margin-top:6px">${esc(s.note || p?.tagline || '')}</p>
            <div class="chips">${(p?.tech || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
          <div>${closed ? '' : own ? '<span class="small muted">Your entry</span>' : `<button class="btn btn-sm ${mine ? 'btn-primary' : ''}" data-act="champ-vote" data-id="${s.id}">${mine ? '✓ Voted' : 'Vote'}</button>`}</div>
        </div></div>`;
      }).join('') || '<div class="card empty">No entries yet in this category. Be the first to submit!</div>'}`;
  } else if (champState.tab === 'winners') {
    const months = [...new Set(db.champ.winners.map((w) => w.month))].sort().reverse();
    body = months.map((mo) => `<div class="card"><h3>${esc(monthLabel(mo))} champions</h3><div class="grid-3">${CHAMP_CATEGORIES.map((c) => {
      const w = db.champ.winners.find((x) => x.month === mo && x.category === c.id);
      if (!w) return `<div class="small muted">${c.icon} ${c.name}: no entries</div>`;
      const u = user(w.userId);
      return `<div class="trophy"><span class="cup">${c.icon}</span><div style="min-width:0"><div class="small muted">${esc(c.name)}</div><a href="#/u/${esc(u?.handle)}"><strong>${esc(u?.name)}</strong></a><div class="small muted">${esc(w.projectName)} · ${w.votes} votes</div></div></div>`;
    }).join('')}</div></div>`).join('') || '<div class="card empty">No champions yet.</div>';
  } else {
    const counts = {};
    db.champ.winners.filter((w) => w.month.startsWith(year)).forEach((w) => { const k = `${w.category}|${w.userId}`; counts[k] = (counts[k] || 0) + 1; });
    const past = yearly().sort((a, b) => b.year - a.year);
    body = `<div class="card"><h3>${year} race — trophies so far</h3><p class="small muted">The builder with the most monthly trophies in a category after all 12 months becomes that year's champion and earns a permanent 👑 badge.</p>
      <div class="grid-2">${CHAMP_CATEGORIES.map((c) => {
        const rows = Object.entries(counts).filter(([k]) => k.startsWith(c.id + '|')).map(([k, n]) => [k.split('|')[1], n]).sort((a, b) => b[1] - a[1]).slice(0, 3);
        return `<div class="card" style="box-shadow:none"><strong>${c.icon} ${c.name}</strong>${rows.map(([uId, n], i) => `<div class="row between small" style="padding:4px 0"><span>${['🥇', '🥈', '🥉'][i]} ${userLink(user(uId))}</span><span class="mono">${n} 🏆</span></div>`).join('') || '<div class="small muted">No trophies yet</div>'}</div>`;
      }).join('')}</div></div>
      ${past.length ? `<h2 style="margin-top:18px">Yearly champions</h2>${[...new Set(past.map((p) => p.year))].map((y) => `<div class="card yearly"><h3>👑 ${y} Champions of the Year</h3><div class="grid-3">${past.filter((p) => p.year === y).map((p) => `<div><div class="small muted">${catIcon(p.category)} ${esc(catName(p.category))}</div>${userLink(user(p.userId))}<div class="small muted">${p.trophies} of 12 months won</div></div>`).join('')}</div></div>`).join('')}` : ''}`;
  }
  return `<div class="page single">
    <div class="hero"><h1>🏆 Patch Championship</h1><p class="muted">Each month builders submit projects into categories. The community votes — one vote per person, per category. The top entry in each category becomes that month's <strong>Verified Champion</strong>, and every win stays forever in their trophy room.</p></div>
    <div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button class="tab ${champState.tab === k ? 'active' : ''}" data-ctab="${k}">${v}</button>`).join('')}</div>
    ${body}
  </div>`;
}
function afterChampionship(root) {
  $$('[data-ccat]', root).forEach((b) => b.onclick = () => { champState.cat = b.dataset.ccat; render(); });
  $$('[data-ctab]', root).forEach((b) => b.onclick = () => { champState.tab = b.dataset.ctab; render(); });
}
function openSubmitEntry() {
  const m = me(), mk = monthKey();
  const mine = db.projects.filter((p) => p.ownerId === m.id);
  modal(`<h2>Submit to ${esc(catName(champState.cat))}</h2><p class="small muted">${esc(monthLabel(mk))} · one entry per category per month.</p><form id="subForm">
    <div class="field"><label for="sf-p">Project</label><select id="sf-p" name="projectId">${mine.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
    <div class="field"><label for="sf-n">Why should people vote for it?</label><textarea id="sf-n" name="note" maxlength="300" style="min-height:80px" placeholder="What is special, who is it useful for…"></textarea></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-gold">Submit entry</button></div></form>`);
  $('#subForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (await act('submitEntry', { category: champState.cat, projectId: f.projectId.value, note: f.note.value }, 'Entry submitted — good luck!')) closeModal();
  };
}

/* Playlists */
const playlistCache = new Map(); // unlisted playlists opened by link
const plState = { id: null, idx: 0, autoplay: true };
const playlist = (id) => db.playlists.find((p) => p.id === id) || playlistCache.get(id);
function playlistCard(pl) {
  const o = user(pl.ownerId);
  const thumb = pl.items.map(post).filter(Boolean).flatMap((p) => p.media || []).find((m) => m.kind === 'image');
  return `<a class="card pl-card" href="#/playlist/${esc(pl.id)}">
    <div class="pl-thumb">${thumb ? `<img src="${mediaUrl(thumb)}" alt="" loading="lazy">` : '<span>🎞️</span>'}<span class="pl-count">${plural(pl.items.length, 'post')}</span></div>
    <div style="padding-top:10px"><strong>${esc(pl.name)}</strong><div class="small muted">by ${esc(o?.name)} · ${PLAYLIST_VISIBILITY[pl.visibility]}</div>${pl.description ? `<div class="small" style="margin-top:4px">${esc(pl.description.slice(0, 100))}</div>` : ''}</div></a>`;
}
function viewPlaylists() {
  const m = me();
  const mine = m ? db.playlists.filter((p) => p.ownerId === m.id) : [];
  const pub = db.playlists.filter((p) => p.visibility === 'public' && (!m || p.ownerId !== m.id));
  return `<div class="page single">
    <div class="row between" style="margin-bottom:10px"><div><h1>🎞️ Playlists</h1><p class="muted">Group posts, photos and videos into a named playlist and share one link. Great for devlogs, tutorials and showcases.</p></div>${m ? '<button class="btn btn-primary" data-act="new-playlist">＋ New playlist</button>' : ''}</div>
    ${m ? `<h3>Your playlists</h3><div class="grid-3" style="margin-bottom:18px">${mine.map(playlistCard).join('') || '<div class="card empty small" style="grid-column:1/-1">No playlists yet. Use “🎞️ Playlist” on any post to start one.</div>'}</div>` : ''}
    <h3>Public playlists</h3><div class="grid-3">${pub.map(playlistCard).join('') || '<div class="card empty small" style="grid-column:1/-1">No public playlists yet.</div>'}</div>
  </div>`;
}
function viewPlaylist(id) {
  const pl = playlist(id);
  if (!pl) {
    if (!playlistCache.has(id)) {
      playlistCache.set(id, null);
      api(`/api/playlists/${encodeURIComponent(id)}`).then((r) => { playlistCache.set(id, r.playlist); render(); }).catch(() => render());
      return '<div class="page single"><div class="card empty">Loading playlist…</div></div>';
    }
    return notFound();
  }
  if (plState.id !== id) { plState.id = id; plState.idx = 0; }
  const items = pl.items.map(post).filter(Boolean);
  plState.idx = Math.min(plState.idx, Math.max(0, items.length - 1));
  const cur = items[plState.idx], o = user(pl.ownerId), m = me(), mine = m && m.id === pl.ownerId;
  const player = !cur ? '<div class="card empty">This playlist is empty.</div>'
    : (cur.media || []).length ? `<div class="card player">
        ${cur.media[0].kind === 'video' ? `<video id="plVideo" class="player-media" src="${mediaUrl(cur.media[0])}" controls playsinline ${plState.play ? 'autoplay' : ''}></video>` : `<img class="player-media" src="${mediaUrl(cur.media[0])}" alt="">`}
        ${cur.media.length > 1 ? `<div class="gallery n4" style="margin-top:8px">${cur.media.slice(1).map((mm) => mm.kind === 'video' ? `<video class="media" src="${mediaUrl(mm)}" controls preload="metadata" playsinline></video>` : `<img class="media" src="${mediaUrl(mm)}" alt="" loading="lazy">`).join('')}</div>` : ''}
        <div class="post-title" style="margin-top:10px"><a href="#/post/${cur.id}">${esc(cur.title)}</a></div>
        <div class="small muted">${userLink(user(cur.authorId))} · ${ago(cur.createdAt)}</div>
        ${cur.body ? `<div class="post-body small" style="margin-top:6px">${esc(cur.body)}</div>` : ''}
      </div>` : postCard(cur, { full: true });
  return `<div class="page">
    <div class="stack">
      <div class="hero">
        <div class="row between"><span class="pill pill-accent">${PLAYLIST_VISIBILITY[pl.visibility]}</span>${mine ? `<div class="row"><button class="btn btn-sm" data-act="edit-playlist" data-id="${esc(pl.id)}">Edit</button><button class="btn btn-sm btn-danger" data-act="delete-playlist" data-id="${esc(pl.id)}">Delete</button></div>` : ''}</div>
        <h1 style="margin-top:10px">🎞️ ${esc(pl.name)}</h1>
        ${pl.description ? `<p class="muted">${esc(pl.description)}</p>` : ''}
        <div class="row small">${avatar(o, 'sm')} ${userLink(o)} <span class="muted">· ${plural(items.length, 'post')} · updated ${ago(pl.updatedAt)}</span></div>
        <div class="row" style="margin-top:12px">${pl.visibility !== 'private' ? `<button class="btn btn-primary" data-act="share" data-kind="playlist" data-id="${esc(pl.id)}">↗ Share link</button>` : '<span class="small muted">🔒 Private — make it public or unlisted to share.</span>'}${m && !mine ? `<button class="btn" data-act="report" data-kind="playlist" data-id="${esc(pl.id)}">⚑ Report</button>` : ''}</div>
      </div>
      ${items.length > 1 ? `<div class="row between"><button class="btn btn-sm" data-pl-nav="-1" ${plState.idx === 0 ? 'disabled' : ''}>⏮ Previous</button><span class="small muted">${plState.idx + 1} / ${items.length}</span><label class="row small" style="font-weight:500"><input type="checkbox" id="plAuto" ${plState.autoplay ? 'checked' : ''}> Autoplay next</label><button class="btn btn-sm" data-pl-nav="1" ${plState.idx >= items.length - 1 ? 'disabled' : ''}>Next ⏭</button></div>` : ''}
      ${player}
    </div>
    <aside class="rail"><div class="card pl-list"><h3>Up next</h3>
      ${items.map((p, i) => `<div class="pl-row ${i === plState.idx ? 'active' : ''}"><button class="pl-pick" data-pl-go="${i}"><span class="pl-num">${i === plState.idx ? '▶' : i + 1}</span>
        ${p.media?.[0] ? (p.media[0].kind === 'image' ? `<img src="${mediaUrl(p.media[0])}" alt="" loading="lazy">` : '<span class="pl-vid">▶</span>') : `<span class="pl-vid">${(POST_TYPES[p.type] || POST_TYPES.discussion).icon}</span>`}
        <span class="pl-title">${esc(p.title)}</span></button>
        ${mine ? `<span class="pl-tools"><button class="icon-btn" data-pl-move="up" data-post="${p.id}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon-btn" data-pl-move="down" data-post="${p.id}" aria-label="Move down" ${i === items.length - 1 ? 'disabled' : ''}>↓</button><button class="icon-btn" data-pl-rm="${p.id}" aria-label="Remove">✕</button></span>` : ''}</div>`).join('') || '<p class="small muted">Nothing here yet.</p>'}
    </div></aside>
  </div>`;
}
function afterPlaylist(root, id) {
  const go = (i, play = false) => { plState.idx = i; plState.play = play; render(); };
  $$('[data-pl-nav]', root).forEach((b) => b.onclick = () => go(plState.idx + Number(b.dataset.plNav)));
  $$('[data-pl-go]', root).forEach((b) => b.onclick = () => go(Number(b.dataset.plGo), true));
  const auto = $('#plAuto', root); if (auto) auto.onchange = () => plState.autoplay = auto.checked;
  const v = $('#plVideo', root);
  const total = playlist(id)?.items.map(post).filter(Boolean).length || 0;
  if (v) v.onended = () => { if (plState.autoplay && plState.idx < total - 1) go(plState.idx + 1, true); };
  plState.play = false;
  $$('[data-pl-move]', root).forEach((b) => b.onclick = () => act('playlistMove', { id, postId: b.dataset.post, dir: b.dataset.plMove }));
  $$('[data-pl-rm]', root).forEach((b) => b.onclick = () => act('playlistRemove', { id, postId: b.dataset.plRm }, 'Removed from playlist'));
}
function playlistForm(pl = {}) {
  return `<div class="field"><label for="pl-n">Playlist name</label><input id="pl-n" type="text" name="name" required maxlength="80" value="${esc(pl.name || '')}" placeholder="My Godot devlogs"></div>
    <div class="field"><label for="pl-d">Description (optional)</label><textarea id="pl-d" name="description" maxlength="500" style="min-height:60px">${esc(pl.description || '')}</textarea></div>
    <div class="field"><label for="pl-v">Who can see it?</label><select id="pl-v" name="visibility">${Object.entries(PLAYLIST_VISIBILITY).map(([k, l]) => `<option value="${k}" ${(pl.visibility || 'public') === k ? 'selected' : ''}>${l}</option>`).join('')}</select><div class="hint">Unlisted playlists don't show up anywhere — only people with the link can open them.</div></div>`;
}
function openNewPlaylist(postId) {
  modal(`<h2>New playlist</h2><form id="plForm">${playlistForm()}<div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Create</button></div></form>`);
  $('#plForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    const r = await act('createPlaylist', { name: f.name.value, description: f.description.value, visibility: f.visibility.value, postId }, 'Playlist created');
    if (r) { closeModal(); if (!postId) location.hash = `#/playlist/${r.id}`; else openAddToPlaylist(postId); }
  };
}
function openAddToPlaylist(postId) {
  if (!requireLogin()) return;
  const mine = db.playlists.filter((p) => p.ownerId === me().id);
  modal(`<h2>Save to playlist</h2>
    <div class="stack" style="margin-bottom:14px">${mine.map((pl) => `<label class="row pl-check" style="font-weight:500"><input type="checkbox" data-pl="${esc(pl.id)}" ${pl.items.includes(postId) ? 'checked' : ''}> <span style="flex:1">${esc(pl.name)}</span><span class="tag">${PLAYLIST_VISIBILITY[pl.visibility].split(' ')[0]} ${plural(pl.items.length, 'post')}</span></label>`).join('') || '<p class="muted small">You have no playlists yet.</p>'}</div>
    <button class="btn btn-primary" id="plNew">＋ New playlist</button>`);
  $$('[data-pl]').forEach((cb) => cb.onchange = async () => {
    cb.disabled = true;
    const ok = await act(cb.checked ? 'playlistAdd' : 'playlistRemove', { id: cb.dataset.pl, postId }, cb.checked ? 'Added to playlist' : 'Removed from playlist');
    if (ok === undefined) cb.checked = !cb.checked;
    cb.disabled = false;
  });
  $('#plNew').onclick = () => openNewPlaylist(postId);
}
function openEditPlaylist(id) {
  const pl = playlist(id);
  modal(`<h2>Edit playlist</h2><form id="plForm">${playlistForm(pl)}<div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Save</button></div></form>`);
  $('#plForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (await act('updatePlaylist', { id, name: f.name.value, description: f.description.value, visibility: f.visibility.value }, 'Playlist saved')) closeModal();
  };
}

/* Profiles */
const profState = { tab: 'posts' };
function viewProfile(handle) {
  const u = userByHandle(handle); if (!u) return notFound();
  const m = me(), isMe = m && m.id === u.id;
  const followers = db.users.filter((x) => x.following.includes(u.id));
  const following = m && m.following.includes(u.id);
  if (!u.isPublic && !isMe) return `<div class="page single"><div class="card empty">${avatar(u, 'lg')}<h2 style="margin-top:10px">${esc(u.name)}</h2><p>This profile is private.</p></div></div>`;
  const wins = db.champ.winners.filter((w) => w.userId === u.id).sort((a, b) => (a.month < b.month ? 1 : -1));
  const yearlyWins = yearly().filter((y) => y.userId === u.id);
  const posts = db.posts.filter((p) => p.authorId === u.id).sort((a, b) => b.createdAt - a.createdAt);
  const projects = db.projects.filter((p) => p.ownerId === u.id);
  const lists = db.playlists.filter((p) => p.ownerId === u.id && (isMe || p.visibility === 'public'));
  let tab = '';
  if (profState.tab === 'posts') tab = posts.map((p) => postCard(p)).join('') || '<div class="card empty">No posts yet.</div>';
  if (profState.tab === 'media') { const media = posts.filter((p) => p.media?.length); tab = media.length ? `<div class="media-grid">${media.flatMap((p) => p.media.map((mm) => `<a href="#/post/${p.id}" class="media-tile">${mm.kind === 'video' ? `<video src="${mediaUrl(mm)}" preload="metadata" muted></video><span class="pl-vid">▶</span>` : `<img src="${mediaUrl(mm)}" alt="" loading="lazy">`}</a>`)).join('')}</div>` : '<div class="card empty">No photos or videos yet.</div>'; }
  if (profState.tab === 'projects') tab = projects.length ? `<div class="grid-2">${projects.map(projectCard).join('')}</div>` : '<div class="card empty">No projects in the Vault yet.</div>';
  if (profState.tab === 'playlists') tab = lists.length ? `<div class="grid-3">${lists.map(playlistCard).join('')}</div>` : '<div class="card empty">No playlists yet.</div>';
  if (profState.tab === 'trophies') tab = `<div class="card"><h2>🏆 Trophy room</h2>
    ${yearlyWins.map((y) => `<div class="trophy yearly" style="margin-bottom:10px"><span class="cup">👑</span><div><strong>${y.year} ${esc(catName(y.category))} — Champion of the Year</strong><div class="small muted">Won ${y.trophies} of 12 months</div></div></div>`).join('')}
    ${wins.length ? `<div class="grid-3">${wins.map((w) => `<div class="trophy"><span class="cup">${catIcon(w.category)}</span><div style="min-width:0"><strong>${esc(shortMonth(w.month))}</strong><div class="small muted">${esc(catName(w.category))}</div><div class="small muted">${esc(w.projectName)} · ${w.votes} votes</div></div></div>`).join('')}</div>` : '<div class="empty">No trophies yet. Enter the <a class="link" href="#/championship">Championship</a>!</div>'}</div>`;
  return `<div class="page single">
    <div class="card"><div class="row" style="align-items:flex-start;gap:16px">${avatar(u, 'lg')}
      <div style="flex:1;min-width:0"><h1 style="margin:0">${esc(u.name)}${badges(u)}</h1><div class="muted">@${esc(u.handle)} · joined ${ago(u.joinedAt)}</div>
        <p style="margin-top:8px">${esc(u.bio)}</p>
        <div class="chips">${u.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
        <div class="row small" style="margin-top:10px"><strong>${followers.length}</strong> followers · <strong>${u.following.length}</strong> following · <strong>${wins.length}</strong> trophies ${u.openToWork ? '<span class="pill pill-good">💼 Open to work & collabs</span>' : ''} ${!u.isPublic ? '<span class="pill pill-warn">🔒 Private profile</span>' : ''} ${u.banned ? '<span class="pill pill-warn">⛔ Suspended</span>' : ''}</div>
      </div>
      <div class="row">${isMe ? '<button class="btn" data-act="edit-profile">Edit profile</button><a class="btn" href="#/settings">🔐 Security</a>' : m ? `<button class="btn ${following ? '' : 'btn-primary'}" data-act="follow" data-id="${u.id}">${following ? 'Following ✓' : '＋ Follow'}</button><a class="btn" href="#/messages/${esc(u.handle)}">✉ Message</a><button class="btn" data-act="report" data-kind="user" data-id="${u.id}" title="Report user">⚑</button>` : ''}</div>
    </div></div>
    <div class="tabs" style="margin-top:14px">${[['posts', `Posts (${posts.length})`], ['media', '📸 Media'], ['projects', `Projects (${projects.length})`], ['playlists', `🎞️ Playlists (${lists.length})`], ['trophies', `🏆 Trophy room (${wins.length})`]].map(([k, l]) => `<button class="tab ${profState.tab === k ? 'active' : ''}" data-ptab="${k}">${l}</button>`).join('')}</div>
    ${tab}
  </div>`;
}
function afterProfile(root) { $$('[data-ptab]', root).forEach((b) => b.onclick = () => { profState.tab = b.dataset.ptab; render(); }); }
function openEditProfile() {
  const u = me();
  modal(`<h2>Edit profile</h2><form id="profForm">
    <div class="field"><label for="ef-n">Display name</label><input id="ef-n" type="text" name="name" maxlength="50" required value="${esc(u.name)}"></div>
    <div class="field"><label for="ef-b">Bio</label><textarea id="ef-b" name="bio" maxlength="300" style="min-height:70px">${esc(u.bio)}</textarea></div>
    <div class="field"><label for="ef-s">Skills</label><input id="ef-s" type="text" name="skills" value="${esc(u.skills.join(', '))}"></div>
    <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="openToWork" ${u.openToWork ? 'checked' : ''}> 💼 Open to freelance work & collaborations</label><div class="hint">Shows you on the Opportunities page so clients, creators and brands can find you.</div></div>
    <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="isPublic" ${u.isPublic ? 'checked' : ''}> Public profile (others can see your posts and trophy room)</label></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Save</button></div></form>`);
  $('#profForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (await act('editProfile', { name: f.name.value, bio: f.bio.value, skills: f.skills.value, openToWork: f.openToWork.checked, isPublic: f.isPublic.checked }, 'Profile updated')) closeModal();
  };
}

/* Account security settings */
let accountInfo = null;
function viewSettings() {
  if (!me()) return loginWall('manage your account');
  if (!accountInfo) {
    api('/api/account').then((a) => { accountInfo = a; render(); }).catch((e) => toast(e.message));
    return '<div class="page single"><div class="card empty">Loading…</div></div>';
  }
  const a = accountInfo;
  return `<div class="page single">
    <h1>🔐 Account & security</h1>
    <div class="card"><h3>Login</h3><p class="small muted">You sign in with your username <strong>@${esc(a.username)}</strong> and password. Patch never asks for your email.</p>
      <form id="pwForm" class="grid-2"><div class="field"><label for="pw-c">Current password</label><input id="pw-c" type="password" name="current" autocomplete="current-password" required></div>
      <div class="field"><label for="pw-n">New password</label><input id="pw-n" type="password" name="next" autocomplete="new-password" minlength="8" required></div>
      <div><button class="btn btn-primary">Change password</button><div class="hint">Changing it logs out every other device.</div></div></form></div>
    <div class="card"><div class="row between"><h3>Two-factor authentication (2FA)</h3>${a.twoFactor ? '<span class="pill pill-good">✓ On</span>' : '<span class="pill pill-warn">Off</span>'}</div>
      <p class="small muted">Like Discord: after your password, Patch asks for a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password, Microsoft Authenticator).</p>
      ${a.twoFactor ? `<p class="small">Backup codes left: <strong>${a.backupCodesLeft}</strong></p><button class="btn" id="tfaOff">Turn off 2FA</button>` : '<button class="btn btn-primary" id="tfaOn">Turn on 2FA</button>'}</div>
    <div class="card"><h3>Recovery code</h3><p class="small muted">No email means no "forgot password" email. Your recovery code is how you get back in if you forget your password. You got one when you signed up.</p><button class="btn" id="newRecovery">Make a new recovery code</button></div>
    <div class="card"><div class="row between"><h3>Where you're logged in</h3>${a.sessions.length > 1 ? '<button class="btn btn-sm btn-danger" id="revokeAll">Log out all other devices</button>' : ''}</div>
      ${a.sessions.map((x) => `<div class="notif"><span>${x.kind === 'admin' ? '🛡️' : '💻'}</span><span style="flex:1"><strong>${esc(x.device)}</strong>${x.current ? ' <span class="pill pill-good">This device</span>' : ''}${x.kind === 'admin' ? ' <span class="pill pill-accent">Admin panel</span>' : ''}<div class="small muted">${esc(x.ip || '')} · active ${ago(x.lastSeen)} · signed in ${ago(x.createdAt)}</div></span>${x.current ? '' : `<button class="btn btn-sm" data-revoke="${esc(x.id)}">Log out</button>`}</div>`).join('')}</div>
    <div class="card"><h3>Log out</h3><button class="btn" data-act="logout">↩ Log out of this device</button></div>
  </div>`;
}
function afterSettings(root) {
  if (!accountInfo) return;
  const reload = async () => { accountInfo = await api('/api/account'); render(); };
  const pf = $('#pwForm', root);
  if (pf) pf.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/account/password', { method: 'POST', body: { current: pf.current.value, next: pf.next.value } }); toast('Password changed. Other devices were logged out.'); await reload(); } catch (err) { toast(err.message); }
  };
  $('#tfaOn', root)?.addEventListener('click', () => {
    modal(`<h2>Turn on 2FA</h2><form id="tfa1"><div class="field"><label for="t1-p">Confirm your password</label><input id="t1-p" type="password" name="password" autocomplete="current-password" required></div><button class="btn btn-primary">Continue</button></form>`);
    $('#tfa1').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/account/2fa/setup', { method: 'POST', body: { password: e.target.password.value } });
        modal(`<h2>Scan or type this key</h2><ol class="small"><li>Open your authenticator app and add a new account.</li><li>Choose “enter a setup key” and type the key below (or tap the link on your phone).</li><li>Enter the 6-digit code it shows.</li></ol>
          <div class="secret-box mono">${esc(r.secret.match(/.{1,4}/g).join(' '))}</div><p class="small"><a class="link" href="${esc(r.otpauth)}">Open in authenticator app</a></p>
          <form id="tfa2"><div class="field"><label for="t2-c">6-digit code</label><input id="t2-c" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div><button class="btn btn-primary">Turn on 2FA</button></form>`);
        $('#tfa2').onsubmit = async (ev) => {
          ev.preventDefault();
          try { const done = await api('/api/account/2fa/enable', { method: 'POST', body: { code: ev.target.code.value } }); showCodes('2FA is on ✓', 'Save these backup codes. Each one works once if you lose your phone.', done.backupCodes); await reload(); } catch (err) { toast(err.message); }
        };
      } catch (err) { toast(err.message); }
    };
  });
  $('#tfaOff', root)?.addEventListener('click', () => {
    modal(`<h2>Turn off 2FA</h2><form id="tfaX"><div class="field"><label for="tx-p">Password</label><input id="tx-p" type="password" name="password" required></div><div class="field"><label for="tx-c">6-digit code or backup code</label><input id="tx-c" type="text" name="code" required></div><button class="btn btn-danger">Turn off</button></form>`);
    $('#tfaX').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/account/2fa/disable', { method: 'POST', body: { password: e.target.password.value, code: e.target.code.value } }); closeModal(); toast('2FA turned off'); await reload(); } catch (err) { toast(err.message); } };
  });
  $('#newRecovery', root)?.addEventListener('click', () => {
    modal(`<h2>New recovery code</h2><p class="small muted">Your old code stops working.</p><form id="recF"><div class="field"><label for="rc-p">Password</label><input id="rc-p" type="password" name="password" required></div><button class="btn btn-primary">Make new code</button></form>`);
    $('#recF').onsubmit = async (e) => { e.preventDefault(); try { const r = await api('/api/account/recovery', { method: 'POST', body: { password: e.target.password.value } }); showCodes('Your new recovery code', 'Write it down or store it in a password manager. It is shown only once.', [r.recoveryCode]); } catch (err) { toast(err.message); } };
  });
  $('#revokeAll', root)?.addEventListener('click', async () => { try { await api('/api/account/sessions/revoke', { method: 'POST', body: { all: true } }); toast('Other devices logged out'); await reload(); } catch (err) { toast(err.message); } });
  $$('[data-revoke]', root).forEach((b) => b.onclick = async () => { try { await api('/api/account/sessions/revoke', { method: 'POST', body: { id: b.dataset.revoke } }); await reload(); } catch (err) { toast(err.message); } });
}
function showCodes(title, note, codes) {
  modal(`<h2>${esc(title)}</h2><p class="small muted">${esc(note)}</p><div class="secret-box mono">${codes.map(esc).join('<br>')}</div>
    <div class="row" style="margin-top:12px"><button class="btn" id="copyCodes">📋 Copy</button><button class="btn btn-primary" id="savedCodes">I saved it</button></div>`);
  $('#copyCodes').onclick = () => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Copied'), () => toast('Copy failed — select and copy manually'));
  $('#savedCodes').onclick = closeModal;
}

/* Opportunities */
function viewBuilders() {
  const list = db.users.filter((u) => u.openToWork && u.isPublic && !u.banned)
    .map((u) => ({ u, wins: db.champ.winners.filter((w) => w.userId === u.id).length, projects: db.projects.filter((p) => p.ownerId === u.id) }))
    .sort((a, b) => b.wins - a.wins || b.projects.length - a.projects.length);
  return `<div class="page single">
    <div class="hero"><h1>💼 Opportunities</h1><p class="muted">Builders open to freelance work and collaborations. Clients, creators and brands can browse real projects and championship records here — not just like counts.</p>${me() ? '<button class="btn btn-sm" data-act="edit-profile">Set my availability</button>' : ''}</div>
    <div class="grid-2">${list.map(({ u, wins, projects }) => `<div class="card"><div class="row">${avatar(u)}<div style="flex:1;min-width:0">${userLink(u)}<div class="small muted">@${esc(u.handle)}</div></div></div>
      <p class="small" style="margin-top:8px">${esc(u.bio)}</p>
      <div class="chips">${u.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
      <div class="small muted" style="margin-top:8px">${plural(projects.length, 'project')} · ${plural(wins, 'trophy', 'trophies')}</div>
      <div class="row" style="margin-top:10px"><a class="btn btn-sm" href="#/u/${esc(u.handle)}">View profile</a>${me() && me().id !== u.id ? `<a class="btn btn-sm btn-primary" href="#/messages/${esc(u.handle)}">✉ Reach out</a>` : ''}</div></div>`).join('') || '<div class="card empty">No builders are open to work right now.</div>'}</div>
  </div>`;
}

/* Messages */
function viewMessages(handle) {
  if (!me()) return loginWall('message builders');
  const m = me();
  const partners = new Map();
  db.messages.slice().sort((a, b) => b.createdAt - a.createdAt).forEach((x) => { const o = x.from === m.id ? x.to : x.from; if (!partners.has(o)) partners.set(o, x); });
  const other = handle ? userByHandle(handle) : user([...partners.keys()][0]);
  if (other && other.id !== m.id && !partners.has(other.id)) partners.set(other.id, null);
  const thread = other ? db.messages.filter((x) => (x.from === m.id && x.to === other.id) || (x.from === other.id && x.to === m.id)).sort((a, b) => a.createdAt - b.createdAt) : [];
  return `<div class="page single" style="max-width:1000px"><h1>Messages</h1><div class="card dm" style="padding:0">
    <div class="dm-list">${[...partners.entries()].map(([id, last]) => { const u = user(id); if (!u) return ''; const unread = last && last.to === m.id && !last.read; return `<a href="#/messages/${esc(u.handle)}" class="${other && other.id === id ? 'active' : ''}"><span class="avatar" style="background:${esc(u.color)}">${esc(u.name[0])}</span><span style="min-width:0;flex:1"><strong>${esc(u.name)}</strong>${unread ? ' <span class="pill pill-accent">new</span>' : ''}<div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${last ? esc(last.body) : 'Start a conversation'}</div></span></a>`; }).join('') || '<div class="empty small">No conversations yet. Visit a profile and hit Message.</div>'}</div>
    <div class="dm-thread">${other && other.id !== m.id ? `<div class="row" style="padding:10px 14px;border-bottom:1px solid var(--border)">${avatar(other, 'sm')} ${userLink(other)}</div>
      <div class="dm-msgs" id="dmMsgs">${thread.map((x) => `<div class="bubble ${x.from === m.id ? 'me' : ''}">${esc(x.body)}<div class="small" style="opacity:.7">${ago(x.createdAt)}</div></div>`).join('') || '<div class="muted small">Say hi 👋 — talk about collabs, feedback or testing.</div>'}</div>
      <form class="dm-form" id="dmForm" data-to="${other.id}"><input type="text" name="body" placeholder="Message ${esc(other.name)}…" maxlength="2000" autocomplete="off" required><button class="btn btn-primary">Send</button></form>` : '<div class="empty">Select a conversation</div>'}</div>
  </div></div>`;
}
function afterMessages(root) {
  const box = $('#dmMsgs', root); if (box) box.scrollTop = box.scrollHeight;
  const f = $('#dmForm', root); if (!f) return;
  const to = f.dataset.to;
  if (db.messages.some((x) => x.from === to && x.to === me().id && !x.read)) act('readThread', { userId: to });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = f.body.value.trim(); if (!body) return;
    if (await act('sendMessage', { to, body }) !== undefined) setTimeout(() => $('#dmForm input')?.focus(), 0);
  };
}

/* Notifications, Saved, Search */
function viewNotifications() {
  if (!me()) return loginWall('see notifications');
  const list = db.notifications.slice().sort((a, b) => b.createdAt - a.createdAt);
  return `<div class="page single"><div class="row between"><h1>Notifications</h1>${list.some((n) => !n.read) ? '<button class="btn btn-sm" data-act="read-all">Mark all read</button>' : ''}</div><div class="card">${list.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link && n.link.startsWith('#/') ? n.link : '#/notifications')}" data-nid="${esc(n.id)}"><span>${n.read ? '○' : '●'}</span><span style="flex:1">${esc(n.text)}<div class="small muted">${ago(n.createdAt)}</div></span></a>`).join('') || '<div class="empty">You are all caught up.</div>'}</div></div>`;
}
function afterNotifications(root) { $$('[data-nid]', root).forEach((a) => a.addEventListener('click', () => { const n = db.notifications.find((x) => x.id === a.dataset.nid); if (n && !n.read) act('readNotif', { id: n.id }); })); }
function viewSaved() {
  if (!me()) return loginWall('save posts');
  const list = db.posts.filter((p) => p.saves.includes(me().id));
  return `<div class="page single"><h1>🔖 Saved</h1>${list.map((p) => postCard(p)).join('') || '<div class="card empty">Save useful posts to find them later.</div>'}</div>`;
}
function viewSearch(q) {
  const s = q.toLowerCase();
  const has = (...f) => f.some((x) => String(x || '').toLowerCase().includes(s));
  const posts = db.posts.filter((p) => has(p.title, p.body, p.tags?.join(' ')));
  const projects = db.projects.filter((p) => has(p.name, p.tagline, p.desc, p.tech.join(' ')));
  const tools = db.tools.filter((t) => t.status !== 'pending' && has(t.name, t.desc, t.category));
  const people = db.users.filter((u) => u.isPublic && has(u.name, u.handle, u.skills.join(' ')));
  const comms = db.communities.filter((c) => has(c.name, c.slug, c.desc));
  const lists = db.playlists.filter((p) => p.visibility === 'public' && has(p.name, p.description));
  const none = !posts.length && !projects.length && !tools.length && !people.length && !comms.length && !lists.length;
  return `<div class="page single"><h1>Results for “${esc(q)}”</h1>
    ${comms.length ? `<h3>Communities</h3><div class="chips" style="margin-bottom:12px">${comms.map((c) => `<a class="chip" href="#/c/${esc(c.slug)}">${esc(c.icon)} p/${esc(c.slug)}</a>`).join('')}</div>` : ''}
    ${people.length ? `<h3>People</h3><div class="chips" style="margin-bottom:12px">${people.map((u) => `<a class="chip" href="#/u/${esc(u.handle)}">@${esc(u.handle)}</a>`).join('')}</div>` : ''}
    ${lists.length ? `<h3>Playlists</h3><div class="grid-3" style="margin-bottom:12px">${lists.map(playlistCard).join('')}</div>` : ''}
    ${projects.length ? `<h3>Projects</h3><div class="grid-2" style="margin-bottom:12px">${projects.map(projectCard).join('')}</div>` : ''}
    ${tools.length ? `<h3>Tools</h3><div class="card" style="margin-bottom:12px">${tools.map((t) => `<div style="padding:4px 0"><strong>${esc(t.name)}</strong> <span class="muted small">${esc(t.desc)}</span></div>`).join('')}</div>` : ''}
    ${posts.length ? `<h3>Posts</h3>${posts.map((p) => postCard(p)).join('')}` : ''}
    ${none ? '<div class="card empty">No results.</div>' : ''}
  </div>`;
}

const notFound = () => '<div class="page single"><div class="card empty"><h2>Not found</h2><p>That page does not exist or was removed.</p><a class="btn" href="#/">Go home</a></div></div>';
const loginWall = (what) => `<div class="page single"><div class="card empty"><h2>Join Patch</h2><p>Log in to ${esc(what)}.</p><button class="btn btn-primary" data-act="login">Log in / Sign up</button></div></div>`;

/* ---------- login / signup / recovery ---------- */
function openAuth(tab = 'login') {
  const tabs = `<div class="tabs">${[['login', 'Log in'], ['signup', 'Create account'], ['recover', 'Forgot password']].map(([k, l]) => `<button class="tab ${tab === k ? 'active' : ''}" data-auth="${k}">${l}</button>`).join('')}</div>`;
  const bodies = {
    login: `<form id="authForm"><div class="field"><label for="a-u">Username</label><input id="a-u" type="text" name="username" autocomplete="username" autocapitalize="none" required></div>
      <div class="field"><label for="a-p">Password</label><input id="a-p" type="password" name="password" autocomplete="current-password" required></div>
      <button class="btn btn-primary" style="width:100%">Log in</button></form>`,
    signup: `<form id="authForm"><div class="field"><label for="s-n">Display name</label><input id="s-n" type="text" name="name" maxlength="50" required></div>
      <div class="field"><label for="s-u">Username</label><input id="s-u" type="text" name="username" autocomplete="username" autocapitalize="none" pattern="[a-z0-9_]{3,20}" maxlength="20" required placeholder="lowercase, 3–20 characters"><div class="hint">Letters, numbers and _ only. This is how you log in — no email needed.</div></div>
      <div class="field"><label for="s-p">Password</label><input id="s-p" type="password" name="password" autocomplete="new-password" minlength="8" required><div class="hint">At least 8 characters. Use something you don't use anywhere else.</div></div>
      <div class="field"><label for="s-p2">Repeat password</label><input id="s-p2" type="password" name="password2" autocomplete="new-password" required></div>
      <button class="btn btn-primary" style="width:100%">Create account</button></form>`,
    recover: `<p class="small muted">Use the recovery code you saved when you signed up.</p><form id="authForm"><div class="field"><label for="r-u">Username</label><input id="r-u" type="text" name="username" autocapitalize="none" required></div>
      <div class="field"><label for="r-c">Recovery code</label><input id="r-c" type="text" name="code" class="mono" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required></div>
      <div class="field"><label for="r-p">New password</label><input id="r-p" type="password" name="password" autocomplete="new-password" minlength="8" required></div>
      <button class="btn btn-primary" style="width:100%">Reset password</button></form>`,
  };
  modal(`<h2>Welcome to Patch</h2>${tabs}${bodies[tab]}`);
  $$('[data-auth]').forEach((b) => b.onclick = () => openAuth(b.dataset.auth));
  const f = $('#authForm');
  const afterLogin = async (msg) => { await refresh(); accountInfo = null; closeModal(); render(); toast(msg); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const btn = f.querySelector('button.btn-primary'); btn.disabled = true;
    try {
      if (tab === 'login') {
        const r = await api('/api/auth/login', { method: 'POST', body: { username: f.username.value, password: f.password.value } });
        if (r.need2fa) return ask2fa(r.ticket, afterLogin);
        await afterLogin(`Welcome back, ${me()?.name || ''}!`);
      } else if (tab === 'signup') {
        if (!USERNAME_RE.test(f.username.value)) throw new Error('Username: 3–20 lowercase letters, numbers or _');
        if (f.password.value !== f.password2.value) throw new Error('Passwords do not match');
        const r = await api('/api/auth/signup', { method: 'POST', body: { name: f.name.value, username: f.username.value, password: f.password.value } });
        await refresh(); render();
        showCodes('Save your recovery code', 'Patch has no email, so this code is the only way back in if you forget your password. It is shown only once — store it in a password manager or write it down.', [r.recoveryCode]);
      } else {
        const r = await api('/api/auth/recover', { method: 'POST', body: { username: f.username.value, recoveryCode: f.code.value, newPassword: f.password.value } });
        showCodes('Password reset ✓', 'Your old recovery code no longer works. Here is your new one — save it. You can now log in with your new password.', [r.recoveryCode]);
      }
    } catch (err) { toast(err.message); btn.disabled = false; }
  };
}
function ask2fa(ticket, done) {
  modal(`<h2>Two-factor check</h2><p class="small muted">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
    <form id="tfaLogin"><div class="field"><input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="9" required autofocus aria-label="Code"></div><button class="btn btn-primary" style="width:100%">Verify</button></form>`);
  $('#tfaLogin').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/api/auth/login/2fa', { method: 'POST', body: { ticket, code: e.target.code.value } }); await done('Logged in securely ✓'); } catch (err) { toast(err.message); if (/expired/.test(err.message)) openAuth(); }
  };
}

/* ---------- global actions ---------- */
function openReport(kind, id) {
  modal(`<h2>Report ${esc(kind)}</h2><p class="small muted">Reports are private and reviewed by Patch moderators.</p><form id="repForm">
    <div class="field">${REPORT_REASONS.map((r, i) => `<label class="row" style="font-weight:500;margin-bottom:6px"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? 'checked' : ''}> ${esc(r)}</label>`).join('')}</div>
    <div class="field"><label for="rp-n">Details (optional)</label><textarea id="rp-n" name="note" maxlength="500" style="min-height:70px"></textarea></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-danger">Submit report</button></div></form>`);
  $('#repForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    if (await act('report', { kind, targetId: id, reason: f.reason.value, note: f.note.value }, 'Thanks — moderators will review it')) closeModal();
  };
}
function openLightbox(postId, i) {
  const p = post(postId); if (!p) return;
  const imgs = p.media.filter((m) => m.kind === 'image');
  let idx = Math.max(0, imgs.findIndex((m) => m.id === p.media[i]?.id));
  const draw = () => {
    modal(`<div class="lightbox"><img src="${mediaUrl(imgs[idx])}" alt="">${imgs.length > 1 ? `<div class="row between" style="margin-top:10px"><button class="btn btn-sm" id="lbPrev">← Prev</button><span class="small muted">${idx + 1} / ${imgs.length}</span><button class="btn btn-sm" id="lbNext">Next →</button></div>` : ''}</div>`, 'wide');
    $('#lbPrev')?.addEventListener('click', () => { idx = (idx - 1 + imgs.length) % imgs.length; draw(); });
    $('#lbNext')?.addEventListener('click', () => { idx = (idx + 1) % imgs.length; draw(); });
  };
  draw();
}
async function share(kind, id) {
  const url = shareUrl(kind, id);
  const title = kind === 'post' ? post(id)?.title : playlist(id)?.name;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) { try { await navigator.share({ title, url }); return; } catch {} }
  modal(`<h2>Share ${esc(kind)}</h2><p class="small muted">Anyone with this link can open it — no account needed. It shows a preview in Discord, WhatsApp and X.</p>
    <div class="row" style="flex-wrap:nowrap"><input type="text" id="shareUrl" value="${esc(url)}" readonly><button class="btn btn-primary" id="copyShare">Copy</button></div>`);
  $('#shareUrl').onfocus = (e) => e.target.select();
  $('#copyShare').onclick = () => navigator.clipboard?.writeText(url).then(() => toast('Link copied'), () => { $('#shareUrl').select(); toast('Press Ctrl+C to copy'); });
}

const actions = {
  login: () => openAuth(),
  async logout() { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} accountInfo = null; await refresh(); location.hash = '#/'; render(); toast('Logged out'); },
  like: (id) => requireLogin() && act('like', { postId: id }),
  save: (id) => requireLogin() && act('save', { postId: id }, (r) => (r.saved ? 'Saved' : 'Removed from saved')),
  share: (id, el) => share(el.dataset.kind, id),
  solve: (id) => act('solve', { postId: id }),
  async 'delete-post'(id) {
    const p = post(id); if (!p) return;
    const own = p.authorId === me()?.id;
    if (!confirm(own ? 'Delete this post?' : 'Remove this post as a community moderator? The author will be notified.')) return;
    if (await act('deletePost', { postId: id }, own ? 'Post deleted' : 'Post removed') && location.hash.includes(id)) location.hash = '#/';
  },
  'vote-poll': (id, el) => requireLogin() && act('votePoll', { postId: id, option: Number(el.dataset.i) }),
  join: (id) => requireLogin() && act('join', { communityId: id }, (r) => (r.joined ? 'Joined!' : 'Left community')),
  follow: (id) => requireLogin() && act('follow', { userId: id }),
  'new-community': () => openNewCommunity(),
  'edit-community': (id) => openEditCommunity(id),
  'new-tool': () => openNewTool(),
  'upvote-tool': (id) => requireLogin() && act('upvoteTool', { toolId: id }),
  'add-update': (id) => openAddUpdate(id),
  async 'delete-project'(id) { if (!confirm('Delete this project page? Its timeline will be lost.')) return; if (await act('deleteProject', { projectId: id }, 'Project deleted')) location.hash = '#/vault'; },
  'submit-entry': () => requireLogin() && openSubmitEntry(),
  'champ-vote': (id) => requireLogin() && act('champVote', { submissionId: id }, (r) => ({ cast: 'Vote cast!', changed: 'Vote changed', removed: 'Vote removed' }[r.vote])),
  'edit-profile': () => requireLogin() && openEditProfile(),
  'read-all': () => act('readAllNotifs'),
  report: (id, el) => requireLogin() && openReport(el.dataset.kind, id),
  'pin-post': (id) => act('pinPost', { postId: id }, (r) => (r.pinned ? 'Pinned to the top' : 'Unpinned')),
  async 'delete-comment'(id) {
    const [postId, commentId] = id.split('|');
    if (!confirm('Delete this comment?')) return;
    act('deleteComment', { postId, commentId }, 'Comment deleted');
  },
  'add-to-playlist': (id) => openAddToPlaylist(id),
  'new-playlist': () => requireLogin() && openNewPlaylist(),
  'edit-playlist': (id) => openEditPlaylist(id),
  async 'delete-playlist'(id) { if (!confirm('Delete this playlist? The posts themselves stay.')) return; if (await act('deletePlaylist', { id }, 'Playlist deleted')) location.hash = '#/playlists'; },
  lightbox: (id, el) => openLightbox(id, Number(el.dataset.i)),
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = Object.hasOwn(actions, el.dataset.act) ? actions[el.dataset.act] : null;
  if (!fn) return;
  e.preventDefault();
  fn(el.dataset.id, el);
});

/* ---------- modal / toast ---------- */
function modal(html, size = '') {
  $('#modalBody').innerHTML = html;
  $('.modal').classList.toggle('wide', size === 'wide');
  $('#modal').hidden = false;
  setTimeout(() => $('#modal input:not([type=checkbox]):not([type=radio]):not([readonly]), #modal textarea, #modal select, #modal button:not(.modal-close)')?.focus(), 0);
}
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600); }

/* ---------- chrome ---------- */
function banner() {
  const m = me();
  let s = '';
  if (db.settings.announcement) s += `<div class="announce">📣 ${esc(db.settings.announcement)}</div>`;
  if (m?.banned) s += '<div class="notice" style="margin-bottom:14px">⛔ Your account is suspended. You can browse Patch, but posting, commenting, messaging and voting are disabled.</div>';
  return s;
}
function renderChrome(section) {
  const m = me();
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  const unread = m ? db.notifications.filter((n) => !n.read).length : 0;
  const nc = $('#notifCount'); nc.hidden = !unread; nc.textContent = unread > 9 ? '9+' : unread;
  $('#msgDot').hidden = !(m && db.messages.some((x) => x.to === m.id && !x.read));
  const um = $('#userMenu');
  um.innerHTML = m
    ? `<button class="icon-btn" id="umBtn" aria-label="Account" style="width:auto;padding:0 4px"><span class="avatar sm" style="background:${esc(m.color)}">${esc(m.name[0])}</span></button><div class="menu" id="umMenu" hidden>
        <div style="padding:8px 10px"><strong>${esc(m.name)}</strong><div class="small muted">@${esc(m.handle)}</div></div><hr>
        <a href="#/u/${esc(m.handle)}">👤 Profile & trophy room</a><a href="#/playlists">🎞️ My playlists</a><a href="#/vault/new">🗄️ Add project</a><a href="#/saved">🔖 Saved</a><a href="#/settings">🔐 Account & security</a><hr>
        <button data-act="logout">↩ Log out</button></div>`
    : '<button class="btn btn-primary btn-sm" data-act="login">Log in</button>';
  const b = $('#umBtn'); if (b) b.onclick = (e) => { e.stopPropagation(); $('#umMenu').hidden = !$('#umMenu').hidden; };
  $('#myCommunities').innerHTML = m
    ? (db.communities.filter((c) => c.members.includes(m.id)).map((c) => `<a href="#/c/${esc(c.slug)}"><span class="comm-icon">${esc(c.icon)}</span> p/${esc(c.slug)}</a>`).join('') || '<div class="small muted" style="padding:0 12px">Join a community to see it here.</div>')
      + '<a href="#" data-act="new-community"><span class="comm-icon">＋</span> Create community</a>'
    : '<div class="small muted" style="padding:0 12px">Log in to join communities.</div>';
}
document.addEventListener('click', (e) => { const mn = $('#umMenu'); if (mn && !mn.hidden && !e.target.closest('#userMenu')) mn.hidden = true; });

/* ---------- router ---------- */
function route() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const parts = (path || '/').split('/').filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  const [a, b, c] = parts;
  if (!a) return ['feed', viewFeed, afterFeed];
  if (a === 'post') return ['feed', () => viewPost(b), (r) => afterPost(r, b)];
  if (a === 'new') return ['feed', () => viewNewPost(params), afterNewPost];
  if (a === 'communities') return ['communities', viewCommunities];
  if (a === 'c') return ['communities', () => viewCommunity(b), (r) => bindFeed(r, commState)];
  if (a === 'tools') return ['tools', viewTools, afterTools];
  if (a === 'vault' && b === 'new') return ['vault', () => viewProjectForm(null), (r) => afterProjectForm(r, null)];
  if (a === 'vault' && b && c === 'edit') return ['vault', () => viewProjectForm(b), (r) => afterProjectForm(r, b)];
  if (a === 'vault' && b) return ['vault', () => viewProject(b)];
  if (a === 'vault') return ['vault', viewVault, afterVault];
  if (a === 'championship') return ['championship', viewChampionship, afterChampionship];
  if (a === 'playlists') return ['playlists', viewPlaylists];
  if (a === 'playlist') return ['playlists', () => viewPlaylist(b), (r) => afterPlaylist(r, b)];
  if (a === 'u') return ['', () => viewProfile(b), afterProfile];
  if (a === 'builders') return ['builders', viewBuilders];
  if (a === 'messages') return ['messages', () => viewMessages(b), afterMessages];
  if (a === 'notifications') return ['', viewNotifications, afterNotifications];
  if (a === 'saved') return ['saved', viewSaved];
  if (a === 'settings') return ['', viewSettings, afterSettings];
  if (a === 'search') return ['', () => viewSearch(params.get('q') || '')];
  return ['', notFound];
}
let lastHash = null;
function render() {
  if (!db) return;
  const [section, view, after] = route();
  const root = $('#app');
  // keep video playback / scroll when the same page re-renders after an action
  const y = window.scrollY;
  root.innerHTML = banner() + view();
  after && after(root);
  renderChrome(section);
  if (location.hash !== lastHash) { window.scrollTo(0, 0); lastHash = location.hash; if (!location.hash.startsWith('#/settings')) accountInfo = null; }
  else window.scrollTo(0, y);
  $('#sidebar').classList.remove('open');
}

/* ---------- boot ---------- */
const THEME_KEY = 'patch.theme';
try { const th = localStorage.getItem(THEME_KEY); if (th) document.documentElement.dataset.theme = th; } catch {}
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme); } catch {}
};
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
let searchTimer;
$('#searchInput').addEventListener('input', (e) => { clearTimeout(searchTimer); const q = e.target.value.trim(); searchTimer = setTimeout(() => { location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/'; }, 250); });
window.addEventListener('hashchange', render);
// pick up new likes, comments and messages every 30 s while the tab is open
setInterval(async () => {
  if (document.hidden || !$('#modal').hidden || document.activeElement?.matches('input, textarea, select') || $$('video').some((v) => !v.paused)) return;
  try { await refresh(); render(); } catch {}
}, 30e3);
try { await refresh(); } catch (e) { $('#app').innerHTML = `<div class="page single"><div class="card empty"><h2>Can't reach the Patch server</h2><p>${esc(e.message)}</p></div></div>`; }
render();
