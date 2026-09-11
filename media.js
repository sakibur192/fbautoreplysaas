const axios = require('axios');

/**
 * Downloads an image from a plain public URL (e.g. a Facebook attachment
 * CDN link) and returns it as base64 + mime type, ready to hand to a
 * vision-capable model.
 */
async function fetchPublicImageAsBase64(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  const mimeType = (res.headers['content-type'] || 'image/jpeg').split(';')[0];
  return { base64: Buffer.from(res.data).toString('base64'), mimeType };
}

/**
 * Downloads a WhatsApp Cloud API media object. This is a two-step fetch:
 * first resolve the media ID to a temporary signed URL, then download the
 * bytes from that URL — both calls need the tenant's own access token.
 */
async function fetchWhatsappCloudMedia(mediaId, accessToken) {
  const metaRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const { url, mime_type } = metaRes.data;
  const fileRes = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    responseType: 'arraybuffer'
  });
  return { base64: Buffer.from(fileRes.data).toString('base64'), mimeType: mime_type || 'image/jpeg' };
}

module.exports = { fetchPublicImageAsBase64, fetchWhatsappCloudMedia };
