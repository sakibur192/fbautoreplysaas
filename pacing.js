const config = require('./config');

/**
 * Waits a random amount of time before a reply is sent, so replies don't
 * look like an instant automated response. One of several measures aimed
 * at keeping tenant accounts looking like normal, human-paced usage —
 * see README "Staying safe" section for the full picture and its limits.
 */
function humanDelay() {
  const min = config.REPLY_DELAY_MIN_MS;
  const max = config.REPLY_DELAY_MAX_MS;
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { humanDelay };
