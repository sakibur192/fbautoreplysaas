# Deploying on Coolify — no Dockerfile, no env vars

This assumes Coolify is already installed on your VPS. If not: SSH in and run
the one-line installer from https://coolify.io/docs/installation, then open
the Coolify dashboard it gives you a URL for.

Coolify builds this with **Nixpacks** (its default builder) — it just sees
`package.json`, runs `npm install`, and starts the app with `npm start`.
There's no Dockerfile to maintain, and (since everything here talks to
Meta's official APIs, not a local browser) no extra system packages needed
either — everything is edited directly in `config.js`, same as your other
projects.

## 0. Push this project to a Git repo
Use a **private** repo — `config.js` will hold your real super admin
password and other secrets once you edit it, and there's no `.env` here to
keep those out of the codebase.

## 1. Create the database
In Coolify: **+ New Resource → Database → PostgreSQL**. Deploy it, then open
it and copy the connection details (host, port, user, password, database
name) — Coolify shows these as separate fields as well as a combined URL.
You want the separate fields.

## 2. Edit `config.js` with your real values, then commit
Before deploying, edit `config.js` directly:
- `SESSION_SECRET` — a long random string
- `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` — your login
- `DB` — the host/port/user/password/database from step 1
- `FB_WEBHOOK_VERIFY_TOKEN` — any string you pick, reused in Meta's App settings later
- `PRICE_BDT`, `TRIAL_DAYS`, `SUBSCRIPTION_DAYS`, `BKASH_RECEIVE_NUMBER`, `BKASH_TYPE` — your billing terms
  (per-plan pricing and duration — 1/3/6/12 months or custom — are set later from `/superadmin` → Plans, not here; these `config.js` values are just fallback/defaults)
- `FORCE_SECURE_COOKIES` — **leave this `false` for now.** Only flip it to
  `true` after step 5-6 below confirm your real domain is live on `https://`
  end-to-end. Turning it on too early silently breaks every login (see the
  README's "Security hardening" section for why).

Commit and push this to your repo. Any time you need to change one of these
later, edit `config.js` again and push — that's the deploy mechanism here,
there's no separate secrets store to update.

## 3. Create the app
**+ New Resource → Application → (your Git provider) → select this repo.**
Coolify should auto-detect it as a Node.js app via Nixpacks — no build pack
selection needed (make sure the **Build Pack** dropdown says **Nixpacks**,
not "Static" — a static/nginx build pack will fail here since this is a
Node server, not a pre-built static site).

## 4. Let Coolify manage the port
Leave the app's port setting on whatever Coolify assigns/injects — `config.js`
reads `process.env.PORT` (falling back to 3000 only when that's unset, e.g.
running locally outside Coolify), so you don't need to hardcode a port here.

## 5. Set your domain
In the app's **Domains** tab, add your domain (e.g. `app.yourdomain.com`).
Coolify provisions HTTPS via Let's Encrypt automatically once your domain's
DNS A record points at the VPS's IP.

## 6. Deploy
Hit **Deploy** and watch the build log — `npm install`, then it starts.

## 7. After it's live
- Visit `https://yourdomain.com/superadmin`, confirm you can log in with
  what you put in `config.js`, then set your **Platform AI** key (OpenAI or
  Gemini) — nothing will reply to anyone until this is set.
- Still in `/superadmin`, create at least one **Plan** (Plans tab) — a fresh
  deploy starts with zero plans on purpose, so pricing/duration is entirely
  yours to define before tenants can subscribe to anything.
- Now that `https://yourdomain.com` is confirmed live with a valid
  certificate, go back to `config.js`, flip `FORCE_SECURE_COOKIES` to
  `true`, commit, and redeploy — this is the safe order to do it in.
- Visit `https://yourdomain.com/` and try a signup on the landing page.
- In your Meta App (developers.facebook.com), set the webhook callback URL
  to `https://yourdomain.com/webhook` with the same verify token you put in
  `FB_WEBHOOK_VERIFY_TOKEN`, and subscribe to `messages` on the Page,
  Instagram, and WhatsApp Business Account webhook fields.

## Things specific to this app worth knowing
- **Multiple instances are fine.** Nothing here holds in-process state tied
  to a single running container (there's no browser session to keep alive
  per tenant) — everything lives in Postgres, so you can scale replicas if
  you ever need to.
- **No persistent volume needed.** An earlier version of this app used an
  unofficial WhatsApp QR method that required a volume for browser session
  files; that method has been removed entirely (Facebook, Instagram, and
  WhatsApp are all official Meta API integrations now), so there's nothing
  session-related to persist across redeploys.
- **I couldn't test this exact build path end-to-end** — this sandbox has
  no live Coolify instance to deploy against. The logic matches Coolify's
  documented Nixpacks/Node.js flow, but treat your first deploy as the real
  test: watch the build log, and confirm the landing page loads and a test
  webhook round-trip works before pointing real tenants at it.
