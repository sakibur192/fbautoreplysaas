# AI Auto-Reply — SaaS Edition

Multi-tenant SaaS: customers sign up on your landing page, get a 3-day free
trial, connect their own Facebook Page and WhatsApp number, and pay you
1,000 BDT/month by bKash to keep it running. You manage everyone from one
super admin panel.

**Deploying on Coolify?** See [`DEPLOY_COOLIFY.md`](./DEPLOY_COOLIFY.md) instead of the manual VPS steps below — no Dockerfile or env vars needed, Coolify auto-builds this with Nixpacks and you edit `config.js` directly, same as the manual setup.

## Three separate panels
- **`/`** — public landing page: pricing, "Start free trial" signup form
- **`/admin`** — each tenant's own panel (login with the email/password they signed up with): dashboard summary, settings, WhatsApp QR, products, orders, conversations, billing
- **`/superadmin`** — your panel (login from `config.js`): see every tenant, approve/reject bKash payments, suspend accounts, and **log directly into any tenant's admin panel** for setup help or support — click "Log in as" next to their name, and "Exit to Super Admin" from the banner that appears in their panel to return

## How billing works (manual bKash, as you asked)
1. Tenant signs up → gets a 3-day free trial automatically (`config.js: TRIAL_DAYS`).
2. In their **Billing** tab, they see your bKash number (`config.js: BKASH_RECEIVE_NUMBER`) and the amount to send (`PRICE_BDT`).
3. They send the money manually and submit the Transaction ID in that tab.
4. You see it under **Pending payments** in `/superadmin`. Click **Approve**, and their subscription extends 30 days from whichever is later — today, or their current paid-through date (so early renewals stack correctly instead of wasting days).
5. If trial + subscription both lapse (or you hit **Suspend**), their bot stops auto-replying immediately — checked on every single incoming message, not just at login. Their admin panel itself stays reachable so they can still pay and get reactivated without contacting you.

Nothing here talks to bKash's API — it's a manual queue. If you outgrow manual approval, you already have working bKash/Nagad merchant-API code in your MFS gateway project that could plug into the payments table here to auto-approve instead of you clicking a button.

## One-time setup

### 1. Server prerequisites (VPS)
```bash
sudo apt update
sudo apt install -y nodejs npm postgresql
sudo apt install -y ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 \
  libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 \
  libgbm1 libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
  libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
  libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
  libxss1 libxtst6 lsb-release wget xdg-utils
```
```bash
sudo -u postgres psql -c "CREATE DATABASE fb_wa_bot;"
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
```

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

### 4. One Meta App serves every tenant's Page **and** WhatsApp number
You only create **one** Meta App, ever:
1. developers.facebook.com → Create App → "Business" → add **Messenger** product, and add the **WhatsApp** product too (if you want to offer the official option).
2. Under the app's Webhooks, set callback URL `https://yourdomain.com/webhook`, verify token = your `FB_WEBHOOK_VERIFY_TOKEN`. Subscribe to `messages` for both the Page and the WhatsApp Business Account fields — one URL and one token cover both, Meta tells them apart by the `object` field in the payload.
3. Each tenant does their own setup in **their own Settings tab** and never touches your Meta App:
   - **Facebook:** generates their own Page Access Token (Messenger → Settings → their Page) and enters it + their Page ID.
   - **WhatsApp — QR method:** just clicks Connect and scans a code. Nothing to set up on Meta's side.
   - **WhatsApp — Official Cloud API method:** creates their own WhatsApp Business Platform setup under their own Meta Business Account, gets a Phone Number ID + permanent Access Token, and enters both. This needs Meta business verification (can take a day or two) but has **no ban risk** and **no per-tenant Chrome instance** — replies within 24h of a customer's message are free, so this costs them nothing for normal use.

Tenants choose their WhatsApp method per-account in the **WhatsApp** tab. Both can't run at once for the same tenant — whichever mode they pick is the only one that replies.

## Platform AI fallback, trial defaults, and manual extensions
Three things live in the super admin panel now, not per-tenant:
- **Fallback AI key** — set your own OpenAI key/model once in `/superadmin`. Any tenant who hasn't set their own AI key uses yours automatically and transparently — they never see an error, replies just work. A tenant's own key always takes priority the moment they set one.
- **Default trial length** — change how many free days *new* signups get, without touching `config.js` or redeploying.
- **Extend by X days** — a per-tenant control in the Tenants table for manually granting extra time (comps, goodwill, fixing a payment mix-up) — separate from the bKash approval flow, stacks on top of whatever time they already have left.

## When the AI genuinely can't reply
If an AI call fails for any reason — no key configured anywhere, an invalid key, a rate limit, a provider outage — the customer still gets a real reply instead of silence: the tenant's **fallback message** (Settings tab, editable, defaults to *"Sorry for the delay — I've passed this along to our team and someone will get back to you shortly!"*). It's sent through the same channel the customer messaged on, logged in the conversation so the tenant can see it happened, and tagged separately from AI replies so it doesn't skew the Dashboard's reply-count stats.

Note: `db.getSettings()` always merges in sensible defaults for any setting a tenant's row doesn't have yet — this matters because the list of settings has grown over time, so a tenant created before a given field existed (e.g. `fallback_message`) would otherwise get `undefined` for it instead of the default, which broke the fallback reply itself in an early version of this feature. Fixed now, but worth knowing if you ever add a new per-tenant setting: always add it to `DEFAULT_SETTINGS` in `db.js` rather than assuming existing tenants will have it.

