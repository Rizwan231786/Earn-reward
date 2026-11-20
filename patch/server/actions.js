// Every change to community data goes through one of these actions.
// The server validates input and checks permissions; the browser is never trusted.
import { CHAMP_CATEGORIES, POST_TYPES, TOOL_CATEGORIES, PROJECT_STATUS, REPORT_REASONS, ROLE_LABEL, PLAYLIST_VISIBILITY, LIMITS, DAY, monthKey, monthLabel } from '../public/shared.js';
import { uid } from './auth.js';

export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = (m) => { throw new HttpError(400, m); };
const forbid = (m = 'You are not allowed to do that') => { throw new HttpError(403, m); };
const missing = (what = 'Item') => { throw new HttpError(404, `${what} not found`); };

/* ---------- validation ---------- */
function text(v, { max = 200, min = 0, name = 'Field' } = {}) {
  v = (v == null ? '' : String(v)).replace(/\r\n/g, '\n').trim();
  if (v.length < min) bad(min <= 1 ? `${name} is required` : `${name} must be at least ${min} characters`);
  if (v.length > max) bad(`${name} is too long (max ${max} characters)`);
  return v;
}
function link(v, name) {
  v = text(v, { max: 500, name });
  if (!v) return '';
  try { const u = new URL(v); if (!/^https?:$/.test(u.protocol)) throw 0; return u.href; } catch { bad(`${name} must start with http:// or https://`); }
}
const pick = (v, list, name) => (list.includes(v) ? v : bad(`Invalid ${name}`));
const tags = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim().replace(/^#/, '').toLowerCase().replace(/[^a-z0-9_+.-]/g, '').slice(0, 30)).filter(Boolean).slice(0, 6);
const list = (v, max, each = 40) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => String(s).trim().slice(0, each)).filter(Boolean).slice(0, max);
const int = (v, lo, hi) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) bad('Invalid number'); return Math.max(lo, Math.min(hi, n)); };
const date = (v) => { v = String(v || ''); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) bad('Invalid date'); return v; };
const toggle = (arr, id) => { const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); else arr.push(id); return i < 0; };

