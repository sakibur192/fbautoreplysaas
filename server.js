const path = require('path');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const multer = require('multer');

const config = require('./config');
const db = require('./db');
const metaWebhook = require('./meta-webhook');
const metaOauth = require('./meta-oauth');
const metaconfig = require('./metaconfig');
const ai = require('./ai');
const websiteScan = require('./website-scan');
const analytics = require('./analytics');

const app = express();
const server = http.createServer(app);

// Coolify (and most PaaS setups) terminate HTTPS at a reverse proxy in
// front of this app — without trust proxy, Express never sees the request
// as secure, so a "secure" session cookie would never actually get set.
app.set('trust proxy', 1);

// Security headers. CSP is left off deliberately: every panel here is a
// single self-contained HTML file with inline <script>/<style> (no build
// step), so a default CSP would break the whole app — the other headers
// (clickjacking protection, MIME sniffing, etc.) still apply.
app.use(helmet({ contentSecurityPolicy: false }));

// The webhook route needs the exact bytes Meta sent, because the signature
// is computed over them — so keep a copy of the raw body for /webhook only.
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    if (req.originalUrl && req.originalUrl.split('?')[0] === '/webhook') req.rawBody = buf;
  }
}));

// ---- Image uploads (logo, favicon, hero slides, blog covers, avatars) ----
// Super-admin-only (enforced per-route below). Stored on local disk under
// public/uploads and served statically — fine for a single-VPS Coolify
// deploy; if you ever move to multiple replicas/containers, this would
// need to move to shared/object storage instead, since local disk isn't
// shared between replicas.
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safeExt = path.extname(file.originalname).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10) || '.png';
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + safeExt);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Only image files are allowed'));
    cb(null, true);
  }
});
app.use('/uploads', express.static(uploadsDir));
app.use('/assets', express.static(path.join(__dirname, 'public', 'landing', 'assets')));

app.use(session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, sameSite: 'lax', secure: !!config.FORCE_SECURE_COOKIES, httpOnly: true }
}));

// Slows down brute-force guessing on the endpoints that check a password.
// Keyed by IP; generous enough that a real tenant mistyping their password
// a few times never gets blocked, but a scripted credential-stuffing run
// does.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' }
});

// Meta webhook — public, no session (Meta calls this directly). One
// endpoint handles Facebook Messenger, Instagram DMs, and WhatsApp Cloud
// API, since they all arrive through the same Meta App webhook mechanism.
app.use('/webhook', metaWebhook.router);
app.use('/api/connect', metaOauth.router);

