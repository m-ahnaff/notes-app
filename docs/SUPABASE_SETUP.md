# Supabase setup

Follow this guide to run Inkwell against **your own** Supabase project, for example if you fork the repo. It takes about 5 minutes on Supabase's free plan.

## 1. Create a project

1. Sign in at [supabase.com](https://supabase.com) (GitHub sign-in works).
2. Click **New project**, choose an organization, and give it a name (e.g. `notes-app`).
3. Generate a strong **database password** and save it in a password manager. The app doesn't need it, but you'll need it to connect to the database directly.
4. Pick a region close to your users and click **Create new project**. It's ready in about a minute.

## 2. Create the database table and security rules

1. Open **SQL Editor → New query**.
2. Paste the whole of [`supabase/schema.sql`](../supabase/schema.sql) and click **Run**.
   Supabase may warn about "destructive operations". The script only drops and recreates its *own* policies and trigger so it can safely be run again. On a new project there's nothing to lose.
3. You should see *Success. No rows returned.*

The script creates:

- the `notes` table with size limits on title, content and tags
- an index for listing a user's notes by last edit
- a trigger that sets `updated_at` and stops `user_id` / `created_at` from being changed
- **Row Level Security** policies, so users can only select, insert, update and delete their own notes
- permissions: signed-in users get table access, signed-out requests get none

### Check it worked (optional)

Run this in the SQL Editor:

```sql
select policyname, cmd from pg_policies where tablename = 'notes';
```

You should see four policies: `notes_select_own`, `notes_insert_own`, `notes_update_own` and `notes_delete_own`.

## 3. Connect the app

1. Open **Project Settings → API Keys**.
2. Copy the **Project URL** (also shown on the project home page) and the **Publishable key** (`sb_publishable_…`).
3. Put them in `js/config.js`:

```js
export const SUPABASE_URL = 'https://YOUR-PROJECT-REF.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_...';
```

> **Never** use the **secret** key (`sb_secret_…`) or the legacy `service_role` key here. Those bypass Row Level Security and must never reach a browser. The publishable key is designed to be public (see [SECURITY.md](../SECURITY.md)).

Older projects show a legacy **anon** key (a long `eyJ…` JWT) instead. That works too.

## 4. Set the login URLs

Confirmation, magic-link and password-reset emails send people back to your site, and Supabase only allows addresses you list.

Go to **Authentication → URL Configuration**:

| Setting | Value |
|---|---|
| **Site URL** | your deployed URL, e.g. `https://your-app.vercel.app/` |
| **Redirect URLs** | `https://your-app.vercel.app/**` and `http://localhost:8743/**` |

The `**` wildcard allows any path on that site. Add the localhost entry so email links also work while testing locally.

## 5. Email settings (optional)

- **Confirm email** is on by default (*Authentication → Sign In / Providers → Email*). New users must click the link in their email before signing in, and the app guides them through this.
- Supabase's built-in email sender is for testing and only allows a few emails per hour. For real use, set up your own SMTP provider under **Authentication → Emails → SMTP Settings**.

## 6. Try it

Serve the app locally (`python3 -m http.server 8743`), open http://localhost:8743, create an account, confirm it from your email, and add a note. You can see it in **Table Editor → notes**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| App only offers Demo mode | `js/config.js` values are empty or the page is cached. Hard-refresh. |
| Email link opens the wrong site or errors | Add that exact site to **Redirect URLs** (with `/**`). |
| "permission denied for table notes" | You're signed out, or `schema.sql` didn't run fully. Re-run it. |
| Confirmation email never arrives | Built-in email limit reached. Wait an hour or configure SMTP. |
| Requests blocked in the console (CSP) | You're using a custom Supabase domain. Add it to `connect-src` in the CSP `<meta>` in `index.html`. |