/* ---------- lookups & rules ---------- */
const find = (arr, id, what) => arr.find((x) => x.id === id) || missing(what);
export const isStaff = (u) => !!u && (u.role === 'admin' || u.role === 'moderator');
export const isAdmin = (u) => !!u && u.role === 'admin';
// Inside the main app only a community's owner and its moderators can moderate it.
// Site-wide staff powers live in the separate admin panel.
const canModerate = (c, u) => !!u && !!c && !u.banned && (c.createdBy === u.id || (c.mods || []).includes(u.id));
const ageDays = (u) => (Date.now() - u.joinedAt) / DAY;
const minAge = (s) => s.settings.communityMinAgeDays ?? 3;
function eligibility(s, u) {
  if (u.banned) return 'Suspended accounts cannot enter';
  if (ageDays(u) < minAge(s) && !isStaff(u)) return `Accounts must be at least ${minAge(s)} days old to enter`;
  if (!s.projects.some((p) => p.ownerId === u.id)) return 'Add a project to the Vault first';
  return null;
}
const voteCount = (s, subId) => s.champ.votes.filter((v) => v.submissionId === subId && !s.users.find((u) => u.id === v.voterId)?.banned).length;
function tally(s, mk, cat) {
  return s.champ.submissions.filter((x) => x.month === mk && x.category === cat)
    .map((x) => ({ ...x, votes: voteCount(s, x.id) }))
    .sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt);
}
export function closeMonthIn(ctx, mk) {
  const { s } = ctx;
  if (s.champ.closed.includes(mk)) return false;
  CHAMP_CATEGORIES.forEach((c) => {
    const [top] = tally(s, mk, c.id);
    if (!top || !top.votes) return;
    const p = s.projects.find((x) => x.id === top.projectId);
    s.champ.winners.push({ month: mk, category: c.id, userId: top.userId, projectId: top.projectId, projectName: p?.name || 'Entry', votes: top.votes });
    ctx.notify(top.userId, `🏆 You are the ${monthLabel(mk)} ${c.name} champion!`, `#/u/${s.users.find((u) => u.id === top.userId)?.handle}`);
  });
  s.champ.closed.push(mk);
  return true;
}
// Called on a timer: closes every past month that still has open voting.
export function autoCloseMonths(ctx) {
  const current = monthKey();
  const months = [...new Set(ctx.s.champ.submissions.map((x) => x.month))].filter((m) => m < current && !ctx.s.champ.closed.includes(m));
  months.sort().forEach((m) => { if (closeMonthIn(ctx, m)) ctx.audit('auto-closed championship', monthLabel(m)); });
  return months.length;
}
function removeProjectFrom(s, id) {
  s.projects = s.projects.filter((p) => p.id !== id);
  s.posts.forEach((p) => { if (p.projectId === id) p.projectId = ''; });
  const subIds = s.champ.submissions.filter((x) => x.projectId === id && !s.champ.closed.includes(x.month)).map((x) => x.id);
  s.champ.submissions = s.champ.submissions.filter((x) => !subIds.includes(x.id));
  s.champ.votes = s.champ.votes.filter((v) => !subIds.includes(v.submissionId));
}
function removePostFrom(s, id) {
  s.posts = s.posts.filter((p) => p.id !== id);
  s.playlists.forEach((pl) => { pl.items = pl.items.filter((x) => x !== id); });
}
function mediaList(ctx, ids) {
  if (!Array.isArray(ids)) return [];
  if (ids.length > LIMITS.mediaPerPost) bad(`Up to ${LIMITS.mediaPerPost} photos/videos per post`);
  return [...new Set(ids.map(String))].map((id) => {
    const m = ctx.media(id);
    if (!m || m.owner_id !== ctx.me.id) bad('One of the uploads was not found — please upload it again');
    return { id: m.id, kind: m.kind, mime: m.mime };
  });
}

