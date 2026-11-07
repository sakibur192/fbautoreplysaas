const express = require('express');
const axios = require('axios');
const db = require('./db');
const metaconfig = require('./metaconfig');

const router = express.Router();
const FB_GRAPH = metaconfig.GRAPH;

function requireTenantSession(req, res, next) {
  if (req.session && req.session.tenantId) return next();
  return res.redirect('/admin'); // bounce to login if the session was lost mid-flow
}

const SUBSCRIBE_FAILED_MSG = "Your Page is connected, but we couldn't switch on message delivery for it. Please disconnect and connect again, and contact support if it keeps happening.";

// Each connected Page must also be subscribed to our app, otherwise Meta
// never sends us that Page's messages. Failure is logged but never blocks
// the connection itself.
async function trySubscribePage(pageId, pageToken) {
  try {
    await metaconfig.subscribePage(pageId, pageToken);
    return true;
  } catch (err) {
    console.error('[facebook-oauth] subscribe page failed:', metaconfig.explainGraphError(err).message);
    return false;
  }
}

// ================= Facebook Page Connect (OAuth) =================

// Step 1: tenant clicks "Connect Facebook Page" in their Settings tab,
// which links here. We send them to Facebook's own login/consent screen.
router.get('/facebook/start', requireTenantSession, async (req, res) => {
  const mc = await metaconfig.getMetaConfig();
  if (!mc.appId || !mc.publicBaseUrl) {
    return res.redirect('/admin?fb_error=' + encodeURIComponent('Facebook connect is not set up yet — the platform owner needs to finish Meta Setup.'));
  }
  const redirectUri = `${mc.publicBaseUrl}/api/connect/facebook/callback`;
  const scope = [
    'pages_show_list',
    'pages_messaging',
    'pages_manage_metadata',
    'pages_read_engagement',
    'instagram_basic',
    'instagram_manage_messages'
  ].join(',');
  const authUrl =
    `https://www.facebook.com/${metaconfig.GRAPH_VERSION}/dialog/oauth` +
    `?client_id=${encodeURIComponent(mc.appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(String(req.session.tenantId))}`;
  res.redirect(authUrl);
});

// Step 2: Facebook redirects back here with a `code` (or `error` if the
// tenant cancelled). We exchange it for a token, then list the Pages
// they manage — each with its own ready-to-use Page Access Token.
router.get('/facebook/callback', requireTenantSession, async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/admin?fb_error=' + encodeURIComponent('Connection cancelled.'));
  if (!code) return res.redirect('/admin?fb_error=' + encodeURIComponent('No authorization code received.'));

  try {
    const mc = await metaconfig.getMetaConfig();
    const redirectUri = `${mc.publicBaseUrl}/api/connect/facebook/callback`;

    const shortLived = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
      params: { client_id: mc.appId, client_secret: mc.appSecret, redirect_uri: redirectUri, code }
    });

    const longLived = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: mc.appId,
        client_secret: mc.appSecret,
        fb_exchange_token: shortLived.data.access_token
      }
    });

    const pagesRes = await axios.get(`${FB_GRAPH}/me/accounts`, {
      params: { access_token: longLived.data.access_token, fields: 'id,name,access_token' }
    });
    const pages = pagesRes.data.data || [];

    if (pages.length === 0) {
      return res.redirect('/admin?fb_error=' + encodeURIComponent('No Facebook Pages found — make sure you are an admin of at least one Page.'));
    }

    if (pages.length === 1) {
      await db.updateSettings(req.session.tenantId, {
        fb_page_id: pages[0].id,
        fb_page_name: pages[0].name,
        fb_page_access_token: pages[0].access_token,
        fb_enabled: 'true'
      });
      const subscribed = await trySubscribePage(pages[0].id, pages[0].access_token);
      return res.redirect(subscribed ? '/admin?fb_connected=1' : '/admin?fb_error=' + encodeURIComponent(SUBSCRIBE_FAILED_MSG));
    }

    // Multiple Pages — stash them in the session and let the tenant pick.
    req.session.fbPendingPages = pages.map((p) => ({ id: p.id, name: p.name, access_token: p.access_token }));
    return res.redirect('/admin?fb_pick_page=1');
  } catch (err) {
    console.error('[facebook-oauth] callback failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    return res.redirect('/admin?fb_error=' + encodeURIComponent('Something went wrong connecting your Page. Please try again.'));
  }
});

router.get('/facebook/pending-pages', requireTenantSession, (req, res) => {
  res.json((req.session.fbPendingPages || []).map((p) => ({ id: p.id, name: p.name })));
});

