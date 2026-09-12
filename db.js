const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(config.DB);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  business_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  suspended BOOLEAN DEFAULT false,
  trial_ends_at TIMESTAMPTZ NOT NULL,
  subscription_ends_at TIMESTAMPTZ, -- null until first approved payment
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  trx_id TEXT NOT NULL,
  amount TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  submitted_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS settings (
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (tenant_id, key)
);

-- Platform-wide settings (no tenant_id) — set by YOU, the super admin.
-- Currently used for the fallback AI key tenants fall back to if they
-- haven't set their own, and the default trial length for new signups.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,           -- 'facebook' or 'whatsapp'
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  ai_enabled BOOLEAN DEFAULT true,
  last_message_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, platform, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,   -- 'in' or 'out'
  sender TEXT NOT NULL,      -- 'user', 'ai', 'human'
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  items JSONB DEFAULT '[]',
  total_amount TEXT,
  customer_name TEXT,
  delivery_address TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | paid | cancelled
  payment_trx_id TEXT,
  payment_amount TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_tenant ON conversations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_tenant ON payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_conversation ON orders(conversation_id);
`;

const DEFAULT_SETTINGS = {
  ai_provider: 'openai', // 'openai' or 'gemini'
  openai_api_key: '',
  openai_model: 'gpt-4o-mini',
  gemini_api_key: '',
  gemini_model: 'gemini-3.5-flash',
  system_prompt: 'You are a helpful, friendly customer support assistant. Keep replies short and clear.',
  order_tools_enabled: 'true',
  fallback_message: "Sorry for the delay — I've passed this along to our team and someone will get back to you shortly!",
  fb_page_id: '',
  fb_page_access_token: '',
  fb_enabled: 'false',
  whatsapp_enabled: 'true',
  whatsapp_mode: 'qr', // 'qr' (whatsapp-web.js) or 'cloud_api' (official Meta API)
  wa_cloud_phone_number_id: '',
  wa_cloud_access_token: ''
};

const DEFAULT_PLATFORM_SETTINGS = {
  platform_openai_api_key: '', // fallback AI used when a tenant hasn't set their own
  platform_openai_model: 'gpt-4o-mini',
  default_trial_days: '3'
};

async function init() {
  await pool.query(SCHEMA);
  for (const [key, value] of Object.entries(DEFAULT_PLATFORM_SETTINGS)) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    );
  }
}

// ---------- platform settings (super admin only) ----------
async function getPlatformSettings() {
  const { rows } = await pool.query('SELECT key, value FROM platform_settings');
  const out = { ...DEFAULT_PLATFORM_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function updatePlatformSettings(obj) {
  for (const [key, value] of Object.entries(obj)) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, String(value)]
    );
  }
}

// ---------- tenants ----------
async function createTenant(businessName, email, passwordHash, trialDays) {
  const days = trialDays !== undefined && trialDays !== null ? trialDays : config.TRIAL_DAYS;
  const trialEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const { rows } = await pool.query(
    `INSERT INTO tenants (business_name, email, password_hash, trial_ends_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessName, email, passwordHash, trialEndsAt]
  );
  const tenant = rows[0];
  // seed default settings for the new tenant
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query(
      `INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [tenant.id, key, value]
    );
  }
  return tenant;
}

async function getTenantByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE email = $1', [email]);
  return rows[0];
}

async function getTenantById(id) {
  const { rows } = await pool.query('SELECT * FROM tenants WHERE id = $1', [id]);
  return rows[0];
}

async function listTenants() {
  const { rows } = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
  return rows;
}

async function setTenantSuspended(id, suspended) {
  await pool.query('UPDATE tenants SET suspended = $1 WHERE id = $2', [suspended, id]);
}

async function extendSubscription(tenantId, days) {
  const tenant = await getTenantById(tenantId);
  const base = tenant.subscription_ends_at && new Date(tenant.subscription_ends_at) > new Date()
    ? new Date(tenant.subscription_ends_at)
    : (tenant.trial_ends_at && new Date(tenant.trial_ends_at) > new Date() ? new Date(tenant.trial_ends_at) : new Date());
  const newEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  await pool.query('UPDATE tenants SET subscription_ends_at = $1 WHERE id = $2', [newEnd, tenantId]);
  return newEnd;
}

// Effective active-until = later of trial_ends_at and subscription_ends_at.
// A tenant can send/receive AI replies only while this is in the future
// AND they are not manually suspended.
function isTenantActive(tenant) {
  if (!tenant) return false;
  if (tenant.suspended) return false;
  const trial = tenant.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const sub = tenant.subscription_ends_at ? new Date(tenant.subscription_ends_at) : null;
  const latest = [trial, sub].filter(Boolean).sort((a, b) => b - a)[0];
  return !!latest && latest > new Date();
}

// ---------- payments ----------
async function submitPayment(tenantId, trxId, amount) {
  const { rows } = await pool.query(
    `INSERT INTO payments (tenant_id, trx_id, amount) VALUES ($1, $2, $3) RETURNING *`,
    [tenantId, trxId, amount]
  );
  return rows[0];
}

async function listPaymentsForTenant(tenantId) {
  const { rows } = await pool.query(
    'SELECT * FROM payments WHERE tenant_id = $1 ORDER BY submitted_at DESC',
    [tenantId]
  );
  return rows;
}

async function listPendingPayments() {
  const { rows } = await pool.query(
    `SELECT payments.*, tenants.business_name, tenants.email
     FROM payments JOIN tenants ON tenants.id = payments.tenant_id
     WHERE payments.status = 'pending' ORDER BY payments.submitted_at ASC`
  );
  return rows;
}

async function getPayment(id) {
  const { rows } = await pool.query('SELECT * FROM payments WHERE id = $1', [id]);
  return rows[0];
}

async function decidePayment(id, status) {
  await pool.query('UPDATE payments SET status = $1, decided_at = now() WHERE id = $2', [status, id]);
}

// ---------- settings (per tenant) ----------
async function getSettings(tenantId) {
  const { rows } = await pool.query('SELECT key, value FROM settings WHERE tenant_id = $1', [tenantId]);
  // Merge over DEFAULT_SETTINGS so a tenant created before some setting
  // existed (this list has grown over time) still gets a sane default
  // for it, instead of undefined breaking whatever reads it.
  const out = { ...DEFAULT_SETTINGS };
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function getSetting(tenantId, key) {
  const { rows } = await pool.query(
    'SELECT value FROM settings WHERE tenant_id = $1 AND key = $2',
    [tenantId, key]
  );
  return rows.length ? rows[0].value : null;
}

async function updateSettings(tenantId, obj) {
  for (const [key, value] of Object.entries(obj)) {
    await pool.query(
      `INSERT INTO settings (tenant_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3`,
      [tenantId, key, String(value)]
    );
  }
}

// Look up which tenant owns a given Facebook Page ID (for webhook routing)
async function getTenantIdByFacebookPageId(pageId) {
  const { rows } = await pool.query(
    `SELECT tenant_id FROM settings WHERE key = 'fb_page_id' AND value = $1 LIMIT 1`,
    [pageId]
  );
  return rows.length ? rows[0].tenant_id : null;
}

// Look up which tenant owns a given WhatsApp Cloud API phone number ID
async function getTenantIdByWaPhoneNumberId(phoneNumberId) {
  const { rows } = await pool.query(
    `SELECT tenant_id FROM settings WHERE key = 'wa_cloud_phone_number_id' AND value = $1 LIMIT 1`,
    [phoneNumberId]
  );
  return rows.length ? rows[0].tenant_id : null;
}

// ---------- conversations ----------
async function getOrCreateConversation(tenantId, platform, contactId, contactName) {
  const existing = await pool.query(
    'SELECT * FROM conversations WHERE tenant_id = $1 AND platform = $2 AND contact_id = $3',
    [tenantId, platform, contactId]
  );
  if (existing.rows.length) {
    if (contactName) {
      await pool.query('UPDATE conversations SET contact_name = $1 WHERE id = $2', [
        contactName,
        existing.rows[0].id
      ]);
    }
    return existing.rows[0];
  }
  const inserted = await pool.query(
    `INSERT INTO conversations (tenant_id, platform, contact_id, contact_name) VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, platform, contactId, contactName || null]
  );
  return inserted.rows[0];
}

