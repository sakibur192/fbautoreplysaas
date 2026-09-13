const express = require('express');
const axios = require('axios');
const config = require('./config');
const db = require('./db');
const ai = require('./ai');
const { humanDelay } = require('./pacing');
const { fetchPublicImageAsBase64, fetchWhatsappCloudMedia } = require('./media');

const router = express.Router();

// --- Webhook verification (Meta calls this once when you set this URL up) ---
// One Meta App, one verify token, covers both the Messenger and the
// WhatsApp Business Account webhook subscriptions.
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.FB_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Incoming events, from ANY tenant's Page or WhatsApp number ---
router.post('/', async (req, res) => {
  res.sendStatus(200); // ack immediately so Meta doesn't retry

  try {
    const body = req.body;
    if (body.object === 'page') {
      await handleFacebookEntries(body.entry || []);
    } else if (body.object === 'whatsapp_business_account') {
      await handleWhatsappCloudEntries(body.entry || []);
    }
  } catch (err) {
    console.error('[meta-webhook] handling error:', err.message);
  }
});

// ================= Facebook Messenger =================
async function handleFacebookEntries(entries) {
  for (const entry of entries) {
    const pageId = entry.id;
    const tenantId = await db.getTenantIdByFacebookPageId(pageId);
    if (!tenantId) continue;

    const tenant = await db.getTenantById(tenantId);
    if (!db.isTenantActive(tenant)) continue;

    const settings = await db.getSettings(tenantId);
    if (settings.fb_enabled !== 'true') continue;

    for (const event of entry.messaging || []) {
      const senderId = event.sender && event.sender.id;
      if (!senderId || !event.message) continue;

      const text = event.message.text || '';
      const imageAttachment = (event.message.attachments || []).find((a) => a.type === 'image');
      if (!text && !imageAttachment) continue;

      let imageData = null;
      if (imageAttachment && imageAttachment.payload && imageAttachment.payload.url) {
        try {
          imageData = await fetchPublicImageAsBase64(imageAttachment.payload.url);
        } catch (err) {
          console.error(`[facebook] tenant ${tenantId} image download failed:`, err.message);
        }
      }

      const conversation = await db.getOrCreateConversation(tenantId, 'facebook', senderId, null);
      await db.addMessage(conversation.id, 'in', 'user', text || '[Image]');
      if (!conversation.ai_enabled) continue;

      const usage = await db.getReplyUsage(tenantId);
      if (usage.exceeded) {
        const limitMsg = ai.channelSetting(settings, 'facebook', 'limit_reached_message');
        try {
          await humanDelay();
          await sendFacebookMessage(settings.fb_page_access_token, senderId, limitMsg);
          await db.addMessage(conversation.id, 'out', 'system', limitMsg);
        } catch (err) {
          console.error(`[facebook] tenant ${tenantId} limit-reached message failed:`, err.message);
        }
        continue;
      }

      try {
        let reply = await ai.generateReply(tenantId, conversation.id, text, imageData, 'facebook');
        if (settings.bot_disclosure_enabled !== 'false' && db.shouldShowDisclosure(conversation)) {
          reply = `${settings.bot_disclosure_message}\n\n${reply}`;
          await db.markDisclosureShown(conversation.id);
        }
        await humanDelay();
        await sendFacebookMessage(settings.fb_page_access_token, senderId, reply);
        await db.addMessage(conversation.id, 'out', 'ai', reply);
      } catch (err) {
        console.error(`[facebook] tenant ${tenantId} AI reply failed:`, err.message);
        const fallbackMsg = ai.channelSetting(settings, 'facebook', 'fallback_message');
        try {
          await humanDelay();
          await sendFacebookMessage(settings.fb_page_access_token, senderId, fallbackMsg);
          await db.addMessage(conversation.id, 'out', 'system', fallbackMsg);
        } catch (err2) {
          console.error(`[facebook] tenant ${tenantId} fallback reply also failed:`, err2.message);
        }
      }
    }
  }
}

