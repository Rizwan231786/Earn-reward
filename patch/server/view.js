// What each person is allowed to see. Private data never leaves the server.
const PUBLIC_USER = ['id', 'name', 'handle', 'bio', 'skills', 'openToWork', 'isPublic', 'color', 'joinedAt', 'following', 'role', 'banned', 'verified'];
const pickUser = (u) => Object.fromEntries(PUBLIC_USER.map((k) => [k, u[k]]));

function voteCounts(s) {
  const banned = new Set(s.users.filter((u) => u.banned).map((u) => u.id));
  const counts = {};
  for (const v of s.champ.votes) if (!banned.has(v.voterId)) counts[v.submissionId] = (counts[v.submissionId] || 0) + 1;
  return counts;
}

export function appState(s, me) {
  const mid = me?.id || null;
  return {
    me: mid ? { id: mid } : null,
    users: s.users.map(pickUser),
    communities: s.communities,
    // who saved a post is private: each person only sees their own save
    posts: s.posts.map((p) => ({ ...p, saves: mid && p.saves.includes(mid) ? [mid] : [] })),
    projects: s.projects,
    tools: s.tools.filter((t) => t.status !== 'pending' || t.addedBy === mid),
    champ: {
      submissions: s.champ.submissions, winners: s.champ.winners, closed: s.champ.closed,
      votes: s.champ.votes.filter((v) => v.voterId === mid), // only your own ballot
      counts: voteCounts(s),
    },
    // unlisted playlists are reachable by link only, so they are not listed here
    playlists: s.playlists.filter((p) => p.visibility === 'public' || p.ownerId === mid),
    notifications: mid ? s.notifications.filter((n) => n.userId === mid).slice(0, 100) : [],
    messages: mid ? s.messages.filter((m) => m.from === mid || m.to === mid) : [],
    settings: { communityMinAgeDays: s.settings.communityMinAgeDays, announcement: s.settings.announcement, toolApproval: s.settings.toolApproval },
  };
}

export function adminState(s, me, security) {
  return {
    me: { id: me.id, role: me.role },
    users: s.users.map((u) => ({ ...pickUser(u), twoFactor: !!security[u.id]?.totp, sessions: security[u.id]?.sessions || 0 })),
    communities: s.communities,
    posts: s.posts.map(({ saves, ...p }) => p),
    projects: s.projects,
    tools: s.tools,
    champ: { submissions: s.champ.submissions, winners: s.champ.winners, closed: s.champ.closed, counts: voteCounts(s), votes: s.champ.votes.map(({ month, submissionId, voterId }) => ({ month, submissionId, voterId })) },
    playlists: s.playlists,
    reports: s.reports,
    audit: s.audit.slice(0, 300),
    settings: s.settings,
  };
}
