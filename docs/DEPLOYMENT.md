# Deployment

Inkwell is a static site with no build step, so it can be hosted anywhere that serves files. The live version runs on **Vercel**: https://inkwell-m-ahnaff.vercel.app

## Vercel from GitHub (recommended)

Every push to `main` redeploys automatically, and pull requests get preview URLs.

1. Sign in at [vercel.com](https://vercel.com) with GitHub.
2. **Add New → Project**, then import this repository.
3. Settings:
   - **Framework preset:** Other
   - **Build command:** *(leave empty)*
   - **Output directory:** *(leave empty, the repo root)*
4. Click **Deploy**.

## Vercel CLI

```sh
npm install -g vercel
vercel login
vercel deploy --prod     # run in the repo root
```

The first run creates the Vercel project, and later runs redeploy it. `vercel git connect` links the project to this GitHub repo so pushes deploy automatically.

## What gets deployed

[`.vercelignore`](../.vercelignore) leaves out files the browser doesn't need: `README.md`, `LICENSE`, `SECURITY.md`, `docs/`, `supabase/` and `.github/`. Only `index.html`, `css/`, `js/` and `favicon.svg` are published.

## After deploying: update Supabase

Whenever the site gets a new address, add it in Supabase under **Authentication → URL Configuration**:

- **Site URL:** `https://your-domain/`
- **Redirect URLs:** `https://your-domain/**`

Otherwise confirmation, magic-link and password-reset emails can't redirect back to the site. See [SUPABASE_SETUP.md](SUPABASE_SETUP.md#4-set-the-login-urls).

## Custom domain

In Vercel, go to **Project → Settings → Domains**, add your domain and follow the DNS instructions. Then add the domain to the Supabase URL settings as above.

## Other static hosts

All asset paths are relative, so the app also works on GitHub Pages, Netlify, Cloudflare Pages or any web server, including under a sub-path like `/notes-app/`. Serve the repo root as-is. Note that `index.html` includes a Content-Security-Policy: if you load scripts from anywhere other than this site and `cdn.jsdelivr.net`, update the policy.
