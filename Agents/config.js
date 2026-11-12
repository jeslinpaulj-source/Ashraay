'use strict';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const LLM_MODES = ['github-models', 'rules'];

class ConfigError extends Error {}

function parseUrl(value, label, problems, { secret }) {
  let url;
  try { url = new URL(String(value)); } catch { problems.push(`${label} is not a valid URL.`); return null; }
  if (!['http:', 'https:'].includes(url.protocol)) problems.push(`${label} must use http or https.`);
  if (url.username || url.password) problems.push(`${label} must not contain a user name or password.`);
  // Bearer tokens and client secrets must not travel in clear text beyond this computer.
  if (secret && url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) problems.push(`${label} must use https unless it points at this computer.`);
  return url;
}

function integerInRange(value, label, min, max, problems) {
  if (!Number.isInteger(value) || value < min || value > max) {
    problems.push(`${label} must be a whole number from ${min} to ${max}.`);
    return min;
  }
  return value;
}

/** Validate the extension settings once, with all problems reported together in plain English. */
function normalizeConfig(raw) {
  const problems = [];
  const databaseUrl = String(raw.databaseUrl || '').trim();
  if (!databaseUrl) {
    problems.push('The database URL is empty. Set ASHRAAY_AGENT_DATABASE_URL to a PostgreSQL connection string.');
  } else {
    try {
      const url = new URL(databaseUrl);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) problems.push('The database URL must use PostgreSQL.');
      if (!LOOPBACK_HOSTS.has(url.hostname) && url.searchParams.get('sslmode') !== 'verify-full') problems.push('Remote PostgreSQL must use sslmode=verify-full.');
    } catch { problems.push('The database URL is invalid.'); }
  }
  const apiBaseUrl = parseUrl(raw.apiBaseUrl, 'The API URL', problems, { secret: true });
  const tokenUrl = parseUrl(raw.tokenUrl, 'The token URL', problems, { secret: true });
  const predictionUrl = parseUrl(raw.predictionUrl, 'The prediction page URL', problems, { secret: false });
  const pollSeconds = integerInRange(raw.pollSeconds, 'The prediction check interval (seconds)', 1, 86_400, problems);
  const inboxPollMs = integerInRange(raw.inboxPollMs ?? 500, 'The work-queue poll interval (milliseconds)', 100, 10_000, problems);
  const retentionDays = integerInRange(raw.retentionDays ?? 30, 'The history retention (days)', 1, 3650, problems);
  const llmMode = raw.llmMode;
  if (!LLM_MODES.includes(llmMode)) problems.push(`The language-model mode must be one of: ${LLM_MODES.join(', ')}.`);
  if (problems.length) throw new ConfigError(problems.join(' '));
  return {
    databaseUrl,
    apiBaseUrl: apiBaseUrl.toString().replace(/\/+$/, ''),
    tokenUrl: tokenUrl.toString(),
    predictionUrl: predictionUrl.toString(),
    pollSeconds,
    inboxPollMs,
    retentionDays,
    llmMode,
    llmModel: String(raw.llmModel || 'openai/gpt-4o-mini'),
    includePrompts: Boolean(raw.includePrompts),
    logFile: String(raw.logFile || ''),
    clientIds: { a1: raw.clientIds.a1, a2: raw.clientIds.a2, a3: raw.clientIds.a3 },
  };
}

/** Bearer tokens, client secrets and control tokens must not travel in clear text beyond this computer. */
function checkSecretDestination(value, label) {
  const problems = [];
  parseUrl(value, label, problems, { secret: true });
  if (problems.length) throw new ConfigError(problems.join(' '));
}

module.exports = { normalizeConfig, checkSecretDestination, ConfigError };
