# Security

## Is the Supabase key in `js/config.js` a secret?

No. `SUPABASE_ANON_KEY` holds Supabase's **publishable** key, which is designed to ship in browser code. It only identifies the project. On its own it grants nothing: signed-out requests to the `notes` table are refused with *permission denied*.

What actually protects the data is **Postgres Row Level Security (RLS)**, enforced inside the database for every request:

- Every policy (select, insert, update, delete) requires `auth.uid() = user_id`. Each request carries the signed-in user's JWT, and Postgres checks it on every row.
- `user_id` defaults to the signed-in user, and a trigger stops it from being changed, so a note can't be moved into another account.
- The `anon` (signed-out) role has no permissions on the table at all.

The **secret** key (`sb_secret_…`, or the legacy `service_role` key) bypasses RLS. It is not in this repository and must never be added to frontend code.

## Browser-side protections

- **Markdown sanitizing:** rendered notes go through DOMPurify. Scripts, event handlers, `javascript:` links, styles, forms, iframes and SVG are removed, and links get `rel="noopener noreferrer"`.
- **Content-Security-Policy:** scripts may only load from this site and `cdn.jsdelivr.net`, and network requests may only go to this site and `*.supabase.co`.
- **Pinned dependencies:** third-party libraries load at exact versions (see `js/vendor.js`).
- **No raw HTML from user input:** titles and tags are rendered as text, never as HTML.

## Reporting a vulnerability

Please open a [GitHub issue](https://github.com/m-ahnaff/notes-app/issues) without exploit details and ask for a private contact, or use GitHub's **Report a vulnerability** button on the Security tab if it's enabled. I'll respond as soon as I can.
