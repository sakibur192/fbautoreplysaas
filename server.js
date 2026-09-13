const path = require('path');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const db = require('./db');
const metaWebhook = require('./meta-webhook');
const metaOauth = require('./meta-oauth');
const whatsapp = require('./whatsapp');
const ai = require('./ai');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

const sessionMiddleware = session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, sameSite: 'lax' }
});
app.use(sessionMiddleware);

// Share the same session store with socket.io, so a tenant's browser
// socket automatically joins only their own private room — no client
// ever sees another tenant's QR code or status.
io.engine.use(sessionMiddleware);
io.on('connection', (socket) => {
  const req = socket.request;
  if (req.session && req.session.tenantId) {
    socket.join(`tenant-${req.session.tenantId}`);
  }
});

// Meta webhook — public, no session (Meta calls this directly). One
// endpoint handles both Facebook Messenger and WhatsApp Cloud API,
// since they arrive through the same Meta App webhook mechanism.
app.use('/webhook', metaWebhook.router);
app.use('/api/connect', metaOauth.router);

// ================= Tenant auth =================
function requireTenant(req, res, next) {
  if (req.session && req.session.tenantId) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

app.post('/api/register', async (req, res) => {
  try {
    const { business_name, email, password } = req.body;
    if (!business_name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const existing = await db.getTenantByEmail(email.toLowerCase().trim());
    if (existing) return res.status(400).json({ error: 'An account with this email already exists' });

    const passwordHash = await bcrypt.hash(password, 10);
    const platformSettings = await db.getPlatformSettings();
    const trialDays = parseInt(platformSettings.default_trial_days, 10) || config.TRIAL_DAYS;
    const tenant = await db.createTenant(business_name.trim(), email.toLowerCase().trim(), passwordHash, trialDays);
    req.session.tenantId = tenant.id;
    res.json({ ok: true });
  } catch (err) {
    console.error('[register]', err.message);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

app.post('/api/login', async (req, res) => {
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
    active: db.isTenantActive(tenant),
    suspended: tenant.suspended,
    trial_ends_at: tenant.trial_ends_at,
    subscription_ends_at: tenant.subscription_ends_at,
    impersonating: !!req.session.isSuperAdmin
  });
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

app.post('/api/billing/submit', requireTenant, async (req, res) => {
  const { trx_id, amount } = req.body;
  if (!trx_id) return res.status(400).json({ error: 'Transaction ID is required' });
  const tenant = await db.getTenantById(req.session.tenantId);
  const usage = await db.getReplyUsage(req.session.tenantId);
  const defaultAmount = usage.plan ? String(usage.plan.price_bdt) : String(config.PRICE_BDT);
  const payment = await db.submitPayment(req.session.tenantId, trx_id.trim(), amount || defaultAmount);
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
    'whatsapp_enabled',
    'whatsapp_mode',
    'wa_cloud_phone_number_id',
    'wa_cloud_access_token'
  ];
  const allowedAlways = [
    'fb_system_prompt',
    'fb_order_tools_enabled',
    'fb_fallback_message',
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
  const { name, price, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  res.json(await db.addProduct(req.session.tenantId, name, price, description));
});
app.put('/api/products/:id', requireTenant, async (req, res) => {
  const { name, price, description } = req.body;
  await db.updateProduct(req.session.tenantId, req.params.id, name, price, description);
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

// ================= WhatsApp =================
app.get('/api/whatsapp/status', requireTenant, (req, res) => {
  res.json({ status: whatsapp.getStatus(req.session.tenantId) });
});

app.post('/api/whatsapp/connect', requireTenant, async (req, res) => {
  const tenant = await db.getTenantById(req.session.tenantId);
  if (!db.isTenantActive(tenant)) {
    return res.status(403).json({ error: 'Your trial/subscription has expired. Renew to connect WhatsApp.' });
  }
  whatsapp.connectTenant(req.session.tenantId, io);
  res.json({ ok: true });
});

app.post('/api/whatsapp/reset', requireTenant, async (req, res) => {
  await whatsapp.resetSession(req.session.tenantId);
  res.json({ ok: true });
});

// ================= Super admin (you) =================
function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.isSuperAdmin) return next();
  return res.status(401).json({ error: 'Not logged in' });
}

app.post('/api/superadmin/login', (req, res) => {
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

// ---- Plans ----
app.get('/api/superadmin/plans', requireSuperAdmin, async (req, res) => {
  res.json(await db.listPlans(false));
});
app.post('/api/superadmin/plans', requireSuperAdmin, async (req, res) => {
  const { name, reply_limit, price_bdt } = req.body;
  if (!name || !reply_limit || !price_bdt) return res.status(400).json({ error: 'Name, reply limit, and price are required' });
  const plan = await db.createPlan(name, parseInt(reply_limit, 10), parseInt(price_bdt, 10));
  res.json(plan);
});
app.put('/api/superadmin/plans/:id', requireSuperAdmin, async (req, res) => {
  const { name, reply_limit, price_bdt } = req.body;
  await db.updatePlan(req.params.id, name, parseInt(reply_limit, 10), parseInt(price_bdt, 10));
  res.json({ ok: true });
});
app.post('/api/superadmin/plans/:id/deactivate', requireSuperAdmin, async (req, res) => {
  await db.deactivatePlan(req.params.id);
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
  res.json({
    tenant: {
      business_name: tenant.business_name,
      email: tenant.email,
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
      whatsapp_enabled: settings.whatsapp_enabled,
      whatsapp_mode: settings.whatsapp_mode
    },
    products_count: products.length,
    orders_count: orders.length,
    dashboard
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
  const newEnd = await db.extendSubscription(payment.tenant_id, config.SUBSCRIPTION_DAYS);
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
