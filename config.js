// ============================================================
// Hardcoded configuration. Edit these values directly before
// deploying — no .env file, no environment variables.
// Per-tenant stuff (their AI key, prompt, FB tokens, products)
// lives in the DATABASE and is edited from each tenant's own
// admin panel. This file only holds platform-level, deploy-time
// config that you (the SaaS owner) control.
// ============================================================

module.exports = {
  // Web server
  PORT: 3000,

  // Session secret — change this to a long random string
  SESSION_SECRET: 'change-this-to-a-long-random-string',

  // ---- YOUR (super admin) login — manages all tenants/payments ----
  SUPERADMIN_USERNAME: 'admin',
  SUPERADMIN_PASSWORD: 'change-this-password',

  // PostgreSQL connection — use the host/port/user/password/database
  // Coolify's Postgres resource gives you (Coolify → your Postgres
  // resource → Connection Details).
  DB: {
    host: '76.13.223.236',
    port: 5466,
    user: 'postgres',
    password: 'LaYpTAhiYayycvCiHA9PvZnr5yfFObOoh4T4SK52oM9Gtn4WbP6ORT8a388kYr0h',
    database: 'postgres'
  },

  // ---- Facebook: ONE Meta App/webhook serves every tenant's Page ----
  // Set this in your Meta App's webhook config. Each tenant only
  // needs to give you their own Page ID + Page Access Token (entered
  // in their own admin panel) — you don't need a separate Meta App
  // per customer.
  FB_WEBHOOK_VERIFY_TOKEN: 'change-this-verify-token',

  // ---- Billing ----
  PRICE_BDT: 1000,
  TRIAL_DAYS: 3,
  SUBSCRIPTION_DAYS: 30,
  BKASH_RECEIVE_NUMBER: '01XXXXXXXXX', // the number customers send payment to
  BKASH_TYPE: 'Send Money', // or "Payment" if it's a merchant/agent number

  // How many previous messages to feed the AI as context
  AI_HISTORY_LIMIT: 10,

  // ---- Anti-ban pacing (see README "Staying safe" section) ----
  REPLY_DELAY_MIN_MS: 1500,
  REPLY_DELAY_MAX_MS: 4500
};