// ================= Tenant auth =================
function requireTenant(req, res, next) {
  if (req.session && req.session.tenantId) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const { business_name, phone, whatsapp_number, email, password } = req.body;
    if (!business_name || !phone || !whatsapp_number || !email || !password) {
      return res.status(400).json({ error: 'Name, phone, WhatsApp number, email, and password are all required' });
    }
    const cleanEmail = String(email).toLowerCase().trim();
    if (!EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const existing = await db.getTenantByEmail(cleanEmail);
    if (existing) return res.status(400).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const platformSettings = await db.getPlatformSettings();
    const trialDays = parseInt(platformSettings.default_trial_days, 10) || config.TRIAL_DAYS;
    const tenant = await db.createTenant(
      business_name.trim(),
      String(phone).trim(),
      String(whatsapp_number).trim(),
      cleanEmail,
      passwordHash,
      trialDays
    );
    req.session.tenantId = tenant.id;
    res.json({ ok: true });
  } catch (err) {
    console.error('[register]', err.message);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const tenant = await db.getTenantByEmail((email || '').toLowerCase().trim());
  if (!tenant || !(await bcrypt.compare(password || '', tenant.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  req.session.tenantId = tenant.id;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Public, non-secret identifiers the frontend needs for Meta's JS SDK
// (Facebook App ID and an Embedded Signup Configuration ID are always
// meant to be used client-side — this is not the app secret).
app.get('/api/public-config', async (req, res) => {
  const mc = await metaconfig.getMetaConfig();
  res.json({
    fb_app_id: mc.appId || null,
    wa_embedded_signup_config_id: mc.waConfigId || null,
    graph_version: metaconfig.GRAPH_VERSION
  });
});

app.get('/api/session', async (req, res) => {
  if (!req.session || !req.session.tenantId) return res.json({ loggedIn: false });
  const tenant = await db.getTenantById(req.session.tenantId);
  if (!tenant) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    business_name: tenant.business_name,
    email: tenant.email,
    phone: tenant.phone,
    whatsapp_number: tenant.whatsapp_number,
    active: db.isTenantActive(tenant),
    suspended: tenant.suspended,
    trial_ends_at: tenant.trial_ends_at,
    subscription_ends_at: tenant.subscription_ends_at,
    impersonating: !!req.session.isSuperAdmin
  });
});

// ================= Public marketing site (read-only) =================
// Everything the landing page needs to render itself — branding, hero
// copy/slider, testimonials, and a blog summary — pulled from what's set
// in /superadmin → Website. No auth: this is the public site.
app.get('/api/site-content', async (req, res) => {
  const content = await db.getSiteContent();
  const heroSlides = await db.listHeroSlides(true);
  const testimonials = await db.listTestimonials(true);
  const posts = (await db.listBlogPosts(true)).slice(0, 3).map(p => ({
    title: p.title, slug: p.slug, excerpt: p.excerpt, cover_image_url: p.cover_image_url, created_at: p.created_at
  }));
  res.json({ ...content, hero_slides: heroSlides, testimonials, recent_posts: posts });
});
app.get('/api/testimonials', async (req, res) => {
  res.json(await db.listTestimonials(true));
});
app.get('/api/blog', async (req, res) => {
  const posts = (await db.listBlogPosts(true)).map(p => ({
    title: p.title, slug: p.slug, excerpt: p.excerpt, cover_image_url: p.cover_image_url, created_at: p.created_at
  }));
  res.json(posts);
});
app.get('/api/blog/:slug', async (req, res) => {
  const post = await db.getBlogPostBySlug(req.params.slug);
  if (!post || !post.published) return res.status(404).json({ error: 'Not found' });
  res.json(post);
});

// ================= Billing (tenant side) =================
app.get('/api/billing', requireTenant, async (req, res) => {
  const tenant = await db.getTenantById(req.session.tenantId);
  const payments = await db.listPaymentsForTenant(req.session.tenantId);
  const usage = await db.getReplyUsage(req.session.tenantId);
  res.json({
    active: db.isTenantActive(tenant),
    suspended: tenant.suspended,
    trial_ends_at: tenant.trial_ends_at,
    subscription_ends_at: tenant.subscription_ends_at,
    bkash_number: config.BKASH_RECEIVE_NUMBER,
    bkash_type: config.BKASH_TYPE,
    plan: usage.plan,
    usage: { used: usage.used, limit: usage.limit },
    payments
  });
});

// Checks a coupon against the tenant's current plan price without
// consuming it — used to show the discounted amount before they pay.
app.post('/api/billing/validate-coupon', requireTenant, async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Enter a coupon code' });
  const usage = await db.getReplyUsage(req.session.tenantId);
  const basePrice = usage.plan ? usage.plan.price_bdt : config.PRICE_BDT;
  const coupon = await db.getCouponByCode(code);
  if (!coupon) return res.status(404).json({ error: 'That coupon code was not found' });
  try {
    const { discount, finalPrice } = db.computeCouponDiscount(coupon, basePrice);
    res.json({ valid: true, base_price: basePrice, discount, final_price: finalPrice });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/billing/submit', requireTenant, async (req, res) => {
  const { trx_id, amount, coupon_code } = req.body;
  if (!trx_id) return res.status(400).json({ error: 'Transaction ID is required' });
  const tenant = await db.getTenantById(req.session.tenantId);
  const usage = await db.getReplyUsage(req.session.tenantId);
  const basePrice = usage.plan ? usage.plan.price_bdt : config.PRICE_BDT;
  let finalAmount = amount || String(basePrice);
  let discountAmount = null;
  let appliedCouponCode = null;
  if (coupon_code) {
    const coupon = await db.getCouponByCode(coupon_code);
    if (!coupon) return res.status(404).json({ error: 'That coupon code was not found' });
    try {
      const { discount, finalPrice } = db.computeCouponDiscount(coupon, basePrice);
      finalAmount = String(finalPrice);
      discountAmount = String(discount);
      appliedCouponCode = coupon.code;
      await db.incrementCouponUsage(coupon.id); // consumed at submission — see coupons table note on the manual-billing trust model
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  const payment = await db.submitPayment(req.session.tenantId, trx_id.trim(), finalAmount, appliedCouponCode, discountAmount);
  res.json(payment);
});

// ---- Plans (tenant-facing) ----
app.get('/api/plans', requireTenant, async (req, res) => {
  res.json(await db.listPlans(true));
});

app.post('/api/billing/change-plan', requireTenant, async (req, res) => {
  const plan = await db.getPlanById(req.body.plan_id);
  if (!plan || !plan.active) return res.status(400).json({ error: 'Plan not found' });
  await db.setTenantPlan(req.session.tenantId, plan.id);
  res.json({ ok: true, plan });
});

// ================= Dashboard =================
app.get('/api/dashboard', requireTenant, async (req, res) => {
  const stats = await db.getDashboardStats(req.session.tenantId);
  const usage = await db.getReplyUsage(req.session.tenantId);
  res.json({ ...stats, plan: usage.plan, usage: { used: usage.used, limit: usage.limit } });
});

// Chart data for the tenant dashboard: daily series, period totals with the
// previous period for comparison, busiest hours, best sellers, setup progress.
app.get('/api/analytics', requireTenant, async (req, res) => {
  try {
    res.json(await analytics.getTenantAnalytics(req.session.tenantId, req.query.days));
  } catch (err) {
    console.error('[analytics] tenant failed:', err);
    res.status(500).json({ error: 'Could not load your analytics.' });
  }
});

// ================= Settings =================
app.get('/api/settings', requireTenant, async (req, res) => {
  const settings = await db.getSettings(req.session.tenantId);
  res.json(settings);
});

app.post('/api/settings', requireTenant, async (req, res) => {
  // Most fields: skip if left blank (so an empty input doesn't wipe out a
  // saved value by accident). The channel-override fields are the
  // exception — an empty value there is meaningful ("use the shared
  // setting instead"), so those are allowed through even when blank.
  const allowedIfNonEmpty = [
    'system_prompt',
    'order_tools_enabled',
    'fallback_message',
    'limit_reached_message',
    'bot_disclosure_enabled',
    'bot_disclosure_message',
    'reply_mode',
    'fb_page_id',
    'fb_page_access_token',
    'fb_enabled',
    'ig_enabled',
    'whatsapp_enabled',
    'wa_cloud_phone_number_id',
    'wa_cloud_access_token',
    'website_url',
    'website_info'
  ];
  const allowedAlways = [
    'fb_system_prompt',
    'fb_order_tools_enabled',
    'fb_fallback_message',
    'ig_system_prompt',
    'ig_order_tools_enabled',
    'ig_fallback_message',
    'wa_system_prompt',
    'wa_order_tools_enabled',
    'wa_fallback_message'
  ];
  const update = {};
  for (const key of allowedIfNonEmpty) {
    if (req.body[key] !== undefined && req.body[key] !== '') update[key] = req.body[key];
  }
  for (const key of allowedAlways) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  await db.updateSettings(req.session.tenantId, update);
  res.json({ ok: true });
});

function maskKey(key) {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

// ================= Products =================
app.get('/api/products', requireTenant, async (req, res) => {
  res.json(await db.listProducts(req.session.tenantId));
});
app.post('/api/products', requireTenant, async (req, res) => {
  const { name, price, description, image_url, category, sku, stock_quantity } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const stockQty = stock_quantity === '' || stock_quantity === undefined || stock_quantity === null ? null : parseInt(stock_quantity, 10);
  res.json(await db.addProduct(req.session.tenantId, name, price, description, image_url, category, sku, stockQty));
});
app.put('/api/products/:id', requireTenant, async (req, res) => {
  const { name, price, description, image_url, category, sku, stock_quantity } = req.body;
  const stockQty = stock_quantity === '' || stock_quantity === undefined || stock_quantity === null ? null : parseInt(stock_quantity, 10);
  await db.updateProduct(req.session.tenantId, req.params.id, name, price, description, image_url, category, sku, stockQty);
  res.json({ ok: true });
});
app.delete('/api/products/:id', requireTenant, async (req, res) => {
  await db.deleteProduct(req.session.tenantId, req.params.id);
  res.json({ ok: true });
});

// ================= Orders =================
app.get('/api/orders', requireTenant, async (req, res) => {
  res.json(await db.listOrders(req.session.tenantId));
});
app.post('/api/orders/:id/status', requireTenant, async (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'paid', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  await db.updateOrderStatus(req.session.tenantId, req.params.id, status);
  res.json({ ok: true });
});

// ================= Conversations =================
app.get('/api/conversations', requireTenant, async (req, res) => {
  res.json(await db.listConversations(req.session.tenantId));
});
app.get('/api/conversations/:id/messages', requireTenant, async (req, res) => {
  res.json(await db.getAllMessages(req.session.tenantId, req.params.id));
});
app.post('/api/conversations/:id/toggle-ai', requireTenant, async (req, res) => {
  await db.setConversationAI(req.session.tenantId, req.params.id, req.body.enabled);
  res.json({ ok: true });
});

// ================= Profile (tenant side) =================
app.get('/api/profile', requireTenant, async (req, res) => {
  const tenant = await db.getTenantById(req.session.tenantId);
  res.json({
    business_name: tenant.business_name,
    email: tenant.email,
    phone: tenant.phone,
    whatsapp_number: tenant.whatsapp_number,
    address: tenant.address
  });
});

app.post('/api/profile', requireTenant, async (req, res) => {
  const { business_name, phone, whatsapp_number, address } = req.body;
  if (!business_name || !phone || !whatsapp_number) {
    return res.status(400).json({ error: 'Name, phone, and WhatsApp number are required' });
  }
  const tenant = await db.updateTenantProfile(req.session.tenantId, {
    business_name: String(business_name).trim(),
    phone: String(phone).trim(),
    whatsapp_number: String(whatsapp_number).trim(),
    address: address ? String(address).trim() : '' // optional, per the signup requirements
  });
  res.json({ ok: true, tenant: { business_name: tenant.business_name, phone: tenant.phone, whatsapp_number: tenant.whatsapp_number, address: tenant.address } });
});

app.post('/api/profile/change-password', requireTenant, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are both required' });
  }
  if (String(new_password).length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const tenant = await db.getTenantById(req.session.tenantId);
  if (!(await bcrypt.compare(current_password, tenant.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const newHash = await bcrypt.hash(new_password, 10);
  await db.updateTenantPassword(req.session.tenantId, newHash);
  res.json({ ok: true });
});

// ================= Website scan (AI-built business knowledge) =================
// Tenant pastes their website URL; we fetch it, strip it down to plain
// text, and ask the AI to write a short business-profile summary from it.
// The result is saved into the same editable `website_info` setting a
// tenant could otherwise type by hand — this is just a shortcut to fill it
// in, not a separate source of truth, so it's included in the AI's system
// prompt the same way the product catalog is (see ai.js).
app.post('/api/settings/scan-website', requireTenant, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'A website URL is required' });
  try {
    const info = await websiteScan.scanWebsite(req.session.tenantId, url);
    await db.updateSettings(req.session.tenantId, { website_url: url.trim(), website_info: info });
    res.json({ ok: true, website_info: info });
  } catch (err) {
    console.error('[scan-website]', err.message);
    res.status(500).json({ error: err.message || 'Could not read that website' });
  }
});

// ================= Super admin (you) =================
function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.isSuperAdmin) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

app.post('/api/superadmin/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  if (username === config.SUPERADMIN_USERNAME && password === config.SUPERADMIN_PASSWORD) {
    req.session.isSuperAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});
app.post('/api/superadmin/logout', (req, res) => {
  req.session.isSuperAdmin = false;
  res.json({ ok: true });
});
app.get('/api/superadmin/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.isSuperAdmin) });
});

// Platform-wide AI credentials + default trial length — set by you, this
// is now the ONLY place AI credentials live. Every tenant's replies use
// whichever provider/key/model is set here.
app.get('/api/superadmin/platform-settings', requireSuperAdmin, async (req, res) => {
  const settings = await db.getPlatformSettings();
  if (settings.platform_openai_api_key) {
    settings.platform_openai_api_key_masked = maskKey(settings.platform_openai_api_key);
  }
  if (settings.platform_gemini_api_key) {
    settings.platform_gemini_api_key_masked = maskKey(settings.platform_gemini_api_key);
  }
  if (settings.platform_wa_system_user_token) {
    settings.platform_wa_system_user_token_masked = maskKey(settings.platform_wa_system_user_token);
  }
  delete settings.platform_openai_api_key;
  delete settings.platform_gemini_api_key;
  delete settings.platform_wa_system_user_token;
  res.json(settings);
});

app.post('/api/superadmin/platform-settings', requireSuperAdmin, async (req, res) => {
  const allowed = [
    'platform_ai_provider',
    'platform_openai_api_key',
    'platform_openai_model',
    'platform_gemini_api_key',
    'platform_gemini_model',
    'platform_wa_system_user_token',
    'default_trial_days'
  ];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined && req.body[key] !== '') update[key] = req.body[key];
  }
  await db.updatePlatformSettings(update);
  res.json({ ok: true });
});

