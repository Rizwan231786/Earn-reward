// Demo content for local testing (SEED_DEMO=1). Never enable this in production.
import { CHAMP_CATEGORIES, COLORS, DAY, monthKey } from '../public/shared.js';
import { uid } from './auth.js';
import { emptyState } from './db.js';

export function seedDemo() {
  const t = Date.now();
  const s = emptyState();
  s.users = [
    ['u1', 'Arjun Mehta', 'arjun', 'Building Patch. Making things for builders.', ['JavaScript', 'Node', 'Design'], 400, true],
    ['u2', 'Kavya Rao', 'kavya', 'Indie game dev. Unity + Godot. Shipping one tiny game a month.', ['Godot', 'Unity', 'C#'], 380, true],
    ['u3', 'Leo Fernandes', 'leo', 'AI agents & automations. Previously backend at a fintech.', ['Python', 'LangGraph', 'n8n'], 300, true],
    ['u4', 'Mira Santos', 'mira', 'UI/UX designer who codes. Figma → React.', ['Figma', 'React', 'CSS'], 260, false],
    ['u5', 'Dev Patel', 'devp', 'Built my first tool on my phone with AI Studio. Learning every day.', ['AI Studio', 'Apps Script'], 120, true],
    ['u6', 'Sana Qureshi', 'sana', 'Web dev, freelance. Next.js and Tailwind all day.', ['Next.js', 'Tailwind', 'Supabase'], 200, true],
    ['u7', 'Noah Kim', 'noah', 'Battle royale grinder and part-time modder.', ['Lua', 'Blender'], 90, false],
  ].map(([id, name, handle, bio, skills, ageDays, openToWork], i) => ({
    id, name, handle, bio, skills, openToWork, isPublic: true, color: COLORS[i % COLORS.length],
    joinedAt: t - ageDays * DAY, following: [], role: 'user', banned: false, verified: false,
  }));
  const users = s.users;
  users[1].role = 'moderator';
  users[1].verified = users[2].verified = true;
  users[0].following = ['u2', 'u3'];
  users[1].following = ['u1', 'u3', 'u4'];
  users[2].following = ['u1'];

  s.communities = [
    ['c1', 'gamedev', 'Game Development', '🎮', 'Engines, mechanics, devlogs and playtests.', ['Show your work-in-progress, not just finished games', 'Give feedback you would want to receive', 'No piracy links'], ['u1', 'u2', 'u7', 'u5']],
    ['c2', 'ai-agents', 'AI Agents', '🤖', 'Agents, tool-calling, evals and everything LLM.', ['Share prompts and code, not just screenshots', 'Mark sponsored content', 'Be kind to beginners'], ['u1', 'u3', 'u5', 'u6']],
    ['c3', 'webdev', 'Web Development', '🌐', 'Frontend, backend, deployment and the stuff in between.', ['Include a link or code when asking for help', 'No self-promo without context'], ['u1', 'u4', 'u6']],
    ['c4', 'battle-royale', 'Battle Royale Squad', '🪂', 'Find squadmates, share wins, talk loadouts.', ['Be respectful in LFG posts', 'No cheats or exploits'], ['u7', 'u2', 'u5']],
    ['c5', 'automation', 'Automation', '⚙️', 'n8n, Zapier, scripts and bots that save hours.', ['Share workflows as JSON when you can'], ['u3', 'u5', 'u6']],
  ].map(([id, slug, name, icon, desc, rules, members], i) => ({ id, slug, name, icon, desc, rules, members, mods: id === 'c4' ? ['u2'] : [], createdBy: members[0], createdAt: t - (200 - i * 20) * DAY }));

  s.projects = [
    { id: 'p1', ownerId: 'u2', name: 'Lanternfall', tagline: 'A cozy roguelite where your lantern is your health bar.', desc: 'Explore a drowned city with a lantern that dims as you take damage. Built in Godot 4.', status: 'beta', visibility: 'closed', tech: ['Godot', 'GDScript', 'Aseprite'], demo: 'https://example.com/lanternfall', repo: '', lookingFor: 'Composer for the soundtrack',
      updates: [[60, 'Character controller done', 'Movement, dash and wall-jump feel good now.', 25], [35, 'Environment pass', 'First biome blocked out with lighting.', 55], [8, 'Enemy AI + beta build', 'Three enemy types and a playable beta.', 80]] },
    { id: 'p2', ownerId: 'u3', name: 'InboxPilot', tagline: 'An AI agent that triages your inbox and drafts replies.', desc: 'Classifies email, drafts replies in your tone and asks before sending anything.', status: 'launched', visibility: 'open', tech: ['Python', 'LangGraph', 'FastAPI'], demo: 'https://example.com/inboxpilot', repo: 'https://github.com/example/inboxpilot', lookingFor: '',
      updates: [[90, 'Prototype', 'Classifier working on my own inbox.', 30], [40, 'Draft replies', 'Replies now match tone using a few examples.', 70], [12, 'v1.0 launched', 'Public launch with Gmail support.', 100]] },
    { id: 'p3', ownerId: 'u5', name: 'FPS Booster Lite', tagline: 'One-tap tweaks that boost game FPS on low-end PCs.', desc: 'Built entirely on my phone using AI Studio.', status: 'building', visibility: 'closed', tech: ['AI Studio', 'PowerShell'], demo: '', repo: '', lookingFor: 'Testers with low-end laptops',
      updates: [[20, 'First version works', 'Getting +12 FPS on my cousin’s laptop.', 40]] },
    { id: 'p4', ownerId: 'u4', name: 'Glasskit UI', tagline: 'A tiny, accessible component kit for dashboards.', desc: 'Contrast-checked components with dark mode built in.', status: 'launched', visibility: 'open', tech: ['React', 'CSS'], demo: 'https://example.com/glasskit', repo: 'https://github.com/example/glasskit', lookingFor: '',
      updates: [[50, 'Buttons, inputs, cards', 'Core components with keyboard support.', 50], [15, 'v1 docs live', 'Docs site with live examples.', 100]] },
    { id: 'p5', ownerId: 'u6', name: 'ShopSprint', tagline: 'A Next.js storefront template that loads in under a second.', desc: 'Commerce starter with Supabase auth and Stripe checkout.', status: 'beta', visibility: 'open', tech: ['Next.js', 'Supabase', 'Tailwind'], demo: 'https://example.com/shopsprint', repo: '', lookingFor: 'Design feedback',
      updates: [[25, 'Checkout flow', 'Stripe checkout and order emails.', 60]] },
    { id: 'p6', ownerId: 'u1', name: 'Patch', tagline: 'A home for builders to showcase projects and grow together.', desc: 'Feed, communities, Vault, playlists and the Championship.', status: 'building', visibility: 'closed', tech: ['JavaScript', 'Node', 'SQLite'], demo: '', repo: '', lookingFor: 'Suggestions from the community!',
      updates: [[30, 'Feed + posts', 'Posts, comments, likes and saves.', 30], [10, 'Vault + Championship', 'Project pages and monthly voting.', 70]] },
  ].map((p) => ({ ...p, createdAt: t - (p.updates[0][0] + 5) * DAY, updates: p.updates.map(([d, title, body, percent]) => ({ id: uid(), title, body, percent, createdAt: t - d * DAY })) }));

  const P = (o) => ({ id: uid(), likes: [], saves: [], comments: [], tags: [], media: [], ...o });
  s.posts = [
    P({ type: 'showcase', authorId: 'u3', communityId: 'c2', projectId: 'p2', title: 'I built an AI agent that drafts my email replies', body: 'InboxPilot reads incoming mail, sorts it, and drafts a reply in my tone. It never sends without asking.\n\nWould love feedback on the onboarding!', tags: ['ai', 'agents', 'python'], createdAt: t - 3 * 3600e3, likes: ['u1', 'u5', 'u6', 'u2'],
      comments: [{ id: uid(), authorId: 'u5', body: 'This is exactly what I needed. Does it work with Outlook?', createdAt: t - 2 * 3600e3 }, { id: uid(), authorId: 'u3', body: 'Gmail only for now, Outlook is next on the roadmap.', createdAt: t - 1.5 * 3600e3 }] }),
    P({ type: 'question', authorId: 'u5', communityId: 'c1', title: 'Godot: "Invalid get index \'position\' (on base: \'null instance\')" — how do I fix this?', body: 'My enemy script crashes when the player dies. I call get_node("Player").position every frame.', tags: ['godot', 'help'], createdAt: t - 7 * 3600e3, likes: ['u2'],
      comments: [{ id: uid(), authorId: 'u2', body: 'The player node is freed when it dies. Check is_instance_valid(player) before reading position.', createdAt: t - 6 * 3600e3 }], solved: true }),
    P({ type: 'progress', authorId: 'u2', communityId: 'c1', projectId: 'p1', title: 'Lanternfall devlog: enemy AI is in, beta is live', body: 'Three enemy types now hunt by light level. Beta build is up for testers.', progress: { percent: 80, eta: new Date(t + 25 * DAY).toISOString().slice(0, 10) }, tags: ['devlog', 'godot'], createdAt: t - 26 * 3600e3, likes: ['u1', 'u7', 'u5'] }),
    P({ type: 'poll', authorId: 'u1', communityId: 'c3', title: 'Which name sounds better for project pages?', body: 'Every project gets its own dedicated page. Help me pick the name!', poll: { options: [{ text: 'Project Vault', votes: ['u2', 'u3', 'u6'] }, { text: 'Project Void', votes: ['u7'] }] }, createdAt: t - 30 * 3600e3, likes: ['u4'] }),
    P({ type: 'tool-request', authorId: 'u7', communityId: 'c4', title: 'Looking for a tool that tracks my battle royale stats across games', body: 'Something that pulls wins/kills from multiple games into one dashboard. Does it exist?', tags: ['gaming', 'tools'], createdAt: t - 40 * 3600e3 }),
    P({ type: 'discussion', authorId: 'u7', communityId: 'c4', title: '5 wins today 🔥 who is up for squads tonight?', body: 'Finally hit my weekly goal. Looking for 2 more for ranked squads around 9 PM IST.', createdAt: t - 50 * 3600e3, likes: ['u2', 'u5'] }),
    P({ type: 'showcase', authorId: 'u4', communityId: 'c3', projectId: 'p4', title: 'Glasskit UI v1 — accessible dashboard components', body: 'Every color pair passes contrast checks in light and dark mode. Free and open source.', tags: ['react', 'design', 'a11y'], createdAt: t - 3 * DAY, likes: ['u1', 'u6'] }),
    P({ type: 'discussion', authorId: 'u1', communityId: 'c2', title: 'What should the Patch Championship categories be?', body: 'Right now: AI Agent Builder, Game Developer, Website Builder, Automation Expert, UI/UX Builder, Tool Creator. What else should we add?', createdAt: t - 4 * DAY, likes: ['u2', 'u3', 'u4', 'u5', 'u6'],
      comments: [{ id: uid(), authorId: 'u6', body: 'Mobile App Builder for sure!', createdAt: t - 3.8 * DAY }] }),
  ];

  s.playlists = [
    { id: uid(8), ownerId: 'u2', name: 'Lanternfall devlogs', description: 'Every update on my roguelite, in order.', visibility: 'public', items: [s.posts[2].id, s.posts[1].id], createdAt: t - 2 * DAY, updatedAt: t - DAY },
    { id: uid(8), ownerId: 'u1', name: 'Best of Patch this week', description: 'Projects and threads worth your time.', visibility: 'public', items: [s.posts[0].id, s.posts[6].id, s.posts[7].id], createdAt: t - DAY, updatedAt: t - DAY },
  ];

  s.tools = [
    ['Cursor', 'https://cursor.com', 'AI Tools', 'AI-first code editor with codebase chat.', false],
    ['Google AI Studio', 'https://aistudio.google.com', 'AI Tools', 'Prototype apps with Gemini right from the browser — works on phones too.', false],
    ['n8n', 'https://n8n.io', 'Automation', 'Open-source workflow automation you can self-host.', false],
    ['Godot Engine', 'https://godotengine.org', 'Game Dev', 'Free, open-source 2D/3D game engine.', false],
    ['Excalidraw', 'https://excalidraw.com', 'Design', 'Hand-drawn style whiteboard for quick diagrams.', false],
    ['awesome-selfhosted', 'https://github.com/awesome-selfhosted/awesome-selfhosted', 'GitHub Repos', 'Huge list of self-hostable software.', false],
    ['Vercel Hobby', 'https://vercel.com', 'Hosting & Cloud', 'Free tier for hosting frontend projects.', false],
    ['Cloud credits for students', 'https://education.github.com/pack', 'Hosting & Cloud', 'Free cloud credits and dev tools with the GitHub Student Pack.', true],
  ].map(([name, url, category, desc, isOffer], i) => ({ id: uid(), name, url, category, desc, isOffer, expires: isOffer ? new Date(t + 30 * DAY).toISOString().slice(0, 10) : '', addedBy: users[i % users.length].id, upvotes: users.slice(0, (i * 3) % 6 + 1).map((u) => u.id), status: 'approved', createdAt: t - i * 2 * DAY }));
  s.tools.push({ id: uid(), name: 'FreeGPU Finder', url: 'https://example.com/freegpu', category: 'Hosting & Cloud', desc: 'Tracks free GPU credits across cloud providers.', isOffer: true, expires: '', addedBy: 'u5', upvotes: ['u5'], status: 'pending', createdAt: t - 3600e3 });

  // Championship history from January last year up to last month.
  const pools = { 'ai-agent': ['u3', 'u5', 'u6'], game: ['u2', 'u7', 'u5'], website: ['u6', 'u4', 'u1'], automation: ['u3', 'u5', 'u6'], uiux: ['u4', 'u6', 'u1'], tool: ['u5', 'u3', 'u1'] };
  const cur = new Date();
  const projectOf = (userId) => s.projects.find((p) => p.ownerId === userId);
  for (let d = new Date(cur.getFullYear() - 1, 0, 1); d < new Date(cur.getFullYear(), cur.getMonth(), 1); d.setMonth(d.getMonth() + 1)) {
    const mk = monthKey(d);
    s.champ.closed.push(mk);
    CHAMP_CATEGORIES.forEach((c, ci) => {
      const r = (d.getMonth() * 7 + ci * 3 + d.getFullYear()) % 10;
      const userId = r < 5 ? pools[c.id][0] : r < 8 ? pools[c.id][1] : pools[c.id][2];
      s.champ.winners.push({ month: mk, category: c.id, userId, projectId: projectOf(userId)?.id || '', projectName: projectOf(userId)?.name || 'Entry', votes: 20 + ((r * 13 + ci * 5) % 60) });
    });
  }
  const mk = monthKey(cur);
  [['ai-agent', 'p2'], ['game', 'p1'], ['tool', 'p3'], ['uiux', 'p4'], ['website', 'p5'], ['website', 'p6']].forEach(([category, projectId]) => {
    const p = s.projects.find((x) => x.id === projectId);
    s.champ.submissions.push({ id: uid(), month: mk, category, projectId, userId: p.ownerId, note: p.tagline, createdAt: t - 5 * DAY });
  });
  const sub = (cat, pid) => s.champ.submissions.find((x) => x.category === cat && x.projectId === pid).id;
  [['u1', 'ai-agent', 'p2'], ['u6', 'ai-agent', 'p2'], ['u7', 'game', 'p1'], ['u5', 'game', 'p1'], ['u2', 'tool', 'p3'], ['u3', 'tool', 'p3'], ['u1', 'uiux', 'p4'], ['u2', 'website', 'p5'], ['u3', 'website', 'p6']]
    .forEach(([voterId, category, pid]) => s.champ.votes.push({ month: mk, category, voterId, submissionId: sub(category, pid) }));

  s.notifications = [
    { id: uid(), userId: 'u1', text: 'Leo Fernandes started following you', link: '#/u/leo', read: false, createdAt: t - 2 * 3600e3 },
    { id: uid(), userId: 'u1', text: 'Kavya Rao voted in your poll', link: `#/post/${s.posts[3].id}`, read: false, createdAt: t - 20 * 3600e3 },
  ];
  s.messages = [
    { id: uid(), from: 'u2', to: 'u1', body: 'Hey! Loved the Patch idea. Want to collab on the game dev community?', createdAt: t - 5 * 3600e3, read: false },
    { id: uid(), from: 'u1', to: 'u2', body: 'Absolutely — let’s set up some rules and pin a devlog thread.', createdAt: t - 4 * 3600e3, read: true },
  ];
  s.reports = [
    { id: uid(), kind: 'post', targetId: s.posts[4].id, reason: 'Off-topic', note: 'Not really a tool request, more of a gaming question.', reporterId: 'u6', status: 'open', createdAt: t - 5 * 3600e3 },
  ];
  s.settings = { communityMinAgeDays: 3, toolApproval: true, announcement: '🎉 Patch beta is open — add your first project to the Vault!' };
  return s;
}
