// ============================================================
// Numbers behind the dashboards (tenant panel + super admin overview).
//
// Day buckets are computed here in JS rather than in SQL on purpose: it
// keeps the queries plain (just a timestamp column over a bounded date
// range) and lets "a day" mean a Bangladesh calendar day instead of a UTC
// one. Change REPORT_TZ_OFFSET_MINUTES in config.js (default 360 = UTC+6)
// if you serve another time zone.
// ============================================================

const db = require('./db');
const config = require('./config');

const OFFSET_MIN = Number.isFinite(config.REPORT_TZ_OFFSET_MINUTES) ? config.REPORT_TZ_OFFSET_MINUTES : 360;
const DAY_MS = 86400000;
const ROW_CAP = 300000; // safety net so one huge range can never exhaust memory

function localDate(d) {
  return new Date(new Date(d).getTime() + OFFSET_MIN * 60000);
}
function dayKey(d) {
  return localDate(d).toISOString().slice(0, 10);
}
function hourOf(d) {
  return localDate(d).getUTCHours();
}
// The last n local calendar days, oldest first, as YYYY-MM-DD.
function buildDays(n) {
  const keys = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) keys.push(dayKey(now - i * DAY_MS));
  return keys;
}
// The UTC instant at which the first of the last n local days begins.
function rangeStart(n) {
  const [y, m, d] = dayKey(Date.now()).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - OFFSET_MIN * 60000 - (n - 1) * DAY_MS);
}

