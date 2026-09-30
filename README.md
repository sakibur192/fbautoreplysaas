# AI Auto-Reply — SaaS Edition

Multi-tenant SaaS: customers sign up on your landing page, get a free
trial, connect their own Facebook Page (Messenger + Instagram DMs) and
WhatsApp number, pick a plan (e.g. "5,000 replies / 2,000 BDT per month"),
and pay by bKash to keep it running. You manage everyone — including AI
credentials, which are yours alone now — from one super admin panel.

**Deploying on Coolify?** See [`DEPLOY_COOLIFY.md`](./DEPLOY_COOLIFY.md) instead of the manual VPS steps below — no Dockerfile or env vars needed, Coolify auto-builds this with Nixpacks and you edit `config.js` directly, same as the manual setup.

## Three separate panels
- **`/`** — public landing page: pricing, "Start free trial" signup form
- **`/admin`** — each tenant's own panel (login with the email/password they signed up with): dashboard summary + plan usage, settings (Facebook/Instagram/WhatsApp connections and reply behavior), products, orders, conversations, billing + plan switching
- **`/superadmin`** — your panel (login from `config.js`): platform AI credentials, real **$ cost dashboard**, per-tenant AI key overrides, plan management, approve/reject bKash payments, suspend accounts, extend a tenant's time manually, view any tenant's usage/settings summary, and **log directly into any tenant's admin panel** for setup help — click "Log in as" next to their name, and "Exit to Super Admin" from the banner that appears in their panel to return

## How billing works (manual bKash, plan-based)
1. Tenant signs up → gets a free trial automatically (length set in `/superadmin`, `default_trial_days`) with **unlimited replies** until they pick a plan.
2. In their **Billing** tab, they pick a plan from the cards you've defined (e.g. "Starter — 5,000 replies — ৳2,000 / 1 month", "Growth — 20,000 replies — ৳10,000 / 6 months") — switching plans is instant and self-service, no approval needed for the switch itself.
3. They see your bKash number (`config.js: BKASH_RECEIVE_NUMBER`) and the plan's price, send the money manually, and submit the Transaction ID in that tab.
4. You see it under **Pending payments** in `/superadmin`. Click **Approve**, and their subscription extends by **that plan's own duration** (30/90/180/365 days, or any custom number you set when creating the plan) from whichever is later — today, or their current paid-through date (so early renewals, and payment while still in trial, stack correctly) — **and their reply-usage counter resets for a fresh cycle.**
5. If trial + subscription both lapse (or you hit **Suspend**), their bot stops auto-replying immediately — checked on every single incoming message, not just at login. Their admin panel itself stays reachable so they can still pay and get reactivated without contacting you.
6. **Separately**, if a tenant hits their plan's reply limit before their next renewal, the AI stops being called (no wasted API cost) and customers get a distinct limit-reached message instead — independent of whether their subscription itself is still active.

Nothing here talks to bKash's API — it's a manual queue. If you outgrow manual approval, you already have working bKash/Nagad merchant-API code in your MFS gateway project that could plug into the payments table here to auto-approve instead of you clicking a button.

## One-time setup

