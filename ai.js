const OpenAI = require('openai');
const config = require('./config');
const db = require('./db');
const { estimateCostUsd } = require('./pricing');

// ---------- shared: order/payment tools the AI can call ----------
// Same two actions regardless of provider: confirm an order once details
// are agreed, and record a payment once a transaction ID/amount is known
// (typed by the customer, or read off a payment screenshot they sent).
async function executeToolCall(tenantId, conversationId, name, args) {
  try {
    if (name === 'confirm_order') {
      const order = await db.createOrder(
        tenantId,
        conversationId,
        args.items || [],
        args.total_amount,
        args.customer_name,
        args.delivery_address,
        args.note
      );
      return { ok: true, order_id: order.id };
    }
    if (name === 'record_payment') {
      const order = await db.recordPayment(tenantId, conversationId, args.trx_id, args.amount);
      return { ok: true, order_id: order ? order.id : null };
    }
    return { ok: false, error: 'Unknown tool: ' + name };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const ORDER_TOOL_INSTRUCTIONS =
  "You can confirm orders and record payments using the tools available to you. " +
  "When a customer wants to buy something, agree the exact items, quantities and total price with " +
  "them in the conversation first, then call confirm_order. If the customer sends a photo that looks " +
  "like a payment screenshot (e.g. a bKash/Nagad transaction confirmation), read the transaction ID and " +
  "amount from it and call record_payment. If you can't clearly read the transaction ID or amount from " +
  "an image, ask the customer to type it rather than guessing.";

// ---------- OpenAI ----------
const OPENAI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'confirm_order',
      description: "Confirm a customer's order once you've agreed the exact items, quantities, and total price with them.",
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                quantity: { type: 'string' },
                price: { type: 'string' }
              },
              required: ['name']
            }
          },
          total_amount: { type: 'string' },
          customer_name: { type: 'string' },
          delivery_address: { type: 'string' },
          note: { type: 'string' }
        },
        required: ['items', 'total_amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'record_payment',
      description: 'Record a payment once you have a transaction ID and amount, whether typed by the customer or read from a payment screenshot.',
      parameters: {
        type: 'object',
        properties: {
          trx_id: { type: 'string' },
          amount: { type: 'string' }
        },
        required: ['trx_id']
      }
    }
  }
];