// Standalone AI connection test — the real provider error shows up here
// directly instead of only ever reaching server logs.
app.post('/api/superadmin/test-ai', requireSuperAdmin, async (req, res) => {
  try {
    const result = await ai.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Platform-wide real $ cost dashboard — computed from ai_usage, which is
// logged from the provider's own token counts on every reply.
app.get('/api/superadmin/analytics', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await analytics.getPlatformAnalytics(req.query.days));
  } catch (err) {
    console.error('[analytics] platform failed:', err);
    res.status(500).json({ error: 'Could not load platform analytics.' });
  }
});

app.get('/api/superadmin/costs', requireSuperAdmin, async (req, res) => {
  res.json(await db.getPlatformCostSummary());
});

// ---- Meta App setup (everything the tenants' Facebook/Instagram/WhatsApp
// connections depend on). Values live in platform_settings; config.js is
// only a fallback. Secrets are never sent back to the browser — only
// whether they're set and a masked preview.
function metaCheckVerifyToken(v) { return /^\S{8,100}$/.test(v); }

async function buildMetaSettingsView() {
  const mc = await metaconfig.getMetaConfig(true);
  const d = metaconfig.derived(mc);
  const platform = await db.getPlatformSettings();
  let manual = {};
  try { manual = JSON.parse(platform.meta_checklist_json || '{}') || {}; } catch (e) { manual = {}; }
  return {
    values: {
      public_base_url: mc.publicBaseUrl,
      app_id: mc.appId,
      verify_token: mc.verifyToken,
      wa_config_id: mc.waConfigId
    },
    app_secret_set: !!mc.appSecret,
    app_secret_masked: mc.appSecret ? maskKey(mc.appSecret) : '',
    wa_system_token_set: !!mc.waSystemToken,
    wa_system_token_masked: mc.waSystemToken ? maskKey(mc.waSystemToken) : '',
    sources: mc.sources,
    derived: d,
    https_ok: /^https:\/\//i.test(mc.publicBaseUrl),
    graph_version: metaconfig.GRAPH_VERSION,
    manual
  };
}

