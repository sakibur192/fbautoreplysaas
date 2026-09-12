# Deploying on Coolify — no Dockerfile, no env vars

This assumes Coolify is already installed on your VPS. If not: SSH in and run
the one-line installer from https://coolify.io/docs/installation, then open
the Coolify dashboard it gives you a URL for.

Coolify builds this with **Nixpacks** (its default builder) — it just sees
`package.json`, runs `npm install`, and starts the app with `npm start`.
There's no Dockerfile to maintain. The only extra file is `nixpacks.toml`,
which tells Nixpacks to install a handful of system libraries Chromium
needs for WhatsApp — everything else is edited directly in `config.js`,
same as your other projects.

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

Commit and push this to your repo. Any time you need to change one of these
later, edit `config.js` again and push — that's the deploy mechanism here,
there's no separate secrets store to update.

## 3. Create the app
**+ New Resource → Application → (your Git provider) → select this repo.**
Coolify should auto-detect it as a Node.js app via Nixpacks — no build pack
selection needed. Set the port to `3000` (matches `config.js: PORT`).

## 4. Add a persistent volume for WhatsApp sessions — don't skip this
Without it, **every redeploy logs every tenant's WhatsApp out**, forcing them
all to re-scan their QR code. In the app's **Storages** tab, add a volume
with mount path `/app/wwebjs_sessions` (Nixpacks apps run from `/app`).

## 5. Set your domain
In the app's **Domains** tab, add your domain (e.g. `app.yourdomain.com`).
Coolify provisions HTTPS via Let's Encrypt automatically once your domain's
DNS A record points at the VPS's IP.

## 6. Deploy
Hit **Deploy**. Watch the build log — the `nixpacks.toml` packages install
during the setup phase, then `npm install`, then it starts.

## 7. After it's live
- Visit `https://yourdomain.com/superadmin`, confirm you can log in with
  what you put in `config.js`.
- Visit `https://yourdomain.com/` and try a signup on the landing page.
- In your Meta App (developers.facebook.com), set the webhook callback URL
  to `https://yourdomain.com/webhook` with the same verify token you put in
  `FB_WEBHOOK_VERIFY_TOKEN`.

## Things specific to this app worth knowing
- **Run exactly one instance.** Don't turn on multiple replicas for this
  app — each tenant's WhatsApp QR session is tied to one running
  container's live Puppeteer process; more than one instance would fight
  over the same sessions.
- **Chromium needs real RAM.** Each connected WhatsApp tenant is its own
  headless Chromium process (~150-300MB). If replies fail or the app gets
  killed for memory once a few tenants connect, that's the first thing to
  check — bump the VPS/container memory, or point some tenants at the
  Official Cloud API method instead (no Chromium at all for those).
- **I couldn't test this exact build path end-to-end** — this sandbox has
  no Coolify/Nixpacks and no access to Debian's package mirrors, so I
  can't confirm the `nixpacks.toml` package list is complete for every
  Nixpacks base image version. It's the same library list Chromium itself
  documents as required, and matches what the manual-VPS setup in the main
  README installs via `apt`. Still, treat your first deploy as a real test:
  watch the build log, and confirm a WhatsApp QR code actually renders and
  a test message gets a reply before pointing real tenants at it. If the
  build succeeds but WhatsApp still won't launch, the error in the app log
  will usually name the specific missing `.so` library — tell me that and
  I'll add it to the list.