/* ---------- member actions ---------- */
// `open: true` = allowed for suspended accounts too (reading-type actions).
export const userActions = {
  like({ s, me, notify }, { postId }) {
    const p = find(s.posts, postId, 'Post');
    if (toggle(p.likes, me.id)) notify(p.authorId, `${me.name} liked "${p.title.slice(0, 50)}"`, `#/post/${p.id}`);
  },
  save({ s, me }, { postId }) { return { saved: toggle(find(s.posts, postId, 'Post').saves, me.id) }; },
  solve({ s, me }, { postId }) {
    const p = find(s.posts, postId, 'Post');
    if (p.authorId !== me.id) forbid();
    p.solved = !p.solved;
  },
  votePoll({ s, me }, { postId, option }) {
    const p = find(s.posts, postId, 'Post');
    if (p.type !== 'poll' || !p.poll) bad('Not a poll');
    const i = int(option, 0, p.poll.options.length - 1);
    p.poll.options.forEach((o, j) => {
      const k = o.votes.indexOf(me.id);
      if (k >= 0) o.votes.splice(k, 1);
      else if (j === i) o.votes.push(me.id);
    });
  },
  comment({ s, me, notify }, { postId, body }) {
    const p = find(s.posts, postId, 'Post');
    const c = { id: uid(), authorId: me.id, body: text(body, { min: 1, max: 4000, name: 'Comment' }), createdAt: Date.now() };
    p.comments.push(c);
    notify(p.authorId, `${me.name} commented on "${p.title.slice(0, 50)}"`, `#/post/${p.id}`);
    return { id: c.id };
  },
  deleteComment({ s, me, notify, audit }, { postId, commentId }) {
    const p = find(s.posts, postId, 'Post');
    const c = find(p.comments, commentId, 'Comment');
    const own = c.authorId === me.id;
    if (!own && !canModerate(s.communities.find((x) => x.id === p.communityId), me)) forbid();
    p.comments = p.comments.filter((x) => x !== c);
    if (!own) { audit('removed comment (community mod)', `on "${p.title}"`); notify(c.authorId, `Your comment on "${p.title.slice(0, 50)}" was removed by community moderators.`, `#/post/${p.id}`); }
  },
  createPost(ctx, a) {
    const { s, me } = ctx;
    const type = pick(a.type, Object.keys(POST_TYPES), 'post type');
    const c = find(s.communities, a.communityId, 'Community');
    const p = {
      id: uid(), type, authorId: me.id, communityId: c.id, createdAt: Date.now(),
      title: text(a.title, { min: 1, max: 200, name: 'Title' }), body: text(a.body, { max: 10000, name: 'Details' }),
      tags: tags(a.tags), media: mediaList(ctx, a.media), likes: [], saves: [], comments: [],
    };
    if (type === 'media' && !p.media.length) bad('Add at least one photo or video');
    if (type === 'poll') {
      const opts = list(a.pollOptions, 6, 100);
      if (opts.length < 2) bad('A poll needs at least 2 options');
      p.poll = { options: opts.map((t) => ({ text: t, votes: [] })) };
    }
    if (type === 'progress') p.progress = { percent: int(a.percent, 0, 100), eta: date(a.eta) };
    if ((type === 'showcase' || type === 'progress') && a.projectId) {
      const proj = find(s.projects, a.projectId, 'Project');
      if (proj.ownerId !== me.id) forbid('You can only link your own projects');
      p.projectId = proj.id;
      if (type === 'progress') proj.updates.push({ id: uid(), title: p.title, body: p.body, percent: p.progress.percent, createdAt: Date.now() });
    }
    s.posts.unshift(p);
    s.users.filter((u) => u.following.includes(me.id)).forEach((u) => ctx.notify(u.id, `${me.name} posted: "${p.title.slice(0, 50)}"`, `#/post/${p.id}`));
    return { id: p.id };
  },
  deletePost({ s, me, notify, audit }, { postId }) {
    const p = find(s.posts, postId, 'Post');
    const own = p.authorId === me.id;
    if (!own && !canModerate(s.communities.find((x) => x.id === p.communityId), me)) forbid();
    removePostFrom(s, p.id);
    if (!own) { audit('removed post (community mod)', p.title); notify(p.authorId, `Your post "${p.title.slice(0, 50)}" was removed by community moderators.`, '#/notifications'); }
  },
  pinPost({ s, me, audit }, { postId }) {
    const p = find(s.posts, postId, 'Post');
    if (!canModerate(s.communities.find((x) => x.id === p.communityId), me)) forbid();
    p.pinned = !p.pinned;
    audit(p.pinned ? 'pinned post (community mod)' : 'unpinned post (community mod)', p.title);
    return { pinned: p.pinned };
  },
  join({ s, me }, { communityId }) { return { joined: toggle(find(s.communities, communityId, 'Community').members, me.id) }; },
  follow({ s, me, notify }, { userId }) {
    const u = find(s.users, userId, 'User');
    if (u.id === me.id) bad("You can't follow yourself");
    const now = toggle(me.following, u.id);
    if (now) notify(u.id, `${me.name} started following you`, `#/u/${me.handle}`);
    return { following: now };
  },
  createCommunity({ s, me }, a) {
    if (ageDays(me) < minAge(s) && !isStaff(me)) forbid(`New accounts can create a community after ${minAge(s)} days`);
    const slug = text(a.slug, { min: 3, max: 30, name: 'URL name' }).toLowerCase();
    if (!/^[a-z0-9-]{3,30}$/.test(slug)) bad('URL name: lowercase letters, numbers and dashes only');
    if (s.communities.some((c) => c.slug === slug)) bad('That URL name is taken');
    if (s.communities.filter((c) => c.createdBy === me.id).length >= 10) bad('You can own at most 10 communities');
    const c = { id: uid(), slug, name: text(a.name, { min: 2, max: 50, name: 'Name' }), icon: text(a.icon, { max: 8 }) || '✨', desc: text(a.desc, { min: 1, max: 300, name: 'Description' }), rules: list(String(a.rules || '').split('\n'), 15, 200), members: [me.id], mods: [], createdBy: me.id, createdAt: Date.now() };
    s.communities.push(c);
    return { slug };
  },
  editCommunity({ s, me, notify, audit }, a) {
    const c = find(s.communities, a.id, 'Community');
    if (!canModerate(c, me)) forbid();
    const handles = [...new Set(list(a.mods, 20).map((h) => h.replace(/^@/, '').toLowerCase()))];
    const mods = handles.map((h) => s.users.find((u) => u.handle === h) || bad(`Unknown user: @${h}`));
    Object.assign(c, { name: text(a.name, { min: 2, max: 50, name: 'Name' }), icon: text(a.icon, { max: 8 }) || c.icon, desc: text(a.desc, { min: 1, max: 300, name: 'Description' }), rules: list(String(a.rules || '').split('\n'), 15, 200) });
    // Only the owner can change who moderates.
    if (c.createdBy === me.id) {
      mods.filter((u) => !(c.mods || []).includes(u.id)).forEach((u) => notify(u.id, `You are now a moderator of p/${c.slug}`, `#/c/${c.slug}`));
      c.mods = mods.map((u) => u.id);
    }
    audit('updated community', 'p/' + c.slug);
  },
  createTool({ s, me, notify }, a) {
    const needsReview = s.settings.toolApproval && !isStaff(me);
    const t = { id: uid(), name: text(a.name, { min: 1, max: 80, name: 'Name' }), url: link(a.url, 'Link') || bad('Link is required'), category: pick(a.category, TOOL_CATEGORIES, 'category'), desc: text(a.desc, { min: 1, max: 300, name: 'Description' }), isOffer: !!a.isOffer, expires: a.isOffer ? date(a.expires) : '', addedBy: me.id, upvotes: [me.id], createdAt: Date.now(), status: needsReview ? 'pending' : 'approved' };
    s.tools.unshift(t);
    if (needsReview) s.users.filter(isStaff).forEach((u) => notify(u.id, `New tool waiting for approval: ${t.name}`, ''));
    return { pending: needsReview };
  },
  upvoteTool({ s, me }, { toolId }) {
    const t = find(s.tools, toolId, 'Tool');
    if (t.status === 'pending') bad('This tool is waiting for approval');
    toggle(t.upvotes, me.id);
  },
  saveProject({ s, me }, a) {
    const data = {
      name: text(a.name, { min: 1, max: 60, name: 'Project name' }), tagline: text(a.tagline, { min: 1, max: 120, name: 'Tagline' }), desc: text(a.desc, { max: 5000, name: 'Description' }),
      status: pick(a.status, Object.keys(PROJECT_STATUS), 'status'), visibility: pick(a.visibility, ['open', 'closed'], 'source type'),
      tech: list(a.tech, 12, 30), demo: link(a.demo, 'Demo link'), repo: link(a.repo, 'Repository link'), lookingFor: text(a.lookingFor, { max: 140, name: 'Looking for' }),
    };
    if (a.id) {
      const p = find(s.projects, a.id, 'Project');
      if (p.ownerId !== me.id) forbid();
      Object.assign(p, data);
      return { id: p.id };
    }
    if (s.projects.filter((p) => p.ownerId === me.id).length >= 50) bad('Project limit reached');
    const p = { id: uid(), ownerId: me.id, createdAt: Date.now(), updates: [{ id: uid(), title: 'Project added to the Vault', body: '', percent: int(a.percent ?? 0, 0, 100), createdAt: Date.now() }], ...data };
    s.projects.unshift(p);
    return { id: p.id };
  },
  deleteProject({ s, me }, { projectId }) {
    const p = find(s.projects, projectId, 'Project');
    if (p.ownerId !== me.id) forbid();
    removeProjectFrom(s, p.id);
  },
  addUpdate({ s, me }, a) {
    const p = find(s.projects, a.projectId, 'Project');
    if (p.ownerId !== me.id) forbid();
    const u = { id: uid(), title: text(a.title, { min: 1, max: 100, name: 'Title' }), body: text(a.body, { max: 3000, name: 'Details' }), percent: int(a.percent, 0, 100), createdAt: Date.now() };
    p.updates.push(u);
    if (u.percent >= 100) p.status = 'launched';
    if (a.share) {
      const c = find(s.communities, a.communityId, 'Community');
      s.posts.unshift({ id: uid(), type: 'progress', authorId: me.id, communityId: c.id, projectId: p.id, title: `${p.name}: ${u.title}`, body: u.body, progress: { percent: u.percent, eta: '' }, tags: [], media: [], likes: [], saves: [], comments: [], createdAt: Date.now() });
    }
  },
  submitEntry({ s, me }, a) {
    const mk = monthKey();
    if (s.champ.closed.includes(mk)) bad('Voting for this month is closed');
    const why = eligibility(s, me); if (why) forbid(why);
    const category = pick(a.category, CHAMP_CATEGORIES.map((c) => c.id), 'category');
    const p = find(s.projects, a.projectId, 'Project');
    if (p.ownerId !== me.id) forbid('You can only enter your own projects');
    if (s.champ.submissions.some((x) => x.month === mk && x.category === category && x.userId === me.id)) bad('You already entered this category this month');
    s.champ.submissions.push({ id: uid(), month: mk, category, projectId: p.id, userId: me.id, note: text(a.note, { max: 300, name: 'Note' }), createdAt: Date.now() });
  },
  champVote({ s, me }, { submissionId }) {
    const sub = find(s.champ.submissions, submissionId, 'Entry');
    if (s.champ.closed.includes(sub.month)) bad('Voting is closed');
    if (sub.userId === me.id) bad("You can't vote for your own entry");
    const existing = s.champ.votes.find((v) => v.month === sub.month && v.category === sub.category && v.voterId === me.id);
    if (existing && existing.submissionId === sub.id) { s.champ.votes = s.champ.votes.filter((v) => v !== existing); return { vote: 'removed' }; }
    if (existing) { existing.submissionId = sub.id; return { vote: 'changed' }; }
    s.champ.votes.push({ month: sub.month, category: sub.category, voterId: me.id, submissionId: sub.id });
    return { vote: 'cast' };
  },
  editProfile({ me }, a) {
    Object.assign(me, { name: text(a.name, { min: 1, max: 50, name: 'Name' }), bio: text(a.bio, { max: 300, name: 'Bio' }), skills: list(a.skills, 10, 30), openToWork: !!a.openToWork, isPublic: !!a.isPublic });
  },
  sendMessage({ s, me, notify }, { to, body }) {
    const u = find(s.users, to, 'User');
    if (u.id === me.id) bad("You can't message yourself");
    s.messages.push({ id: uid(), from: me.id, to: u.id, body: text(body, { min: 1, max: 2000, name: 'Message' }), createdAt: Date.now(), read: false });
  },
  readThread: { open: true, run({ s, me }, { userId }) { s.messages.forEach((m) => { if (m.from === userId && m.to === me.id) m.read = true; }); } },
  readNotif: { open: true, run({ s, me }, { id }) { const n = s.notifications.find((x) => x.id === id && x.userId === me.id); if (n) n.read = true; } },
  readAllNotifs: { open: true, run({ s, me }) { s.notifications.forEach((n) => { if (n.userId === me.id) n.read = true; }); } },
  report({ s, me, notify }, a) {
    const kind = pick(a.kind, ['post', 'comment', 'user', 'project', 'playlist'], 'report type');
    const targetId = text(a.targetId, { min: 1, max: 80 });
    const exists = {
      post: () => s.posts.some((p) => p.id === targetId),
      comment: () => { const [pid, cid] = targetId.split('|'); return !!s.posts.find((p) => p.id === pid)?.comments.some((c) => c.id === cid); },
      user: () => s.users.some((u) => u.id === targetId && u.id !== me.id),
      project: () => s.projects.some((p) => p.id === targetId),
      playlist: () => s.playlists.some((p) => p.id === targetId),
    }[kind]();
    if (!exists) missing('Reported item');
    if (s.reports.some((r) => r.status === 'open' && r.kind === kind && r.targetId === targetId && r.reporterId === me.id)) bad('You already reported this');
    const reason = pick(a.reason, REPORT_REASONS, 'reason');
    s.reports.unshift({ id: uid(), kind, targetId, reason, note: text(a.note, { max: 500, name: 'Details' }), reporterId: me.id, status: 'open', createdAt: Date.now() });
    s.users.filter(isStaff).forEach((u) => notify(u.id, `New report: ${kind} — ${reason}`, ''));
  },

  /* playlists */
  createPlaylist({ s, me }, a) {
    if (s.playlists.filter((p) => p.ownerId === me.id).length >= 100) bad('Playlist limit reached');
    const pl = { id: uid(8), ownerId: me.id, name: text(a.name, { min: 1, max: 80, name: 'Playlist name' }), description: text(a.description, { max: 500, name: 'Description' }), visibility: pick(a.visibility || 'public', Object.keys(PLAYLIST_VISIBILITY), 'visibility'), items: [], createdAt: Date.now(), updatedAt: Date.now() };
    if (a.postId) { find(s.posts, a.postId, 'Post'); pl.items.push(a.postId); }
    s.playlists.unshift(pl);
    return { id: pl.id };
  },
  updatePlaylist({ s, me }, a) {
    const pl = find(s.playlists, a.id, 'Playlist');
    if (pl.ownerId !== me.id) forbid();
    Object.assign(pl, { name: text(a.name, { min: 1, max: 80, name: 'Playlist name' }), description: text(a.description, { max: 500, name: 'Description' }), visibility: pick(a.visibility, Object.keys(PLAYLIST_VISIBILITY), 'visibility'), updatedAt: Date.now() });
  },
  deletePlaylist({ s, me }, { id }) {
    const pl = find(s.playlists, id, 'Playlist');
    if (pl.ownerId !== me.id) forbid();
    s.playlists = s.playlists.filter((x) => x !== pl);
  },
  playlistAdd({ s, me }, { id, postId }) {
    const pl = find(s.playlists, id, 'Playlist');
    if (pl.ownerId !== me.id) forbid();
    find(s.posts, postId, 'Post');
    if (pl.items.includes(postId)) return;
    if (pl.items.length >= LIMITS.playlistItems) bad(`A playlist can hold ${LIMITS.playlistItems} posts`);
    pl.items.push(postId); pl.updatedAt = Date.now();
  },
  playlistRemove({ s, me }, { id, postId }) {
    const pl = find(s.playlists, id, 'Playlist');
    if (pl.ownerId !== me.id) forbid();
    pl.items = pl.items.filter((x) => x !== postId); pl.updatedAt = Date.now();
  },
  playlistMove({ s, me }, { id, postId, dir }) {
    const pl = find(s.playlists, id, 'Playlist');
    if (pl.ownerId !== me.id) forbid();
    const i = pl.items.indexOf(postId), j = i + (dir === 'up' ? -1 : 1);
    if (i < 0 || j < 0 || j >= pl.items.length) return;
    [pl.items[i], pl.items[j]] = [pl.items[j], pl.items[i]];
  },
};

