// ============================================================
// $ per 1,000,000 tokens, by provider/model. This is a point-in-time
// snapshot (September 2026) of published API pricing — providers change
// prices without much notice, so if the numbers in your super admin Cost
// dashboard look off, update the rates below to match the provider's
// current pricing page. This file only affects the *reporting* shown to
// you; it never changes what you're actually billed by OpenAI/Google.
// ============================================================

const PRICING = {
  openai: {
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4o': { input: 2.50, output: 10.00 },
    'gpt-4-turbo': { input: 10.00, output: 30.00 },
    'gpt-4.1-mini': { input: 0.40, output: 1.60 },
    'gpt-4.1': { input: 2.00, output: 8.00 }
  },
  gemini: {
    'gemini-3.5-flash': { input: 1.50, output: 9.00 },
    'gemini-3.1-flash-lite': { input: 0.25, output: 1.50 },
    'gemini-3.1-pro': { input: 2.00, output: 12.00 },
    'gemini-2.5-flash': { input: 0.30, output: 2.50 },
    'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
    'gemini-2.5-pro': { input: 1.25, output: 10.00 }
  }
};

// Used when a model isn't in the table above (e.g. a brand-new model the
// tenant/super admin typed in manually) — a mid-range guess so the cost
// dashboard shows *something* rather than silently reporting $0.
const FALLBACK_RATE = { input: 1.00, output: 5.00 };

function estimateCostUsd(provider, model, inputTokens, outputTokens) {
  const table = PRICING[provider] || {};
  const rate = table[model] || FALLBACK_RATE;
  const cost = ((inputTokens || 0) * rate.input + (outputTokens || 0) * rate.output) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6; // 6 decimal places — these are fractions of a cent
}

module.exports = { estimateCostUsd, PRICING };
