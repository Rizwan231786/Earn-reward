# Patch — a community platform for builders

Patch is a place where builders showcase projects, get help, and grow their own communities, so a project shared today doesn't vanish from the feed by tomorrow.

Open `patch/index.html` in a browser. There's no build step and nothing to install. Data is stored in your browser (localStorage) and comes pre-filled with demo users and content. Use **Log in → Continue as…** to switch between demo accounts, or sign up as a new user. **Reset demo data** sits at the bottom of the sidebar.

## Features

| # | Feature | Where |
|---|---------|-------|
| 1 | **Feed**: projects, discussions, questions and updates, sorted by For you, Latest or Top, filtered by post type, or limited to "my communities & following" | `#/` |
| 2 | **Create Post**: Discussion, Project Showcase, Question/Help (can be marked solved), Progress Update (% complete plus a target date), Poll, Tool Request. Posts can have images and tags, and can be liked, commented on, saved and shared | `#/new` |
| 3 | **Communities**: each has its own rules, members and posts. Join or leave, or create your own once your account is **3 days old** (anti-spam rule) | `#/communities`, `#/c/<slug>` |
| 4 | **Tools & Offers**: AI tools, dev tools, GitHub repos and limited-time deals by category, with direct links and upvotes | `#/tools` |
| 5 | **Profiles & following**: each creator's posts, projects and trophy room. Follow, save, notifications, public or private profile | `#/u/<handle>`, `#/notifications`, `#/saved` |
| 6 | **Messages**: direct messages for collaboration, beyond the comments | `#/messages` |
| 7 | **Project Vault**: a permanent page for each project with description, status, tech stack, demo and repo links, "looking for", and a development timeline of milestones. Closed-source projects are welcome | `#/vault`, `#/vault/<id>` |
| 8 | **Patch Championship**: monthly categories (AI Agent Builder, Game Developer, Website Builder, Automation Expert, UI/UX Builder, Tool Creator). Eligible builders submit a Vault project. Each person gets one vote per category and can't vote for their own entry. The top entry becomes that month's Verified Champion. Every win stays in the builder's **trophy room**, and the builder with the most trophies in a category over a full year is that year's **Champion of the Year** 👑 | `#/championship` |
| + | **Opportunities**: builders who are open to freelance work and collaborations, with their projects and trophies, so clients, creators and brands can find them | `#/builders` |

## Files

- `index.html`: the app shell (top bar, sidebar, modal)
- `styles.css`: theme tokens (light and dark), layout, components
- `app.js`: data model, seed data, views, router and actions

## Taking it to production

All reads and writes go through the `db` object in `app.js` (`load`/`save`). Replacing that object with API calls to a real backend adds real accounts, a shared database for posts and votes, and a scheduled job that closes each month's Championship. The **Crown champions** button stands in for that job in the demo.