async function touchConversation(id) {
  await pool.query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [id]);
}

async function listConversations(tenantId) {
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE tenant_id = $1 ORDER BY last_message_at DESC LIMIT 200',
    [tenantId]
  );
  return rows;
}

async function setConversationAI(tenantId, id, enabled) {
  await pool.query(
    'UPDATE conversations SET ai_enabled = $1 WHERE id = $2 AND tenant_id = $3',
    [enabled, id, tenantId]
  );
}

async function getConversation(tenantId, id) {
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  return rows[0];
}

// ---------- messages ----------
async function addMessage(conversationId, direction, sender, content) {
  await pool.query(
    `INSERT INTO messages (conversation_id, direction, sender, content) VALUES ($1, $2, $3, $4)`,
    [conversationId, direction, sender, content]
  );
  await touchConversation(conversationId);
}

async function getRecentMessages(conversationId, limit) {
  const { rows } = await pool.query(
    `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse();
}

async function getAllMessages(tenantId, conversationId) {
  // tenantId check via join keeps one tenant from reading another's thread
  const { rows } = await pool.query(
    `SELECT messages.* FROM messages
     JOIN conversations ON conversations.id = messages.conversation_id
     WHERE messages.conversation_id = $1 AND conversations.tenant_id = $2
     ORDER BY messages.created_at ASC`,
    [conversationId, tenantId]
  );
  return rows;
}

// ---------- orders ----------
async function createOrder(tenantId, conversationId, items, totalAmount, customerName, deliveryAddress, note) {
  const { rows } = await pool.query(
    `INSERT INTO orders (tenant_id, conversation_id, items, total_amount, customer_name, delivery_address, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, conversationId, JSON.stringify(items || []), totalAmount || null, customerName || null, deliveryAddress || null, note || null]
  );
  return rows[0];
}

