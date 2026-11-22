# Architecture

Inkwell is a static single-page app with no build step. All the logic runs in the browser, and the only backend is Supabase (Postgres + Auth). This document explains how the pieces fit together.

## Files

```
index.html              App shell: auth screen, sidebar, editor, dialogs. Strict CSP.
css/styles.css          Design tokens (light/dark), layout, components
js/config.js            SUPABASE_URL and SUPABASE_ANON_KEY (empty = Demo mode only)
js/vendor.js            Pinned CDN imports: supabase-js 2.45.4, marked 12.0.2, DOMPurify 3.2.7
js/app.js               Boot, demo ↔ cloud switching, note list, editor, shortcuts
js/auth.js              Supabase client, sign-in / sign-up / magic link / reset, redirect handling
js/sync.js              Syncer: the autosave engine
js/store/index.js       The storage interface (contract shared by both stores)
js/store/localStore.js  Demo store: localStorage, with an in-memory fallback
js/store/supabaseStore.js  Cloud store: Postgres via supabase-js (PostgREST)
js/store/errors.js      Error types with a `retryable` flag
js/markdown.js          marked → DOMPurify → DocumentFragment
js/io.js                Export (JSON, Markdown) and import (JSON)
js/toast.js, js/util.js Toast notifications and small helpers
supabase/schema.sql     Table, index, trigger, RLS policies, grants
```

## The two modes

```
                ┌──────────── app.js (UI) ────────────┐
                │  in-memory notes, list, editor       │
                └──────────────┬──────────────────────┘
                               │ changes
                         ┌─────▼─────┐
                         │  Syncer   │  debounce · one request per note · retry
                         └─────┬─────┘
                               │ NoteStore API
              ┌────────────────┴────────────────┐
      ┌───────▼────────┐                ┌───────▼─────────┐
      │  localStore    │                │  supabaseStore  │
      │  (Demo mode)   │                │  (signed in)    │
      └───────┬────────┘                └───────┬─────────┘
              │                                 │ HTTPS + user JWT
        localStorage                   Supabase Postgres (RLS)
```

Both stores implement the same interface (`list`, `get`, `create`, `update`, `delete`, `subscribe`, `refresh`), so the UI and the Syncer never need to know where notes are stored. Which store is used depends on whether Supabase is configured and whether the user is signed in or chose **Try without an account**.

## How a keystroke gets saved

1. **Optimistic update.** The editor updates the in-memory note straight away, so the UI never waits for the network.
2. **Debounce.** The Syncer waits for a short pause in typing. During continuous typing it still saves at least every 5 seconds.
3. **One request per note.** Each note has at most one save in flight. Edits made while a save is running are queued and sent next, so saves can never arrive out of order.
4. **Merge the response.** When the server responds, it only overwrites fields that have no newer local edits, so text you typed during the request is never replaced.
5. **Retry.** Network errors are retried with exponential backoff, and the status shows *Offline — retrying*. Errors that won't succeed on retry, like validation or permission errors, are shown to the user.

Creates are idempotent: the client generates the UUID and sends it as an upsert, so retrying after a lost response doesn't create a duplicate.

## Never losing edits

- **Outbox.** Changes not yet confirmed by the server are also written to a `localStorage` outbox, one per account. If the tab closes, crashes or the session expires, they're replayed the next time that account signs in.
- **Multiple tabs.** Outbox entries are tagged by tab, and open tabs hold a short claim, so two tabs never replay or overwrite each other's work.
- **Conflicts.** Each outbox entry records the server version it started from. If the note was changed elsewhere in the meantime, the app keeps both versions by saving yours as a *(conflicted copy)*.
- **Deleted elsewhere.** If an update finds the note gone (deleted on another device), the note is recreated from the local copy.

Live edits between devices otherwise resolve as **last write wins per field**. The server trigger stamps `updated_at`, which drives sorting. The app refreshes when the tab regains focus or the network comes back, so Supabase Realtime isn't needed.

## Authentication

`js/auth.js` creates the Supabase client and handles:

- email + password sign-up (including the "check your email to confirm" step) and sign-in
- magic-link sign-in
- password reset: the request, then the "set a new password" dialog after the email link
- the redirect back from email links (`emailRedirectTo` is the current page URL)
- session changes via `onAuthStateChange`. On sign-out or an account switch, the UI is locked (`inert`) while it tears down, so nothing is written to the wrong account.

## Security model

See [SECURITY.md](../SECURITY.md) for the full explanation. In short:

- **Row Level Security** in Postgres is the only access control. Every policy checks `auth.uid() = user_id`.
- `user_id` defaults to `auth.uid()`, and a trigger makes it and `created_at` read-only once a note exists.
- Signed-out (`anon`) requests have no permissions on the table at all.
- Markdown is sanitized with DOMPurify, and a Content-Security-Policy only lets scripts load from this site and jsDelivr.

## Database schema

```sql
notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null default '',        -- ≤ 500 chars
  content     text not null default '',        -- ≤ 200,000 chars
  tags        text[] not null default '{}',    -- ≤ 20 tags
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()  -- set by trigger on every update
)
index notes_user_updated_idx on (user_id, updated_at desc)
```

The full script, with policies and grants, is in [`supabase/schema.sql`](../supabase/schema.sql).

## Design decisions

- **No framework, no build step.** The app is small enough that vanilla ES modules keep it fast and dependency-light, and any static host can serve it as-is.
- **Pinned CDN versions.** The dependencies in `js/vendor.js` use exact versions, so a library update can't change the app unexpectedly.
- **Storage interface first.** Demo mode and cloud mode share every line of UI and sync code. Adding another backend would only mean writing a new store.