async function generateOpenAIReply(tenantId, conversationId, settings, systemPrompt, priorHistory, latestUserMessage, imageData, useTools) {
  const openai = new OpenAI({ apiKey: settings.openai_api_key });
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of priorHistory) {
    messages.push({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.content });
  }

  if (imageData) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: latestUserMessage || 'Please check this image.' },
        { type: 'image_url', image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` } }
      ]
    });
  } else {
    messages.push({ role: 'user', content: latestUserMessage });
  }

  const callOptions = { model: settings.openai_model || 'gpt-4o-mini', messages };
  if (useTools) callOptions.tools = OPENAI_TOOLS;

  let completion = await openai.chat.completions.create(callOptions);
  let choice = completion.choices[0];
  let inputTokens = (completion.usage && completion.usage.prompt_tokens) || 0;
  let outputTokens = (completion.usage && completion.usage.completion_tokens) || 0;

  if (choice.message.tool_calls && choice.message.tool_calls.length) {
    messages.push(choice.message);
    for (const toolCall of choice.message.tool_calls) {
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch (e) { /* leave empty */ }
      const result = await executeToolCall(tenantId, conversationId, toolCall.function.name, args);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
    }
    completion = await openai.chat.completions.create({ model: settings.openai_model || 'gpt-4o-mini', messages });
    choice = completion.choices[0];
    inputTokens += (completion.usage && completion.usage.prompt_tokens) || 0;
    outputTokens += (completion.usage && completion.usage.completion_tokens) || 0;
  }

  return { text: choice.message.content.trim(), inputTokens, outputTokens };
}

// ---------- Gemini ----------
// Uses Google's current @google/genai SDK. This SDK is explicitly marked
// experimental by Google and changes fairly often — if a tenant reports
// Gemini replies failing, check https://googleapis.github.io/js-genai/
// for anything that shifted in the function-calling / vision API shape.
const GEMINI_TOOLS_BUILDER = () => {
  const { Type } = require('@google/genai');
  return [{
    functionDeclarations: [
      {
        name: 'confirm_order',
        description: "Confirm a customer's order once you've agreed the exact items, quantities, and total price with them.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  quantity: { type: Type.STRING },
                  price: { type: Type.STRING }
                }
              }
            },
            total_amount: { type: Type.STRING },
            customer_name: { type: Type.STRING },
            delivery_address: { type: Type.STRING },
            note: { type: Type.STRING }
          },
          required: ['items', 'total_amount']
        }
      },
      {
        name: 'record_payment',
        description: 'Record a payment once you have a transaction ID and amount, whether typed by the customer or read from a payment screenshot.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            trx_id: { type: Type.STRING },
            amount: { type: Type.STRING }
          },
          required: ['trx_id']
        }
      }
    ]
  }];
};

async function generateGeminiReply(tenantId, conversationId, settings, priorHistory, systemPrompt, latestUserMessage, imageData, useTools) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey: settings.gemini_api_key });
  const model = settings.gemini_model || 'gemini-3.5-flash';

  let contents = priorHistory.map((m) => ({
    role: m.direction === 'in' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  if (imageData) {
    contents.push({
      role: 'user',
      parts: [{ text: latestUserMessage || 'Please check this image.' }, { inlineData: { data: imageData.base64, mimeType: imageData.mimeType } }]
    });
  } else {
    contents.push({ role: 'user', parts: [{ text: latestUserMessage }] });
  }

  const config2 = { systemInstruction: systemPrompt };
  if (useTools) config2.tools = GEMINI_TOOLS_BUILDER();

  let response = await ai.models.generateContent({ model, contents, config: config2 });
  const calls = response.functionCalls;
  let inputTokens = (response.usageMetadata && response.usageMetadata.promptTokenCount) || 0;
  let outputTokens = (response.usageMetadata && response.usageMetadata.candidatesTokenCount) || 0;

  if (calls && calls.length) {
    contents.push({ role: 'model', parts: calls.map((c) => ({ functionCall: c })) });
    for (const call of calls) {
      const result = await executeToolCall(tenantId, conversationId, call.name, call.args || {});
      contents.push({ role: 'user', parts: [{ functionResponse: { name: call.name, response: result } }] });
    }
    response = await ai.models.generateContent({ model, contents, config: { systemInstruction: systemPrompt } });
    inputTokens += (response.usageMetadata && response.usageMetadata.promptTokenCount) || 0;
    outputTokens += (response.usageMetadata && response.usageMetadata.candidatesTokenCount) || 0;
  }

  return { text: response.text.trim(), inputTokens, outputTokens };
}

// Picks a channel-specific override when reply_mode is 'separate' and the
// tenant has actually set one, otherwise falls back to the shared/unified
// value — so switching to "separate" mode doesn't blank out anything
// they haven't customized yet.
const CHANNEL_PREFIXES = { facebook: 'fb_', instagram: 'ig_', whatsapp: 'wa_' };
function channelSetting(settings, platform, baseKey) {
  if (settings.reply_mode === 'separate') {
    const prefixed = (CHANNEL_PREFIXES[platform] || 'wa_') + baseKey;
    if (settings[prefixed] !== undefined && settings[prefixed] !== '') return settings[prefixed];
  }
  return settings[baseKey];
}

// Which AI credentials actually get used for this tenant's replies.
// Priority: the tenant's own super-admin-set override (if one is
// configured) → the universal platform-wide key. Tenants never see or set
// this themselves — it's set only from the super admin "AI Key" modal.
function resolveAiCredentials(settings, platformSettings) {
  if (settings.override_ai_provider === 'openai' && settings.override_openai_api_key) {
    return {
      provider: 'openai',
      openai_api_key: settings.override_openai_api_key,
      openai_model: settings.override_openai_model || 'gpt-4o-mini',
      gemini_api_key: '',
      gemini_model: '',
      usingOverride: true
    };
  }
  if (settings.override_ai_provider === 'gemini' && settings.override_gemini_api_key) {
    return {
      provider: 'gemini',
      openai_api_key: '',
      openai_model: '',
      gemini_api_key: settings.override_gemini_api_key,
      gemini_model: settings.override_gemini_model || 'gemini-3.5-flash',
      usingOverride: true
    };
  }
  return {
    provider: platformSettings.platform_ai_provider || 'openai',
    openai_api_key: platformSettings.platform_openai_api_key,
    openai_model: platformSettings.platform_openai_model || 'gpt-4o-mini',
    gemini_api_key: platformSettings.platform_gemini_api_key,
    gemini_model: platformSettings.platform_gemini_model || 'gemini-3.5-flash',
    usingOverride: false
  };
}

// ---------- dispatcher ----------
/**
 * Generate an AI reply for a tenant's conversation. Credentials resolve via
 * resolveAiCredentials(): a tenant-specific override if the super admin set
 * one, otherwise the universal platform key — tenants never set their own.
 * @param {number} tenantId
 * @param {number} conversationId
 * @param {string} latestUserMessage
 * @param {{base64: string, mimeType: string}|null} imageData - set when the
 *   customer's latest message was an image (e.g. a payment screenshot).
 * @param {'facebook'|'instagram'|'whatsapp'} platform - picks channel-specific
 *   prompt/tools settings when the tenant has "separate" reply mode enabled.
 */
async function generateReply(tenantId, conversationId, latestUserMessage, imageData = null, platform = 'whatsapp') {
  const settings = await db.getSettings(tenantId);
  const platformSettings = await db.getPlatformSettings();
  const creds = resolveAiCredentials(settings, platformSettings);

  if (creds.provider === 'gemini' && !creds.gemini_api_key) {
    throw new Error('No AI configured — set a Gemini API key in the super admin panel.');
  }
  if (creds.provider === 'openai' && !creds.openai_api_key) {
    throw new Error('No AI configured — set an OpenAI API key in the super admin panel.');
  }

  settings.openai_api_key = creds.openai_api_key;
  settings.openai_model = creds.openai_model;
  settings.gemini_api_key = creds.gemini_api_key;
  settings.gemini_model = creds.gemini_model;

  const useTools = channelSetting(settings, platform, 'order_tools_enabled') !== 'false';

  const history = await db.getRecentMessages(conversationId, config.AI_HISTORY_LIMIT);
  // The incoming message is already saved before generateReply() is called,
  // so it's the last entry in history — treat everything before it as
  // context, and build the "current turn" fresh (with the image, if any)
  // rather than duplicating it.
  const isCurrentTurnAlreadyInHistory = history.length && history[history.length - 1].direction === 'in';
  const priorHistory = isCurrentTurnAlreadyInHistory ? history.slice(0, -1) : history;

  const products = await db.listProducts(tenantId);

  let systemPrompt = channelSetting(settings, platform, 'system_prompt') || 'You are a helpful assistant.';
  if (settings.website_info) {
    systemPrompt += `\n\nHere is background information about this business, gathered from their website. Use it to answer general questions (what the business does, policies, etc.):\n\n${settings.website_info}`;
  }
  if (products.length) {
    const catalogText = products
      .map((p) => {
        const bits = [p.price ? `Price: ${p.price}` : null, p.category ? `Category: ${p.category}` : null, p.sku ? `SKU: ${p.sku}` : null,
          (p.stock_quantity !== null && p.stock_quantity !== undefined) ? `Stock: ${p.stock_quantity}` : null];
        const meta = bits.filter(Boolean).join(', ');
        return `- ${p.name}${meta ? ` (${meta})` : ''}${p.description ? `: ${p.description}` : ''}`;
      })
      .join('\n');
    systemPrompt += `\n\nHere is the current product catalog. Answer customer questions using only this information. If something isn't covered here, say you'll check and get back to them rather than guessing.\n\n${catalogText}`;
  }
  if (useTools) systemPrompt += `\n\n${ORDER_TOOL_INSTRUCTIONS}`;

  const result = creds.provider === 'gemini'
    ? await generateGeminiReply(tenantId, conversationId, settings, priorHistory, systemPrompt, latestUserMessage, imageData, useTools)
    : await generateOpenAIReply(tenantId, conversationId, settings, systemPrompt, priorHistory, latestUserMessage, imageData, useTools);

  // Cost logging must never break an actual reply — if it fails, log and
  // move on rather than losing the customer's message.
  try {
    const model = creds.provider === 'gemini' ? creds.gemini_model : creds.openai_model;
    const costUsd = estimateCostUsd(creds.provider, model, result.inputTokens, result.outputTokens);
    await db.recordAiUsage(tenantId, conversationId, creds.provider, model, result.inputTokens, result.outputTokens, costUsd, creds.usingOverride);
  } catch (err) {
    console.error(`[ai] cost logging failed for tenant ${tenantId}:`, err.message);
  }

  return result.text;
}

// ---------- connection test (for the super admin "Test AI" button) ----------
// Does a minimal, standalone call — no conversation history, no tools, no
// product catalog — so a failure here can only mean the key/model/provider
// itself is the problem, not something else in the pipeline.
// Pass a tenantId to test that specific tenant's override key instead of
// the universal platform key.
async function testConnection(tenantId = null) {
  const platformSettings = await db.getPlatformSettings();
  let creds;
  if (tenantId) {
    const settings = await db.getSettings(tenantId);
    if (!settings.override_ai_provider) {
      throw new Error('This tenant has no AI key override set — it uses the universal platform key.');
    }
    creds = resolveAiCredentials(settings, platformSettings);
  } else {
    creds = resolveAiCredentials({ override_ai_provider: '' }, platformSettings);
  }

  if (creds.provider === 'gemini') {
    if (!creds.gemini_api_key) {
      throw new Error('No Gemini API key is set.');
    }
    const { GoogleGenAI } = require('@google/genai');
    const genAI = new GoogleGenAI({ apiKey: creds.gemini_api_key });
    const response = await genAI.models.generateContent({
      model: creds.gemini_model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: test successful' }] }]
    });
    return { ok: true, provider: 'gemini', model: creds.gemini_model, sample: response.text };
  }

  if (!creds.openai_api_key) {
    throw new Error('No OpenAI API key is set.');
  }
  const openai = new OpenAI({ apiKey: creds.openai_api_key });
  const completion = await openai.chat.completions.create({
    model: creds.openai_model,
    messages: [{ role: 'user', content: 'Reply with exactly: test successful' }]
  });
  return { ok: true, provider: 'openai', model: creds.openai_model, sample: completion.choices[0].message.content };
}

// ---------- one-shot freeform text (e.g. summarizing a scanned website) ----------
// Same credential resolution as generateReply() (tenant override → universal
// platform key), but a single standalone prompt with no conversation
// history, tools, or product catalog — for utility calls that just need
// "send this text to the AI, get text back."
async function generateFreeformText(tenantId, prompt) {
  const settings = await db.getSettings(tenantId);
  const platformSettings = await db.getPlatformSettings();
  const creds = resolveAiCredentials(settings, platformSettings);

  if (creds.provider === 'gemini') {
    if (!creds.gemini_api_key) throw new Error('No AI configured — set a Gemini API key in the super admin panel.');
    const { GoogleGenAI } = require('@google/genai');
    const genAI = new GoogleGenAI({ apiKey: creds.gemini_api_key });
    const response = await genAI.models.generateContent({
      model: creds.gemini_model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    try {
      const inputTokens = (response.usageMetadata && response.usageMetadata.promptTokenCount) || 0;
      const outputTokens = (response.usageMetadata && response.usageMetadata.candidatesTokenCount) || 0;
      const costUsd = estimateCostUsd('gemini', creds.gemini_model, inputTokens, outputTokens);
      await db.recordAiUsage(tenantId, null, 'gemini', creds.gemini_model, inputTokens, outputTokens, costUsd, creds.usingOverride);
    } catch (err) { console.error(`[ai] freeform cost logging failed for tenant ${tenantId}:`, err.message); }
    return response.text.trim();
  }

  if (!creds.openai_api_key) throw new Error('No AI configured — set an OpenAI API key in the super admin panel.');
  const openai = new OpenAI({ apiKey: creds.openai_api_key });
  const completion = await openai.chat.completions.create({
    model: creds.openai_model,
    messages: [{ role: 'user', content: prompt }]
  });
  try {
    const inputTokens = (completion.usage && completion.usage.prompt_tokens) || 0;
    const outputTokens = (completion.usage && completion.usage.completion_tokens) || 0;
    const costUsd = estimateCostUsd('openai', creds.openai_model, inputTokens, outputTokens);
    await db.recordAiUsage(tenantId, null, 'openai', creds.openai_model, inputTokens, outputTokens, costUsd, creds.usingOverride);
  } catch (err) { console.error(`[ai] freeform cost logging failed for tenant ${tenantId}:`, err.message); }
  return completion.choices[0].message.content.trim();
}

module.exports = { generateReply, testConnection, channelSetting, resolveAiCredentials, generateFreeformText };