## Dashboard tab
The first thing a tenant sees when they log in: total AI replies sent, replies sent today, conversation counts split by Facebook/WhatsApp, and order counts by status (awaiting payment / paid / cancelled). All computed live from the same `messages`, `conversations`, and `orders` tables — nothing separate to keep in sync.

## What each tenant can customize themselves
Every one of these lives in that tenant's own Settings tab — you never set these on their behalf:
- **AI provider**: OpenAI or Google Gemini, with their own API key and model name for either
- **System prompt**: their shop's voice/instructions
- **Products**: their own catalog, fed to the AI as its only source of truth
- **Order & payment automation**: on/off toggle — when on, the AI can confirm orders and record payments as tool calls during the conversation (see below)
- **Facebook**: their own Page ID + Page Access Token
- **WhatsApp**: QR method or Official Cloud API, with their own credentials for whichever

## Order confirmation & payment screenshots
When "Let the AI confirm orders and record payments automatically" is on, the AI has two actions available mid-conversation:
- **`confirm_order`** — called once the AI has agreed the exact items, quantities, and total price with the customer. Creates an order (status `confirmed`) visible in the tenant's **Orders** tab.
- **`record_payment`** — called once a transaction ID and amount are known. This works two ways: the customer can type it, or send a photo of their bKash/Nagad confirmation screen — the AI reads the image directly (vision) and extracts the ID/amount itself. Matches to the most recent open order in that conversation, or creates a bare order record if none existed yet so the payment isn't lost.

Tenants can also override any order's status manually from the Orders tab (confirmed / paid / cancelled) — useful if the AI got something wrong or a customer paid a different way.

**Image handling note:** incoming images are downloaded, base64-encoded, and sent straight to the AI model for that single reply — they're not saved to disk or the database. The conversation log stores a `[Image]` placeholder so you can see one arrived, but not the image itself. If you want a permanent image archive later, that's an addition, not something built in now.

**On Gemini specifically:** Google's `@google/genai` SDK is explicitly marked experimental by Google and changes fairly often (model names, function-calling response shape). If Gemini replies suddenly stop working after an update, check https://googleapis.github.io/js-genai/ for anything that shifted before assuming the code is wrong.


## Staying safe — what this does, and its real limits

You asked that no customer's Facebook Page or WhatsApp account gets banned using this. Being straight with you: I can build in the practices that reduce risk, but I can't guarantee zero bans — that call ultimately belongs to Meta's and WhatsApp's own automated risk systems, and it depends on each account's history and how it's used beyond this tool.

What's built in:
- **Reply-only, never cold outreach.** The bot only ever responds to a message someone sent in; it never messages someone first. This is the single biggest factor in both platforms' spam detection.
- **Human-like pacing.** Before every reply, WhatsApp shows a typing indicator and both platforms wait a randomized 1.5–4.5 second delay (`config.js: REPLY_DELAY_MIN_MS/MAX_MS`) instead of replying instantly like an obvious bot.
- **Facebook uses the real, official Graph API** — replying to inbound messages this way is exactly what Meta's platform is built for, so this side carries essentially the ban risk of any legitimate Page.
- **WhatsApp now has two options, and tenants choose:**
  - *QR method* (`whatsapp-web.js`) — quick, but unofficial and against WhatsApp's ToS. Real ban risk exists industry-wide for this approach, especially on high-volume or business-critical numbers. Tell tenants this plainly before they connect.
  - *Official Cloud API method* — Meta's own hosted WhatsApp Business Platform. No ban risk, no persistent browser session, and replies within the 24h customer-service window are free. The tradeoff is setup friction: the tenant needs their own Meta Business verification, which isn't instant.

Things worth adding as you grow, not yet built:
- Per-tenant reply-rate caps (e.g. max N replies/minute) to smooth out bursts
- A queue instead of instant Puppeteer calls, so one busy tenant can't slow down another's replies
- If a customer needs guaranteed safety at scale, the honest answer is WhatsApp's **official Cloud API** instead of `whatsapp-web.js` — that requires Meta Business verification per number but carries none of the unofficial-automation risk. Worth offering as a "Pro" tier later.

## Resource note: WhatsApp scales per-customer, not for free — but only for QR-mode tenants
Every tenant on the **QR method** gets their own always-on headless Chrome instance (roughly 150–300MB RAM each), created lazily the first time they click **Connect**. A handful of active QR-mode tenants is fine on a modest VPS; past ~15–20 concurrent, budget more RAM or start steering tenants toward the **Official Cloud API** method instead, which uses no browser at all and scales the same as the Facebook integration — just API calls.

## What's in each file
- `config.js` — your one-time deploy config (DB, super admin login, billing terms, webhook token, pacing)
- `db.js` — all Postgres access, multi-tenant schema (tenants, payments, settings, conversations, messages, products, orders), raw SQL
- `whatsapp.js` — one `whatsapp-web.js` Client per tenant, created on demand, gated by live subscription status on every message
- `meta-webhook.js` — single webhook for all tenants, routes each incoming message (text or image) to the right tenant by Facebook Page ID or WhatsApp phone number ID
- `media.js` — downloads incoming images (Facebook attachment URLs, WhatsApp Cloud API's two-step media fetch) and base64-encodes them for the vision-capable AI call
- `ai.js` — OpenAI or Gemini reply generation per tenant (their own key, model, prompt, products, conversation history), including order/payment tool-calling and image understanding
- `pacing.js` — the human-like delay helper shared by both platforms
- `server.js` — Express app: tenant auth/register/login, billing, super admin, all API routes
- `public/landing/index.html` — the buy/signup page
- `public/admin/index.html` — tenant's own panel
- `public/superadmin/index.html` — your panel
