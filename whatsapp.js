const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const { humanDelay } = require('./pacing');

// One Client per tenant, keyed by tenant id. Created lazily the first
// time a tenant clicks "Connect" in their admin panel — we don't spin up
// a headless Chrome for every signup, only for tenants actually using
// WhatsApp. Sessions persist on disk so a server restart doesn't force
// a re-scan.
const clients = new Map(); // tenantId -> Client
const statuses = new Map(); // tenantId -> 'disconnected' | 'qr' | 'connected'

function getStatus(tenantId) {
  return statuses.get(tenantId) || 'disconnected';
}

function connectTenant(tenantId, io) {
  if (clients.has(tenantId)) return; // already connecting/connected

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `tenant_${tenantId}`,
      dataPath: path.join(__dirname, 'wwebjs_sessions')
    }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  statuses.set(tenantId, 'disconnected');

  client.on('qr', async (qr) => {
    statuses.set(tenantId, 'qr');
    const dataUrl = await QRCode.toDataURL(qr);
    io.to(`tenant-${tenantId}`).emit('wa-qr', dataUrl);
    io.to(`tenant-${tenantId}`).emit('wa-status', 'qr');
  });

  client.on('ready', () => {
    statuses.set(tenantId, 'connected');
    io.to(`tenant-${tenantId}`).emit('wa-status', 'connected');
    console.log(`[whatsapp] tenant ${tenantId} client ready`);
  });

  client.on('disconnected', (reason) => {
    statuses.set(tenantId, 'disconnected');
    io.to(`tenant-${tenantId}`).emit('wa-status', 'disconnected');
    console.log(`[whatsapp] tenant ${tenantId} disconnected:`, reason);
    clients.delete(tenantId);
  });

  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;

      // Gate every single reply on live subscription status — this is
      // what makes "expired = auto-pause, no reconnect needed" work.
      const tenant = await db.getTenantById(tenantId);
      if (!db.isTenantActive(tenant)) return;

      const settings = await db.getSettings(tenantId);
      if (settings.whatsapp_enabled !== 'true') return;
      if (settings.whatsapp_mode === 'cloud_api') return; // this tenant uses the official API instead

      let text = msg.body || '';
      let imageData = null;
      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          if (media && media.mimetype && media.mimetype.startsWith('image/')) {
            imageData = { base64: media.data, mimeType: media.mimetype };
          }
        } catch (err) {
          console.error(`[whatsapp] tenant ${tenantId} media download failed:`, err.message);
        }
      }
      if (!text && !imageData) return; // nothing usable (e.g. audio note, sticker)

      const contact = await msg.getContact();
      const conversation = await db.getOrCreateConversation(
        tenantId,
        'whatsapp',
        msg.from,
        contact.pushname || contact.number || msg.from
      );

      await db.addMessage(conversation.id, 'in', 'user', text || '[Image]');
      if (!conversation.ai_enabled) return;

      const reply = await ai.generateReply(tenantId, conversation.id, text, imageData);

      // Anti-ban pacing: show a typing indicator and wait a human-like
      // amount of time before sending, instead of replying instantly.
      try {
        const chat = await msg.getChat();
        await chat.sendStateTyping();
      } catch (e) { /* non-fatal if typing indicator fails */ }
      await humanDelay();

      await msg.reply(reply);
      await db.addMessage(conversation.id, 'out', 'ai', reply);
    } catch (err) {
      console.error(`[whatsapp] tenant ${tenantId} message handling failed:`, err.message);
    }
  });

  clients.set(tenantId, client);
  client.initialize();
}

async function resetSession(tenantId) {
  const client = clients.get(tenantId);
  if (client) {
    try {
      await client.destroy();
    } catch (e) {
      console.error(`[whatsapp] tenant ${tenantId} error destroying client:`, e.message);
    }
    clients.delete(tenantId);
  }
  statuses.set(tenantId, 'disconnected');
}

module.exports = { connectTenant, getStatus, resetSession };