app.get('/api/superadmin/meta-settings', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await buildMetaSettingsView());
  } catch (err) {
    console.error('[meta-settings] load failed:', err);
    res.status(500).json({ error: 'Could not load Meta settings.' });
  }
});

app.post('/api/superadmin/meta-settings', requireSuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const update = {};
    const current = await metaconfig.getMetaConfig(true);
    const candidate = { ...current };

    if (b.public_base_url !== undefined) {
      const raw = String(b.public_base_url).trim();
      if (raw === '') {
        update.meta_public_base_url = '';
      } else {
        let u;
        try { u = new URL(raw); } catch (e) { return res.status(400).json({ error: 'Public URL is not a valid web address (example: https://baybexai.digital).' }); }
        const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
        if (u.protocol !== 'https:' && !(isLocal && u.protocol === 'http:')) {
          return res.status(400).json({ error: 'Public URL must start with https:// — Meta only talks to secure addresses.' });
        }
        update.meta_public_base_url = u.origin;
        candidate.publicBaseUrl = u.origin;
      }
    }
    if (b.app_id !== undefined) {
      const v = String(b.app_id).trim();
      if (v !== '' && !/^\d{6,20}$/.test(v)) return res.status(400).json({ error: 'App ID should be digits only (find it in Meta → Settings → Basic).' });
      update.meta_app_id = v;
      candidate.appId = v || (current.sources.app_id === 'config.js' ? current.appId : '');
    }
    if (b.clear_app_secret === true) {
      update.meta_app_secret = '';
      candidate.appSecret = '';
    } else if (b.app_secret !== undefined && String(b.app_secret).trim() !== '') {
      const v = String(b.app_secret).trim();
      if (!/^[A-Za-z0-9]{16,64}$/.test(v)) return res.status(400).json({ error: 'App Secret looks wrong — it is normally 32 letters/numbers with no spaces.' });
      update.meta_app_secret = v;
      candidate.appSecret = v;
    }
    if (b.verify_token !== undefined) {
      const v = String(b.verify_token).trim();
      if (v !== '' && !metaCheckVerifyToken(v)) return res.status(400).json({ error: 'Verify token must be 8–100 characters with no spaces.' });
      update.meta_webhook_verify_token = v;
    }
    if (b.wa_config_id !== undefined) {
      const v = String(b.wa_config_id).trim();
      if (v !== '' && !/^\d{5,25}$/.test(v)) return res.status(400).json({ error: 'Embedded Signup Configuration ID should be digits only.' });
      update.meta_wa_config_id = v;
    }
    if (b.wa_system_token !== undefined && String(b.wa_system_token).trim() !== '') {
      const v = String(b.wa_system_token).trim();
      if (!/^\S{20,600}$/.test(v)) return res.status(400).json({ error: 'WhatsApp system token looks wrong — it should be one long string with no spaces.' });
      update.platform_wa_system_user_token = v;
    }
    if (b.manual && typeof b.manual === 'object') {
      const platform = await db.getPlatformSettings();
      let saved = {};
      try { saved = JSON.parse(platform.meta_checklist_json || '{}') || {}; } catch (e) { saved = {}; }
      for (const k of ['redirect_uri', 'domains', 'business_verified', 'permissions', 'app_live']) {
        if (b.manual[k] !== undefined) saved[k] = !!b.manual[k];
      }
      update.meta_checklist_json = JSON.stringify(saved);
    }

    // If the App ID / Secret pair is changing, ask Meta whether it's real
    // BEFORE saving. A wrong secret would make every signed webhook fail
    // and silence every tenant's bot, so it's better refused up front. If
    // Meta simply can't be reached we save anyway and say so.
    let warning = null;
    const credsChanged = update.meta_app_id !== undefined || update.meta_app_secret !== undefined;
    if (credsChanged && candidate.appId && candidate.appSecret) {
      try {
        await metaconfig.fetchAppInfo(candidate);
      } catch (err) {
        const e = metaconfig.explainGraphError(err);
        if (e.kind === 'rejected') {
          return res.status(400).json({ error: 'Meta did not accept that App ID / App Secret pair: ' + e.message });
        }
        warning = e.message + ' The values were saved but could not be checked — use "Check with Meta" once your server has internet access.';
      }
    }

    if (Object.keys(update).length) await db.updatePlatformSettings(update);
    metaconfig.invalidate();
    const view = await buildMetaSettingsView();
    res.json({ ok: true, warning, settings: view });
  } catch (err) {
    console.error('[meta-settings] save failed:', err);
    res.status(500).json({ error: 'Could not save Meta settings.' });
  }
});

