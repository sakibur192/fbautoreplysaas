// ============================================================
// One place that knows the Meta App's settings and how to talk to Meta's
// Graph API about them.
//
// Values are set from /superadmin → Meta Setup and stored in the
// platform_settings table. If a value isn't set there, it falls back to
// whatever is in config.js, so an existing deployment that already has
// FB_APP_ID etc. in config.js keeps working untouched.
// ============================================================

const crypto = require('crypto');
const axios = require('axios');
const config = require('./config');
const db = require('./db');

// Meta retires Graph API versions about two years after release; calls to a
// retired version get silently upgraded, which is how things break without
// warning. One constant, used everywhere, overridable from config.js.
const GRAPH_VERSION = (config.FB_GRAPH_VERSION && String(config.FB_GRAPH_VERSION).trim()) || 'v23.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

const PLACEHOLDER_URL = 'https://your-domain.example.com';
const PLACEHOLDER_TOKEN = 'change-this-verify-token';

// Which webhook "objects" the app listens to, and which fields on each.
const WEBHOOK_OBJECTS = [
  { object: 'page', fields: 'messages,messaging_postbacks', label: 'Facebook Messenger' },
  { object: 'instagram', fields: 'messages', label: 'Instagram DMs' },
  { object: 'whatsapp_business_account', fields: 'messages', label: 'WhatsApp' }
];

let cache = null;
let cacheAt = 0;
const CACHE_MS = 5000;

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Resolves every Meta setting: the panel value wins, config.js is the
// fallback, and the shipped placeholder values count as "not set".
async function getMetaConfig(force) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;

  let s = {};
  try {
    s = await db.getPlatformSettings();
  } catch (err) {
    // Never let a database hiccup take the webhook down — config.js alone
    // is still enough to answer Meta.
    console.error('[metaconfig] could not read platform settings:', err.message);
  }

  const pick = (dbKey, cfgKey, placeholder) => {
    const fromDb = clean(s[dbKey]);
    if (fromDb) return { value: fromDb, source: 'panel' };
    const fromCfg = clean(config[cfgKey]);
    if (fromCfg && fromCfg !== placeholder) return { value: fromCfg, source: 'config.js' };
    return { value: '', source: 'unset' };
  };

  const base = pick('meta_public_base_url', 'PUBLIC_BASE_URL', PLACEHOLDER_URL);
  const appId = pick('meta_app_id', 'FB_APP_ID');
  const secret = pick('meta_app_secret', 'FB_APP_SECRET');
  const token = pick('meta_webhook_verify_token', 'FB_WEBHOOK_VERIFY_TOKEN', PLACEHOLDER_TOKEN);
  const waCfg = pick('meta_wa_config_id', 'WA_EMBEDDED_SIGNUP_CONFIG_ID');
  const waToken = clean(s.platform_wa_system_user_token);

  cache = {
    publicBaseUrl: base.value.replace(/\/+$/, ''),
    appId: appId.value,
    appSecret: secret.value,
    verifyToken: token.value,
    waConfigId: waCfg.value,
    waSystemToken: waToken,
    sources: {
      public_base_url: base.source,
      app_id: appId.source,
      app_secret: secret.source,
      verify_token: token.source,
      wa_config_id: waCfg.source
    }
  };
  cacheAt = Date.now();
  return cache;
}

function invalidate() {
  cache = null;
}

function derived(mc) {
  const base = mc.publicBaseUrl;
  let host = '';
  try { host = base ? new URL(base).host : ''; } catch (e) { /* bad url */ }
  return {
    webhook_url: base ? base + '/webhook' : '',
    oauth_redirect_uri: base ? base + '/api/connect/facebook/callback' : '',
    app_domain: host
  };
}

function appToken(mc) {
  return mc.appId + '|' + mc.appSecret;
}

// Turns an axios error into something safe and readable. `kind` is
// 'rejected' when Meta answered with an error (bad id/secret/params) and
// 'network' when we never got an answer (offline, DNS, timeout).
function explainGraphError(err) {
  const data = err && err.response && err.response.data;
  const metaErr = data && data.error;
  if (metaErr) {
    return { kind: 'rejected', message: metaErr.message || 'Meta rejected the request.', code: metaErr.code };
  }
  if (err && err.response) {
    return { kind: 'rejected', message: 'Meta answered with HTTP ' + err.response.status + '.', code: err.response.status };
  }
  return { kind: 'network', message: 'Could not reach Meta (' + ((err && err.message) || 'network error') + ').' };
}

// ---- Calls using the app's own credentials ----

async function fetchAppInfo(mc) {
  const res = await axios.get(`${GRAPH}/${encodeURIComponent(mc.appId)}`, {
    params: { fields: 'name,link', access_token: appToken(mc) },
    timeout: 12000
  });
  return res.data; // { name, link, id }
}

async function fetchSubscriptions(mc) {
  const res = await axios.get(`${GRAPH}/${encodeURIComponent(mc.appId)}/subscriptions`, {
    params: { access_token: appToken(mc) },
    timeout: 12000
  });
  return res.data.data || [];
}

// Registers (or updates) the app's webhook for each object. Meta calls our
// GET /webhook with the verify token while this request is in flight, so
// the settings must already be saved and the public URL must be reachable.
async function registerWebhooks(mc) {
  const callback = derived(mc).webhook_url;
  const results = [];
  for (const w of WEBHOOK_OBJECTS) {
    try {
      await axios.post(`${GRAPH}/${encodeURIComponent(mc.appId)}/subscriptions`, null, {
        params: {
          object: w.object,
          callback_url: callback,
          fields: w.fields,
          verify_token: mc.verifyToken,
          access_token: appToken(mc)
        },
        timeout: 20000
      });
      results.push({ object: w.object, label: w.label, ok: true });
    } catch (err) {
      results.push({ object: w.object, label: w.label, ok: false, error: explainGraphError(err).message });
    }
  }
  return results;
}

// ---- Per-tenant subscriptions ----
// Registering the app-level webhook is not enough on its own: each Page and
// each WhatsApp Business Account also has to be subscribed to the app, or
// Meta never delivers that tenant's messages.

async function subscribePage(pageId, pageToken) {
  await axios.post(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, null, {
    params: { subscribed_fields: 'messages,messaging_postbacks', access_token: pageToken },
    timeout: 15000
  });
}

async function unsubscribePage(pageId, pageToken) {
  await axios.delete(`${GRAPH}/${encodeURIComponent(pageId)}/subscribed_apps`, {
    params: { access_token: pageToken },
    timeout: 15000
  });
}

async function subscribeWaba(wabaId, accessToken) {
  await axios.post(`${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, null, {
    params: { access_token: accessToken },
    timeout: 15000
  });
}

// ---- Webhook signature ----
// Meta signs every webhook body with the app secret (HMAC-SHA256, sent as
// "X-Hub-Signature-256: sha256=<hex>"). Checking it proves the request
// really came from Meta and not from someone who found the webhook URL.
function verifySignature(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  GRAPH,
  GRAPH_VERSION,
  WEBHOOK_OBJECTS,
  getMetaConfig,
  invalidate,
  derived,
  appToken,
  explainGraphError,
  fetchAppInfo,
  fetchSubscriptions,
  registerWebhooks,
  subscribePage,
  unsubscribePage,
  subscribeWaba,
  verifySignature
};
