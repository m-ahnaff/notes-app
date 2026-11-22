# Inkwell — markdown notes with cloud sync

A fast, keyboard-friendly notes app with autosave, tags, search and markdown preview.
Notes sync across devices through **Supabase** (Postgres + Auth + Row Level Security),
or stay in your browser in **Demo mode**. Plain HTML, CSS and vanilla ES modules, with no build step.

**Live demo:** https://m-ahnaff.github.io/notes-app/

> **Screenshot:** _placeholder. Add `docs/screenshot.png` and replace this line with_ `![Inkwell](docs/screenshot.png)`.

## Features

- **Accounts:** email + password sign-up and sign-in, magic-link sign-in, password reset, sign-out.
  Handles the "check your email to confirm" step, keeps you signed in, and handles the redirect back from email links.
- **Demo mode:** works without an account (or before Supabase is configured). Notes stay in `localStorage`,
  and a badge says so. When you later sign in, the app offers to copy your demo notes into your account.
- **Autosave:** debounced saves with a live *Saving… / Saved / Offline — retrying* status. Saves for each note are
  serialized, retried with backoff, and never overwrite text you typed while a save was in flight.
- **Organise:** pin notes, add/remove tags, filter by tag, full-text search over title, content and tags
  (`#tag` in the search box matches tags), sort by last edited, created or title.
- **Markdown:** edit/preview toggle (GFM: tables, task lists, code), sanitized with DOMPurify. Word count and reading time.
- **Delete with undo**, **export** all notes as JSON or one combined Markdown file, **import** JSON.
- **Keyboard shortcuts:** <kbd>Ctrl/⌘ K</kbd> search, <kbd>Ctrl/⌘ N</kbd> or <kbd>Alt N</kbd> new note,
  <kbd>Ctrl/⌘ E</kbd> edit/preview, <kbd>Ctrl/⌘ S</kbd> save now, <kbd>↑ ↓</kbd> move through the list,
  <kbd>Esc</kbd> back/clear, <kbd>?</kbd> help.
- **Responsive and accessible:** sidebar + editor on desktop, list → editor navigation on phones (from 360px up),
  light/dark themes that follow the system (or a manual choice), visible focus states, labelled controls, and live regions for status and toasts.

## Architecture

```
index.html            App shell (auth screen, sidebar, editor, dialogs); strict CSP
css/styles.css        Design tokens (light/dark), layout, components
js/config.js          SUPABASE_URL / SUPABASE_ANON_KEY (empty = demo only)
js/vendor.js          Pinned CDN URLs (supabase-js 2.45.4, marked 12.0.2, DOMPurify 3.2.7)
js/app.js             Boot, demo ↔ cloud mode switching, list/editor UI, shortcuts
js/auth.js            Supabase client, auth screen, redirect handling, password reset dialog
js/sync.js            Syncer: debounced, serialized, retrying writes for each note
js/store/index.js     Storage interface (list/get/create/update/delete/subscribe/refresh)
js/store/localStore.js     Demo store (localStorage, memory fallback)
js/store/supabaseStore.js  Cloud store (PostgREST via supabase-js)
js/markdown.js        marked → DOMPurify → DocumentFragment (never raw innerHTML)
js/io.js              JSON / Markdown export, JSON import
supabase/schema.sql   Table, trigger, index, RLS policies
```

**Data flow.** The UI changes its in-memory copy right away (optimistic), then hands the change to the `Syncer`.
The Syncer allows at most one request in flight for each note. Edits made during a request are queued and sent next,
so saves can't arrive out of order. When a response comes back, it only updates fields that have no newer local edits.
Creates are idempotent upserts by a client-generated UUID, so a retry after a lost response is safe. If an update finds
the row gone (deleted on another device), the note is recreated from the local copy, so nothing you typed is lost.
Conflicts between devices resolve as last write wins: each save sends only the fields you changed, and whichever
device saves a field last wins. The server's trigger stamps `updated_at`, and that value drives sorting and refreshes.
Unsynced changes are mirrored to `localStorage` (an outbox for each account), so they survive a closed tab, a crash or an
expired session, and they are replayed the next time that account signs in. The app refreshes when the tab regains
focus or the network comes back. Realtime is not required.

**Security.** All access control is in Postgres RLS: every policy checks `auth.uid() = user_id`. `user_id` defaults to
`auth.uid()`, and a trigger stops it (and `created_at`) from changing. The `anon` role has no grants on the table.
Markdown is rendered with marked and sanitized with DOMPurify (no `style`, forms, iframes or SVG; links get
`rel=noopener`). A Content-Security-Policy limits scripts to this site and jsDelivr.

## Supabase setup

1. **Create a project** at [supabase.com](https://supabase.com) → *New project*.
2. **Create the schema:** open *SQL Editor* → *New query*, paste all of [`supabase/schema.sql`](supabase/schema.sql), and click *Run*.
   It is safe to run again.
3. **Copy your keys:** go to *Project Settings → API* (or *Data API*) and copy the **Project URL** and the **anon / publishable** key
   into `js/config.js`:
   ```js
   export const SUPABASE_URL = 'https://YOUR-REF.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJ...';   // anon / publishable key, NOT service_role
   ```
   The anon key is meant to be public. Row Level Security is what protects the data.
   Newer projects show a `sb_publishable_…` key. If sign-in requests fail with it, use the legacy **anon** JWT key
   from the *Legacy API keys* tab instead.
4. **Set the auth URLs:** go to *Authentication → URL Configuration*:
   - **Site URL:** `https://m-ahnaff.github.io/notes-app/`
   - **Redirect URLs:** add `https://m-ahnaff.github.io/notes-app/` and `http://localhost:8743/`
     (you can also add `https://m-ahnaff.github.io/notes-app/**` to allow `index.html`).
5. *(Optional)* Under *Authentication → Providers → Email*, decide whether to keep **Confirm email** on (it is on by default
   and the app handles it). Supabase's built-in email sender has strict rate limits. For real use, set up custom SMTP
   under *Authentication → Emails*.
6. Commit and push. The GitHub Actions workflow deploys the repository root to Pages.

> If your project uses a custom domain instead of `*.supabase.co`, add it to `connect-src` in the CSP `<meta>` in `index.html`.

## Run locally

No build step is needed. Serve the folder over HTTP (ES modules don't load from `file://`):

```sh
python3 -m http.server 8743
# open http://localhost:8743/
```

With `js/config.js` empty, the app starts in Demo mode.

## Deploy (GitHub Pages)

`.github/workflows/pages.yml` publishes the repository root on every push to `main`.
In the repo, go to *Settings → Pages → Build and deployment* and set *Source* to **GitHub Actions**.
`.nojekyll` makes Pages serve the files as they are. All paths are relative, so the site works under `/notes-app/`.

## License

[MIT](LICENSE) © m-ahnaff
