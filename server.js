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
const ai = require('./ai');
const websiteScan = require('./website-scan');

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

app.use(express.json({ limit: '2mb' }));

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
app.get('/api/public-config', (req, res) => {
  res.json({
    fb_app_id: config.FB_APP_ID || null,
    wa_embedded_signup_config_id: config.WA_EMBEDDED_SIGNUP_CONFIG_ID || null
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
app.get('/api/superadmin/costs', requireSuperAdmin, async (req, res) => {
  res.json(await db.getPlatformCostSummary());
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
app.get('/api/superadmin/plans', requireSuperAdmin, async (req, res) => {
  res.json(await db.listPlans(false));
});
app.post('/api/superadmin/plans', requireSuperAdmin, async (req, res) => {
  const { name, reply_limit, price_bdt, duration_days } = req.body;
  if (!name || !reply_limit || !price_bdt || !duration_days) {
    return res.status(400).json({ error: 'Name, reply limit, price, and duration are required' });
  }
  const plan = await db.createPlan(name, parseInt(reply_limit, 10), parseInt(price_bdt, 10), parseInt(duration_days, 10));
  res.json(plan);
});
app.put('/api/superadmin/plans/:id', requireSuperAdmin, async (req, res) => {
  const { name, reply_limit, price_bdt, duration_days } = req.body;
  await db.updatePlan(req.params.id, name, parseInt(reply_limit, 10), parseInt(price_bdt, 10), parseInt(duration_days, 10));
  res.json({ ok: true });
});
app.post('/api/superadmin/plans/:id/deactivate', requireSuperAdmin, async (req, res) => {
  await db.deactivatePlan(req.params.id);
  res.json({ ok: true });
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