// Asks Meta directly what it knows: are the App ID/Secret real, and which
// webhook callbacks are registered for this app right now.
app.post('/api/superadmin/meta-verify', requireSuperAdmin, async (req, res) => {
  const mc = await metaconfig.getMetaConfig(true);
  const d = metaconfig.derived(mc);
  if (!mc.appId || !mc.appSecret) {
    return res.json({ ok: false, error: 'Save your App ID and App Secret first.' });
  }
  const out = { ok: true, app: null, subscriptions: [], expected_callback: d.webhook_url };
  try {
    out.app = await metaconfig.fetchAppInfo(mc);
  } catch (err) {
    const e = metaconfig.explainGraphError(err);
    return res.json({ ok: false, error: e.kind === 'network' ? e.message : 'Meta rejected the App ID / Secret: ' + e.message });
  }
  let subs = [];
  try {
    subs = await metaconfig.fetchSubscriptions(mc);
  } catch (err) {
    out.subscriptions_error = metaconfig.explainGraphError(err).message;
  }
  out.subscriptions = metaconfig.WEBHOOK_OBJECTS.map((w) => {
    const found = subs.find((s) => s.object === w.object);
    return {
      object: w.object,
      label: w.label,
      registered: !!found,
      callback_url: found ? found.callback_url : null,
      matches: !!found && found.callback_url === d.webhook_url,
      active: found ? found.active !== false : false
    };
  });
  res.json(out);
});

