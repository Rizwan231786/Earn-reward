// Constants and helpers shared by the browser app, the admin panel and the server.
export const DAY = 864e5;
export const CHAMP_CATEGORIES = [
  { id: 'ai-agent', name: 'AI Agent Builder', icon: '🤖' },
  { id: 'game', name: 'Game Developer', icon: '🎮' },
  { id: 'website', name: 'Website Builder', icon: '🌐' },
  { id: 'automation', name: 'Automation Expert', icon: '⚙️' },
  { id: 'uiux', name: 'UI/UX Builder', icon: '🎨' },
  { id: 'tool', name: 'Tool Creator', icon: '🛠️' },
];
export const POST_TYPES = {
  discussion: { label: 'Discussion', icon: '💬' },
  media: { label: 'Photos & Videos', icon: '📸' },
  showcase: { label: 'Project Showcase', icon: '🚀' },
  question: { label: 'Question / Help', icon: '❓' },
  progress: { label: 'Progress Update', icon: '📈' },
  poll: { label: 'Poll', icon: '📊' },
  'tool-request': { label: 'Tool Request', icon: '🧰' },
};
export const TOOL_CATEGORIES = ['AI Tools', 'Dev Tools', 'GitHub Repos', 'Design', 'Hosting & Cloud', 'Automation', 'Game Dev'];
export const PROJECT_STATUS = { idea: 'Idea', building: 'In development', beta: 'Beta', launched: 'Launched' };
export const REPORT_REASONS = ['Spam or self-promotion', 'Harassment or hate', 'Scam or malicious link', 'Stolen / plagiarised project', 'Inappropriate media', 'Off-topic', 'Other'];
export const ROLE_LABEL = { admin: 'Admin', moderator: 'Moderator', user: 'Member' };
export const PLAYLIST_VISIBILITY = { public: '🌍 Public', unlisted: '🔗 Unlisted (link only)', private: '🔒 Private' };
export const COLORS = ['#5b5bf0', '#e0567a', '#11875d', '#d9822b', '#2f80ed', '#9b51e0', '#14a3a3', '#c2362f'];
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
export const RESERVED_USERNAMES = ['admin', 'administrator', 'patch', 'moderator', 'mod', 'support', 'system', 'root', 'staff', 'help', 'official'];
export const LIMITS = {
  imageBytes: 10 * 1024 * 1024,
  videoBytes: 100 * 1024 * 1024,
  mediaPerPost: 10,
  playlistItems: 200,
};

export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export const monthLabel = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en', { month: 'long', year: 'numeric' }); };
export const shortMonth = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleString('en', { month: 'short', year: 'numeric' }); };

// A year's champion per category = most monthly trophies in that category, once all 12 months are closed.
export function yearlyTitles(winners, closed) {
  const byYear = {};
  winners.forEach((w) => {
    const y = w.month.slice(0, 4);
    const cats = (byYear[y] ||= {});
    const counts = (cats[w.category] ||= {});
    counts[w.userId] = (counts[w.userId] || 0) + 1;
  });
  const out = [];
  Object.entries(byYear).forEach(([year, cats]) => {
    if (closed.filter((m) => m.startsWith(year)).length < 12) return;
    Object.entries(cats).forEach(([category, counts]) => {
      const [userId, trophies] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      out.push({ year, category, userId, trophies });
    });
  });
  return out;
}