/* ---------- staff actions (admin panel only) ---------- */
// `admin: true` = admins only; everything else is open to moderators too.
function removeReported(ctx, r) {
  const { s, notify } = ctx;
  if (r.kind === 'post') {
    const p = s.posts.find((x) => x.id === r.targetId);
    if (p) { removePostFrom(s, p.id); notify(p.authorId, `Your post "${p.title.slice(0, 50)}" was removed by moderators (${r.reason}).`, '#/notifications'); }
  } else if (r.kind === 'comment') {
    const [pid, cid] = r.targetId.split('|'); const p = s.posts.find((x) => x.id === pid); const c = p?.comments.find((x) => x.id === cid);
    if (c) { p.comments = p.comments.filter((x) => x !== c); notify(c.authorId, `Your comment on "${p.title.slice(0, 50)}" was removed by moderators (${r.reason}).`, `#/post/${p.id}`); }
  } else if (r.kind === 'user') {
    const u = s.users.find((x) => x.id === r.targetId);
    if (u && u.role !== 'admin') { u.banned = true; notify(u.id, 'Your account has been suspended by moderators.', '#/notifications'); }
  } else if (r.kind === 'project') {
    const p = s.projects.find((x) => x.id === r.targetId);
    if (p) { removeProjectFrom(s, p.id); notify(p.ownerId, `Your project "${p.name}" was removed by moderators (${r.reason}).`, '#/notifications'); }
  } else if (r.kind === 'playlist') {
    const p = s.playlists.find((x) => x.id === r.targetId);
    if (p) { s.playlists = s.playlists.filter((x) => x !== p); notify(p.ownerId, `Your playlist "${p.name}" was removed by moderators (${r.reason}).`, '#/notifications'); }
  }
}
export const adminActions = {
  reportRemove(ctx, { id }) {
    const r = find(ctx.s.reports, id, 'Report');
    if (r.kind === 'user' && !isAdmin(ctx.me)) forbid('Only admins can suspend accounts');
    removeReported(ctx, r);
    ctx.s.reports.forEach((x) => { if (x.status === 'open' && x.kind === r.kind && x.targetId === r.targetId) Object.assign(x, { status: 'resolved', handledBy: ctx.me.id, handledAt: Date.now() }); });
    ctx.audit(r.kind === 'user' ? 'suspended user (report)' : `removed ${r.kind} (report)`, r.reason);
  },
  reportDismiss(ctx, { id }) {
    const r = find(ctx.s.reports, id, 'Report');
    Object.assign(r, { status: 'dismissed', handledBy: ctx.me.id, handledAt: Date.now() });
    ctx.audit('dismissed report', `${r.kind} — ${r.reason}`);
  },
  pinPost(ctx, { postId }) {
    const p = find(ctx.s.posts, postId, 'Post');
    p.pinned = !p.pinned;
    ctx.audit(p.pinned ? 'pinned post' : 'unpinned post', p.title);
  },
  deletePost(ctx, { postId }) {
    const p = find(ctx.s.posts, postId, 'Post');
    removePostFrom(ctx.s, p.id);
    ctx.audit('removed post', p.title);
    ctx.notify(p.authorId, `Your post "${p.title.slice(0, 50)}" was removed by moderators.`, '#/notifications');
  },
  approveTool(ctx, { id }) {
    const t = find(ctx.s.tools, id, 'Tool');
    t.status = 'approved'; t.createdAt = Date.now();
    ctx.audit('approved tool', t.name);
    ctx.notify(t.addedBy, `Your tool "${t.name}" was approved and is now live.`, '#/tools');
  },
  rejectTool(ctx, { id }) {
    const t = find(ctx.s.tools, id, 'Tool');
    ctx.s.tools = ctx.s.tools.filter((x) => x !== t);
    ctx.audit('rejected tool', t.name);
    ctx.notify(t.addedBy, `Your tool "${t.name}" was not approved.`, '#/tools');
  },
  removeTool(ctx, { id }) {
    const t = find(ctx.s.tools, id, 'Tool');
    ctx.s.tools = ctx.s.tools.filter((x) => x !== t);
    ctx.audit('removed tool', t.name);
  },
  disqualify(ctx, { id }) {
    const sub = find(ctx.s.champ.submissions, id, 'Entry');
    if (ctx.s.champ.closed.includes(sub.month)) bad('That month is already closed');
    ctx.s.champ.submissions = ctx.s.champ.submissions.filter((x) => x !== sub);
    ctx.s.champ.votes = ctx.s.champ.votes.filter((v) => v.submissionId !== id);
    ctx.notify(sub.userId, `Your ${CHAMP_CATEGORIES.find((c) => c.id === sub.category)?.name} championship entry was disqualified by staff.`, '#/championship');
    ctx.audit('disqualified entry', `${ctx.s.projects.find((p) => p.id === sub.projectId)?.name || 'entry'} — ${sub.category}`);
  },
  closeMonth: { admin: true, run(ctx) {
    if (!closeMonthIn(ctx, monthKey())) bad('This month is already closed');
    ctx.audit('crowned champions', monthLabel(monthKey()));
  } },
  banUser: { admin: true, run(ctx, { userId }) {
    const u = find(ctx.s.users, userId, 'User');
    if (u.role === 'admin') bad("Admins can't be suspended — change their role first");
    u.banned = !u.banned;
    ctx.audit(u.banned ? 'suspended user' : 'restored user', '@' + u.handle);
    ctx.notify(u.id, u.banned ? 'Your account has been suspended by an admin.' : 'Your account has been restored. Welcome back!', '#/notifications');
    return { banned: u.banned };
  } },
  verifyUser: { admin: true, run(ctx, { userId }) {
    const u = find(ctx.s.users, userId, 'User');
    u.verified = !u.verified;
    ctx.audit(u.verified ? 'verified user' : 'removed verification', '@' + u.handle);
    if (u.verified) ctx.notify(u.id, 'You are now a ✔ Verified builder on Patch!', `#/u/${u.handle}`);
  } },
  setRole: { admin: true, run(ctx, { userId, role }) {
    const u = find(ctx.s.users, userId, 'User');
    role = pick(role, Object.keys(ROLE_LABEL), 'role');
    if (u.id === ctx.me.id) bad("You can't change your own role");
    if (u.role === 'admin' && role !== 'admin' && ctx.s.users.filter((x) => x.role === 'admin').length === 1) bad('Patch needs at least one admin');
    u.role = role;
    if (role !== 'user') u.banned = false;
    ctx.audit('changed role', `@${u.handle} → ${ROLE_LABEL[role]}`);
    ctx.notify(u.id, `Your Patch role is now: ${ROLE_LABEL[role]}`, '#/');
  } },
  editCommunity: { admin: true, run(ctx, a) {
    const c = find(ctx.s.communities, a.id, 'Community');
    const handles = [...new Set(list(a.mods, 20).map((h) => h.replace(/^@/, '').toLowerCase()))];
    const mods = handles.map((h) => ctx.s.users.find((u) => u.handle === h) || bad(`Unknown user: @${h}`));
    Object.assign(c, { name: text(a.name, { min: 2, max: 50, name: 'Name' }), icon: text(a.icon, { max: 8 }) || c.icon, desc: text(a.desc, { min: 1, max: 300, name: 'Description' }), rules: list(String(a.rules || '').split('\n'), 15, 200), mods: mods.map((u) => u.id) });
    ctx.audit('updated community', 'p/' + c.slug);
  } },
  deleteCommunity: { admin: true, run(ctx, { id }) {
    const c = find(ctx.s.communities, id, 'Community');
    ctx.s.posts.filter((p) => p.communityId === id).forEach((p) => removePostFrom(ctx.s, p.id));
    ctx.s.communities = ctx.s.communities.filter((x) => x !== c);
    ctx.audit('deleted community', 'p/' + c.slug);
  } },
  settings: { admin: true, run(ctx, a) {
    Object.assign(ctx.s.settings, { communityMinAgeDays: int(a.communityMinAgeDays, 0, 60), toolApproval: !!a.toolApproval, announcement: text(a.announcement, { max: 200, name: 'Announcement' }) });
    ctx.audit('updated settings', `wait ${ctx.s.settings.communityMinAgeDays}d · tool approval ${ctx.s.settings.toolApproval ? 'on' : 'off'}`);
  } },
};
