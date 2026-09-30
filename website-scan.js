// Fetches a tenant's website, strips it down to plain text, and asks the
// AI to turn it into a short business-profile summary — saved as the
// editable `website_info` setting and fed into the AI's system prompt
// alongside the product catalog (see ai.js).
const axios = require('axios');
const db = require('./db');

const MAX_HTML_BYTES = 1_500_000; // don't try to read an enormous page
const MAX_TEXT_CHARS = 12000; // keep the AI prompt a reasonable size

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function scanWebsite(tenantId, rawUrl) {
  let url = String(rawUrl).trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  let html;
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      maxContentLength: MAX_HTML_BYTES,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BaybexAI-WebsiteScan/1.0)' },
      validateStatus: (s) => s >= 200 && s < 400
    });
    html = String(res.data);
  } catch (err) {
    throw new Error('Could not fetch that website — check the URL and that the site is publicly reachable.');
  }

  const text = stripHtmlToText(html).slice(0, MAX_TEXT_CHARS);
  if (!text || text.length < 40) {
    throw new Error('That page had little to no readable text to learn from.');
  }

  const prompt =
    'The following is raw text extracted from a business\'s website. Write a concise business-profile ' +
    'summary a customer-support AI can use to answer general questions about this business — what it sells ' +
    'or does, its specialties, policies (shipping/returns/hours) if mentioned, and anything else a customer ' +
    'might ask about. Plain text, a few short paragraphs, no markdown headers. If the page is clearly not a ' +
    'real business (e.g. a parked domain or an error page), say so plainly instead of inventing details.\n\n' +
    '--- WEBSITE TEXT ---\n' + text;

  return ai_summarize(tenantId, prompt);
}

// Kept as its own function (rather than inlined) so it can reuse whichever
// AI credentials are already configured for this tenant — same resolution
// order (tenant override, then universal platform key) as normal replies.
async function ai_summarize(tenantId, prompt) {
  const ai = require('./ai'); // required lazily to avoid a require cycle (ai.js doesn't need this file)
  return ai.generateFreeformText(tenantId, prompt);
}

module.exports = { scanWebsite, stripHtmlToText };