### 1. Server prerequisites (VPS)
```bash
sudo apt update
sudo apt install -y nodejs npm postgresql
```
```bash
sudo -u postgres psql -c "CREATE DATABASE fb_wa_bot;"
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
```
(No headless-browser system packages needed — everything here talks to Meta's official APIs, nothing runs a local Chrome/Puppeteer instance.)

### 2. Configure `config.js`
Set: `DB` credentials, `SESSION_SECRET`, `SUPERADMIN_USERNAME`/`SUPERADMIN_PASSWORD`,
`FB_WEBHOOK_VERIFY_TOKEN`, `BKASH_RECEIVE_NUMBER`, `PRICE_BDT`, `TRIAL_DAYS`.

### 3. Install and run
```bash
npm install
node server.js
```
For production:
```bash
npm install -g pm2
pm2 start server.js --name fb-wa-saas
pm2 save && pm2 startup
```
Put this behind Nginx + HTTPS (Let's Encrypt) — required for the Facebook webhook, and for tenants' passwords/tokens to travel encrypted.

### 4. One Meta App serves every tenant's Page, Instagram account, **and** WhatsApp number
You only create **one** Meta App, ever:
1. developers.facebook.com → Create App → "Business" → add the **Messenger** product (this also covers Instagram DMs once a tenant's IG professional account is linked to their Page), and add the **WhatsApp** product too.
2. Under the app's Webhooks, set callback URL `https://yourdomain.com/webhook`, verify token = your `FB_WEBHOOK_VERIFY_TOKEN`. Subscribe to `messages` for the Page, Instagram, and WhatsApp Business Account fields — one URL and one token cover all three, Meta tells them apart by the `object` field in the payload (`page`, `instagram`, `whatsapp_business_account`).
3. Each tenant does their own setup in **their own Settings tab** and never touches your Meta App:
   - **Facebook:** one-click **Connect Facebook Page** (OAuth) — see below; manual Page ID/token entry still available as a fallback.
   - **Instagram:** no separate connect step — DMs ride on the same Page connection and token as Facebook Messenger (the Page's linked Instagram professional account is required). Just flip the toggle in Settings once Facebook is connected.
   - **WhatsApp:** one-click **Connect WhatsApp** (Embedded Signup, official Cloud API) — see below; manual Phone Number ID/token entry still available as a fallback. There is no QR/unofficial option — it was removed to eliminate ban risk and the per-tenant browser-session overhead that came with it.

## Platform AI, trial defaults, and manual extensions
Three things live in the super admin panel now, not per-tenant:
- **Universal AI key** — set your OpenAI or Gemini key/model once in `/superadmin` → Platform AI. Every tenant's replies use it automatically unless a tenant-specific override is set (see below).
- **Default trial length** — change how many free days *new* signups get, without touching `config.js` or redeploying.
- **Extend by X days** — a per-tenant control in the Tenants table for manually granting extra time (comps, goodwill, fixing a payment mix-up) — separate from the bKash approval flow, stacks on top of whatever time they already have left.

### Per-tenant AI key override
Occasionally a specific tenant needs their own dedicated key (their own OpenAI/Gemini billing, a different model, isolation from your shared quota). Click **AI Key** next to any tenant in `/superadmin` → Tenants to set one: pick a provider, paste their key, optionally a specific model, and **Test** it before saving. Leave it on "Use universal platform key" (the default) and that tenant just uses your shared key like everyone else. This is entirely super-admin-controlled — tenants never see or set this themselves, and switching it back to universal at any time is one click.

## Bot disclosure
Meta's Messenger/WhatsApp policy requires disclosing an automated chat experience at the start of a conversation, and again after a significant gap. This is on by default (toggle + editable message in each tenant's Settings tab) — it's automatically prepended to the AI's first reply in a thread, and again if a customer goes quiet for 24+ hours before messaging again. Off by itself does nothing to fix compliance if a tenant turns it off in a region where disclosure is legally required — that's on them, same as any other business tool.

## When the AI genuinely can't reply
If an AI call fails for any reason — no key configured anywhere, an invalid key, a rate limit, a provider outage — the customer still gets a real reply instead of silence: the tenant's **fallback message** (Settings tab, editable, defaults to *"Sorry for the delay — I've passed this along to our team and someone will get back to you shortly!"*). It's sent through the same channel the customer messaged on, logged in the conversation so the tenant can see it happened, and tagged separately from AI replies so it doesn't skew the Dashboard's reply-count stats.

Note: `db.getSettings()` always merges in sensible defaults for any setting a tenant's row doesn't have yet — this matters because the list of settings has grown over time, so a tenant created before a given field existed (e.g. `fallback_message`) would otherwise get `undefined` for it instead of the default, which broke the fallback reply itself in an early version of this feature. Fixed now, but worth knowing if you ever add a new per-tenant setting: always add it to `DEFAULT_SETTINGS` in `db.js` rather than assuming existing tenants will have it.

## Dashboard tab
The first thing a tenant sees when they log in: total AI replies sent, replies sent today, conversation counts split by Facebook/Instagram/WhatsApp, and order counts by status (awaiting payment / paid / cancelled). All computed live from the same `messages`, `conversations`, and `orders` tables — nothing separate to keep in sync.

## AI credentials, plans, and real $ cost tracking
This changed from earlier versions: **tenants never set an AI key.** AI credentials (OpenAI or Gemini) live in the super admin panel's **Platform AI** card as the universal default, with an optional per-tenant override (above). Every tenant's replies use whichever one resolves for them automatically and transparently.

Tenants subscribe to a **plan** you define — e.g. "Starter: 5,000 replies / 2,000 BDT / 1 month" or "Yearly: 100,000 replies / 18,000 BDT / 1 year." Manage plans from `/superadmin` → **Plans**, and every part of a plan is editable there, any time — including on existing plans:
- **Name**, **reply limit** for the billing cycle, **price in BDT**, and **duration** — pick 1 month / 3 months / 6 months / 1 year from the dropdown, or "Custom" for any exact number of days
- Editing a plan's price/limit/duration only changes what happens *going forward* (new signups and the next renewal for existing subscribers) — it never silently changes a tenant's already-approved, already-paid-for cycle
- Deactivate a plan without breaking tenants already on it (soft-delete — existing subscribers keep it until they switch)

There is no seeded/default plan list — a brand-new deployment starts with **zero plans**, by design, so pricing is entirely yours to set. Create at least one plan from `/superadmin` → Plans before pointing real tenants at the Billing tab, or their only option there will be to stay on the free trial.

Tenants pick and switch plans themselves from their **Billing** tab — no approval needed for the switch itself; they still submit a bKash Trx ID and you still approve it the same manual way as before, which extends their subscription **and resets their reply-usage counter** for a fresh cycle.

**What happens at the limit:** once a tenant hits their plan's reply count for the current cycle, the AI is never called again that cycle — no wasted API cost — and the customer gets a distinct **limit-reached message** (editable, separate from the "AI is down" fallback message) instead. A tenant with no plan assigned yet (e.g. still in trial) has unlimited replies.

**Real $ cost, separate from reply-count plans.** A reply-limit plan tells you how many replies a tenant is *allowed*; it doesn't tell you what their AI usage actually *costs you* in dollars — a 5,000-reply Starter tenant asking short questions and a 5,000-reply tenant pasting long product descriptions cost very different amounts. The `/superadmin` **AI Cost** card shows exactly that, computed from each provider's own token counts on every single reply (not estimated from text length):
- Today / this month / all-time totals, platform-wide
- A per-tenant breakdown table, so you can see at a glance which accounts are actually expensive to serve — useful for deciding who needs a higher-priced plan, or whether your plan pricing has enough margin
- Rates come from `pricing.js` — a $-per-million-token table by provider/model. Providers change prices occasionally; if the numbers here look stale, update that file's rates (this only affects the report, never what you're actually billed by OpenAI/Google).

## Connecting Facebook, Instagram & WhatsApp — one-click for tenants, real setup for you

Tenants no longer copy-paste Page IDs or tokens. They click **Connect Facebook Page** / **Connect WhatsApp**, authorize through Meta's own popup, and pick their Page or number — Instagram then just needs a toggle, since it rides on the same Page connection. Manual entry still exists as a fallback link on both, in case a tenant already has their own separate Meta App setup, or your OAuth isn't configured yet.

**This shifts the setup burden to you, once, instead of to every tenant, every time.** Two different levels of Meta-side work:

### Facebook Page Connect + Instagram (moderate setup)
1. In your Meta App (developers.facebook.com) → **Settings → Basic**, copy the **App ID** and **App Secret** into `config.js`: `FB_APP_ID`, `FB_APP_SECRET`.
2. Set `PUBLIC_BASE_URL` in `config.js` to your real HTTPS domain (e.g. `https://app.yourdomain.com`), no trailing slash.
3. Add **Facebook Login** as a product in your Meta App, and add `{PUBLIC_BASE_URL}/api/connect/facebook/callback` to its allowed **Valid OAuth Redirect URIs**.
4. **Submit for App Review** requesting `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `instagram_basic`, and `instagram_manage_messages` with Advanced Access. Until this is approved, the Connect button only works for Facebook accounts that have a role on your Meta App (you, testers) — not real external tenants. This is Meta's requirement, not something this code can skip.

### WhatsApp Connect / Embedded Signup (heavier setup)
1. Your **Meta Business must be verified** (Business Settings → Security Center) — this is a prerequisite Meta enforces before Embedded Signup is available at all.
2. In your Meta App → **WhatsApp → Embedded Signup**, create a **Configuration** and copy its ID into `config.js`: `WA_EMBEDDED_SIGNUP_CONFIG_ID`.
3. Create a **System User** in Business Settings with `whatsapp_business_management` + `whatsapp_business_messaging` permissions, generate a permanent token, and paste it into the super admin panel's Platform AI card: `platform_wa_system_user_token`. This one token sends messages on behalf of **every** tenant's WhatsApp number connected via Embedded Signup — that's the standard "Tech Provider" pattern, and why tenants never see or enter a WhatsApp token themselves.
4. Same App Review requirement as Facebook applies here too, for the WhatsApp permissions.

**Honest caveat:** I built and tested this against mocked Meta API responses — the logic (token exchange, page listing, the popup handshake) follows Meta's documented flow correctly, but I have no way to run it against Meta's real OAuth servers from here. Treat your first real click-through as the actual test, on all three buttons, before pointing tenants at them.

## What each tenant can customize themselves
Every one of these lives in that tenant's own Settings tab — you never set these on their behalf (the one exception, an AI key override, is super-admin-only — see above):
- **System prompt, order/payment automation, fallback message, limit-reached message** — either one shared set for all channels, or switch to "separate" and give Facebook, Instagram, and WhatsApp their own system prompt / order-automation toggle / fallback message each (blank = falls back to the shared value)
- **Products**: their own catalog, fed to the AI as its only source of truth — see "Product catalog" below for the full e-commerce-style field set
- **Business website**: paste their site's URL and click **Scan Website with AI** — see "Website scan" below
- **Facebook**: one-click Connect (OAuth) — see above; manual Page ID/token entry still available as a fallback
- **Instagram**: a toggle, once Facebook is connected
- **WhatsApp**: one-click Connect (Embedded Signup, official Cloud API) — manual Phone Number ID/token entry still available as a fallback

### Product catalog — full e-commerce-style fields
Beyond name, price, and description, each product can carry: an **image URL** (shown as a thumbnail in the Products table and available for the AI to reference), a **category**, a **SKU**, and a **stock quantity**. All of it is fed to the AI as part of the product catalog it's given for every reply, so it can answer "do you have this in stock?" or "what category is this in?" accurately, and none of it is required — a tenant can still add a bare-bones product with just a name and price if that's all they need.

### Website scan — AI reads a tenant's site and remembers it
In Settings, a tenant pastes their business website's URL and clicks **Scan Website with AI**. The server fetches that page, strips it down to plain text, and asks the AI to write a short business-profile summary (what they sell, policies, hours — whatever the page actually says). That summary is saved as an editable setting (`website_info`) and shown right there in a textbox the tenant can rewrite by hand — the scan is a one-time convenience fill-in, not a live/recurring re-fetch, and it's injected into the system prompt for every AI reply from then on, so the bot can answer general "what do you do / what's your return policy" questions even if the tenant never wrote a system prompt covering that themselves. Re-running the scan (e.g. after the tenant updates their real website) overwrites the saved summary; editing the textbox directly and saving does not require re-scanning at all.

## Signup, login, and the tenant Profile tab
Signing up on the landing page now collects **name, phone number, WhatsApp number, email, and password** (password requires at least 8 characters) — not just a business name and email like earlier versions. All of it is validated server-side (valid email format, all required fields present) before the account is created.

Once logged in, a tenant's **Profile** tab lets them edit their own details at any time:
- **Name, phone, WhatsApp number** — editable, required
- **Physical address** — a free-text field, explicitly **optional** (leaving it blank is fine and doesn't block saving)
- **Password** — changed separately, in its own card, and requires typing the current password correctly first

Email itself isn't editable from the Profile tab by design — it's the tenant's login identity, and changing it there would risk account-recovery confusion; if a tenant genuinely needs their email changed, that's a super-admin/database-level change for now.

## Order confirmation & payment screenshots
When "Let the AI confirm orders and record payments automatically" is on (shared, or per-channel if using separate mode), the AI has two actions available mid-conversation:
- **`confirm_order`** — called once the AI has agreed the exact items, quantities, and total price with the customer. Creates an order (status `confirmed`) visible in the tenant's **Orders** tab.
- **`record_payment`** — called once a transaction ID and amount are known. This works two ways: the customer can type it, or send a photo of their bKash/Nagad confirmation screen — the AI reads the image directly (vision) and extracts the ID/amount itself. Matches to the most recent open order in that conversation, or creates a bare order record if none existed yet so the payment isn't lost.

Tenants can also override any order's status manually from the Orders tab (confirmed / paid / cancelled) — useful if the AI got something wrong or a customer paid a different way.

**Image handling note:** incoming images are downloaded, base64-encoded, and sent straight to the AI model for that single reply — they're not saved to disk or the database. The conversation log stores a `[Image]` placeholder so you can see one arrived, but not the image itself. If you want a permanent image archive later, that's an addition, not something built in now.

## The public website is now a CMS — all controlled from `/superadmin` → Website
The landing page at `/` is no longer static HTML you'd have to edit and redeploy to change. Everything below is editable live from the super admin panel's **Website** section and takes effect immediately, no redeploy:

- **Branding** — upload a logo and favicon (shown in `/superadmin` → Website → Branding; uploads go through a `multer`-backed endpoint and are served from `/uploads`), and pick a primary/accent color for the whole site (CSS custom properties, applied at runtime).
- **Meta Pixel** — paste a Pixel ID and the landing page (and blog pages) inject Facebook's standard pixel snippet automatically, including the `<noscript>` fallback. Leave it blank to disable tracking entirely.
- **Hero section & "how it works" steps** — headline, subheadline, both button labels, the steps section headline, and each of the three step titles/descriptions are all plain text fields you edit directly — no code.
- **Hero slider** — an optional rotating image banner above the headline. Add as many slides as you want (image + optional headline/subheadline + sort order); with zero or one slide, no slider chrome (arrows/dots) renders at all.
- **Blog** — full CRUD (title, cover image, excerpt, content, publish/unpublish). Published posts appear at `/blog` (list) and `/blog/<slug>` (detail), and the 3 most recent show in a "From the blog" section on the homepage. Slugs are generated from the title automatically and de-duplicated if two posts would collide.
- **Testimonials / reviews** — name, role, avatar, quote, star rating (1–5). Shown on the homepage once at least one exists; the whole section stays hidden otherwise.

All of it is served from one public, no-auth endpoint (`GET /api/site-content`) that the landing page (and `/blog`, `/blog/<slug>`) fetch on load — so the static HTML files ship with sensible built-in defaults (including this project's own default logo/colors) and layer the super admin's edits on top at runtime. If that fetch ever fails, the page still renders with its defaults rather than breaking.

## Discount coupons
Super admin → Website → **Discount coupons**: create a code (percent-off or flat-BDT-off), an optional max-uses cap, and an optional expiry date. In their Billing tab, a tenant can enter a code before submitting a bKash payment — it's validated live and the amount they're told to pay updates to the discounted price.

**Be clear-eyed about what this does and doesn't enforce.** Billing here is still the same manual bKash queue as everywhere else in this app — there's no payment gateway actually charging a card. A coupon automates the *discount math* (computing the reduced price, capping usage, expiring on schedule) and *records* which coupon was used on the payment row you see in Pending payments — it does not verify that the tenant actually sent the discounted amount. Keep glancing at the coupon/discount note shown next to each pending payment when you approve, the same way you already eyeball the transaction ID and amount.

## Super admin visibility into any tenant
Beyond impersonation ("Log in as", full access to their panel), the Tenants table has a **View** button showing a read-only summary without switching session: their plan and usage, reply mode, which channels are enabled, whether they're on the universal AI key or a tenant-specific override, product/order counts, total replies sent, and their AI cost this month / all-time — a quick way to answer a support question without fully logging in as them.

**On Gemini specifically:** Google's `@google/genai` SDK is explicitly marked experimental by Google and changes fairly often (model names, function-calling response shape). If Gemini replies suddenly stop working after an update, check https://googleapis.github.io/js-genai/ for anything that shifted before assuming the code is wrong.


## Security hardening
Baseline protections, on by default:
- **Security headers** via `helmet` on every response (content-type sniffing protection, etc.). Its content-security-policy is disabled deliberately — every panel here is a single self-contained HTML file with inline `<script>` tags, and a strict CSP would break them all; if you later split scripts into separate files, revisit this.
- **Rate limiting on auth endpoints** — registration, tenant login, and super admin login are each capped (20 requests / 15 minutes per IP) to slow down brute-force and credential-stuffing attempts, via `express-rate-limit`.
- **Input validation** on registration (required fields, valid email format, password length) and on profile updates.
- **Passwords are always bcrypt-hashed**, never stored or logged in plain text (unchanged from earlier versions, worth restating here).
- **`app.set('trust proxy', 1)`** — needed so rate limiting and cookies behave correctly behind Coolify's reverse proxy (otherwise every request looks like it comes from the same internal IP).

**One flag you'll want to flip once you're live on HTTPS:** `config.js` has `FORCE_SECURE_COOKIES: false` by default. This controls whether the login session cookie is marked `Secure` (browser only ever sends it back over HTTPS). It's **off by default on purpose** — turning it on before your real domain + HTTPS is fully working (Coolify's Let's Encrypt certificate issued, site actually loads on `https://`, and the proxy is correctly forwarding `X-Forwarded-Proto`) silently breaks **every single login**, with no error message anywhere — the cookie just never gets set, and every request looks logged-out. Once you've confirmed `https://yourdomain.com` works end-to-end, flip this to `true` for the extra protection. Sessions already default to `httpOnly: true` and `sameSite: 'lax'` either way, which covers the most common session-hijacking and CSRF-adjacent risks on their own, so leaving this `false` during initial rollout is not a serious exposure — just don't forget to revisit it.

Not built in, worth knowing: no CSRF tokens (mitigated in part by `sameSite: 'lax'` cookies, which block the most common cross-site POST forgery pattern), no 2FA on any login, no per-IP account lockout beyond the rate limiter above. None of this is unusual for a bKash-manual-approval SaaS at this stage, but they're the honest next things to add as the tenant count grows.

## Staying safe — what this does, and its real limits

You asked that no customer's Facebook Page or WhatsApp account gets banned using this. Being straight with you: I can build in the practices that reduce risk, but I can't guarantee zero bans — that call ultimately belongs to Meta's own automated risk systems, and it depends on each account's history and how it's used beyond this tool.

What's built in:
- **Reply-only, never cold outreach.** The bot only ever responds to a message someone sent in; it never messages someone first. This is the single biggest factor in the platform's spam detection.
- **Human-like pacing.** Before every reply, the bot waits a randomized 1.5–4.5 second delay (`config.js: REPLY_DELAY_MIN_MS/MAX_MS`) instead of replying instantly like an obvious bot.
- **Everything runs through Meta's real, official APIs** — Messenger, Instagram Messaging, and the WhatsApp Cloud API. There is no unofficial/QR-based automation anywhere in this app anymore (an earlier version offered a `whatsapp-web.js` QR option; it was removed specifically because it carried real ban risk and ran against WhatsApp's ToS). Replying to inbound messages this way is exactly what Meta's platforms are built for, so this carries essentially the ban risk of any legitimate, compliant integration — not zero, but not elevated by how this tool operates.
- **No per-tenant browser sessions.** Since everything is API-based, there's no headless Chrome instance per tenant to keep alive, crash, or get flagged — this also means the app scales the same way regardless of tenant count, just API calls.

Things worth adding as you grow, not yet built:
- Per-tenant reply-rate caps (e.g. max N replies/minute) to smooth out bursts
- Usage-based ("pay as you go") billing on top of the AI Cost data now being tracked, as an alternative or supplement to flat reply-limit plans

## What's in each file
- `config.js` — your one-time deploy config (DB, super admin login, billing terms, webhook token, pacing, `FORCE_SECURE_COOKIES`)
- `db.js` — all Postgres access, multi-tenant schema (tenants, plans, payments, settings, platform settings, conversations, messages, products, orders, AI usage), raw SQL, and the `MIGRATIONS` list that safely adds new columns to an existing live database on startup
- `pricing.js` — $-per-million-token rate table by provider/model, used to compute real $ cost from token counts
- `meta-webhook.js` — single webhook for all tenants, routes each incoming message (text or image) to the right tenant by Facebook Page ID or WhatsApp phone number ID, for Facebook Messenger, Instagram DMs, and WhatsApp Cloud API
- `meta-oauth.js` — "Connect Facebook Page" OAuth flow (covers Instagram too) and WhatsApp Embedded Signup callback, so tenants never handle raw tokens
- `media.js` — downloads incoming images (Facebook/Instagram attachment URLs, WhatsApp Cloud API's two-step media fetch) and base64-encodes them for the vision-capable AI call
- `website-scan.js` — fetches a tenant's website, strips it to plain text, and asks the AI to summarize it into a saved, editable business profile (see "Website scan" above)
- `ai.js` — OpenAI or Gemini reply generation per tenant (resolves universal vs. tenant-override credentials, model, prompt, website info, products, conversation history), including order/payment tool-calling, image understanding, and cost logging
- `pacing.js` — the human-like delay helper shared across channels
- `server.js` — Express app: security headers/rate limiting, tenant auth/register/login/profile, billing, super admin, all API routes
- `public/landing/index.html` — the buy/signup page (name, phone, WhatsApp, email, password); now a CMS-driven page that pulls its logo/colors/hero/slider/testimonials/blog preview live from `/api/site-content`
- `public/landing/blog.html`, `public/landing/blog-post.html` — the public blog list and post-detail pages
- `public/landing/assets/logo.png` — the default Baybex AI logo/favicon shipped with the project (replaceable from `/superadmin` → Website → Branding)
- `public/admin/index.html` — tenant's own panel (dashboard, settings, website scan, products, orders, conversations, billing with coupon entry, profile)
- `public/superadmin/index.html` — your panel (plans with duration, Website CMS — branding/pixel/hero/slider/blog/testimonials/coupons, tenants, payments, AI cost)