// One click: tell Meta where to send Messenger, Instagram and WhatsApp
// events. Meta immediately calls our GET /webhook with the verify token to
// prove we own the URL, so this only works once the settings are saved and
// the server is reachable at the public URL.
app.post('/api/superadmin/meta-register-webhooks', requireSuperAdmin, async (req, res) => {
  const mc = await metaconfig.getMetaConfig(true);
  if (!mc.appId || !mc.appSecret) return res.status(400).json({ error: 'Save your App ID and App Secret first.' });
  if (!/^https:\/\//i.test(mc.publicBaseUrl)) return res.status(400).json({ error: 'Set your public https:// address first — Meta only sends webhooks to secure URLs.' });
  if (!mc.verifyToken) return res.status(400).json({ error: 'Set a webhook verify token first (the Generate button makes one).' });
  const results = await metaconfig.registerWebhooks(mc);
  res.json({ ok: results.every((r) => r.ok), results });
});

// ---- Per-tenant AI key override ----
// Never shown in the tenant's own panel — this is the ONLY place a
// tenant-specific key can be set, and it always falls back to the
// universal platform key when left unconfigured (override_ai_provider '').
app.get('/api/superadmin/tenants/:id/ai-override', requireSuperAdmin, async (req, res) => {
  const settings = await db.getSettings(req.params.id);
  const out = {
    override_ai_provider: settings.override_ai_provider || '',
    override_openai_model: settings.override_openai_model || '',
    override_gemini_model: settings.override_gemini_model || '',
    override_openai_api_key_masked: settings.override_openai_api_key ? maskKey(settings.override_openai_api_key) : '',
    override_gemini_api_key_masked: settings.override_gemini_api_key ? maskKey(settings.override_gemini_api_key) : ''
  };
  res.json(out);
});

app.post('/api/superadmin/tenants/:id/ai-override', requireSuperAdmin, async (req, res) => {
  const { override_ai_provider, override_openai_api_key, override_openai_model, override_gemini_api_key, override_gemini_model } = req.body;
  const update = { override_ai_provider: override_ai_provider || '' };
  // Only overwrite a key field when a new value was actually typed — an
  // empty field here means "keep the currently saved key", not "clear it"
  // (clearing happens by switching override_ai_provider back to '').
  if (override_openai_api_key) update.override_openai_api_key = override_openai_api_key;
  if (override_openai_model !== undefined) update.override_openai_model = override_openai_model;
  if (override_gemini_api_key) update.override_gemini_api_key = override_gemini_api_key;
  if (override_gemini_model !== undefined) update.override_gemini_model = override_gemini_model;
  if (!override_ai_provider) {
    update.override_openai_api_key = '';
    update.override_gemini_api_key = '';
  }
  await db.updateSettings(req.params.id, update);
  res.json({ ok: true });
});

app.post('/api/superadmin/tenants/:id/test-ai', requireSuperAdmin, async (req, res) => {
  try {
    const result = await ai.testConnection(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Plans ----
// Validates the plan form. Price may be 0 (a free plan); everything else
// has to be a positive whole number. Returns { error } or { value }.
function parsePlanBody(body) {
  const name = String((body && body.name) || '').trim();
  const reply_limit = parseInt(body && body.reply_limit, 10);
  const price_bdt = parseInt(body && body.price_bdt, 10);
  const duration_days = parseInt(body && body.duration_days, 10);
  if (!name) return { error: 'Plan name is required.' };
  if (name.length > 80) return { error: 'Plan name is too long (80 characters max).' };
  if (!Number.isInteger(reply_limit) || reply_limit < 1) return { error: 'Reply limit must be a whole number of 1 or more.' };
  if (!Number.isInteger(price_bdt) || price_bdt < 0) return { error: 'Price must be a whole number of 0 or more (BDT).' };
  if (!Number.isInteger(duration_days) || duration_days < 1) return { error: 'Duration must be a whole number of days, 1 or more.' };
  return { value: { name, reply_limit, price_bdt, duration_days } };
}

app.get('/api/superadmin/plans', requireSuperAdmin, async (req, res) => {
  try {
    res.json(await db.listPlans(false));
  } catch (err) {
    console.error('List plans failed:', err);
    res.status(500).json({ error: 'Could not load plans.' });
  }
});
app.post('/api/superadmin/plans', requireSuperAdmin, async (req, res) => {
  const parsed = parsePlanBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const v = parsed.value;
    res.json(await db.createPlan(v.name, v.reply_limit, v.price_bdt, v.duration_days));
  } catch (err) {
    console.error('Create plan failed:', err);
    res.status(500).json({ error: 'Could not save the plan.' });
  }
});
app.put('/api/superadmin/plans/:id', requireSuperAdmin, async (req, res) => {
  const parsed = parsePlanBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try {
    const existing = await db.getPlanById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Plan not found.' });
    const v = parsed.value;
    await db.updatePlan(existing.id, v.name, v.reply_limit, v.price_bdt, v.duration_days);
    res.json(await db.getPlanById(existing.id));
  } catch (err) {
    console.error('Update plan failed:', err);
    res.status(500).json({ error: 'Could not save the plan.' });
  }
});
app.post('/api/superadmin/plans/:id/deactivate', requireSuperAdmin, async (req, res) => {
  try {
    await db.deactivatePlan(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Deactivate plan failed:', err);
    res.status(500).json({ error: 'Could not deactivate the plan.' });
  }
});
app.post('/api/superadmin/plans/:id/activate', requireSuperAdmin, async (req, res) => {
  try {
    await db.activatePlan(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Activate plan failed:', err);
    res.status(500).json({ error: 'Could not activate the plan.' });
  }
});

// Public: the active plans, so the landing page's pricing section always
// matches what you set in /superadmin → Plans. No auth, no private fields.
app.get('/api/public-plans', async (req, res) => {
  try {
    const plans = await db.listPlans(true);
    res.json(plans.map(p => ({
      id: p.id, name: p.name, reply_limit: p.reply_limit, price_bdt: p.price_bdt, duration_days: p.duration_days
    })));
  } catch (err) {
    console.error('Public plans failed:', err);
    res.json([]);
  }
});

// ================= Website (public marketing site) — super admin controls =================
// Everything here drives the public landing page (logo, favicon, colors,
// Meta Pixel, hero copy/slider, blog, testimonials) plus discount coupons
// used at billing time. Public read-only versions of the same data are
// exposed further down for the landing page itself to fetch.

app.post('/api/superadmin/upload', requireSuperAdmin, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ ok: true, url: '/uploads/' + req.file.filename });
  });
});

app.get('/api/superadmin/site-content', requireSuperAdmin, async (req, res) => {
  res.json(await db.getSiteContent());
});
app.post('/api/superadmin/site-content', requireSuperAdmin, async (req, res) => {
  const allowed = [
    'logo_url', 'favicon_url', 'meta_pixel_id', 'primary_color', 'accent_color',
    'hero_headline', 'hero_subheadline', 'hero_cta_label', 'hero_cta_secondary_label',
    'steps_headline', 'step1_title', 'step1_body', 'step2_title', 'step2_body', 'step3_title', 'step3_body',
    'pricing_note', 'footer_text'
  ];
  const update = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  const content = await db.updateSiteContent(update);
  res.json({ ok: true, content });
});

// ---- Hero slider ----
app.get('/api/superadmin/hero-slides', requireSuperAdmin, async (req, res) => {
  res.json(await db.listHeroSlides(false));
});
app.post('/api/superadmin/hero-slides', requireSuperAdmin, async (req, res) => {
  res.json(await db.createHeroSlide(req.body));
});
app.put('/api/superadmin/hero-slides/:id', requireSuperAdmin, async (req, res) => {
  await db.updateHeroSlide(req.params.id, req.body);
  res.json({ ok: true });
});
app.delete('/api/superadmin/hero-slides/:id', requireSuperAdmin, async (req, res) => {
  await db.deleteHeroSlide(req.params.id);
  res.json({ ok: true });
});

// ---- Blog ----
function slugify(title) {
  return String(title).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80) || 'post';
}
app.get('/api/superadmin/blog', requireSuperAdmin, async (req, res) => {
  res.json(await db.listBlogPosts(false));
});
app.post('/api/superadmin/blog', requireSuperAdmin, async (req, res) => {
  const { title, cover_image_url, excerpt, content, published } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  let slug = slugify(req.body.slug || title);
  // Ensure uniqueness by appending a short suffix if the slug's taken.
  let candidate = slug, n = 1;
  while (await db.getBlogPostBySlug(candidate)) { candidate = slug + '-' + (++n); }
  const post = await db.createBlogPost({ title, slug: candidate, cover_image_url, excerpt, content, published });
  res.json(post);
});
app.put('/api/superadmin/blog/:id', requireSuperAdmin, async (req, res) => {
  const existing = await db.getBlogPostById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { title, cover_image_url, excerpt, content, published } = req.body;
  let slug = existing.slug;
  if (req.body.slug) slug = slugify(req.body.slug);
  await db.updateBlogPost(req.params.id, { title: title || existing.title, slug, cover_image_url, excerpt, content, published });
  res.json({ ok: true });
});
app.delete('/api/superadmin/blog/:id', requireSuperAdmin, async (req, res) => {
  await db.deleteBlogPost(req.params.id);
  res.json({ ok: true });
});

