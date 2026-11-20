/* Patch — a community platform for builders.
 * Single-page app, no build step. All data lives in localStorage so the
 * prototype runs anywhere; swap `store` for a real API when going live. */
(() => {
'use strict';

const STORAGE_KEY = 'patch.v2';
const DAY = 864e5;
const DEFAULT_MIN_AGE_DAYS = 3;
const REPORT_REASONS = ['Spam or self-promotion', 'Harassment or hate', 'Scam or malicious link', 'Stolen / plagiarised project', 'Off-topic', 'Other'];
const ROLE_LABEL = { admin: 'Admin', moderator: 'Moderator', user: 'Member' };
const CHAMP_CATEGORIES = [
  { id: 'ai-agent', name: 'AI Agent Builder', icon: '🤖' },
  { id: 'game', name: 'Game Developer', icon: '🎮' },
  { id: 'website', name: 'Website Builder', icon: '🌐' },
  { id: 'automation', name: 'Automation Expert', icon: '⚙️' },
  { id: 'uiux', name: 'UI/UX Builder', icon: '🎨' },
  { id: 'tool', name: 'Tool Creator', icon: '🛠️' },
];
const POST_TYPES = {
  discussion: { label: 'Discussion', icon: '💬' },
  showcase: { label: 'Project Showcase', icon: '🚀' },
  question: { label: 'Question / Help', icon: '❓' },
  progress: { label: 'Progress Update', icon: '📈' },
  poll: { label: 'Poll', icon: '📊' },
  'tool-request': { label: 'Tool Request', icon: '🧰' },
};
const TOOL_CATEGORIES = ['AI Tools', 'Dev Tools', 'GitHub Repos', 'Design', 'Hosting & Cloud', 'Automation', 'Game Dev'];
const PROJECT_STATUS = { idea: 'Idea', building: 'In development', beta: 'Beta', launched: 'Launched' };
const COLORS = ['#5b5bf0', '#e0567a', '#11875d', '#d9822b', '#2f80ed', '#9b51e0', '#14a3a3', '#c2362f'];

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthLabel = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' }); };
const shortMonth = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en', { month: 'short', year: 'numeric' }); };
function ago(t) {
  const s = Math.max(1, Math.floor((now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---------- seed data ---------- */
function seed() {
  const t = now();
  const users = [
    ['u1', 'Arjun Mehta', 'arjun', 'Building Patch. Making things for builders.', ['JavaScript', 'Node', 'Design'], 400, true],
    ['u2', 'Kavya Rao', 'kavya', 'Indie game dev. Unity + Godot. Shipping one tiny game a month.', ['Godot', 'Unity', 'C#'], 380, true],
    ['u3', 'Leo Fernandes', 'leo', 'AI agents & automations. Previously backend at a fintech.', ['Python', 'LangGraph', 'n8n'], 300, true],
    ['u4', 'Mira Santos', 'mira', 'UI/UX designer who codes. Figma → React.', ['Figma', 'React', 'CSS'], 260, false],
    ['u5', 'Dev Patel', 'devp', 'Built my first tool on my phone with AI Studio. Learning every day.', ['AI Studio', 'Apps Script'], 120, true],
    ['u6', 'Sana Qureshi', 'sana', 'Web dev, freelance. Next.js and Tailwind all day.', ['Next.js', 'Tailwind', 'Supabase'], 200, true],
    ['u7', 'Noah Kim', 'noah', 'Battle royale grinder and part-time modder.', ['Lua', 'Blender'], 90, false],
  ].map(([id, name, handle, bio, skills, ageDays, openToWork], i) => ({
    id, name, handle, bio, skills, openToWork, isPublic: true, color: COLORS[i % COLORS.length],
    joinedAt: t - ageDays * DAY, following: [], links: {}, role: 'user', banned: false, verified: false,
  }));
  users[0].role = 'admin'; users[1].role = 'moderator';
  users[0].verified = users[1].verified = users[2].verified = true;
  users[0].following = ['u2', 'u3'];
  users[1].following = ['u1', 'u3', 'u4'];
  users[2].following = ['u1'];

  const communities = [
    ['c1', 'gamedev', 'Game Development', '🎮', 'Engines, mechanics, devlogs and playtests.', ['Show your work-in-progress, not just finished games', 'Give feedback you would want to receive', 'No piracy links'], ['u1', 'u2', 'u7', 'u5']],
    ['c2', 'ai-agents', 'AI Agents', '🤖', 'Agents, tool-calling, evals and everything LLM.', ['Share prompts and code, not just screenshots', 'Mark sponsored content', 'Be kind to beginners'], ['u1', 'u3', 'u5', 'u6']],
    ['c3', 'webdev', 'Web Development', '🌐', 'Frontend, backend, deployment and the stuff in between.', ['Include a link or code when asking for help', 'No self-promo without context'], ['u1', 'u4', 'u6']],
    ['c4', 'battle-royale', 'Battle Royale Squad', '🪂', 'Find squadmates, share wins, talk loadouts.', ['Be respectful in LFG posts', 'No cheats or exploits'], ['u7', 'u2', 'u5']],
    ['c5', 'automation', 'Automation', '⚙️', 'n8n, Zapier, scripts and bots that save hours.', ['Share workflows as JSON when you can'], ['u3', 'u5', 'u6']],
  ].map(([id, slug, name, icon, desc, rules, members], i) => ({ id, slug, name, icon, desc, rules, members, mods: id === 'c4' ? ['u2'] : [], createdBy: members[0], createdAt: t - (200 - i * 20) * DAY }));

  const projects = [
    { id: 'p1', ownerId: 'u2', name: 'Lanternfall', tagline: 'A cozy roguelite where your lantern is your health bar.', desc: 'Explore a drowned city with a lantern that dims as you take damage. Built in Godot 4.', status: 'beta', visibility: 'closed', tech: ['Godot', 'GDScript', 'Aseprite'], demo: 'https://example.com/lanternfall', repo: '', lookingFor: 'Composer for the soundtrack',
      updates: [[60, 'Character controller done', 'Movement, dash and wall-jump feel good now.', 25], [35, 'Environment pass', 'First biome blocked out with lighting.', 55], [8, 'Enemy AI + beta build', 'Three enemy types and a playable beta.', 80]] },
    { id: 'p2', ownerId: 'u3', name: 'InboxPilot', tagline: 'An AI agent that triages your inbox and drafts replies.', desc: 'Classifies email, drafts replies in your tone and asks before sending anything.', status: 'launched', visibility: 'open', tech: ['Python', 'LangGraph', 'FastAPI'], demo: 'https://example.com/inboxpilot', repo: 'https://github.com/example/inboxpilot', lookingFor: '',
      updates: [[90, 'Prototype', 'Classifier working on my own inbox.', 30], [40, 'Draft replies', 'Replies now match tone using a few examples.', 70], [12, 'v1.0 launched', 'Public launch with Gmail support.', 100]] },
    { id: 'p3', ownerId: 'u5', name: 'FPS Booster Lite', tagline: 'One-tap tweaks that boost game FPS on low-end PCs.', desc: 'Built entirely on my phone using AI Studio. Disables background junk and switches power plans.', status: 'building', visibility: 'closed', tech: ['AI Studio', 'PowerShell'], demo: '', repo: '', lookingFor: 'Testers with low-end laptops',
      updates: [[20, 'First version works', 'Getting +12 FPS on my cousin’s laptop.', 40]] },
    { id: 'p4', ownerId: 'u4', name: 'Glasskit UI', tagline: 'A tiny, accessible component kit for dashboards.', desc: 'Contrast-checked components with dark mode built in.', status: 'launched', visibility: 'open', tech: ['React', 'CSS'], demo: 'https://example.com/glasskit', repo: 'https://github.com/example/glasskit', lookingFor: '',
      updates: [[50, 'Buttons, inputs, cards', 'Core components with keyboard support.', 50], [15, 'v1 docs live', 'Docs site with live examples.', 100]] },
    { id: 'p5', ownerId: 'u6', name: 'ShopSprint', tagline: 'A Next.js storefront template that loads in under a second.', desc: 'Commerce starter with Supabase auth and Stripe checkout.', status: 'beta', visibility: 'open', tech: ['Next.js', 'Supabase', 'Tailwind'], demo: 'https://example.com/shopsprint', repo: '', lookingFor: 'Design feedback',
      updates: [[25, 'Checkout flow', 'Stripe checkout and order emails.', 60]] },
    { id: 'p6', ownerId: 'u1', name: 'Patch', tagline: 'A home for builders to showcase projects and grow together.', desc: 'The platform you are looking at. Feed, communities, Vault and the Championship.', status: 'building', visibility: 'closed', tech: ['JavaScript', 'HTML', 'CSS'], demo: '', repo: '', lookingFor: 'Suggestions from the community!',
      updates: [[30, 'Feed + posts', 'Posts, comments, likes and saves.', 30], [10, 'Vault + Championship', 'Project pages and monthly voting.', 70]] },
  ].map((p) => ({ ...p, createdAt: t - (p.updates[0][0] + 5) * DAY, updates: p.updates.map(([d, title, body, percent]) => ({ id: uid(), title, body, percent, createdAt: t - d * DAY })) }));

  const P = (o) => ({ id: uid(), likes: [], saves: [], comments: [], tags: [], image: '', ...o });
  const posts = [
    P({ type: 'showcase', authorId: 'u3', communityId: 'c2', projectId: 'p2', title: 'I built an AI agent that drafts my email replies', body: 'InboxPilot reads incoming mail, sorts it, and drafts a reply in my tone. It never sends without asking.\n\nFeatures:\n• Priority triage\n• Tone-matched drafts\n• Daily digest\n\nWould love feedback on the onboarding!', tags: ['ai', 'agents', 'python'], createdAt: t - 3 * 3600e3, likes: ['u1', 'u5', 'u6', 'u2'],
      comments: [{ id: uid(), authorId: 'u5', body: 'This is exactly what I needed. Does it work with Outlook?', createdAt: t - 2 * 3600e3 }, { id: uid(), authorId: 'u3', body: 'Gmail only for now, Outlook is next on the roadmap.', createdAt: t - 1.5 * 3600e3 }] }),
    P({ type: 'question', authorId: 'u5', communityId: 'c1', title: 'Godot: "Invalid get index \'position\' (on base: \'null instance\')" — how do I fix this?', body: 'My enemy script crashes when the player dies. I call get_node("Player").position every frame.', tags: ['godot', 'help'], createdAt: t - 7 * 3600e3, likes: ['u2'],
      comments: [{ id: uid(), authorId: 'u2', body: 'The player node is freed when it dies. Check is_instance_valid(player) before reading position, or listen for a "died" signal and stop chasing.', createdAt: t - 6 * 3600e3 }], solved: true }),
    P({ type: 'progress', authorId: 'u2', communityId: 'c1', projectId: 'p1', title: 'Lanternfall devlog: enemy AI is in, beta is live', body: 'Three enemy types now hunt by light level. Beta build is up for testers.', progress: { percent: 80, eta: new Date(t + 25 * DAY).toISOString().slice(0, 10) }, tags: ['devlog', 'godot'], createdAt: t - 26 * 3600e3, likes: ['u1', 'u7', 'u5'] }),
    P({ type: 'poll', authorId: 'u1', communityId: 'c3', title: 'Which name sounds better for project pages?', body: 'Every project gets its own dedicated page. Help me pick the name!', poll: { options: [{ text: 'Project Vault', votes: ['u2', 'u3', 'u6'] }, { text: 'Project Void', votes: ['u7'] }] }, createdAt: t - 30 * 3600e3, likes: ['u4'] }),
    P({ type: 'tool-request', authorId: 'u7', communityId: 'c4', title: 'Looking for a tool that tracks my battle royale stats across games', body: 'Something that pulls wins/kills from multiple games into one dashboard. Does it exist?', tags: ['gaming', 'tools'], createdAt: t - 40 * 3600e3 }),
    P({ type: 'discussion', authorId: 'u7', communityId: 'c4', title: '5 wins today 🔥 who is up for squads tonight?', body: 'Finally hit my weekly goal. Looking for 2 more for ranked squads around 9 PM IST.', createdAt: t - 50 * 3600e3, likes: ['u2', 'u5'] }),
    P({ type: 'showcase', authorId: 'u4', communityId: 'c3', projectId: 'p4', title: 'Glasskit UI v1 — accessible dashboard components', body: 'Every color pair passes contrast checks in light and dark mode. Free and open source.', tags: ['react', 'design', 'a11y'], createdAt: t - 3 * DAY, likes: ['u1', 'u6'] }),
    P({ type: 'discussion', authorId: 'u1', communityId: 'c2', title: 'What should the Patch Championship categories be?', body: 'Right now: AI Agent Builder, Game Developer, Website Builder, Automation Expert, UI/UX Builder, Tool Creator. What else should we add?', createdAt: t - 4 * DAY, likes: ['u2', 'u3', 'u4', 'u5', 'u6'],
      comments: [{ id: uid(), authorId: 'u6', body: 'Mobile App Builder for sure!', createdAt: t - 3.8 * DAY }] }),
  ];

  const tools = [
    ['Cursor', 'https://cursor.com', 'AI Tools', 'AI-first code editor with codebase chat.', false],
    ['Google AI Studio', 'https://aistudio.google.com', 'AI Tools', 'Prototype apps with Gemini right from the browser — works on phones too.', false],
    ['n8n', 'https://n8n.io', 'Automation', 'Open-source workflow automation you can self-host.', false],
    ['Godot Engine', 'https://godotengine.org', 'Game Dev', 'Free, open-source 2D/3D game engine.', false],
    ['Excalidraw', 'https://excalidraw.com', 'Design', 'Hand-drawn style whiteboard for quick diagrams.', false],
    ['awesome-selfhosted', 'https://github.com/awesome-selfhosted/awesome-selfhosted', 'GitHub Repos', 'Huge list of self-hostable software.', false],
    ['Vercel Hobby', 'https://vercel.com', 'Hosting & Cloud', 'Free tier for hosting frontend projects.', false],
    ['Cloud credits for students', 'https://education.github.com/pack', 'Hosting & Cloud', 'Free cloud credits and dev tools with the GitHub Student Pack.', true],
    ['Bruno', 'https://www.usebruno.com', 'Dev Tools', 'Offline-first API client; collections live in your repo.', false],
  ].map(([name, url, category, desc, isOffer], i) => ({ id: uid(), name, url, category, desc, isOffer, expires: isOffer ? new Date(t + 30 * DAY).toISOString().slice(0, 10) : '', addedBy: users[i % users.length].id, upvotes: users.slice(0, (i * 3) % 6 + 1).map((u) => u.id), status: 'approved', createdAt: t - i * 2 * DAY }));
  tools.push({ id: uid(), name: 'FreeGPU Finder', url: 'https://example.com/freegpu', category: 'Hosting & Cloud', desc: 'Tracks free GPU credits across cloud providers.', isOffer: true, expires: '', addedBy: 'u5', upvotes: ['u5'], status: 'pending', createdAt: t - 3600e3 });

  // Championship history: every month from January of last year up to last month.
  const champ = { submissions: [], votes: [], winners: [], closed: [] };
  const builders = { 'ai-agent': ['u3', 'u5', 'u6'], game: ['u2', 'u7', 'u5'], website: ['u6', 'u4', 'u1'], automation: ['u3', 'u5', 'u6'], uiux: ['u4', 'u6', 'u1'], tool: ['u5', 'u3', 'u1'] };
  const cur = new Date();
  const projectFor = (userId) => (projects.find((p) => p.ownerId === userId) || {}).id || '';
  for (let d = new Date(cur.getFullYear() - 1, 0, 1); d < new Date(cur.getFullYear(), cur.getMonth(), 1); d.setMonth(d.getMonth() + 1)) {
    const mk = monthKey(d);
    champ.closed.push(mk);
    CHAMP_CATEGORIES.forEach((c, ci) => {
      const pool = builders[c.id];
      // deterministic but varied: winners rotate so newer builders get crowned too
      const r = (d.getMonth() * 7 + ci * 3 + d.getFullYear()) % 10;
      const userId = r < 5 ? pool[0] : r < 8 ? pool[1] : pool[2];
      champ.winners.push({ month: mk, category: c.id, userId, projectId: projectFor(userId), projectName: (projects.find((p) => p.id === projectFor(userId)) || {}).name || 'Entry', votes: 20 + ((r * 13 + ci * 5) % 60) });
    });
  }
  // Current month: open submissions with a few votes.
  const mk = monthKey(cur);
  [['ai-agent', 'p2'], ['game', 'p1'], ['tool', 'p3'], ['uiux', 'p4'], ['website', 'p5'], ['website', 'p6']].forEach(([category, projectId]) => {
    const p = projects.find((x) => x.id === projectId);
    champ.submissions.push({ id: uid(), month: mk, category, projectId, userId: p.ownerId, note: p.tagline, createdAt: t - 5 * DAY });
  });
  const sub = (cat, pid) => champ.submissions.find((s) => s.category === cat && s.projectId === pid).id;
  [['u1', 'ai-agent', 'p2'], ['u6', 'ai-agent', 'p2'], ['u7', 'game', 'p1'], ['u5', 'game', 'p1'], ['u2', 'tool', 'p3'], ['u3', 'tool', 'p3'], ['u1', 'uiux', 'p4'], ['u2', 'website', 'p5'], ['u3', 'website', 'p6']]
    .forEach(([voterId, category, pid]) => champ.votes.push({ month: mk, category, voterId, submissionId: sub(category, pid) }));

  const notifications = [
    { id: uid(), userId: 'u1', text: 'Leo Fernandes started following you', link: '#/u/leo', read: false, createdAt: t - 2 * 3600e3 },
    { id: uid(), userId: 'u1', text: 'Kavya Rao voted in your poll "Which name sounds better…"', link: '', read: false, createdAt: t - 20 * 3600e3 },
    { id: uid(), userId: 'u1', text: 'Sana Qureshi commented on "What should the Patch Championship categories be?"', link: '', read: true, createdAt: t - 3.8 * DAY },
  ];
  const pollPost = posts.find((p) => p.type === 'poll'); notifications[1].link = `#/post/${pollPost.id}`;
  notifications[2].link = `#/post/${posts[posts.length - 1].id}`;

  const messages = [
    { id: uid(), from: 'u2', to: 'u1', body: 'Hey! Loved the Patch idea. Want to collab on the game dev community?', createdAt: t - 5 * 3600e3, read: false },
    { id: uid(), from: 'u1', to: 'u2', body: 'Absolutely — let’s set up some rules and pin a devlog thread.', createdAt: t - 4 * 3600e3, read: true },
    { id: uid(), from: 'u6', to: 'u1', body: 'Saw ShopSprint got some views from Patch. A client reached out already!', createdAt: t - 26 * 3600e3, read: true },
  ];

  const reports = [
    { id: uid(), kind: 'post', targetId: posts[4].id, reason: 'Off-topic', note: 'Not really a tool request, more of a gaming question.', reporterId: 'u6', status: 'open', createdAt: t - 5 * 3600e3 },
    { id: uid(), kind: 'comment', targetId: `${posts[0].id}|${posts[0].comments[0].id}`, reason: 'Spam or self-promotion', note: '', reporterId: 'u4', status: 'dismissed', handledBy: 'u2', handledAt: t - 3600e3, createdAt: t - 2 * 3600e3 },
  ];
  const settings = { communityMinAgeDays: 3, toolApproval: true, announcement: '🎉 Patch beta is open — add your first project to the Vault!' };
  const auditLog = [{ id: uid(), actorId: 'u2', action: 'dismissed report', detail: 'comment — Spam or self-promotion', createdAt: t - 3600e3 }];
  return { version: 2, currentUserId: 'u1', users, communities, posts, projects, tools, champ, notifications, messages, reports, settings, audit: auditLog };
}

/* ---------- store ---------- */
let db;
function load() {
  try { db = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { db = null; }
  if (!db || db.version !== 2) { db = seed(); save(); }
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
  catch { toast('Storage is full — try smaller images.'); }
}

const me = () => db.users.find((u) => u.id === db.currentUserId) || null;
const user = (id) => db.users.find((u) => u.id === id);
const userByHandle = (h) => db.users.find((u) => u.handle === h);
const community = (id) => db.communities.find((c) => c.id === id);
const communityBySlug = (s) => db.communities.find((c) => c.slug === s);
const project = (id) => db.projects.find((p) => p.id === id);
const post = (id) => db.posts.find((p) => p.id === id);
const accountAgeDays = (u) => (now() - u.joinedAt) / DAY;
const minAge = () => db.settings?.communityMinAgeDays ?? DEFAULT_MIN_AGE_DAYS;
const isAdmin = (u = me()) => !!u && u.role === 'admin';
const isStaff = (u = me()) => !!u && (u.role === 'admin' || u.role === 'moderator');
// Site staff moderate everywhere; a community's creator and its moderators moderate inside it.
const canModerate = (c, u = me()) => isStaff(u) || (!!u && !!c && !u.banned && (c.createdBy === u.id || (c.mods || []).includes(u.id)));
function audit(action, detail = '') {
  db.audit.unshift({ id: uid(), actorId: me()?.id, action, detail, createdAt: now() });
  if (db.audit.length > 500) db.audit.length = 500;
}

function notify(userId, text, link) {
  const m = me();
  if (!userId || (m && userId === m.id)) return;
  db.notifications.unshift({ id: uid(), userId, text, link, read: false, createdAt: now() });
}

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
function champBadges(u) {
  const wins = db.champ.winners.filter((w) => w.userId === u.id).length;
  const yearly = yearlyTitles().filter((y) => y.userId === u.id).length;
  let s = '';
  if (u.verified) s += ' <span class="verified" title="Verified builder">✔</span>';
  if (u.role === 'admin') s += ' <span class="pill pill-accent" title="Patch admin">🛡️ Admin</span>';
  else if (u.role === 'moderator') s += ' <span class="pill pill-good" title="Patch moderator">🛡️ Mod</span>';
  if (yearly) s += ` <span class="champ-badge" title="Yearly champion">👑 ${yearly}</span>`;
  if (wins) s += ` <span class="champ-badge" title="Monthly championship trophies">🏆 ${wins}</span>`;
  return s;
}
const userLink = (u) => u ? `<a href="#/u/${esc(u.handle)}"><strong>${esc(u.name)}</strong></a>${champBadges(u)}` : 'Unknown';
const progressBar = (pct) => `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>`;
const statusPill = (s) => `<span class="pill status-${esc(s)}">${esc(PROJECT_STATUS[s] || s)}</span>`;

function postCard(p, { full = false } = {}) {
  const a = user(p.authorId), c = community(p.communityId), m = me();
  const type = POST_TYPES[p.type] || POST_TYPES.discussion;
  const liked = m && p.likes.includes(m.id), saved = m && p.saves.includes(m.id);
  const proj = p.projectId && project(p.projectId);
  let extra = '';
  if (p.type === 'poll' && p.poll) {
    const total = p.poll.options.reduce((n, o) => n + o.votes.length, 0);
    extra = `<div class="poll">${p.poll.options.map((o, i) => {
      const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
      const mine = m && o.votes.includes(m.id);
      return `<button class="poll-opt ${mine ? 'mine' : ''}" data-act="vote-poll" data-id="${p.id}" data-i="${i}"><div class="fill" style="width:${pct}%"></div><span>${mine ? '✓ ' : ''}${esc(o.text)}</span><span class="muted" style="float:right">${pct}%</span></button>`;
    }).join('')}<div class="hint">${plural(total, 'vote')}</div></div>`;
  }
  if (p.type === 'progress' && p.progress) {
    extra = `<div style="margin:10px 0"><div class="row between small"><strong>${p.progress.percent}% complete</strong>${p.progress.eta ? `<span class="muted">Target: ${esc(new Date(p.progress.eta).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' }))}</span>` : ''}</div>${progressBar(p.progress.percent)}</div>`;
  }
  const body = p.body ? `<div class="post-body ${full ? '' : 'clamp'}">${esc(p.body)}</div>` : '';
  return `<article class="card post">
    <div class="post-meta">
      ${c ? `<a href="#/c/${esc(c.slug)}" class="row" style="gap:4px"><span class="comm-icon" style="width:20px;height:20px;font-size:.75rem">${esc(c.icon)}</span><strong>p/${esc(c.slug)}</strong></a> ·` : ''}
      ${avatar(a, 'sm')} ${userLink(a)} · <span>${ago(p.createdAt)}</span>
      <span class="pill pill-accent">${type.icon} ${type.label}</span>
      ${p.solved ? '<span class="pill pill-good">✓ Solved</span>' : ''}
      ${p.pinned ? '<span class="pill pill-gold">📌 Pinned</span>' : ''}
    </div>
    <div class="post-title"><a href="#/post/${p.id}">${esc(p.title)}</a></div>
    ${body}
    ${p.image ? `<img class="post-img" src="${esc(p.image)}" alt="">` : ''}
    ${extra}
    ${proj ? `<a href="#/vault/${proj.id}" class="card row" style="padding:10px;margin-top:10px;box-shadow:none;background:var(--surface-2)">🗄️ <span><strong>${esc(proj.name)}</strong> <span class="muted small">— ${esc(proj.tagline)}</span></span> ${statusPill(proj.status)}</a>` : ''}
    ${p.tags?.length ? `<div class="chips" style="margin-top:8px">${p.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="actions">
      <button class="act ${liked ? 'on' : ''}" data-act="like" data-id="${p.id}" aria-pressed="${!!liked}">${liked ? '♥' : '♡'} ${p.likes.length}</button>
      <a class="act" href="#/post/${p.id}">💬 ${p.comments.length}</a>
      <button class="act ${saved ? 'on' : ''}" data-act="save" data-id="${p.id}" aria-pressed="${!!saved}">${saved ? '🔖 Saved' : '🔖 Save'}</button>
      <button class="act" data-act="share" data-id="${p.id}">↗ Share</button>
      ${m && (m.id === p.authorId) && p.type === 'question' ? `<button class="act" data-act="solve" data-id="${p.id}">${p.solved ? 'Mark unsolved' : '✓ Mark solved'}</button>` : ''}
      ${m && m.id !== p.authorId ? `<button class="act" data-act="report" data-kind="post" data-id="${p.id}">⚑ Report</button>` : ''}
      ${canModerate(c) ? `<button class="act" data-act="pin-post" data-id="${p.id}">📌 ${p.pinned ? 'Unpin' : 'Pin'}</button>` : ''}
      ${m && (m.id === p.authorId || canModerate(c)) ? `<button class="act" data-act="delete-post" data-id="${p.id}">🗑 ${m.id === p.authorId ? 'Delete' : 'Remove'}</button>` : ''}
    </div>
  </article>`;
}

function feedFilters(state) {
  return `<div class="tabs">${['hot', 'new', 'top'].map((s) => `<button class="tab ${state.sort === s ? 'active' : ''}" data-sort="${s}">${{ hot: '🔥 For you', new: '🆕 Latest', top: '⬆ Top' }[s]}</button>`).join('')}</div>
  <div class="chips" style="margin-bottom:14px"><button class="chip ${!state.type ? 'active' : ''}" data-type="">All</button>${Object.entries(POST_TYPES).map(([k, v]) => `<button class="chip ${state.type === k ? 'active' : ''}" data-type="${k}">${v.icon} ${v.label}</button>`).join('')}</div>`;
}
function sortPosts(list, sort) {
  return sortRaw(list, sort).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}
function sortRaw(list, sort) {
  const score = (p) => p.likes.length * 2 + p.comments.length * 3;
  if (sort === 'new') return list.sort((a, b) => b.createdAt - a.createdAt);
  if (sort === 'top') return list.sort((a, b) => score(b) - score(a));
  // hot: engagement decayed by age
  return list.sort((a, b) => (score(b) + 1) / Math.pow((now() - b.createdAt) / 3600e3 + 2, 1.2) - (score(a) + 1) / Math.pow((now() - a.createdAt) / 3600e3 + 2, 1.2));
}
function bindFeed(root, state, rerender) {
  $$('[data-sort]', root).forEach((b) => b.onclick = () => { state.sort = b.dataset.sort; rerender(); });
  $$('[data-type]', root).forEach((b) => b.onclick = () => { state.type = b.dataset.type; rerender(); });
}

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
        <div class="row"><a class="btn btn-primary" href="#/new">＋ Create post</a><a class="btn" href="#/vault/new">🗄️ Add a project to the Vault</a></div>
      </div>
      ${m ? `<div class="chips" style="margin-bottom:10px"><button class="chip ${feedState.scope === 'all' ? 'active' : ''}" data-scope="all">Everything</button><button class="chip ${feedState.scope === 'mine' ? 'active' : ''}" data-scope="mine">My communities & following</button></div>` : ''}
      ${feedFilters(feedState)}
      <div id="feedList">${list.length ? list.map((p) => postCard(p)).join('') : `<div class="card empty">Nothing here yet. <a class="link" href="#/communities">Join a community</a> or <a class="link" href="#/new">create a post</a>.</div>`}</div>
    </div>
    <aside class="rail">
      <a class="card trophy" href="#/championship" style="display:block">
        <div class="row"><span class="cup">🏆</span><div><strong>${esc(monthLabel(mk))} Championship</strong><div class="small muted">${daysLeft} days left to vote · ${db.champ.submissions.filter((s) => s.month === mk).length} entries</div></div></div>
      </a>
      <div class="card hide-narrow">
        <h3>Popular communities</h3>
        ${db.communities.slice().sort((a, b) => b.members.length - a.members.length).slice(0, 5).map((c) => `<a href="#/c/${esc(c.slug)}" class="row" style="padding:6px 0"><span class="comm-icon">${esc(c.icon)}</span><span style="flex:1"><strong>p/${esc(c.slug)}</strong><div class="small muted">${plural(c.members.length, 'member')}</div></span></a>`).join('')}
        <a class="btn btn-sm" style="width:100%;margin-top:8px" href="#/communities">See all</a>
      </div>
      <div class="card hide-narrow">
        <h3>Fresh in the Vault</h3>
        ${db.projects.slice().sort((a, b) => lastUpdate(b) - lastUpdate(a)).slice(0, 4).map((p) => `<a href="#/vault/${p.id}" style="display:block;padding:6px 0"><strong>${esc(p.name)}</strong> ${statusPill(p.status)}<div class="small muted">${esc(p.tagline)}</div></a>`).join('')}
      </div>
    </aside>
  </div>`;
}
function afterFeed(root) {
  bindFeed(root, feedState, render);
  $$('[data-scope]', root).forEach((b) => b.onclick = () => { feedState.scope = b.dataset.scope; render(); });
}

function viewPost(id) {
  const p = post(id);
  if (!p) return notFound();
  const m = me();
  return `<div class="page single"><div class="stack">
    ${postCard(p, { full: true })}
    <div class="card">
      <h3>${plural(p.comments.length, 'comment')}</h3>
      ${m ? `<form id="commentForm" class="field"><textarea name="body" placeholder="${p.type === 'question' ? 'Know the fix? Share it…' : 'Add a comment…'}" required maxlength="4000" style="min-height:80px"></textarea><div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn btn-primary btn-sm">Comment</button></div></form>` : `<p class="muted"><button class="link-btn" data-act="login">Log in</button> to comment.</p>`}
      <div>${p.comments.map((c) => { const a = user(c.authorId); return `<div class="comment">${avatar(a, 'sm')}<div style="flex:1;min-width:0"><div class="small">${userLink(a)} <span class="muted">· ${ago(c.createdAt)}</span></div><div class="post-body">${esc(c.body)}</div>${commentActions(p, c)}</div></div>`; }).join('') || '<div class="muted">No comments yet — be the first.</div>'}</div>
    </div>
  </div></div>`;
}
function afterPost(root, id) {
  const f = $('#commentForm', root);
  if (f) f.onsubmit = (e) => {
    e.preventDefault();
    const body = f.body.value.trim(); if (!body) return;
    const p = post(id);
    p.comments.push({ id: uid(), authorId: me().id, body, createdAt: now() });
    notify(p.authorId, `${me().name} commented on "${p.title.slice(0, 50)}"`, `#/post/${p.id}`);
    save(); render();
  };
}

/* Create post */
function viewNewPost(params) {
  if (!me()) return loginWall('create a post');
  const m = me();
  const joined = db.communities.filter((c) => c.members.includes(m.id));
  const myProjects = db.projects.filter((p) => p.ownerId === m.id);
  const pre = params.get('c');
  return `<div class="page single"><div class="card">
    <h1>Create a post</h1>
    <form id="postForm">
      <div class="field"><label>Post type</label><div class="chips" id="typeChips">${Object.entries(POST_TYPES).map(([k, v], i) => `<button type="button" class="chip ${i === 0 ? 'active' : ''}" data-ptype="${k}">${v.icon} ${v.label}</button>`).join('')}</div></div>
      <div class="field"><label for="pf-c">Community</label><select id="pf-c" name="communityId" required>${(joined.length ? joined : db.communities).map((c) => `<option value="${c.id}" ${c.slug === pre ? 'selected' : ''}>p/${esc(c.slug)} — ${esc(c.name)}</option>`).join('')}</select>${joined.length ? '' : '<div class="hint">Join communities to see them listed first.</div>'}</div>
      <div class="field"><label for="pf-t">Title</label><input id="pf-t" type="text" name="title" maxlength="200" required placeholder="What did you build, ask or discover?"></div>
      <div class="field"><label for="pf-b">Details</label><textarea id="pf-b" name="body" maxlength="10000" placeholder="Describe what it does, its features, or the error you are facing…"></textarea></div>
      <div class="field" data-for="poll" hidden><label>Poll options</label><div id="pollOpts"><input type="text" name="opt" placeholder="Option 1" style="margin-bottom:6px"><input type="text" name="opt" placeholder="Option 2" style="margin-bottom:6px"></div><button type="button" class="btn btn-sm" id="addOpt">＋ Add option</button></div>
      <div class="grid-2" data-for="progress" hidden>
        <div class="field"><label for="pf-pct">Completion: <span id="pctOut">50</span>%</label><input id="pf-pct" type="range" name="percent" min="0" max="100" value="50"></div>
        <div class="field"><label for="pf-eta">Expected finish</label><input id="pf-eta" type="date" name="eta"></div>
      </div>
      <div class="field" data-for="showcase progress"><label for="pf-proj">Link a Vault project (optional)</label><select id="pf-proj" name="projectId"><option value="">— none —</option>${myProjects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>${myProjects.length ? '' : '<div class="hint">No projects yet. <a class="link" href="#/vault/new">Add one to the Vault</a> to give it a permanent page.</div>'}</div>
      <div class="field"><label for="pf-img">Image (optional)</label><input id="pf-img" type="file" name="image" accept="image/*"><img id="imgPrev" class="post-img" hidden alt=""></div>
      <div class="field"><label for="pf-tags">Tags</label><input id="pf-tags" type="text" name="tags" placeholder="godot, ai, help (comma separated)"></div>
      <div class="row" style="justify-content:flex-end"><a class="btn" href="#/">Cancel</a><button class="btn btn-primary">Post</button></div>
    </form>
  </div></div>`;
}
function afterNewPost(root) {
  const f = $('#postForm', root); if (!f) return;
  let type = 'discussion', image = '';
  const sync = () => $$('[data-for]', root).forEach((el) => el.hidden = !el.dataset.for.split(' ').includes(type));
  $$('[data-ptype]', root).forEach((b) => b.onclick = () => { type = b.dataset.ptype; $$('[data-ptype]', root).forEach((x) => x.classList.toggle('active', x === b)); sync(); });
  type = 'discussion'; $$('[data-ptype]', root)[0].click();
  $('#addOpt', root).onclick = () => { const n = $$('#pollOpts input', root).length; if (n >= 6) return; $('#pollOpts', root).insertAdjacentHTML('beforeend', `<input type="text" name="opt" placeholder="Option ${n + 1}" style="margin-bottom:6px">`); };
  f.percent.oninput = () => $('#pctOut', root).textContent = f.percent.value;
  f.image.onchange = async () => { image = await readImage(f.image.files[0]); const pv = $('#imgPrev', root); pv.src = image; pv.hidden = !image; };
  f.onsubmit = (e) => {
    e.preventDefault();
    const p = { id: uid(), type, authorId: me().id, communityId: f.communityId.value, title: f.title.value.trim(), body: f.body.value.trim(), image, likes: [], saves: [], comments: [], createdAt: now(),
      tags: f.tags.value.split(',').map((s) => s.trim().replace(/^#/, '').toLowerCase()).filter(Boolean).slice(0, 6) };
    if (!p.title) return toast('Add a title');
    if (type === 'poll') {
      const opts = $$('#pollOpts input', root).map((i) => i.value.trim()).filter(Boolean);
      if (opts.length < 2) return toast('A poll needs at least 2 options');
      p.poll = { options: opts.map((text) => ({ text, votes: [] })) };
    }
    if (type === 'progress') p.progress = { percent: Number(f.percent.value), eta: f.eta.value };
    if ((type === 'showcase' || type === 'progress') && f.projectId.value) {
      p.projectId = f.projectId.value;
      if (type === 'progress') project(p.projectId).updates.push({ id: uid(), title: p.title, body: p.body, percent: p.progress.percent, createdAt: now() });
    }
    db.posts.unshift(p);
    me().following && db.users.filter((u) => u.following.includes(me().id)).forEach((u) => notify(u.id, `${me().name} posted: "${p.title.slice(0, 50)}"`, `#/post/${p.id}`));
    save(); toast('Posted!'); location.hash = `#/post/${p.id}`;
  };
}
function readImage(file) {
  return new Promise((resolve) => {
    if (!file) return resolve('');
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 900 / Math.max(img.width, img.height));
        const c = document.createElement('canvas'); c.width = img.width * scale; c.height = img.height * scale;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => resolve('');
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

/* Communities */
function viewCommunities() {
  const m = me();
  return `<div class="page single">
    <div class="row between" style="margin-bottom:14px"><div><h1>Communities</h1><p class="muted">Join the spaces you care about and your feed fills with what interests you.</p></div><button class="btn btn-primary" data-act="new-community">＋ Create community</button></div>
    <div class="grid-2">${db.communities.map((c) => {
      const joined = m && c.members.includes(m.id);
      return `<div class="card"><div class="row" style="align-items:flex-start"><span class="comm-icon" style="width:44px;height:44px;font-size:1.4rem;border-radius:12px">${esc(c.icon)}</span><div style="flex:1;min-width:0"><a href="#/c/${esc(c.slug)}"><strong>${esc(c.name)}</strong></a><div class="small muted">p/${esc(c.slug)} · ${plural(c.members.length, 'member')} · ${plural(db.posts.filter((p) => p.communityId === c.id).length, 'post')}</div><p class="small" style="margin-top:6px">${esc(c.desc)}</p></div></div><div class="row" style="justify-content:flex-end"><button class="btn btn-sm ${joined ? '' : 'btn-primary'}" data-act="join" data-id="${c.id}">${joined ? 'Joined ✓' : 'Join'}</button></div></div>`;
    }).join('')}</div>
  </div>`;
}
const commState = { sort: 'hot', type: '' };
function viewCommunity(slug) {
  const c = communityBySlug(slug); if (!c) return notFound();
  const m = me(), joined = m && c.members.includes(m.id);
  let list = db.posts.filter((p) => p.communityId === c.id);
  if (commState.type) list = list.filter((p) => p.type === commState.type);
  list = sortPosts(list, commState.sort);
  const creator = user(c.createdBy);
  return `<div class="page">
    <div>
      <div class="hero row" style="align-items:center"><span class="comm-icon lg">${esc(c.icon)}</span><div style="flex:1;min-width:0"><h1 style="margin:0">${esc(c.name)}</h1><div class="muted">p/${esc(c.slug)} · ${plural(c.members.length, 'member')}</div></div>
        <div class="row"><a class="btn" href="#/new?c=${esc(c.slug)}">＋ Post</a><button class="btn ${joined ? '' : 'btn-primary'}" data-act="join" data-id="${c.id}">${joined ? 'Joined ✓' : 'Join'}</button></div></div>
      ${feedFilters(commState)}
      ${list.length ? list.map((p) => postCard(p)).join('') : '<div class="card empty">No posts yet. Start the first discussion!</div>'}
    </div>
    <aside class="rail">
      <div class="card"><h3>About</h3><p class="small">${esc(c.desc)}</p><div class="small muted">Created ${ago(c.createdAt)} by ${userLink(creator)}</div>
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
  if (age < minAge()) {
    const left = Math.ceil((minAge() - age) * 24);
    return modal(`<h2>Almost there!</h2><p>To keep Patch free of spam accounts, new members can create a community after <strong>${minAge()} days</strong>.</p><div class="notice">Your account is ${age < 1 ? 'less than a day' : plural(Math.floor(age), 'day')} old. You can create a community in about ${plural(left, 'hour')}.</div><p class="small muted" style="margin-top:10px">Meanwhile you can join communities, post, and add projects to the Vault.</p>`);
  }
  modal(`<h2>Create a community</h2>
    <form id="commForm">
      <div class="grid-2"><div class="field"><label for="cf-n">Name</label><input id="cf-n" type="text" name="name" maxlength="50" required placeholder="Battle Royale Squad"></div>
      <div class="field"><label for="cf-i">Icon (emoji)</label><input id="cf-i" type="text" name="icon" maxlength="4" value="✨"></div></div>
      <div class="field"><label for="cf-s">URL name</label><input id="cf-s" type="text" name="slug" maxlength="30" required pattern="[a-z0-9-]{3,30}" placeholder="battle-royale"><div class="hint">p/your-name — lowercase letters, numbers and dashes.</div></div>
      <div class="field"><label for="cf-d">Description</label><textarea id="cf-d" name="desc" maxlength="300" required style="min-height:70px"></textarea></div>
      <div class="field"><label for="cf-r">Rules (one per line)</label><textarea id="cf-r" name="rules" maxlength="1500" style="min-height:80px" placeholder="Be respectful&#10;No spam"></textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Create</button></div>
    </form>`);
  const f = $('#commForm');
  f.name.oninput = () => { if (!f.slug.dataset.touched) f.slug.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30); };
  f.slug.oninput = () => f.slug.dataset.touched = '1';
  f.onsubmit = (e) => {
    e.preventDefault();
    const slug = f.slug.value.trim();
    if (communityBySlug(slug)) return toast('That URL name is taken');
    const c = { id: uid(), slug, name: f.name.value.trim(), icon: f.icon.value.trim() || '✨', desc: f.desc.value.trim(), rules: f.rules.value.split('\n').map((s) => s.trim()).filter(Boolean), members: [m.id], mods: [], createdBy: m.id, createdAt: now() };
    db.communities.push(c); save(); closeModal(); toast('Community created!'); location.hash = `#/c/${c.slug}`;
  };
}

/* Tools */
const toolState = { cat: '', sort: 'top' };
function viewTools() {
  const m = me();
  let list = db.tools.filter((t) => t.status !== 'pending');
  if (toolState.cat === 'offers') list = list.filter((t) => t.isOffer);
  else if (toolState.cat) list = list.filter((t) => t.category === toolState.cat);
  list.sort(toolState.sort === 'new' ? (a, b) => b.createdAt - a.createdAt : (a, b) => b.upvotes.length - a.upvotes.length);
  return `<div class="page single">
    <div class="row between" style="margin-bottom:10px"><div><h1>Tools & Offers</h1><p class="muted">Discover AI tools, dev tools, GitHub repos and limited-time deals — shared by the community.</p></div><button class="btn btn-primary" data-act="new-tool">＋ Share a tool</button></div>
    <div class="chips" style="margin-bottom:8px"><button class="chip ${!toolState.cat ? 'active' : ''}" data-cat="">All</button><button class="chip ${toolState.cat === 'offers' ? 'active' : ''}" data-cat="offers">🎁 Offers & deals</button>${TOOL_CATEGORIES.map((c) => `<button class="chip ${toolState.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="tabs"><button class="tab ${toolState.sort === 'top' ? 'active' : ''}" data-tsort="top">Most upvoted</button><button class="tab ${toolState.sort === 'new' ? 'active' : ''}" data-tsort="new">Newest</button></div>
    <div class="grid-2">${list.map((t) => {
      const up = m && t.upvotes.includes(m.id), url = safeUrl(t.url);
      return `<div class="card"><div class="row between"><strong>${esc(t.name)}</strong><span class="tag">${esc(t.category)}</span></div>
        ${t.isOffer ? `<div style="margin-top:4px"><span class="pill pill-warn">🎁 Offer${t.expires ? ` · until ${esc(t.expires)}` : ''}</span></div>` : ''}
        <p class="small" style="margin-top:6px">${esc(t.desc)}</p>
        <div class="row between"><span class="small muted">by ${userLink(user(t.addedBy))}</span><span class="row">${isStaff() ? `<button class="btn btn-sm" data-act="remove-tool" data-id="${t.id}" title="Remove (staff)">🗑</button>` : ''}<button class="btn btn-sm ${up ? 'btn-primary' : ''}" data-act="upvote-tool" data-id="${t.id}">▲ ${t.upvotes.length}</button>${url ? `<a class="btn btn-sm" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` : ''}</span></div></div>`;
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
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Share</button></div></form>`);
  const f = $('#toolForm');
  f.isOffer.onchange = () => $('#expWrap').hidden = !f.isOffer.checked;
  f.onsubmit = (e) => {
    e.preventDefault();
    if (!safeUrl(f.url.value)) return toast('Enter a valid http(s) link');
    const needsReview = db.settings.toolApproval && !isStaff();
    db.tools.unshift({ id: uid(), name: f.name.value.trim(), url: f.url.value.trim(), category: f.category.value, desc: f.desc.value.trim(), isOffer: f.isOffer.checked, expires: f.isOffer.checked ? f.expires.value : '', addedBy: me().id, upvotes: [me().id], createdAt: now(), status: needsReview ? 'pending' : 'approved' });
    if (needsReview) db.users.filter((u) => isStaff(u)).forEach((u) => notify(u.id, `New tool waiting for approval: ${f.name.value.trim()}`, '#/admin'));
    save(); closeModal(); toolState.sort = 'new'; render(); toast(needsReview ? 'Submitted! It appears once a moderator approves it.' : 'Thanks for sharing!');
  };
}

/* Project Vault */
const lastUpdate = (p) => Math.max(p.createdAt, ...p.updates.map((u) => u.createdAt));
const currentPct = (p) => (p.updates.length ? p.updates[p.updates.length - 1].percent : 0);
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
    <div class="grid-2">${list.map(projectCard).join('') || '<div class="card empty">No projects with this status yet.</div>'}</div>
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
        <div class="row" style="margin-top:12px">${demo ? `<a class="btn btn-primary" href="${esc(demo)}" target="_blank" rel="noopener noreferrer">▶ Live demo</a>` : ''}${repo ? `<a class="btn" href="${esc(repo)}" target="_blank" rel="noopener noreferrer">⌥ Source code</a>` : ''}${m && !mine ? `<a class="btn" href="#/messages/${esc(o.handle)}">✉ Contact builder</a><button class="btn" data-act="report" data-kind="project" data-id="${p.id}">⚑ Report</button>` : ''}</div>
      </div>
      <div class="card"><h3>About</h3><div class="post-body">${esc(p.desc)}</div>${p.lookingFor ? `<div class="notice info" style="margin-top:10px">🤝 Looking for: ${esc(p.lookingFor)}</div>` : ''}</div>
      <div class="card">
        <div class="row between"><h3>Development timeline</h3>${mine ? '<button class="btn btn-sm btn-primary" data-act="add-update" data-id="' + p.id + '">＋ Add update</button>' : ''}</div>
        <div class="row between small" style="margin:6px 0"><strong>${currentPct(p)}% complete</strong><span class="muted">${plural(p.updates.length, 'milestone')}</span></div>
        ${progressBar(currentPct(p))}
        <div class="timeline" style="margin-top:16px">${p.updates.slice().reverse().map((u) => `<div class="tl-item"><div class="row between"><strong>${esc(u.title)}</strong><span class="small muted">${ago(u.createdAt)} · ${u.percent}%</span></div>${u.body ? `<div class="small post-body">${esc(u.body)}</div>` : ''}</div>`).join('') || '<div class="muted">No updates yet.</div>'}</div>
      </div>
      ${related.length ? `<h3>Posts about this project</h3>${related.map((x) => postCard(x)).join('')}` : ''}
    </div>
    <aside class="rail">
      <div class="card"><h3>Tech stack</h3><div class="chips">${p.tech.map((t) => `<span class="tag">${esc(t)}</span>`).join('') || '<span class="muted small">Not listed</span>'}</div></div>
      ${mine ? `<div class="card"><h3>Patch Championship</h3><p class="small muted">Enter this project in this month's championship.</p><a class="btn btn-gold btn-sm" href="#/championship">🏆 Submit entry</a></div>` : ''}
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
    <p class="muted small">Your project gets a permanent page you can keep updating — no need to make a new post for every milestone. It does not have to be open source.</p>
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
      ${p ? '' : `<div class="field"><label for="jf-pct">Current progress: <span id="jpOut">20</span>%</label><input id="jf-pct" type="range" name="percent" min="0" max="100" value="20"></div>`}
      <div class="row" style="justify-content:flex-end">${p ? `<button type="button" class="btn" data-act="delete-project" data-id="${p.id}">Delete</button>` : ''}<a class="btn" href="${p ? `#/vault/${p.id}` : '#/vault'}">Cancel</a><button class="btn btn-primary">${p ? 'Save' : 'Create project page'}</button></div>
    </form></div></div>`;
}
function afterProjectForm(root, id) {
  const f = $('#projForm', root); if (!f) return;
  if (f.percent) f.percent.oninput = () => $('#jpOut', root).textContent = f.percent.value;
  f.onsubmit = (e) => {
    e.preventDefault();
    const data = { name: f.name.value.trim(), tagline: f.tagline.value.trim(), desc: f.desc.value.trim(), status: f.status.value, visibility: f.visibility.value, tech: f.tech.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12), demo: f.demo.value.trim(), repo: f.repo.value.trim(), lookingFor: f.lookingFor.value.trim() };
    if ((data.demo && !safeUrl(data.demo)) || (data.repo && !safeUrl(data.repo))) return toast('Links must start with http:// or https://');
    let p;
    if (id) { p = project(id); Object.assign(p, data); }
    else { p = { id: uid(), ownerId: me().id, createdAt: now(), updates: [{ id: uid(), title: 'Project added to the Vault', body: '', percent: Number(f.percent.value), createdAt: now() }], ...data }; db.projects.unshift(p); }
    save(); toast(id ? 'Saved' : 'Project page created!'); location.hash = `#/vault/${p.id}`;
  };
}
function openAddUpdate(id) {
  const p = project(id);
  modal(`<h2>Add a milestone</h2><p class="muted small">Added a character? New environment? Log it here so your project's story stays in one place.</p><form id="updForm">
    <div class="field"><label for="uf-t">Title</label><input id="uf-t" type="text" name="title" required maxlength="100" placeholder="Added player movement"></div>
    <div class="field"><label for="uf-b">Details</label><textarea id="uf-b" name="body" maxlength="3000" style="min-height:80px"></textarea></div>
    <div class="field"><label for="uf-p">Progress: <span id="ufOut">${currentPct(p)}</span>%</label><input id="uf-p" type="range" name="percent" min="0" max="100" value="${currentPct(p)}"></div>
    <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="share" checked> Also share as a progress post in the feed</label></div>
    <div class="field" id="ufComm"><label for="uf-c">Community</label><select id="uf-c" name="communityId">${db.communities.filter((c) => c.members.includes(me().id)).concat(db.communities.filter((c) => !c.members.includes(me().id))).map((c) => `<option value="${c.id}">p/${esc(c.slug)}</option>`).join('')}</select></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Add update</button></div></form>`);
  const f = $('#updForm');
  f.percent.oninput = () => $('#ufOut').textContent = f.percent.value;
  f.share.onchange = () => $('#ufComm').hidden = !f.share.checked;
  f.onsubmit = (e) => {
    e.preventDefault();
    const u = { id: uid(), title: f.title.value.trim(), body: f.body.value.trim(), percent: Number(f.percent.value), createdAt: now() };
    p.updates.push(u);
    if (u.percent >= 100 && p.status !== 'launched') p.status = 'launched';
    if (f.share.checked) db.posts.unshift({ id: uid(), type: 'progress', authorId: me().id, communityId: f.communityId.value, projectId: p.id, title: `${p.name}: ${u.title}`, body: u.body, progress: { percent: u.percent, eta: '' }, tags: [], image: '', likes: [], saves: [], comments: [], createdAt: now() });
    save(); closeModal(); render(); toast('Milestone added');
  };
}

/* Championship */
const catName = (id) => (CHAMP_CATEGORIES.find((c) => c.id === id) || {}).name || id;
const catIcon = (id) => (CHAMP_CATEGORIES.find((c) => c.id === id) || {}).icon || '🏆';
function yearlyTitles() {
  // A year's champion per category = most monthly trophies in that category, once all 12 months are closed.
  const byYear = {};
  db.champ.winners.forEach((w) => { const y = w.month.slice(0, 4); (byYear[y] ||= {}); ((byYear[y][w.category] ||= {})[w.userId] = (byYear[y][w.category][w.userId] || 0) + 1); });
  const out = [];
  Object.entries(byYear).forEach(([year, cats]) => {
    const closedMonths = db.champ.closed.filter((m) => m.startsWith(year)).length;
    if (closedMonths < 12) return;
    Object.entries(cats).forEach(([category, counts]) => {
      const [userId, trophies] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      out.push({ year, category, userId, trophies });
    });
  });
  return out;
}
const champState = { cat: CHAMP_CATEGORIES[0].id, tab: 'vote' };
function eligibility(u) {
  if (!u) return { ok: false, why: 'Log in to take part.' };
  if (u.banned) return { ok: false, why: 'Suspended accounts cannot enter.' };
  if (accountAgeDays(u) < minAge()) return { ok: false, why: `Accounts must be at least ${minAge()} days old to submit.` };
  if (!db.projects.some((p) => p.ownerId === u.id)) return { ok: false, why: 'Add a project to the Vault first — entries are Vault projects.' };
  return { ok: true };
}
function tally(mk, cat) {
  return db.champ.submissions.filter((s) => s.month === mk && s.category === cat)
    .map((s) => ({ ...s, votes: db.champ.votes.filter((v) => v.submissionId === s.id && !user(v.voterId)?.banned).length }))  // votes from suspended accounts don't count
    .sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt);
}
function viewChampionship() {
  const m = me(), mk = monthKey(), closed = db.champ.closed.includes(mk);
  const year = String(new Date().getFullYear());
  const tabs = { vote: '🗳️ This month', winners: '🏆 Hall of champions', yearly: '👑 Yearly race' };
  let body = '';
  if (champState.tab === 'vote') {
    const entries = tally(mk, champState.cat);
    const myVote = m && db.champ.votes.find((v) => v.month === mk && v.category === champState.cat && v.voterId === m.id);
    const el = eligibility(m);
    const mySub = m && db.champ.submissions.find((s) => s.month === mk && s.category === champState.cat && s.userId === m.id);
    body = `<div class="chips" style="margin-bottom:12px">${CHAMP_CATEGORIES.map((c) => `<button class="chip ${champState.cat === c.id ? 'active' : ''}" data-ccat="${c.id}">${c.icon} ${c.name}</button>`).join('')}</div>
      <div class="card" style="margin-bottom:12px"><div class="row between"><div><strong>${catIcon(champState.cat)} ${esc(catName(champState.cat))} — ${esc(monthLabel(mk))}</strong><div class="small muted">${plural(entries.length, 'entry')} · ${closed ? 'Voting closed' : myVote ? 'You have voted in this category (you can change it)' : 'You have 1 vote in this category'}</div></div>
        ${closed ? '' : mySub ? '<span class="pill pill-good">✓ You entered this category</span>' : `<button class="btn btn-gold btn-sm" data-act="submit-entry" ${el.ok ? '' : 'disabled'}>🏆 Submit my project</button>`}</div>
        ${!closed && !el.ok && !mySub ? `<div class="hint">${esc(el.why)}</div>` : ''}</div>
      ${entries.map((s, i) => {
        const p = project(s.projectId), o = user(s.userId), mine = myVote && myVote.submissionId === s.id, own = m && s.userId === m.id;
        return `<div class="card sub-card"><div class="row" style="align-items:flex-start">
          <div class="votes" style="min-width:44px;text-align:center"><div style="font-size:1.3rem">${s.votes}</div><div class="small muted">votes</div></div>
          <div style="flex:1;min-width:0"><div class="row"><a href="#/vault/${p?.id}"><strong>${esc(p?.name || 'Deleted project')}</strong></a>${i === 0 && s.votes ? '<span class="pill pill-gold">Leading</span>' : ''}${p ? statusPill(p.status) : ''}</div>
            <div class="small muted">${avatar(o, 'sm')} ${userLink(o)}</div>
            <p class="small" style="margin-top:6px">${esc(s.note || p?.tagline || '')}</p>
            <div class="chips">${(p?.tech || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>
          <div class="row" style="flex-direction:column;align-items:flex-end">${isStaff() && !closed ? `<button class="btn btn-sm btn-danger" data-act="disqualify" data-id="${s.id}">Disqualify</button>` : ''}${closed ? '' : own ? '<span class="small muted">Your entry</span>' : `<button class="btn btn-sm ${mine ? 'btn-primary' : ''}" data-act="champ-vote" data-id="${s.id}">${mine ? '✓ Voted' : 'Vote'}</button>`}</div>
        </div></div>`;
      }).join('') || '<div class="card empty">No entries yet in this category. Be the first to submit!</div>'}
      ${isAdmin() && !closed ? `<div class="card" style="margin-top:16px"><div class="row between"><div><strong>Close ${esc(monthLabel(mk))} voting</strong><div class="small muted">🛡️ Admin only. In production this also runs automatically at month end.</div></div><button class="btn btn-sm" data-act="close-month">Crown champions</button></div></div>` : ''}`;
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
    const past = yearlyTitles().sort((a, b) => b.year - a.year);
    body = `<div class="card"><h3>${year} race — trophies so far</h3><p class="small muted">The builder with the most monthly trophies in a category after all 12 months becomes that year's champion and earns a permanent 👑 badge.</p>
      <div class="grid-2">${CHAMP_CATEGORIES.map((c) => {
        const rows = Object.entries(counts).filter(([k]) => k.startsWith(c.id + '|')).map(([k, n]) => [k.split('|')[1], n]).sort((a, b) => b[1] - a[1]).slice(0, 3);
        return `<div class="card" style="box-shadow:none"><strong>${c.icon} ${c.name}</strong>${rows.map(([uId, n], i) => `<div class="row between small" style="padding:4px 0"><span>${['🥇', '🥈', '🥉'][i]} ${userLink(user(uId))}</span><span class="mono">${n} 🏆</span></div>`).join('') || '<div class="small muted">No trophies yet</div>'}</div>`;
      }).join('')}</div></div>
      ${past.length ? `<h2 style="margin-top:18px">Yearly champions</h2>${[...new Set(past.map((p) => p.year))].map((y) => `<div class="card yearly"><h3>👑 ${y} Champions of the Year</h3><div class="grid-3">${past.filter((p) => p.year === y).map((p) => `<div><div class="small muted">${catIcon(p.category)} ${esc(catName(p.category))}</div>${userLink(user(p.userId))}<div class="small muted">${p.trophies} of 12 months won</div></div>`).join('')}</div></div>`).join('')}` : ''}`;
  }
  return `<div class="page single">
    <div class="hero"><h1>🏆 Patch Championship</h1><p class="muted">Each month builders submit projects into categories. The community reviews and votes — one vote per person, per category. The top entry in each category becomes that month's <strong>Verified Champion</strong>, and every win stays forever in their trophy room.</p></div>
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
  $('#subForm').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    db.champ.submissions.push({ id: uid(), month: mk, category: champState.cat, projectId: f.projectId.value, userId: m.id, note: f.note.value.trim(), createdAt: now() });
    save(); closeModal(); render(); toast('Entry submitted — good luck!');
  };
}
function closeMonth() {
  if (!isAdmin()) return;
  const mk = monthKey();
  if (!confirm(`Close voting for ${monthLabel(mk)} and crown the champions?`)) return;
  CHAMP_CATEGORIES.forEach((c) => {
    const [top] = tally(mk, c.id);
    if (!top || !top.votes) return;
    const p = project(top.projectId);
    db.champ.winners.push({ month: mk, category: c.id, userId: top.userId, projectId: top.projectId, projectName: p?.name || 'Entry', votes: top.votes });
    notify(top.userId, `🏆 You are the ${monthLabel(mk)} ${c.name} champion!`, `#/u/${user(top.userId).handle}`);
  });
  db.champ.closed.push(mk);
  audit('crowned champions', monthLabel(mk));
  save(); champState.tab = 'winners'; render(); toast('Champions crowned!');
}

/* Profiles */
const profState = { tab: 'posts' };
function viewProfile(handle) {
  const u = userByHandle(handle); if (!u) return notFound();
  const m = me(), isMe = m && m.id === u.id;
  const followers = db.users.filter((x) => x.following.includes(u.id));
  const following = m && m.following.includes(u.id);
  if (!u.isPublic && !isMe) {
    return `<div class="page single"><div class="card empty">${avatar(u, 'lg')}<h2 style="margin-top:10px">${esc(u.name)}</h2><p>This profile is private.</p></div></div>`;
  }
  const wins = db.champ.winners.filter((w) => w.userId === u.id).sort((a, b) => (a.month < b.month ? 1 : -1));
  const yearly = yearlyTitles().filter((y) => y.userId === u.id);
  const posts = db.posts.filter((p) => p.authorId === u.id).sort((a, b) => b.createdAt - a.createdAt);
  const projects = db.projects.filter((p) => p.ownerId === u.id);
  let tab = '';
  if (profState.tab === 'posts') tab = posts.map((p) => postCard(p)).join('') || '<div class="card empty">No posts yet.</div>';
  if (profState.tab === 'projects') tab = `<div class="grid-2">${projects.map(projectCard).join('')}</div>` + (projects.length ? '' : '<div class="card empty">No projects in the Vault yet.</div>');
  if (profState.tab === 'trophies') tab = `<div class="card"><h2>🏆 Trophy room</h2>
    ${yearly.length ? yearly.map((y) => `<div class="trophy yearly" style="margin-bottom:10px"><span class="cup">👑</span><div><strong>${y.year} ${esc(catName(y.category))} — Champion of the Year</strong><div class="small muted">Won ${y.trophies} of 12 months</div></div></div>`).join('') : ''}
    ${wins.length ? `<div class="grid-3">${wins.map((w) => `<div class="trophy"><span class="cup">${catIcon(w.category)}</span><div style="min-width:0"><strong>${esc(shortMonth(w.month))}</strong><div class="small muted">${esc(catName(w.category))}</div><div class="small muted">${esc(w.projectName)} · ${w.votes} votes</div></div></div>`).join('')}</div>` : '<div class="empty">No trophies yet. Enter the <a class="link" href="#/championship">Championship</a>!</div>'}</div>`;
  return `<div class="page single">
    <div class="card"><div class="row" style="align-items:flex-start;gap:16px">${avatar(u, 'lg')}
      <div style="flex:1;min-width:0"><h1 style="margin:0">${esc(u.name)}${champBadges(u)}</h1><div class="muted">@${esc(u.handle)} · joined ${ago(u.joinedAt)}</div>
        <p style="margin-top:8px">${esc(u.bio)}</p>
        <div class="chips">${u.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
        <div class="row small" style="margin-top:10px"><strong>${followers.length}</strong> followers · <strong>${u.following.length}</strong> following · <strong>${wins.length}</strong> trophies ${u.openToWork ? '<span class="pill pill-good">💼 Open to work & collabs</span>' : ''} ${!u.isPublic ? '<span class="pill pill-warn">🔒 Private profile</span>' : ''} ${u.banned ? '<span class="pill pill-warn">⛔ Suspended</span>' : ''}</div>
      </div>
      <div class="row">${isMe ? '<button class="btn" data-act="edit-profile">Edit profile</button>' : m ? `<button class="btn ${following ? '' : 'btn-primary'}" data-act="follow" data-id="${u.id}">${following ? 'Following ✓' : '＋ Follow'}</button><a class="btn" href="#/messages/${esc(u.handle)}">✉ Message</a><button class="btn" data-act="report" data-kind="user" data-id="${u.id}" title="Report user">⚑</button>` : ''}</div>
    </div></div>
    <div class="tabs" style="margin-top:14px">${[['posts', `Posts (${posts.length})`], ['projects', `Projects (${projects.length})`], ['trophies', `🏆 Trophy room (${wins.length})`]].map(([k, l]) => `<button class="tab ${profState.tab === k ? 'active' : ''}" data-ptab="${k}">${l}</button>`).join('')}</div>
    ${tab}
  </div>`;
}
function afterProfile(root) { $$('[data-ptab]', root).forEach((b) => b.onclick = () => { profState.tab = b.dataset.ptab; render(); }); }
function openEditProfile() {
  const u = me();
  modal(`<h2>Edit profile</h2><form id="profForm">
    <div class="field"><label for="ef-n">Name</label><input id="ef-n" type="text" name="name" maxlength="50" required value="${esc(u.name)}"></div>
    <div class="field"><label for="ef-b">Bio</label><textarea id="ef-b" name="bio" maxlength="300" style="min-height:70px">${esc(u.bio)}</textarea></div>
    <div class="field"><label for="ef-s">Skills</label><input id="ef-s" type="text" name="skills" value="${esc(u.skills.join(', '))}"></div>
    <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="openToWork" ${u.openToWork ? 'checked' : ''}> 💼 Open to freelance work & collaborations</label><div class="hint">Shows you on the Opportunities page so clients, creators and brands can find you.</div></div>
    <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="isPublic" ${u.isPublic ? 'checked' : ''}> Public profile (others can see your posts and trophy room)</label></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Save</button></div></form>`);
  $('#profForm').onsubmit = (e) => {
    e.preventDefault(); const f = e.target;
    Object.assign(u, { name: f.name.value.trim(), bio: f.bio.value.trim(), skills: f.skills.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10), openToWork: f.openToWork.checked, isPublic: f.isPublic.checked });
    save(); closeModal(); render(); toast('Profile updated');
  };
}

/* Opportunities */
function viewBuilders() {
  const list = db.users.filter((u) => u.openToWork && u.isPublic)
    .map((u) => ({ u, wins: db.champ.winners.filter((w) => w.userId === u.id).length, projects: db.projects.filter((p) => p.ownerId === u.id) }))
    .sort((a, b) => b.wins - a.wins || b.projects.length - a.projects.length);
  return `<div class="page single">
    <div class="hero"><h1>💼 Opportunities</h1><p class="muted">Builders open to freelance work and collaborations. Clients, creators and brands can browse real projects and championship records here — not just like counts.</p>${me() ? '<button class="btn btn-sm" data-act="edit-profile">Set my availability</button>' : ''}</div>
    <div class="grid-2">${list.map(({ u, wins, projects }) => `<div class="card"><div class="row">${avatar(u)}<div style="flex:1;min-width:0">${userLink(u)}<div class="small muted">@${esc(u.handle)}</div></div></div>
      <p class="small" style="margin-top:8px">${esc(u.bio)}</p>
      <div class="chips">${u.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>
      <div class="small muted" style="margin-top:8px">${plural(projects.length, 'project')} · ${plural(wins, 'trophy').replace('trophys', 'trophies')}</div>
      <div class="row" style="margin-top:10px"><a class="btn btn-sm" href="#/u/${esc(u.handle)}">View profile</a>${me() && me().id !== u.id ? `<a class="btn btn-sm btn-primary" href="#/messages/${esc(u.handle)}">✉ Reach out</a>` : ''}</div></div>`).join('') || '<div class="card empty">No builders are open to work right now.</div>'}</div>
  </div>`;
}

/* Messages */
function viewMessages(handle) {
  if (!me()) return loginWall('message builders');
  const m = me();
  const partners = new Map();
  db.messages.filter((x) => x.from === m.id || x.to === m.id).sort((a, b) => b.createdAt - a.createdAt).forEach((x) => { const o = x.from === m.id ? x.to : x.from; if (!partners.has(o)) partners.set(o, x); });
  const other = handle ? userByHandle(handle) : user([...partners.keys()][0]);
  if (other && !partners.has(other.id)) partners.set(other.id, null);
  if (other) db.messages.forEach((x) => { if (x.from === other.id && x.to === m.id) x.read = true; });
  save();
  const thread = other ? db.messages.filter((x) => (x.from === m.id && x.to === other.id) || (x.from === other.id && x.to === m.id)).sort((a, b) => a.createdAt - b.createdAt) : [];
  return `<div class="page single" style="max-width:1000px"><h1>Messages</h1><div class="card dm" style="padding:0">
    <div class="dm-list">${[...partners.entries()].map(([id, last]) => { const u = user(id); const unread = last && last.to === m.id && !last.read; return `<a href="#/messages/${esc(u.handle)}" class="${other && other.id === id ? 'active' : ''}"><span class="avatar" style="background:${esc(u.color)}">${esc(u.name[0])}</span><span style="min-width:0;flex:1"><strong>${esc(u.name)}</strong>${unread ? ' <span class="pill pill-accent">new</span>' : ''}<div class="small muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${last ? esc(last.body) : 'Start a conversation'}</div></span></a>`; }).join('') || '<div class="empty small">No conversations yet. Visit a profile and hit Message.</div>'}</div>
    <div class="dm-thread">${other ? `<div class="row" style="padding:10px 14px;border-bottom:1px solid var(--border)">${avatar(other, 'sm')} ${userLink(other)}</div>
      <div class="dm-msgs" id="dmMsgs">${thread.map((x) => `<div class="bubble ${x.from === m.id ? 'me' : ''}">${esc(x.body)}<div class="small" style="opacity:.7">${ago(x.createdAt)}</div></div>`).join('') || '<div class="muted small">Say hi 👋 — talk about collabs, feedback or testing.</div>'}</div>
      <form class="dm-form" id="dmForm"><input type="text" name="body" placeholder="Message ${esc(other.name)}…" maxlength="2000" autocomplete="off" required><button class="btn btn-primary">Send</button></form>` : '<div class="empty">Select a conversation</div>'}</div>
  </div></div>`;
}
function afterMessages(root, handle) {
  const box = $('#dmMsgs', root); if (box) box.scrollTop = box.scrollHeight;
  const f = $('#dmForm', root); if (!f) return;
  const other = handle ? userByHandle(handle) : null;
  f.onsubmit = (e) => {
    e.preventDefault();
    const target = other || userByHandle($('.dm-list a.active', root)?.getAttribute('href').split('/').pop());
    const body = f.body.value.trim(); if (!body || !target) return;
    db.messages.push({ id: uid(), from: me().id, to: target.id, body, createdAt: now(), read: false });
    save(); location.hash = `#/messages/${target.handle}`; render();
    setTimeout(() => $('#dmForm input')?.focus(), 0);
  };
}

/* Notifications, Saved, Search */
function viewNotifications() {
  if (!me()) return loginWall('see notifications');
  const list = db.notifications.filter((n) => n.userId === me().id).sort((a, b) => b.createdAt - a.createdAt);
  const html = `<div class="page single"><div class="row between"><h1>Notifications</h1>${list.some((n) => !n.read) ? '<button class="btn btn-sm" data-act="read-all">Mark all read</button>' : ''}</div><div class="card">${list.map((n) => `<a class="notif ${n.read ? '' : 'unread'}" href="${esc(n.link || '#/notifications')}" data-nid="${n.id}"><span>${n.read ? '○' : '●'}</span><span style="flex:1">${esc(n.text)}<div class="small muted">${ago(n.createdAt)}</div></span></a>`).join('') || '<div class="empty">You are all caught up.</div>'}</div></div>`;
  return html;
}
function afterNotifications(root) { $$('[data-nid]', root).forEach((a) => a.addEventListener('click', () => { const n = db.notifications.find((x) => x.id === a.dataset.nid); if (n) { n.read = true; save(); } })); }
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
  const tools = db.tools.filter((t) => has(t.name, t.desc, t.category));
  const people = db.users.filter((u) => u.isPublic && has(u.name, u.handle, u.skills.join(' ')));
  const comms = db.communities.filter((c) => has(c.name, c.slug, c.desc));
  return `<div class="page single"><h1>Results for “${esc(q)}”</h1>
    ${comms.length ? `<h3>Communities</h3><div class="chips" style="margin-bottom:12px">${comms.map((c) => `<a class="chip" href="#/c/${esc(c.slug)}">${esc(c.icon)} p/${esc(c.slug)}</a>`).join('')}</div>` : ''}
    ${people.length ? `<h3>People</h3><div class="chips" style="margin-bottom:12px">${people.map((u) => `<a class="chip" href="#/u/${esc(u.handle)}">@${esc(u.handle)}</a>`).join('')}</div>` : ''}
    ${projects.length ? `<h3>Projects</h3><div class="grid-2" style="margin-bottom:12px">${projects.map(projectCard).join('')}</div>` : ''}
    ${tools.length ? `<h3>Tools</h3><div class="card" style="margin-bottom:12px">${tools.map((t) => `<div style="padding:4px 0"><strong>${esc(t.name)}</strong> <span class="muted small">${esc(t.desc)}</span></div>`).join('')}</div>` : ''}
    ${posts.length ? `<h3>Posts</h3>${posts.map((p) => postCard(p)).join('')}` : ''}
    ${!posts.length && !projects.length && !tools.length && !people.length && !comms.length ? '<div class="card empty">No results.</div>' : ''}
  </div>`;
}

/* ---------- moderation helpers ---------- */
function commentActions(p, cm) {
  const m = me(); if (!m) return '';
  const key = `${p.id}|${cm.id}`;
  let s = '';
  if (m.id !== cm.authorId) s += `<button class="act" data-act="report" data-kind="comment" data-id="${key}">⚑ Report</button>`;
  if (m.id === cm.authorId || canModerate(community(p.communityId))) s += `<button class="act" data-act="delete-comment" data-id="${key}">🗑 ${m.id === cm.authorId ? 'Delete' : 'Remove'}</button>`;
  return s ? `<div class="actions" style="margin-top:2px">${s}</div>` : '';
}
function banner() {
  const m = me();
  let s = '';
  if (db.settings.announcement) s += `<div class="announce">📣 ${esc(db.settings.announcement)}</div>`;
  if (m?.banned) s += '<div class="notice" style="margin-bottom:14px">⛔ Your account is suspended. You can browse Patch, but posting, commenting, messaging and voting are disabled.</div>';
  return s;
}
function removeProject(id) {
  db.projects = db.projects.filter((p) => p.id !== id);
  db.posts.forEach((p) => { if (p.projectId === id) p.projectId = ''; });
  const subIds = db.champ.submissions.filter((x) => x.projectId === id && !db.champ.closed.includes(x.month)).map((x) => x.id);
  db.champ.submissions = db.champ.submissions.filter((x) => !subIds.includes(x.id));
  db.champ.votes = db.champ.votes.filter((v) => !subIds.includes(v.submissionId));
}
function removeTarget(r) {
  if (r.kind === 'post') {
    const p = post(r.targetId);
    if (p) { db.posts = db.posts.filter((x) => x !== p); notify(p.authorId, `Your post "${p.title.slice(0, 50)}" was removed by moderators (${r.reason}).`, '#/notifications'); }
  } else if (r.kind === 'comment') {
    const [pid, cid] = r.targetId.split('|'); const p = post(pid); const cm = p && p.comments.find((x) => x.id === cid);
    if (cm) { p.comments = p.comments.filter((x) => x !== cm); notify(cm.authorId, `Your comment on "${p.title.slice(0, 50)}" was removed by moderators (${r.reason}).`, `#/post/${p.id}`); }
  } else if (r.kind === 'user') {
    const u = user(r.targetId);
    if (u && u.role !== 'admin') { u.banned = true; notify(u.id, 'Your account has been suspended by moderators.', '#/notifications'); }
  } else if (r.kind === 'project') {
    const p = project(r.targetId);
    if (p) { removeProject(p.id); notify(p.ownerId, `Your project "${p.name}" was removed from the Vault by moderators (${r.reason}).`, '#/notifications'); }
  }
}
function reportTarget(r) {
  if (r.kind === 'post') { const p = post(r.targetId); return p ? `📝 Post: <a class="link" href="#/post/${p.id}">${esc(p.title)}</a> by ${userLink(user(p.authorId))}` : '<span class="muted">Post (already removed)</span>'; }
  if (r.kind === 'comment') {
    const [pid, cid] = r.targetId.split('|'); const p = post(pid); const cm = p && p.comments.find((x) => x.id === cid);
    return cm ? `💬 Comment by ${userLink(user(cm.authorId))} on <a class="link" href="#/post/${p.id}">${esc(p.title)}</a><div class="quote">${esc(cm.body.slice(0, 200))}</div>` : '<span class="muted">Comment (already removed)</span>';
  }
  if (r.kind === 'user') { const u = user(r.targetId); return u ? `👤 User: ${userLink(u)} <span class="muted">@${esc(u.handle)}</span> ${u.banned ? '<span class="pill pill-warn">Suspended</span>' : ''}` : '<span class="muted">User (deleted)</span>'; }
  if (r.kind === 'project') { const p = project(r.targetId); return p ? `🗄️ Project: <a class="link" href="#/vault/${p.id}">${esc(p.name)}</a> by ${userLink(user(p.ownerId))}` : '<span class="muted">Project (already removed)</span>'; }
  return '';
}
function openReport(kind, id) {
  modal(`<h2>Report ${esc(kind)}</h2><p class="small muted">Reports are private and reviewed by Patch moderators.</p><form id="repForm">
    <div class="field">${REPORT_REASONS.map((r, i) => `<label class="row" style="font-weight:500;margin-bottom:6px"><input type="radio" name="reason" value="${esc(r)}" ${i === 0 ? 'checked' : ''}> ${esc(r)}</label>`).join('')}</div>
    <div class="field"><label for="rp-n">Details (optional)</label><textarea id="rp-n" name="note" maxlength="500" style="min-height:70px"></textarea></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-danger">Submit report</button></div></form>`);
  $('#repForm').onsubmit = (e) => {
    e.preventDefault(); const f = e.target, m = me();
    if (db.reports.some((r) => r.status === 'open' && r.kind === kind && r.targetId === id && r.reporterId === m.id)) { closeModal(); return toast('You already reported this'); }
    db.reports.unshift({ id: uid(), kind, targetId: id, reason: f.reason.value, note: f.note.value.trim(), reporterId: m.id, status: 'open', createdAt: now() });
    db.users.filter((u) => isStaff(u)).forEach((u) => notify(u.id, `New report: ${kind} — ${f.reason.value}`, '#/admin'));
    save(); closeModal(); render(); toast('Thanks — moderators will review it');
  };
}
function openEditCommunity(id) {
  const c = community(id); if (!c || !canModerate(c)) return;
  modal(`<h2>Manage p/${esc(c.slug)}</h2><form id="ecForm">
    <div class="grid-2"><div class="field"><label for="ec-n">Name</label><input id="ec-n" type="text" name="name" maxlength="50" required value="${esc(c.name)}"></div>
    <div class="field"><label for="ec-i">Icon (emoji)</label><input id="ec-i" type="text" name="icon" maxlength="4" value="${esc(c.icon)}"></div></div>
    <div class="field"><label for="ec-d">Description</label><textarea id="ec-d" name="desc" maxlength="300" style="min-height:70px">${esc(c.desc)}</textarea></div>
    <div class="field"><label for="ec-r">Rules (one per line)</label><textarea id="ec-r" name="rules" maxlength="1500" style="min-height:90px">${esc(c.rules.join('\n'))}</textarea></div>
    <div class="field"><label for="ec-m">Community moderators</label><input id="ec-m" type="text" name="mods" value="${esc((c.mods || []).map((i) => user(i)?.handle).filter(Boolean).join(', '))}" placeholder="kavya, leo"><div class="hint">Usernames, comma separated. They can pin and remove posts and comments in this community.</div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Save</button></div></form>`);
  $('#ecForm').onsubmit = (e) => {
    e.preventDefault(); const f = e.target;
    const handles = [...new Set(f.mods.value.split(',').map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
    const missing = handles.find((h) => !userByHandle(h));
    if (missing) return toast(`Unknown user: @${missing}`);
    Object.assign(c, { name: f.name.value.trim(), icon: f.icon.value.trim() || c.icon, desc: f.desc.value.trim(), rules: f.rules.value.split('\n').map((x) => x.trim()).filter(Boolean), mods: handles.map((h) => userByHandle(h).id) });
    c.mods.forEach((uid2) => notify(uid2, `You are a moderator of p/${c.slug}`, `#/c/${c.slug}`));
    audit('updated community', 'p/' + c.slug); save(); closeModal(); render(); toast('Community updated');
  };
}

/* ---------- admin panel ---------- */
const adminState = { tab: 'overview', q: '', rstatus: 'open' };
const auditRow = (a) => { const u = user(a.actorId); return `<div class="notif">${u ? avatar(u, 'sm') : ''}<span style="flex:1;min-width:0"><strong>${esc(u?.name || 'System')}</strong> ${esc(a.action)} <span class="muted">${esc(a.detail || '')}</span><div class="small muted">${ago(a.createdAt)}</div></span></div>`; };
function viewAdmin() {
  const m = me();
  if (!isStaff()) return '<div class="page single"><div class="card empty"><h2>🛡️ Staff only</h2><p>The admin panel is only available to Patch admins and moderators.</p><a class="btn" href="#/">Go home</a></div></div>';
  const openReports = db.reports.filter((r) => r.status === 'open').length;
  const pendingTools = db.tools.filter((t) => t.status === 'pending').length;
  const tabs = [['overview', '📊 Overview'], ['reports', `⚑ Reports${openReports ? ` (${openReports})` : ''}`], ['content', '📝 Content'], ['tools', `🧰 Tools${pendingTools ? ` (${pendingTools})` : ''}`], ['championship', '🏆 Championship'],
    ...(isAdmin() ? [['users', '👥 Users'], ['communities', '🏘️ Communities'], ['settings', '⚙️ Settings']] : []), ['audit', '📜 Audit log']];
  if (!tabs.some(([k]) => k === adminState.tab)) adminState.tab = 'overview';
  const t = adminState.tab, q = adminState.q.toLowerCase();
  const search = (ph) => `<input type="text" id="adminQ" placeholder="${ph}" value="${esc(adminState.q)}" style="margin-bottom:12px" autocomplete="off">`;
  let body = '';

  if (t === 'overview') {
    const weekAgo = now() - 7 * DAY, mk = monthKey();
    const stats = [['Members', db.users.length], ['New this week', db.users.filter((u) => u.joinedAt > weekAgo).length], ['Posts', db.posts.length], ['Posts this week', db.posts.filter((p) => p.createdAt > weekAgo).length],
      ['Communities', db.communities.length], ['Vault projects', db.projects.length], ['Open reports', openReports], ['Pending tools', pendingTools], ['Suspended', db.users.filter((u) => u.banned).length], [`${shortMonth(mk)} entries`, db.champ.submissions.filter((x) => x.month === mk).length]];
    body = `<div class="stat-grid">${stats.map(([l, v]) => `<div class="card stat"><div class="stat-v">${v}</div><div class="small muted">${esc(l)}</div></div>`).join('')}</div>
      <div class="grid-2" style="margin-top:14px">
        <div class="card"><h3>Needs attention</h3>${openReports || pendingTools ? `<div class="row">${openReports ? `<button class="btn btn-sm btn-danger" data-atab="reports">Review ${plural(openReports, 'report')}</button>` : ''}${pendingTools ? `<button class="btn btn-sm" data-atab="tools">Approve ${plural(pendingTools, 'tool')}</button>` : ''}</div>` : '<p class="small muted">All clear 🎉 No open reports or pending tools.</p>'}</div>
        <div class="card"><h3>Recent staff activity</h3>${db.audit.slice(0, 5).map(auditRow).join('') || '<p class="small muted">Nothing yet.</p>'}</div>
      </div>`;
  }

  if (t === 'reports') {
    const list = db.reports.filter((r) => adminState.rstatus === 'all' || r.status === adminState.rstatus).sort((a, b) => b.createdAt - a.createdAt);
    body = `<div class="chips" style="margin-bottom:12px">${['open', 'resolved', 'dismissed', 'all'].map((x) => `<button class="chip ${adminState.rstatus === x ? 'active' : ''}" data-rstatus="${x}">${x[0].toUpperCase() + x.slice(1)}</button>`).join('')}</div>`
      + (list.map((r) => `<div class="card"><div class="row between"><div class="row"><span class="pill pill-warn">⚑ ${esc(r.reason)}</span><span class="small muted">by ${userLink(user(r.reporterId))} · ${ago(r.createdAt)}</span></div><span class="pill ${r.status === 'open' ? 'pill-accent' : 'pill-good'}">${esc(r.status)}</span></div>
        <div style="margin-top:8px">${reportTarget(r)}</div>
        ${r.note ? `<p class="small muted" style="margin-top:6px">Reporter's note: “${esc(r.note)}”</p>` : ''}
        ${r.status === 'open' ? `<div class="row" style="margin-top:10px"><button class="btn btn-sm btn-danger" data-act="report-remove" data-id="${r.id}">${r.kind === 'user' ? '⛔ Suspend user' : '🗑 Remove ' + esc(r.kind)}</button><button class="btn btn-sm" data-act="report-dismiss" data-id="${r.id}">Dismiss</button></div>`
          : `<div class="small muted" style="margin-top:6px">${r.status === 'resolved' ? 'Actioned' : 'Dismissed'} by ${esc(user(r.handledBy)?.name || 'staff')}${r.handledAt ? ' · ' + ago(r.handledAt) : ''}</div>`}
      </div>`).join('') || '<div class="card empty">No reports here. 🎉</div>');
  }

  if (t === 'content') {
    const list = db.posts.filter((p) => !q || `${p.title} ${p.body} @${user(p.authorId)?.handle}`.toLowerCase().includes(q)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
    body = search('Search posts by title, text or @author…') + `<div class="card table-wrap"><table class="table"><thead><tr><th>Post</th><th>Author</th><th>Community</th><th>Activity</th><th></th></tr></thead><tbody>${list.map((p) => {
      const c = community(p.communityId);
      return `<tr><td><a class="link" href="#/post/${p.id}">${esc(p.title.slice(0, 80))}</a>${p.pinned ? ' 📌' : ''}<div class="small muted">${esc(POST_TYPES[p.type]?.label || p.type)} · ${ago(p.createdAt)}</div></td><td>${userLink(user(p.authorId))}</td><td class="small">${c ? `p/${esc(c.slug)}` : '—'}</td><td class="small nowrap">♥ ${p.likes.length} · 💬 ${p.comments.length}</td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm" data-act="pin-post" data-id="${p.id}">${p.pinned ? 'Unpin' : 'Pin'}</button><button class="btn btn-sm btn-danger" data-act="delete-post" data-id="${p.id}">Remove</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">No posts match.</td></tr>'}</tbody></table></div>`;
  }

  if (t === 'tools') {
    const pending = db.tools.filter((x) => x.status === 'pending'), live = db.tools.filter((x) => x.status !== 'pending');
    body = `<div class="row between"><h3>Waiting for approval</h3><span class="small muted">Approval is ${db.settings.toolApproval ? 'ON' : 'OFF'}${isAdmin() ? ' — change in Settings' : ''}</span></div>
      ${pending.map((x) => { const url = safeUrl(x.url); return `<div class="card"><div class="row between"><strong>${esc(x.name)}</strong><span class="tag">${esc(x.category)}</span></div>${x.isOffer ? '<span class="pill pill-warn">🎁 Offer</span>' : ''}<p class="small" style="margin-top:6px">${esc(x.desc)}</p><div class="small muted">${url ? `<a class="link" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : esc(x.url)} · submitted by ${userLink(user(x.addedBy))} ${ago(x.createdAt)}</div><div class="row" style="margin-top:10px"><button class="btn btn-sm btn-primary" data-act="approve-tool" data-id="${x.id}">✓ Approve</button><button class="btn btn-sm btn-danger" data-act="reject-tool" data-id="${x.id}">Reject</button></div></div>`; }).join('') || '<div class="card empty small">No tools waiting.</div>'}
      <h3 style="margin-top:18px">Live tools (${live.length})</h3>
      <div class="card table-wrap"><table class="table"><tbody>${live.map((x) => `<tr><td><strong>${esc(x.name)}</strong><div class="small muted">${esc(x.category)}${x.isOffer ? ' · 🎁 offer' : ''}</div></td><td class="small">${userLink(user(x.addedBy))}</td><td class="small nowrap">▲ ${x.upvotes.length}</td><td><button class="btn btn-sm btn-danger" data-act="remove-tool" data-id="${x.id}">Remove</button></td></tr>`).join('')}</tbody></table></div>`;
  }

  if (t === 'championship') {
    const mk = monthKey(), closed = db.champ.closed.includes(mk);
    const entries = CHAMP_CATEGORIES.flatMap((c) => tally(mk, c.id));
    const votes = db.champ.votes.filter((v) => v.month === mk);
    const flagged = votes.filter((v) => { const u = user(v.voterId); return !u || u.banned || accountAgeDays(u) < minAge(); }).length;
    body = `<div class="card"><div class="row between"><div><strong>${esc(monthLabel(mk))}</strong><div class="small muted">${closed ? 'Voting closed — champions crowned' : 'Voting open'} · ${plural(entries.length, 'entry')} · ${plural(votes.length, 'vote')}</div></div>${closed ? '<span class="pill pill-good">Closed</span>' : isAdmin() ? '<button class="btn btn-gold btn-sm" data-act="close-month">🏆 Close voting & crown champions</button>' : ''}</div>
      ${flagged ? `<div class="notice" style="margin-top:10px">${plural(flagged, 'vote')} came from suspended or brand-new accounts. Votes from suspended accounts are excluded automatically.</div>` : ''}</div>
      <div class="card table-wrap"><table class="table"><thead><tr><th>Entry</th><th>Category</th><th>Builder</th><th>Votes</th><th></th></tr></thead><tbody>${entries.map((x) => `<tr><td><a class="link" href="#/vault/${x.projectId}">${esc(project(x.projectId)?.name || 'Deleted project')}</a></td><td class="small">${catIcon(x.category)} ${esc(catName(x.category))}</td><td>${userLink(user(x.userId))}</td><td class="mono">${x.votes}</td><td>${closed ? '' : `<button class="btn btn-sm btn-danger" data-act="disqualify" data-id="${x.id}">Disqualify</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No entries yet.</td></tr>'}</tbody></table></div>`;
  }

  if (t === 'users') {
    const list = db.users.filter((u) => !q || `${u.name} ${u.handle}`.toLowerCase().includes(q)).sort((a, b) => b.joinedAt - a.joinedAt);
    body = search('Search members by name or username…') + `<div class="card table-wrap"><table class="table"><thead><tr><th>Member</th><th>Role</th><th>Joined</th><th>Posts</th><th>Reports</th><th>Status</th><th></th></tr></thead><tbody>${list.map((u) => {
      const reportsAgainst = db.reports.filter((r) => (r.kind === 'user' && r.targetId === u.id) || (r.kind === 'post' && post(r.targetId)?.authorId === u.id)).length;
      return `<tr><td><div class="row" style="flex-wrap:nowrap">${avatar(u, 'sm')}<div style="min-width:0">${userLink(u)}<div class="small muted">@${esc(u.handle)}</div></div></div></td>
        <td><select data-role-for="${u.id}" ${u.id === m.id ? 'disabled title="You cannot change your own role"' : ''} style="width:auto;padding:5px 8px">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
        <td class="small nowrap">${ago(u.joinedAt)}</td><td class="small">${db.posts.filter((p) => p.authorId === u.id).length}</td><td class="small">${reportsAgainst}</td>
        <td>${u.banned ? '<span class="pill pill-warn">Suspended</span>' : '<span class="pill pill-good">Active</span>'}</td>
        <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm" data-act="verify-user" data-id="${u.id}">${u.verified ? 'Unverify' : '✔ Verify'}</button>${u.id === m.id ? '' : `<button class="btn btn-sm ${u.banned ? '' : 'btn-danger'}" data-act="ban-user" data-id="${u.id}">${u.banned ? 'Restore' : 'Suspend'}</button>`}</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
  }

  if (t === 'communities') {
    body = `<div class="card table-wrap"><table class="table"><thead><tr><th>Community</th><th>Members</th><th>Posts</th><th>Owner & mods</th><th></th></tr></thead><tbody>${db.communities.map((c) => `<tr><td><a class="link" href="#/c/${esc(c.slug)}">${esc(c.icon)} p/${esc(c.slug)}</a><div class="small muted">${esc(c.name)} · ${ago(c.createdAt)}</div></td><td>${c.members.length}</td><td>${db.posts.filter((p) => p.communityId === c.id).length}</td><td class="small">${userLink(user(c.createdBy))}${(c.mods || []).length ? '<br>' + c.mods.map((id) => esc('@' + (user(id)?.handle || '?'))).join(', ') : ''}</td>
      <td><div class="row" style="flex-wrap:nowrap"><button class="btn btn-sm" data-act="edit-community" data-id="${c.id}">Manage</button><button class="btn btn-sm btn-danger" data-act="delete-community" data-id="${c.id}">Delete</button></div></td></tr>`).join('')}</tbody></table></div>`;
  }

  if (t === 'settings') {
    const st = db.settings;
    body = `<form id="settingsForm" class="card">
      <h3>Platform settings</h3>
      <div class="field"><label for="st-age">New-account waiting period (days)</label><input id="st-age" type="number" name="minAge" min="0" max="60" value="${st.communityMinAgeDays}" style="max-width:140px"><div class="hint">Accounts younger than this can't create communities or enter the Championship (anti-spam).</div></div>
      <div class="field"><label class="row" style="font-weight:500"><input type="checkbox" name="toolApproval" ${st.toolApproval ? 'checked' : ''}> New tools and offers need staff approval before they appear</label></div>
      <div class="field"><label for="st-ann">Site announcement</label><input id="st-ann" type="text" name="announcement" maxlength="200" value="${esc(st.announcement)}" placeholder="e.g. Championship voting closes Sunday!"><div class="hint">Shown at the top of every page. Leave empty to hide.</div></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Save settings</button></div>
    </form>
    <div class="card"><h3>Danger zone</h3><p class="small muted">Wipes everything in this browser and restores the demo data.</p><button class="btn btn-danger" id="adminReset">Reset all data</button></div>`;
  }

  if (t === 'audit') {
    body = `<div class="card">${db.audit.map(auditRow).join('') || '<div class="empty">No staff actions yet.</div>'}</div>`;
  }

  return `<div class="page single" style="max-width:1100px">
    <div class="row between"><div><h1>🛡️ Admin panel</h1><p class="muted small">Signed in as ${esc(m.name)} · ${ROLE_LABEL[m.role]}${isAdmin() ? '' : ' — user management and settings are admin-only'}</p></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${t === k ? 'active' : ''}" data-atab="${k}">${l}</button>`).join('')}</div>
    ${body}
  </div>`;
}
function afterAdmin(root) {
  $$('[data-atab]', root).forEach((b) => b.onclick = () => { adminState.tab = b.dataset.atab; adminState.q = ''; render(); });
  $$('[data-rstatus]', root).forEach((b) => b.onclick = () => { adminState.rstatus = b.dataset.rstatus; render(); });
  const qi = $('#adminQ', root);
  if (qi) qi.oninput = () => { adminState.q = qi.value; render(); const n = $('#adminQ'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  $$('[data-role-for]', root).forEach((sel) => sel.onchange = () => {
    if (!isAdmin()) return;
    const u = user(sel.dataset.roleFor), role = sel.value;
    if (u.role === 'admin' && role !== 'admin' && db.users.filter((x) => x.role === 'admin').length === 1) { toast('Patch needs at least one admin'); return render(); }
    if (!confirm(`Make @${u.handle} a ${ROLE_LABEL[role]}?`)) return render();
    u.role = role; if (role === 'admin') u.banned = false;
    audit('changed role', `@${u.handle} → ${ROLE_LABEL[role]}`);
    notify(u.id, `Your Patch role is now: ${ROLE_LABEL[role]}`, role === 'user' ? '#/' : '#/admin');
    save(); render(); toast('Role updated');
  });
  const sf = $('#settingsForm', root);
  if (sf) sf.onsubmit = (e) => {
    e.preventDefault();
    const days = Math.max(0, Math.min(60, Number(sf.minAge.value) || 0));
    Object.assign(db.settings, { communityMinAgeDays: days, toolApproval: sf.toolApproval.checked, announcement: sf.announcement.value.trim() });
    audit('updated settings', `wait ${days}d · tool approval ${sf.toolApproval.checked ? 'on' : 'off'}`);
    save(); render(); toast('Settings saved');
  };
  const rb = $('#adminReset', root);
  if (rb) rb.onclick = () => { if (confirm('Reset ALL data to the demo state?')) { db = seed(); save(); location.hash = '#/'; render(); toast('Data reset'); } };
}

const notFound = () => '<div class="page single"><div class="card empty"><h2>Not found</h2><p>That page does not exist (yet).</p><a class="btn" href="#/">Go home</a></div></div>';
const loginWall = (what) => `<div class="page single"><div class="card empty"><h2>Join Patch</h2><p>Log in to ${esc(what)}.</p><button class="btn btn-primary" data-act="login">Log in / Sign up</button></div></div>`;

/* ---------- auth (demo) ---------- */
function openAuth() {
  modal(`<h2>Welcome to Patch</h2><p class="muted small">This prototype stores data in your browser. Pick a demo account or create a new one.</p>
    <h3>Continue as</h3><div class="stack" style="margin-bottom:16px">${db.users.map((u) => `<button class="btn" style="width:100%;justify-content:flex-start" data-login="${u.id}"><span class="avatar sm" style="background:${esc(u.color)}">${esc(u.name[0])}</span> ${esc(u.name)} <span class="muted small">@${esc(u.handle)} · ${Math.floor(accountAgeDays(u))}d old</span></button>`).join('')}</div>
    <h3>Or create an account</h3><form id="signupForm"><div class="grid-2"><div class="field"><label for="su-n">Name</label><input id="su-n" type="text" name="name" required maxlength="50"></div><div class="field"><label for="su-h">Username</label><input id="su-h" type="text" name="handle" required pattern="[a-z0-9_]{3,20}" maxlength="20" placeholder="lowercase"></div></div>
    <div class="row" style="justify-content:flex-end"><button class="btn btn-primary">Sign up</button></div></form>`);
  $$('[data-login]').forEach((b) => b.onclick = () => { db.currentUserId = b.dataset.login; save(); closeModal(); render(); toast(`Logged in as ${me().name}`); });
  $('#signupForm').onsubmit = (e) => {
    e.preventDefault(); const f = e.target;
    const handle = f.handle.value.trim().toLowerCase();
    if (userByHandle(handle)) return toast('Username taken');
    const u = { id: uid(), name: f.name.value.trim(), handle, bio: 'New to Patch 👋', skills: [], openToWork: false, isPublic: true, color: COLORS[db.users.length % COLORS.length], joinedAt: now(), following: [], links: {} };
    db.users.push(u); db.currentUserId = u.id; save(); closeModal(); render(); toast('Welcome to Patch!');
  };
}

/* ---------- global actions ---------- */
const actions = {
  login: () => openAuth(),
  logout: () => { db.currentUserId = null; save(); location.hash = '#/'; render(); },
  like(id) { if (!requireLogin()) return; const p = post(id), m = me(); const i = p.likes.indexOf(m.id); if (i >= 0) p.likes.splice(i, 1); else { p.likes.push(m.id); notify(p.authorId, `${m.name} liked "${p.title.slice(0, 50)}"`, `#/post/${p.id}`); } save(); render(); },
  save(id) { if (!requireLogin()) return; const p = post(id), m = me(); const i = p.saves.indexOf(m.id); if (i >= 0) p.saves.splice(i, 1); else p.saves.push(m.id); save(); render(); toast(i >= 0 ? 'Removed from saved' : 'Saved'); },
  share(id) { const url = `${location.origin}${location.pathname}#/post/${id}`; (navigator.clipboard?.writeText(url) || Promise.reject()).then(() => toast('Link copied'), () => prompt('Copy this link:', url)); },
  solve(id) { const p = post(id); p.solved = !p.solved; save(); render(); },
  'delete-post'(id) {
    const p = post(id), m = me(); if (!p || !m) return;
    const own = p.authorId === m.id;
    if (!own && !canModerate(community(p.communityId))) return;
    if (!confirm(own ? 'Delete this post?' : 'Remove this post as a moderator? The author will be notified.')) return;
    db.posts = db.posts.filter((x) => x.id !== id);
    if (!own) { audit('removed post', p.title); notify(p.authorId, `Your post "${p.title.slice(0, 50)}" was removed by moderators.`, '#/notifications'); }
    save(); if (location.hash.includes(id)) location.hash = '#/'; render();
  },
  'vote-poll'(id, el) { if (!requireLogin()) return; const p = post(id), m = me(), i = Number(el.dataset.i); p.poll.options.forEach((o, j) => { const k = o.votes.indexOf(m.id); if (k >= 0) o.votes.splice(k, 1); else if (j === i) o.votes.push(m.id); }); save(); render(); },
  join(id) { if (!requireLogin()) return; const c = community(id), m = me(); const i = c.members.indexOf(m.id); if (i >= 0) c.members.splice(i, 1); else c.members.push(m.id); save(); render(); },
  follow(id) { const m = me(); const i = m.following.indexOf(id); if (i >= 0) m.following.splice(i, 1); else { m.following.push(id); notify(id, `${m.name} started following you`, `#/u/${m.handle}`); } save(); render(); },
  'new-community': () => openNewCommunity(),
  'new-tool': () => openNewTool(),
  'upvote-tool'(id) { if (!requireLogin()) return; const t = db.tools.find((x) => x.id === id), m = me(); const i = t.upvotes.indexOf(m.id); if (i >= 0) t.upvotes.splice(i, 1); else t.upvotes.push(m.id); save(); render(); },
  'add-update': (id) => openAddUpdate(id),
  'delete-project'(id) { if (!confirm('Delete this project page? Its timeline will be lost.')) return; removeProject(id); save(); location.hash = '#/vault'; },
  'submit-entry': () => { if (requireLogin()) openSubmitEntry(); },
  'champ-vote'(id) {
    if (!requireLogin()) return;
    const m = me(), s = db.champ.submissions.find((x) => x.id === id);
    if (s.userId === m.id) return toast("You can't vote for your own entry");
    const existing = db.champ.votes.find((v) => v.month === s.month && v.category === s.category && v.voterId === m.id);
    if (existing && existing.submissionId === id) { db.champ.votes = db.champ.votes.filter((v) => v !== existing); toast('Vote removed'); }
    else if (existing) { existing.submissionId = id; toast('Vote changed'); }
    else { db.champ.votes.push({ month: s.month, category: s.category, voterId: m.id, submissionId: id }); toast('Vote cast!'); }
    save(); render();
  },
  'close-month': () => closeMonth(),
  'edit-profile': () => openEditProfile(),
  'read-all'() { db.notifications.forEach((n) => { if (n.userId === me().id) n.read = true; }); save(); render(); },
  report(id, el) { if (requireLogin()) openReport(el.dataset.kind, id); },
  'pin-post'(id) {
    const p = post(id); if (!p || !canModerate(community(p.communityId))) return;
    p.pinned = !p.pinned; audit(p.pinned ? 'pinned post' : 'unpinned post', p.title);
    save(); render(); toast(p.pinned ? 'Pinned to the top' : 'Unpinned');
  },
  'delete-comment'(id) {
    const [pid, cid] = id.split('|'); const p = post(pid), m = me();
    const cm = p && p.comments.find((x) => x.id === cid); if (!cm || !m) return;
    const own = cm.authorId === m.id;
    if (!own && !canModerate(community(p.communityId))) return;
    if (!confirm(own ? 'Delete this comment?' : 'Remove this comment as a moderator?')) return;
    p.comments = p.comments.filter((x) => x !== cm);
    if (!own) { audit('removed comment', `on "${p.title}"`); notify(cm.authorId, `Your comment on "${p.title.slice(0, 50)}" was removed by moderators.`, `#/post/${p.id}`); }
    save(); render();
  },
  'edit-community': (id) => openEditCommunity(id),
  'report-remove'(id) {
    if (!isStaff()) return;
    const r = db.reports.find((x) => x.id === id); if (!r) return;
    if (!confirm(r.kind === 'user' ? 'Suspend this user?' : `Remove this ${r.kind}? The author will be notified.`)) return;
    removeTarget(r);
    db.reports.forEach((x) => { if (x.status === 'open' && x.kind === r.kind && x.targetId === r.targetId) Object.assign(x, { status: 'resolved', handledBy: me().id, handledAt: now() }); });
    audit(r.kind === 'user' ? 'suspended user (report)' : `removed ${r.kind} (report)`, r.reason);
    save(); render(); toast('Done — report resolved');
  },
  'report-dismiss'(id) {
    if (!isStaff()) return;
    const r = db.reports.find((x) => x.id === id); if (!r) return;
    Object.assign(r, { status: 'dismissed', handledBy: me().id, handledAt: now() });
    audit('dismissed report', `${r.kind} — ${r.reason}`); save(); render();
  },
  'ban-user'(id) {
    if (!isAdmin()) return;
    const u = user(id); if (!u) return;
    if (u.role === 'admin') return toast("Admins can't be suspended — change their role first");
    if (!u.banned && !confirm(`Suspend @${u.handle}? They will be able to browse but not post, comment or vote.`)) return;
    u.banned = !u.banned;
    audit(u.banned ? 'suspended user' : 'restored user', '@' + u.handle);
    notify(u.id, u.banned ? 'Your account has been suspended by an admin.' : 'Your account has been restored. Welcome back!', '#/notifications');
    save(); render();
  },
  'verify-user'(id) {
    if (!isAdmin()) return;
    const u = user(id); u.verified = !u.verified;
    audit(u.verified ? 'verified user' : 'removed verification', '@' + u.handle);
    if (u.verified) notify(u.id, 'You are now a ✔ Verified builder on Patch!', `#/u/${u.handle}`);
    save(); render();
  },
  'approve-tool'(id) {
    if (!isStaff()) return;
    const t = db.tools.find((x) => x.id === id); if (!t) return;
    t.status = 'approved'; t.createdAt = now();
    audit('approved tool', t.name); notify(t.addedBy, `Your tool "${t.name}" was approved and is now live.`, '#/tools');
    save(); render();
  },
  'reject-tool'(id) {
    if (!isStaff()) return;
    const t = db.tools.find((x) => x.id === id); if (!t) return;
    db.tools = db.tools.filter((x) => x !== t);
    audit('rejected tool', t.name); notify(t.addedBy, `Your tool "${t.name}" was not approved.`, '#/tools');
    save(); render();
  },
  'remove-tool'(id) {
    if (!isStaff()) return;
    const t = db.tools.find((x) => x.id === id); if (!t || !confirm(`Remove "${t.name}" from Tools?`)) return;
    db.tools = db.tools.filter((x) => x !== t); audit('removed tool', t.name); save(); render();
  },
  'delete-community'(id) {
    if (!isAdmin()) return;
    const c = community(id); if (!c) return;
    const n = db.posts.filter((p) => p.communityId === id).length;
    if (!confirm(`Delete p/${c.slug} and its ${plural(n, 'post')}? This cannot be undone.`)) return;
    db.posts = db.posts.filter((p) => p.communityId !== id);
    db.communities = db.communities.filter((x) => x !== c);
    audit('deleted community', 'p/' + c.slug); save(); render();
  },
  disqualify(id) {
    if (!isStaff()) return;
    const sub = db.champ.submissions.find((x) => x.id === id); if (!sub) return;
    if (!confirm('Disqualify this entry? Its votes will be removed.')) return;
    db.champ.submissions = db.champ.submissions.filter((x) => x !== sub);
    db.champ.votes = db.champ.votes.filter((v) => v.submissionId !== id);
    notify(sub.userId, `Your ${catName(sub.category)} championship entry was disqualified by staff.`, '#/championship');
    audit('disqualified entry', `${project(sub.projectId)?.name || 'entry'} — ${catName(sub.category)}`);
    save(); render();
  },
};
const BANNED_OK = new Set(['login', 'logout', 'share']);
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  if (me()?.banned && !BANNED_OK.has(el.dataset.act)) return toast('Your account is suspended');
  fn(el.dataset.id, el);
});

/* ---------- modal / toast ---------- */
function modal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; setTimeout(() => $('#modal input:not([type=checkbox]), #modal textarea, #modal select, #modal button')?.focus(), 0); }
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
$('#modalClose').onclick = closeModal;
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
// Suspended accounts can browse but every form submission (post, comment, DM, vote…) is blocked.
document.addEventListener('submit', (e) => {
  if (me()?.banned && e.target.id !== 'signupForm') { e.preventDefault(); e.stopPropagation(); toast('Your account is suspended'); }
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2200); }

/* ---------- chrome ---------- */
function renderChrome(section) {
  const m = me();
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
  const an = $('#adminNav'), openReports = db.reports.filter((r) => r.status === 'open').length + db.tools.filter((t) => t.status === 'pending').length;
  an.hidden = !isStaff();
  an.innerHTML = `🛡️ Admin${openReports ? ` <span class="pill pill-warn">${openReports}</span>` : ''}`;
  const unread = m ? db.notifications.filter((n) => n.userId === m.id && !n.read).length : 0;
  const nc = $('#notifCount'); nc.hidden = !unread; nc.textContent = unread > 9 ? '9+' : unread;
  $('#msgDot').hidden = !(m && db.messages.some((x) => x.to === m.id && !x.read));
  const um = $('#userMenu');
  um.innerHTML = m
    ? `<button class="icon-btn" id="umBtn" aria-label="Account" style="width:auto;padding:0 4px"><span class="avatar sm" style="background:${esc(m.color)}">${esc(m.name[0])}</span></button><div class="menu" id="umMenu" hidden>
        <div style="padding:8px 10px"><strong>${esc(m.name)}</strong><div class="small muted">@${esc(m.handle)}</div></div><hr>
        <a href="#/u/${esc(m.handle)}">👤 Profile & trophy room</a><a href="#/vault/new">🗄️ Add project</a><a href="#/saved">🔖 Saved</a>${isStaff() ? '<a href="#/admin">🛡️ Admin panel</a>' : ''}<hr>
        <button data-act="login">🔁 Switch account</button><button data-act="logout">↩ Log out</button></div>`
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
  const parts = (path || '/').split('/').filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  if (!a) return ['feed', viewFeed, afterFeed];
  if (a === 'post') return ['feed', () => viewPost(b), (r) => afterPost(r, b)];
  if (a === 'new') return ['feed', () => viewNewPost(params), afterNewPost];
  if (a === 'communities') return ['communities', viewCommunities];
  if (a === 'c') return ['communities', () => viewCommunity(b), (r) => bindFeed(r, commState, render)];
  if (a === 'tools') return ['tools', viewTools, afterTools];
  if (a === 'vault' && b === 'new') return ['vault', () => viewProjectForm(null), (r) => afterProjectForm(r, null)];
  if (a === 'vault' && b && c === 'edit') return ['vault', () => viewProjectForm(b), (r) => afterProjectForm(r, b)];
  if (a === 'vault' && b) return ['vault', () => viewProject(b)];
  if (a === 'vault') return ['vault', viewVault, afterVault];
  if (a === 'championship') return ['championship', viewChampionship, afterChampionship];
  if (a === 'u') return ['', () => viewProfile(b), afterProfile];
  if (a === 'builders') return ['builders', viewBuilders];
  if (a === 'messages') return ['messages', () => viewMessages(b), (r) => afterMessages(r, b)];
  if (a === 'notifications') return ['', viewNotifications, afterNotifications];
  if (a === 'saved') return ['saved', viewSaved];
  if (a === 'search') return ['', () => viewSearch(params.get('q') || '')];
  if (a === 'admin') return ['admin', viewAdmin, afterAdmin];
  return ['', notFound];
}
let lastHash = '';
function render() {
  const [section, view, after] = route();
  const root = $('#app');
  root.innerHTML = banner() + view();
  after && after(root);
  renderChrome(section);
  if (location.hash !== lastHash) { window.scrollTo(0, 0); lastHash = location.hash; }
  $('#sidebar').classList.remove('open');
}

/* ---------- boot ---------- */
load();
const THEME_KEY = 'patch.theme';
try { const th = localStorage.getItem(THEME_KEY); if (th) document.documentElement.dataset.theme = th; } catch {}
$('#themeBtn').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, document.documentElement.dataset.theme); } catch {}
};
$('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
$('#resetBtn').onclick = () => { if (confirm('Reset all demo data?')) { db = seed(); save(); location.hash = '#/'; render(); toast('Demo data reset'); } };
let searchTimer;
$('#searchInput').addEventListener('input', (e) => { clearTimeout(searchTimer); const q = e.target.value.trim(); searchTimer = setTimeout(() => { location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/'; }, 250); });
window.addEventListener('hashchange', render);
window.Patch = { reset: () => { db = seed(); save(); render(); } };
render();
})();