async function sendFacebookMessage(pageAccessToken, psid, text) {
  if (!pageAccessToken) throw new Error('Facebook Page Access Token is not set.');
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages`,
    { recipient: { id: psid }, message: { text } },
    { params: { access_token: pageAccessToken } }
  );
}

// ================= WhatsApp Cloud API (official) =================
async function handleWhatsappCloudEntries(entries) {
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value;
      if (!value || !value.metadata) continue;

      const phoneNumberId = value.metadata.phone_number_id;
      const tenantId = await db.getTenantIdByWaPhoneNumberId(phoneNumberId);
      if (!tenantId) continue;

      const tenant = await db.getTenantById(tenantId);
      if (!db.isTenantActive(tenant)) continue;

      const settings = await db.getSettings(tenantId);
      if (settings.whatsapp_enabled !== 'true' || settings.whatsapp_mode !== 'cloud_api') continue;

      // Tenants connected via Embedded Signup have no token of their own —
      // sending uses the one platform-wide system user token instead. A
      // tenant's own wa_cloud_access_token (manual setup) still wins if set.
      const platformSettings = await db.getPlatformSettings();
      const accessToken = settings.wa_cloud_access_token || platformSettings.platform_wa_system_user_token;

      for (const message of value.messages || []) {
        const from = message.from;
        if (!from) continue;

        let text = '';
        let imageData = null;

        if (message.type === 'text') {
          text = message.text && message.text.body;
        } else if (message.type === 'image') {
          text = (message.image && message.image.caption) || '';
          try {
            imageData = await fetchWhatsappCloudMedia(message.image.id, accessToken);
          } catch (err) {
            console.error(`[whatsapp-cloud] tenant ${tenantId} media download failed:`, err.message);
          }
        } else {
          continue; // skip audio/video/documents/etc. for now
        }
        if (!text && !imageData) continue;

        const contactProfile = (value.contacts || []).find((c) => c.wa_id === from);
        const contactName = contactProfile && contactProfile.profile && contactProfile.profile.name;

        const conversation = await db.getOrCreateConversation(tenantId, 'whatsapp', from, contactName || from);
        await db.addMessage(conversation.id, 'in', 'user', text || '[Image]');
        if (!conversation.ai_enabled) continue;

        const usage = await db.getReplyUsage(tenantId);
        if (usage.exceeded) {
          const limitMsg = ai.channelSetting(settings, 'whatsapp', 'limit_reached_message');
          try {
            await humanDelay();
            await sendWhatsappCloudMessage(settings.wa_cloud_phone_number_id, accessToken, from, limitMsg);
            await db.addMessage(conversation.id, 'out', 'system', limitMsg);
          } catch (err) {
            console.error(`[whatsapp-cloud] tenant ${tenantId} limit-reached message failed:`, err.message);
          }
          continue;
        }

        try {
          let reply = await ai.generateReply(tenantId, conversation.id, text, imageData, 'whatsapp');
          if (settings.bot_disclosure_enabled !== 'false' && db.shouldShowDisclosure(conversation)) {
            reply = `${settings.bot_disclosure_message}\n\n${reply}`;
            await db.markDisclosureShown(conversation.id);
          }
          await humanDelay();
          await sendWhatsappCloudMessage(settings.wa_cloud_phone_number_id, accessToken, from, reply);
          await db.addMessage(conversation.id, 'out', 'ai', reply);
        } catch (err) {
          console.error(`[whatsapp-cloud] tenant ${tenantId} AI reply failed:`, err.message);
          const fallbackMsg = ai.channelSetting(settings, 'whatsapp', 'fallback_message');
          try {
            await humanDelay();
            await sendWhatsappCloudMessage(settings.wa_cloud_phone_number_id, accessToken, from, fallbackMsg);
            await db.addMessage(conversation.id, 'out', 'system', fallbackMsg);
          } catch (err2) {
            console.error(`[whatsapp-cloud] tenant ${tenantId} fallback reply also failed:`, err2.message);
          }
        }
      }
    }
  }
}

async function sendWhatsappCloudMessage(phoneNumberId, accessToken, to, text) {
  if (!phoneNumberId || !accessToken) {
    throw new Error('WhatsApp Cloud API Phone Number ID / Access Token is not set.');
  }
  await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
}

module.exports = { router };