router.post('/facebook/select-page', requireTenantSession, async (req, res) => {
  const page = (req.session.fbPendingPages || []).find((p) => p.id === req.body.page_id);
  if (!page) return res.status(400).json({ error: 'That page is no longer in your pending list — please reconnect.' });
  await db.updateSettings(req.session.tenantId, {
    fb_page_id: page.id,
    fb_page_name: page.name,
    fb_page_access_token: page.access_token,
    fb_enabled: 'true'
  });
  delete req.session.fbPendingPages;
  const subscribed = await trySubscribePage(page.id, page.access_token);
  if (!subscribed) return res.json({ ok: true, warning: SUBSCRIBE_FAILED_MSG });
  res.json({ ok: true });
});

router.post('/facebook/disconnect', requireTenantSession, async (req, res) => {
  // Best effort: stop Meta delivering this Page's messages to us.
  try {
    const current = await db.getSettings(req.session.tenantId);
    if (current.fb_page_id && current.fb_page_access_token) {
      await metaconfig.unsubscribePage(current.fb_page_id, current.fb_page_access_token);
    }
  } catch (err) {
    console.error('[facebook-oauth] unsubscribe failed:', metaconfig.explainGraphError(err).message);
  }
  await db.updateSettings(req.session.tenantId, {
    fb_page_id: '',
    fb_page_name: '',
    fb_page_access_token: '',
    fb_enabled: 'false'
  });
  res.json({ ok: true });
});

// ================= WhatsApp Embedded Signup =================
// The frontend runs Facebook's JS SDK popup (see public/admin/index.html)
// and posts us the resulting `code` plus the phone_number_id/waba_id the
// popup reports via postMessage. We exchange the code for a token once
// (mainly to confirm the grant succeeded) — actual sending uses the ONE
// platform-wide System User token set in the super admin panel, which is
// how Meta's Tech Provider model is meant to work: permission is granted
// per-WABA to your app, and your one system user token can act on all of
// them from then on.
router.post('/whatsapp/embedded-signup/callback', requireTenantSession, async (req, res) => {
  const { code, phone_number_id, waba_id, display_phone_number } = req.body;
  if (!phone_number_id || !waba_id) {
    return res.status(400).json({ error: 'Missing phone_number_id/waba_id from the signup popup.' });
  }

  try {
    const mc = await metaconfig.getMetaConfig();
    let businessToken = null;
    if (code && mc.appId && mc.appSecret) {
      // Confirms the grant succeeded. The token isn't stored — sending uses
      // the one platform-wide system user token — but it's good for the
      // one-off subscription call below.
      const exchanged = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
        params: { client_id: mc.appId, client_secret: mc.appSecret, code }
      });
      businessToken = exchanged.data && exchanged.data.access_token;
    }

    // Subscribe this WhatsApp Business Account to our app so its incoming
    // messages are delivered to /webhook. Non-fatal: the number is saved
    // either way, but without this the tenant would never get replies.
    let subscribeWarning = null;
    const subToken = businessToken || mc.waSystemToken;
    if (subToken) {
      try {
        await metaconfig.subscribeWaba(waba_id, subToken);
      } catch (err) {
        console.error('[whatsapp-signup] subscribe WABA failed:', metaconfig.explainGraphError(err).message);
        subscribeWarning = "Number connected, but we couldn't switch on message delivery for it. Please contact support.";
      }
    } else {
      subscribeWarning = "Number connected, but message delivery isn't switched on yet — the platform owner still needs to add the WhatsApp system token.";
    }

    await db.updateSettings(req.session.tenantId, {
      wa_cloud_phone_number_id: phone_number_id,
      wa_cloud_waba_id: waba_id,
      wa_cloud_display_number: display_phone_number || '',
      whatsapp_enabled: 'true'
    });
    res.json({ ok: true, warning: subscribeWarning || undefined });
  } catch (err) {
    console.error('[whatsapp-embedded-signup] failed:', err.response ? JSON.stringify(err.response.data) : err.message);
    res.status(500).json({ error: 'Could not finish connecting WhatsApp. Please try again.' });
  }
});

router.post('/whatsapp/disconnect', requireTenantSession, async (req, res) => {
  await db.updateSettings(req.session.tenantId, {
    wa_cloud_phone_number_id: '',
    wa_cloud_waba_id: '',
    wa_cloud_display_number: '',
    wa_cloud_access_token: ''
  });
  res.json({ ok: true });
});

module.exports = { router };