function money(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function seriesBy(rows, keys, pick, valueOf) {
  const idx = new Map(keys.map((k, i) => [k, i]));
  const out = new Array(keys.length).fill(0);
  for (const r of rows) {
    if (pick && !pick(r)) continue;
    const i = idx.get(dayKey(r.created_at));
    if (i !== undefined) out[i] += valueOf ? valueOf(r) : 1;
  }
  return out;
}
const sum = (a) => a.reduce((x, y) => x + y, 0);
const round2 = (n) => Math.round(n * 100) / 100;

function parseDays(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(90, Math.max(7, n));
}

// Splits rows into "this period" and "the same-length period before it" so
// the UI can show a trend (▲ 12%) next to each total.
function splitPeriods(rows, field, days) {
  const cut = rangeStart(days).getTime();
  const current = [];
  const previous = [];
  for (const r of rows) (new Date(r[field]).getTime() >= cut ? current : previous).push(r);
  return { current, previous };
}

// ---------------------------------------------------------------
// Tenant dashboard
// ---------------------------------------------------------------
async function getTenantAnalytics(tenantId, daysParam) {
  const days = parseDays(daysParam, 14);
  const keys = buildDays(days);
  const since2 = rangeStart(days * 2);

  const [msgRes, orderRes, convRes, settings, products, tenant] = await Promise.all([
    db.pool.query(
      `SELECT m.created_at, m.direction, m.sender, c.platform
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.tenant_id = $1 AND m.created_at >= $2 LIMIT ${ROW_CAP}`,
      [tenantId, since2]
    ),
    db.pool.query(
      `SELECT created_at, status, total_amount, items FROM orders
        WHERE tenant_id = $1 AND created_at >= $2 LIMIT ${ROW_CAP}`,
      [tenantId, since2]
    ),
    db.pool.query(
      `SELECT created_at, platform FROM conversations WHERE tenant_id = $1 AND created_at >= $2 LIMIT ${ROW_CAP}`,
      [tenantId, since2]
    ),
    db.getSettings(tenantId),
    db.listProducts(tenantId),
    db.getTenantById(tenantId)
  ]);

  const msgs = splitPeriods(msgRes.rows, 'created_at', days);
  const orders = splitPeriods(orderRes.rows, 'created_at', days);
  const convs = splitPeriods(convRes.rows, 'created_at', days);

  const ai = (r) => r.sender === 'ai';
  const human = (r) => r.sender === 'human';
  const inbound = (r) => r.direction === 'in';
  const live = (o) => o.status !== 'cancelled';

  // Messages per hour of the local day (inbound) — when customers actually write.
  const byHour = new Array(24).fill(0);
  for (const r of msgs.current) if (inbound(r)) byHour[hourOf(r.created_at)]++;

  const byPlatform = { facebook: 0, instagram: 0, whatsapp: 0 };
  for (const r of msgs.current) if (inbound(r) && byPlatform[r.platform] !== undefined) byPlatform[r.platform]++;

  // Best-selling items from confirmed/paid orders in the period.
  const itemTotals = new Map();
  for (const o of orders.current) {
    if (!live(o) || !Array.isArray(o.items)) continue;
    for (const it of o.items) {
      if (!it || !it.name) continue;
      const q = parseInt(it.quantity, 10);
      const qty = Number.isFinite(q) && q > 0 ? q : 1;
      const key = String(it.name).trim();
      itemTotals.set(key, (itemTotals.get(key) || 0) + qty);
    }
  }
  const topItems = [...itemTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty }));

  const orderValue = (list) => sum(list.filter(live).map((o) => money(o.total_amount)));
  const paidValue = (list) => sum(list.filter((o) => o.status === 'paid').map((o) => money(o.total_amount)));

  const totals = {
    ai_replies: msgs.current.filter(ai).length,
    inbound: msgs.current.filter(inbound).length,
    human_replies: msgs.current.filter(human).length,
    new_conversations: convs.current.length,
    orders: orders.current.filter(live).length,
    order_value: round2(orderValue(orders.current)),
    paid_value: round2(paidValue(orders.current))
  };
  const previous = {
    ai_replies: msgs.previous.filter(ai).length,
    inbound: msgs.previous.filter(inbound).length,
    human_replies: msgs.previous.filter(human).length,
    new_conversations: convs.previous.length,
    orders: orders.previous.filter(live).length,
    order_value: round2(orderValue(orders.previous)),
    paid_value: round2(paidValue(orders.previous))
  };

  const handled = totals.ai_replies + totals.human_replies;

  // Subscription state, same rule the rest of the app uses.
  const now = Date.now();
  const trialEnd = tenant && tenant.trial_ends_at ? new Date(tenant.trial_ends_at).getTime() : 0;
  const subEnd = tenant && tenant.subscription_ends_at ? new Date(tenant.subscription_ends_at).getTime() : 0;
  let state = 'expired';
  let endsAt = Math.max(trialEnd, subEnd) || null;
  if (tenant && tenant.suspended) state = 'suspended';
  else if (subEnd > now) { state = 'paid'; endsAt = subEnd; }
  else if (trialEnd > now) { state = 'trial'; endsAt = trialEnd; }

  const channelsConnected = {
    facebook: !!(settings.fb_page_id && settings.fb_enabled !== 'false'),
    whatsapp: !!(settings.wa_cloud_phone_number_id && settings.whatsapp_enabled !== 'false')
  };

  return {
    days: keys,
    series: {
      ai_replies: seriesBy(msgs.current, keys, ai),
      inbound: seriesBy(msgs.current, keys, inbound),
      human_replies: seriesBy(msgs.current, keys, human),
      new_conversations: seriesBy(convs.current, keys),
      orders: seriesBy(orders.current, keys, live),
      order_value: seriesBy(orders.current, keys, live, (o) => money(o.total_amount))
    },
    totals,
    previous,
    by_hour: byHour,
    by_platform: byPlatform,
    ai_share: handled ? Math.round((totals.ai_replies / handled) * 100) : null,
    top_items: topItems,
    subscription: {
      state,
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      days_left: endsAt && state !== 'expired' && state !== 'suspended' ? Math.max(0, Math.ceil((endsAt - now) / DAY_MS)) : 0
    },
    setup: {
      channels_connected: channelsConnected,
      any_channel: channelsConnected.facebook || channelsConnected.whatsapp,
      products: products.length,
      instructions_customised: !!settings.system_prompt && settings.system_prompt !== 'You are a helpful, friendly customer support assistant. Keep replies short and clear.',
      has_conversation: convRes.rows.length > 0 || msgRes.rows.length > 0
    }
  };
}