// ---- Testimonials ----
app.get('/api/superadmin/testimonials', requireSuperAdmin, async (req, res) => {
  res.json(await db.listTestimonials(false));
});
app.post('/api/superadmin/testimonials', requireSuperAdmin, async (req, res) => {
  const { name, quote } = req.body;
  if (!name || !quote) return res.status(400).json({ error: 'Name and quote are required' });
  res.json(await db.createTestimonial(req.body));
});
app.put('/api/superadmin/testimonials/:id', requireSuperAdmin, async (req, res) => {
  await db.updateTestimonial(req.params.id, req.body);
  res.json({ ok: true });
});
app.delete('/api/superadmin/testimonials/:id', requireSuperAdmin, async (req, res) => {
  await db.deleteTestimonial(req.params.id);
  res.json({ ok: true });
});

// ---- Coupons ----
app.get('/api/superadmin/coupons', requireSuperAdmin, async (req, res) => {
  res.json(await db.listCoupons());
});
app.post('/api/superadmin/coupons', requireSuperAdmin, async (req, res) => {
  const { code, discount_type, discount_value, max_uses, expires_at } = req.body;
  if (!code || !discount_value) return res.status(400).json({ error: 'Code and discount value are required' });
  if (!['percent', 'flat'].includes(discount_type)) return res.status(400).json({ error: 'discount_type must be percent or flat' });
  try {
    const coupon = await db.createCoupon({
      code, discount_type, discount_value: parseFloat(discount_value),
      max_uses: max_uses ? parseInt(max_uses, 10) : null,
      expires_at: expires_at || null
    });
    res.json(coupon);
  } catch (err) {
    res.status(400).json({ error: err.message.includes('duplicate') ? 'That coupon code already exists' : err.message });
  }
});
app.post('/api/superadmin/coupons/:id/toggle', requireSuperAdmin, async (req, res) => {
  await db.updateCoupon(req.params.id, { active: !!req.body.active });
  res.json({ ok: true });
});
app.delete('/api/superadmin/coupons/:id', requireSuperAdmin, async (req, res) => {
  await db.deleteCoupon(req.params.id);
  res.json({ ok: true });
});

