# Patch — a community platform for builders

Patch is a place where builders showcase projects, get help, and grow their own communities, so a project shared today doesn't vanish from the feed by tomorrow.

It is a real web app: a Node.js server with an SQLite database, real accounts, and image and video uploads. It has **zero npm dependencies**.

## Run it

You need **Node.js 22.13 or newer**. Check with `node --version`.

```bash
cd patch
npm run dev            # demo data, demo accounts use the password: patch-demo-2026
# or, for an empty community:
npm start
```

Open http://localhost:3000. The admin panel is a separate site at http://localhost:3000/admin/.

### Create the first admin

Stop the server, then run:

```bash
npm run create-admin -- yourname        # asks for a password and prints a recovery code
# or promote an existing account:
npm run cli -- set-role kavya moderator
```

At the first admin sign-in you'll be asked to set up two-factor with an authenticator app (Google Authenticator, Authy, 1Password or Microsoft Authenticator).

### Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Where the server listens. Use `HOST=0.0.0.0` on a server |
| `PATCH_DATA_DIR` | `./data` | Where the database and uploads are stored. **Back this folder up** |
| `COOKIE_SECURE` | off | Set to `1` when serving over HTTPS. Adds `Secure` cookies and HSTS |
| `TRUST_PROXY` | off | Set to `1` behind nginx or Cloudflare so rate limits see real IPs |
| `PUBLIC_URL` | from the request | e.g. `https://patch.example.com`, used for link previews |
| `SEED_DEMO` / `DEMO_PASSWORD` | off | Demo content (`npm run dev`). **Never in production** |

To put it online, run `npm start` behind HTTPS (nginx, Caddy or Cloudflare), with `COOKIE_SECURE=1 TRUST_PROXY=1 HOST=0.0.0.0`.

## Login & security (no email, Discord-style)

- **Username and password.** No email is collected. Passwords are hashed with scrypt (salted) and are never stored in plain text.
- **Two-factor (2FA).** Members can turn on authenticator-app codes in **Settings → Account & security**. Turning it on gives 10 one-time backup codes. **2FA is mandatory for the admin panel.**
- **Recovery code instead of email.** Each account gets a recovery code at signup. It resets the password, logs out every device and issues a new code.
- **Sessions.** Random tokens in `HttpOnly; SameSite=Strict` cookies, stored hashed on the server. You can see where you're logged in, log out one device or all of them, and changing your password logs out all other devices. You also get a notification for each new login.
- **Rate limits.** An account locks for 15 minutes after repeated failed logins. Signups, uploads, posts, messages and reports are also rate-limited.
- **Other protections:**
  - **CSRF:** every write needs a custom header and a same-origin check.
  - **Security headers:** a strict Content-Security-Policy, `X-Frame-Options: DENY` and `nosniff`.
  - **Server-side checks:** all input is validated and all permissions are checked on the server, so the browser is never trusted.
  - **Private data stays private:** who saved a post, how people voted, and DMs are never sent to other users.

## Admin panel (separate from the site)

`/admin/` has its own sign-in (password plus 2FA) and its own short-lived session cookie, scoped to `/api/admin` and expiring after 30 minutes idle or 8 hours. Being logged into the main site gives **no** admin access, and the main site has no admin UI.

| Tab | What it does | Who |
|---|---|---|
| 📊 Overview | Members, posts, media, playlists, reports, pending tools, suspended accounts, 2FA adoption | Staff |
| ⚑ Reports | Reports on posts, comments, users, projects and playlists. Remove the item, suspend the user (admin only) or dismiss | Staff |
| 📝 Content | Search all posts, pin them or remove them. The author is notified | Staff |
| 🧰 Tools | Approve or reject submitted tools and offers, remove live ones | Staff |
| 🏆 Championship | Entries and vote counts, disqualify entries, close voting early (admin). Voting also closes automatically at month end | Staff |
| 👥 Users | Roles, ✔ verify, suspend or restore, log a user out everywhere, see who has 2FA | Admin |
| 🏘️ Communities | Edit details, rules and moderators, or delete a community | Admin |
| ⚙️ Settings | New-account waiting period, tool approval, site announcement | Admin |
| 📜 Audit log | Every staff action, with who did it and when | Staff |

Community owners and their community moderators can pin and remove posts inside their own community from the main site, the way a Discord server owner can.

## Features

1. **Feed** with For you, Latest and Top sorting and type filters. Pinned posts show first.
2. **Posts:** Discussion, 📸 Photos & Videos, Project Showcase, Question (can be marked solved), Progress Update, Poll, Tool Request. Posts take tags, likes, comments, saves and reports.
3. **📸 Images & videos.** Upload up to 10 per post with drag and drop and progress bars:
   - Images (JPG, PNG, GIF, WebP, AVIF) up to 10 MB each; videos (MP4, WebM, MOV) up to 100 MB each.
   - File types are checked from the bytes themselves, not the file name.
   - Videos stream with seeking (HTTP range requests). Images open in a lightbox.
4. **🎞️ Playlists.** Name a playlist, add any posts to it, and reorder or remove them:
   - Visibility can be 🌍 Public, 🔗 Unlisted (link only) or 🔒 Private.
   - The playlist page is a player: the current item shows large, with Previous and Next, autoplay of the next video, and an "Up next" list.
5. **↗ Share links.** `/s/post/<id>` and `/s/playlist/<id>`:
   - Anyone can open them, even without an account.
   - They show a rich preview (title, description, image) when pasted into Discord, WhatsApp or X.
6. **Communities.** Rules, members and moderators. Creating one requires an account at least 3 days old; admins can change the waiting period.
7. **Tools & Offers** directory with categories and upvotes. Optional staff approval.
8. **Profiles:** posts, a 📸 media grid, projects, playlists and a trophy room. Following, notifications, public or private profiles.
9. **Messages:** private DMs.
10. **Project Vault:** a permanent page per project with a milestone timeline. Closed-source projects are fine.
11. **Patch Championship:**
    - Six monthly categories, and each member gets one vote per category.
    - Voting closes automatically at month end and crowns that month's Verified Champions.
    - Every win goes into the builder's trophy room, and the builder with the most trophies in a category over a year earns the 👑 Champion of the Year badge.
12. **Opportunities:** builders who are open to freelance work and collaborations.

## Files

```
patch/
  package.json
  server/
    server.js    HTTP server: static files, API, uploads, media streaming, share pages, admin API
    auth.js      passwords (scrypt), sessions, TOTP 2FA, backup & recovery codes, rate limits
    actions.js   every member and staff action, with validation and permission checks
    view.js      what each person is allowed to see
    db.js        SQLite storage
    seed.js      demo content (npm run dev only)
    cli.js       owner tools: create-admin, set-role, reset-password, reset-2fa
  public/
    index.html, app.js, styles.css, shared.js   the site
    admin/index.html, admin/admin.js            the admin panel
  data/          created at runtime: patch.db + uploads/ (git-ignored)
```

## Limits to know

- **One server process.** All community data is held in memory and saved to SQLite after each change. That is fine for thousands of members; a bigger community would need pagination and a database table per collection.
- **Uploads go to local disk** in `data/uploads`. On a host with temporary storage (some free tiers), mount a persistent disk or switch to S3 or R2 storage.