// ---------------------------------------------------------------
// Super admin overview
// ---------------------------------------------------------------
async function getPlatformAnalytics(daysParam) {
  const days = parseDays(daysParam, 30);
  const keys = buildDays(days);
  const since2 = rangeStart(days * 2);
  const now = Date.now();

  const [tenantRes, planRes, payRes, usageRes, nameRes, fbRes, waRes] = await Promise.all([
    db.pool.query('SELECT id, business_name, suspended, trial_ends_at, subscription_ends_at, plan_id, created_at FROM tenants'),
    db.pool.query('SELECT id, name, price_bdt, duration_days FROM plans'),
    db.pool.query('SELECT id, tenant_id, amount, status, submitted_at, decided_at FROM payments'),
    db.pool.query(
      `SELECT created_at, tenant_id, cost_usd FROM ai_usage WHERE created_at >= $1 LIMIT ${ROW_CAP}`,
      [since2]
    ),
    db.pool.query('SELECT id, business_name FROM tenants'),
    db.pool.query(`SELECT COUNT(DISTINCT tenant_id)::int AS c FROM settings WHERE key = 'fb_page_id' AND value <> ''`),
    db.pool.query(`SELECT COUNT(DISTINCT tenant_id)::int AS c FROM settings WHERE key = 'wa_cloud_phone_number_id' AND value <> ''`)
  ]);

  const tenants = tenantRes.rows;
  const plans = planRes.rows;
  const planById = new Map(plans.map((p) => [p.id, p]));
  const nameById = new Map(nameRes.rows.map((t) => [t.id, t.business_name]));

  // ---- tenant states ----
  const states = { paid: 0, trial: 0, expired: 0, suspended: 0 };
  const expiringSoon = [];
  let mrr = 0;
  for (const t of tenants) {
    const trialEnd = t.trial_ends_at ? new Date(t.trial_ends_at).getTime() : 0;
    const subEnd = t.subscription_ends_at ? new Date(t.subscription_ends_at).getTime() : 0;
    let state = 'expired';
    let ends = Math.max(trialEnd, subEnd);
    if (t.suspended) state = 'suspended';
    else if (subEnd > now) { state = 'paid'; ends = subEnd; }
    else if (trialEnd > now) { state = 'trial'; ends = trialEnd; }
    states[state]++;
    if (state === 'paid') {
      const p = planById.get(t.plan_id);
      if (p && p.duration_days > 0) mrr += (p.price_bdt * 30) / p.duration_days;
    }
    if ((state === 'paid' || state === 'trial') && ends - now <= 7 * DAY_MS) {
      expiringSoon.push({
        id: t.id,
        business_name: t.business_name,
        state,
        ends_at: new Date(ends).toISOString(),
        days_left: Math.max(0, Math.ceil((ends - now) / DAY_MS))
      });
    }
  }
  expiringSoon.sort((a, b) => a.days_left - b.days_left);

  // ---- plan mix ----
  const planCounts = new Map();
  for (const t of tenants) {
    const label = planById.get(t.plan_id) ? planById.get(t.plan_id).name : 'No plan yet';
    planCounts.set(label, (planCounts.get(label) || 0) + 1);
  }
  const planMix = [...planCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  // ---- signups ----
  const signupRows = tenants.map((t) => ({ created_at: t.created_at }));
  const signups = splitPeriods(signupRows.filter((r) => new Date(r.created_at).getTime() >= since2.getTime()), 'created_at', days);

  // ---- revenue (approved payments, dated by when they were approved) ----
  const approved = payRes.rows
    .filter((p) => p.status === 'approved')
    .map((p) => ({ created_at: p.decided_at || p.submitted_at, amount: money(p.amount), tenant_id: p.tenant_id }));
  const approvedWindow = splitPeriods(approved.filter((p) => new Date(p.created_at).getTime() >= since2.getTime()), 'created_at', days);
  const pending = payRes.rows.filter((p) => p.status === 'pending');

  // ---- AI activity ----
  const usage = splitPeriods(usageRes.rows, 'created_at', days);
  const repliesByTenant = new Map();
  for (const r of usage.current) repliesByTenant.set(r.tenant_id, (repliesByTenant.get(r.tenant_id) || 0) + 1);
  const topTenants = [...repliesByTenant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, replies]) => ({ id, business_name: nameById.get(id) || 'Unknown', replies }));

  const totals = {
    signups: signups.current.length,
    revenue: round2(sum(approvedWindow.current.map((p) => p.amount))),
    replies: usage.current.length,
    ai_cost_usd: Math.round(sum(usage.current.map((r) => Number(r.cost_usd) || 0)) * 1e4) / 1e4
  };
  const previous = {
    signups: signups.previous.length,
    revenue: round2(sum(approvedWindow.previous.map((p) => p.amount))),
    replies: usage.previous.length,
    ai_cost_usd: Math.round(sum(usage.previous.map((r) => Number(r.cost_usd) || 0)) * 1e4) / 1e4
  };

  return {
    days: keys,
    series: {
      signups: seriesBy(signups.current, keys),
      revenue: seriesBy(approvedWindow.current, keys, null, (p) => p.amount),
      replies: seriesBy(usage.current, keys),
      ai_cost_usd: seriesBy(usage.current, keys, null, (r) => Number(r.cost_usd) || 0)
    },
    totals,
    previous,
    kpis: {
      tenants_total: tenants.length,
      states,
      mrr_estimate: Math.round(mrr),
      revenue_all_time: round2(sum(approved.map((p) => p.amount))),
      pending_payments: pending.length,
      pending_amount: round2(sum(pending.map((p) => money(p.amount)))),
      replies_today: seriesBy(usageRes.rows, [keys[keys.length - 1]])[0],
      fb_connected: fbRes.rows[0].c,
      wa_connected: waRes.rows[0].c
    },
    plan_mix: planMix,
    top_tenants: topTenants,
    expiring_soon: expiringSoon.slice(0, 8)
  };
}

module.exports = { getTenantAnalytics, getPlatformAnalytics, buildDays, dayKey, rangeStart, money };