// Tenant detail view for super admin — settings summary + usage, read-only.
app.get('/api/superadmin/tenants/:id/details', requireSuperAdmin, async (req, res) => {
  const tenant = await db.getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Not found' });
  const settings = await db.getSettings(tenant.id);
  const usage = await db.getReplyUsage(tenant.id);
  const products = await db.listProducts(tenant.id);
  const orders = await db.listOrders(tenant.id);
  const dashboard = await db.getDashboardStats(tenant.id);
  const cost = await db.getTenantCostSummary(tenant.id);
  res.json({
    tenant: {
      business_name: tenant.business_name,
      email: tenant.email,
      phone: tenant.phone,
      whatsapp_number: tenant.whatsapp_number,
      address: tenant.address,
      active: db.isTenantActive(tenant),
      suspended: tenant.suspended,
      trial_ends_at: tenant.trial_ends_at,
      subscription_ends_at: tenant.subscription_ends_at
    },
    plan: usage.plan,
    usage: { used: usage.used, limit: usage.limit },
    settings: {
      reply_mode: settings.reply_mode,
      fb_enabled: settings.fb_enabled,
      ig_enabled: settings.ig_enabled,
      whatsapp_enabled: settings.whatsapp_enabled,
      using_ai_override: !!settings.override_ai_provider
    },
    products_count: products.length,
    orders_count: orders.length,
    dashboard,
    cost
  });
});

// Grant a tenant extra days directly — independent of the payment queue,
// for comps, goodwill extensions, manual overrides, etc.
app.post('/api/superadmin/tenants/:id/extend', requireSuperAdmin, async (req, res) => {
  const days = parseInt(req.body.days, 10);
  if (!days || days <= 0) return res.status(400).json({ error: 'Provide a positive number of days' });
  const newEnd = await db.extendSubscription(req.params.id, days);
  res.json({ ok: true, subscription_ends_at: newEnd });
});

app.get('/api/superadmin/tenants', requireSuperAdmin, async (req, res) => {
  const tenants = await db.listTenants();
  const result = [];
  for (const t of tenants) {
    const plan = await db.getPlanById(t.plan_id);
    result.push({
      id: t.id,
      business_name: t.business_name,
      email: t.email,
      phone: t.phone,
      whatsapp_number: t.whatsapp_number,
      suspended: t.suspended,
      trial_ends_at: t.trial_ends_at,
      subscription_ends_at: t.subscription_ends_at,
      created_at: t.created_at,
      active: db.isTenantActive(t),
      plan_name: plan ? plan.name : null
    });
  }
  res.json(result);
});

app.post('/api/superadmin/tenants/:id/suspend', requireSuperAdmin, async (req, res) => {
  await db.setTenantSuspended(req.params.id, !!req.body.suspended);
  res.json({ ok: true });
});

app.get('/api/superadmin/payments', requireSuperAdmin, async (req, res) => {
  res.json(await db.listPendingPayments());
});

app.post('/api/superadmin/payments/:id/approve', requireSuperAdmin, async (req, res) => {
  const payment = await db.getPayment(req.params.id);
  if (!payment || payment.status !== 'pending') return res.status(400).json({ error: 'Payment not pending' });
  await db.decidePayment(payment.id, 'approved');
  // How long this payment extends them by comes from their current plan's
  // package duration (30/90/180/365 days, or whatever you set) — falling
  // back to config.SUBSCRIPTION_DAYS only for a tenant with no plan chosen
  // yet (shouldn't normally happen, since submitting a payment implies
  // they picked one, but keeps this endpoint safe either way).
  const tenant = await db.getTenantById(payment.tenant_id);
  const plan = await db.getPlanById(tenant.plan_id);
  const days = plan ? plan.duration_days : config.SUBSCRIPTION_DAYS;
  const newEnd = await db.extendSubscription(payment.tenant_id, days);
  await db.resetUsageCycle(payment.tenant_id); // new billing cycle = fresh reply quota
  res.json({ ok: true, subscription_ends_at: newEnd });
});

app.post('/api/superadmin/payments/:id/reject', requireSuperAdmin, async (req, res) => {
  await db.decidePayment(req.params.id, 'rejected');
  res.json({ ok: true });
});

// Log directly into a tenant's own admin panel — for support/setup help.
// Keeps isSuperAdmin true so the tenant panel can show an "exit" banner.
app.post('/api/superadmin/tenants/:id/impersonate', requireSuperAdmin, async (req, res) => {
  const tenant = await db.getTenantById(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  req.session.tenantId = tenant.id;
  res.json({ ok: true });
});

app.post('/api/superadmin/exit-impersonation', requireSuperAdmin, (req, res) => {
  delete req.session.tenantId;
  res.json({ ok: true });
});

// ================= Static sites =================
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/superadmin', express.static(path.join(__dirname, 'public/superadmin')));
// Blog list/post pages are static HTML that fetch their content from the
// API above — these explicit routes exist so /blog/some-post-slug resolves
// to that page (static file serving alone can't match a path parameter).
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'public/landing/blog.html')));
app.get('/blog/:slug', (req, res) => res.sendFile(path.join(__dirname, 'public/landing/blog-post.html')));
app.use('/', express.static(path.join(__dirname, 'public/landing')));

// ================= Boot =================
(async () => {
  await db.init();
  server.listen(config.PORT, () => {
    console.log(`Landing page:     http://localhost:${config.PORT}/`);
    console.log(`Tenant admin:     http://localhost:${config.PORT}/admin`);
    console.log(`Super admin:      http://localhost:${config.PORT}/superadmin`);
    console.log(`Facebook webhook: http://localhost:${config.PORT}/webhook`);
  });
})();