// Applies a payment to the most recent open order in this conversation.
// If none exists yet (customer paid before the AI formally confirmed an
// order), creates a bare order record so the payment isn't lost.
async function recordPayment(tenantId, conversationId, trxId, amount) {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'confirmed'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, conversationId]
  );
  if (rows.length) {
    const { rows: updated } = await pool.query(
      `UPDATE orders SET status = 'paid', payment_trx_id = $1, payment_amount = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [trxId, amount || null, rows[0].id]
    );
    return updated[0];
  }
  const { rows: created } = await pool.query(
    `INSERT INTO orders (tenant_id, conversation_id, items, status, payment_trx_id, payment_amount)
     VALUES ($1, $2, '[]', 'paid', $3, $4) RETURNING *`,
    [tenantId, conversationId, trxId, amount || null]
  );
  return created[0];
}

async function listOrders(tenantId) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 300', [tenantId]);
  return rows;
}

async function updateOrderStatus(tenantId, orderId, status) {
  await pool.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3', [status, orderId, tenantId]);
}

// ---------- dashboard ----------
async function getDashboardStats(tenantId) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const totalConversationsRes = await pool.query('SELECT COUNT(*)::int AS count FROM conversations WHERE tenant_id = $1', [tenantId]);
  const convByPlatformRes = await pool.query(
    'SELECT platform, COUNT(*)::int AS count FROM conversations WHERE tenant_id = $1 GROUP BY platform',
    [tenantId]
  );
  const totalRepliesRes = await pool.query(
    `SELECT COUNT(*)::int AS count FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.tenant_id = $1 AND m.sender = 'ai'`,
    [tenantId]
  );
  const repliesTodayRes = await pool.query(
    `SELECT COUNT(*)::int AS count FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE c.tenant_id = $1 AND m.sender = 'ai' AND m.created_at >= $2`,
    [tenantId, startOfToday]
  );
  const ordersByStatusRes = await pool.query(
    'SELECT status, COUNT(*)::int AS count FROM orders WHERE tenant_id = $1 GROUP BY status',
    [tenantId]
  );

  const conversationsByPlatform = { facebook: 0, whatsapp: 0 };
  for (const row of convByPlatformRes.rows) conversationsByPlatform[row.platform] = row.count;

  const ordersByStatus = { confirmed: 0, paid: 0, cancelled: 0 };
  for (const row of ordersByStatusRes.rows) ordersByStatus[row.status] = row.count;

  return {
    total_conversations: totalConversationsRes.rows[0].count,
    conversations_by_platform: conversationsByPlatform,
    total_ai_replies: totalRepliesRes.rows[0].count,
    ai_replies_today: repliesTodayRes.rows[0].count,
    orders_by_status: ordersByStatus,
    total_orders: ordersByStatus.confirmed + ordersByStatus.paid + ordersByStatus.cancelled
  };
}

// ---------- products (per tenant) ----------
async function listProducts(tenantId) {
  const { rows } = await pool.query('SELECT * FROM products WHERE tenant_id = $1 ORDER BY id ASC', [tenantId]);
  return rows;
}

async function addProduct(tenantId, name, price, description) {
  const { rows } = await pool.query(
    `INSERT INTO products (tenant_id, name, price, description) VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, name, price || null, description || null]
  );
  return rows[0];
}

async function updateProduct(tenantId, id, name, price, description) {
  await pool.query(
    `UPDATE products SET name = $1, price = $2, description = $3 WHERE id = $4 AND tenant_id = $5`,
    [name, price || null, description || null, id, tenantId]
  );
}

async function deleteProduct(tenantId, id) {
  await pool.query('DELETE FROM products WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
}

module.exports = {
  pool,
  init,
  getPlatformSettings,
  updatePlatformSettings,
  createTenant,
  getTenantByEmail,
  getTenantById,
  listTenants,
  setTenantSuspended,
  extendSubscription,
  isTenantActive,
  submitPayment,
  listPaymentsForTenant,
  listPendingPayments,
  getPayment,
  decidePayment,
  getSettings,
  getSetting,
  updateSettings,
  getTenantIdByFacebookPageId,
  getTenantIdByWaPhoneNumberId,
  getOrCreateConversation,
  listConversations,
  setConversationAI,
  getConversation,
  addMessage,
  getRecentMessages,
  getAllMessages,
  listProducts,
  addProduct,
  updateProduct,
  deleteProduct,
  createOrder,
  recordPayment,
  listOrders,
  updateOrderStatus,
  getDashboardStats
};
