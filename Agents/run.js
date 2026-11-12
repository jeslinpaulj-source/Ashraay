#!/usr/bin/env node
'use strict';

/**
 * Standalone entry point for the A1/A2/A3 agents. Runs as a plain Node.js process (no VS Code
 * required): reads configuration from environment variables, connects to the database and API with
 * each agent's own client credentials, and logs the agents' conversation to stdout and a log file.
 *
 * Language-model use defaults to "rules" (deterministic, built-in logic). Set ASHRAAY_LLM_MODE=github-models
 * and ASHRAAY_GITHUB_MODELS_TOKEN (a GitHub PAT with "models: read" permission) to route advisory analysis
 * through GitHub Models (https://docs.github.com/en/github-models) instead.
 */

const os = require('node:os');
const path = require('node:path');
const { PostgresAgentDatabase } = require('./postgres');
const { ApiClient } = require('./api');
const { LlmGateway } = require('./llm');
const { GithubModelsProvider } = require('./github-models-provider');
const { AgentRuntime, AGENT_IDS } = require('./runtime');
const { LogMirror } = require('./logmirror');
const { normalizeConfig, ConfigError } = require('./config');
const { safeErrorMessage } = require('./util');

const ROOT = path.join(__dirname, '..');

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function secretFor(id) {
  return process.env[`ASHRAAY_AGENT_${id.toUpperCase()}_SECRET`] || '';
}

function resolveConfig() {
  const dataDir = env('ASHRAAY_DATA_DIR', path.join(ROOT, 'database', '.local-data'));
  const prefix = env('ASHRAAY_CLIENT_ID_PREFIX', 'ashraay-agent-');
  return normalizeConfig({
    databaseUrl: env('ASHRAAY_AGENT_DATABASE_URL', ''),
    apiBaseUrl: env('ASHRAAY_API_BASE_URL', 'http://127.0.0.1:8000/api/v1'),
    tokenUrl: env('ASHRAAY_TOKEN_URL', 'http://127.0.0.1:8090/token'),
    predictionUrl: env('ASHRAAY_PREDICTION_URL', 'http://127.0.0.1:5177/prediction.html'),
    pollSeconds: Number(env('ASHRAAY_PREDICTION_POLL_SECONDS', 300)),
    inboxPollMs: Number(env('ASHRAAY_INBOX_POLL_MS', 500)),
    retentionDays: Number(env('ASHRAAY_RETENTION_DAYS', 30)),
    llmMode: env('ASHRAAY_LLM_MODE', 'rules'),
    llmModel: env('ASHRAAY_LLM_MODEL', 'openai/gpt-4o-mini'),
    includePrompts: false,
    logFile: env('ASHRAAY_LOG_FILE', path.join(dataDir, 'agent-communications.log')),
    clientIds: { a1: `${prefix}a1`, a2: `${prefix}a2`, a3: `${prefix}a3` },
  });
}

async function main() {
  let config;
  try {
    config = resolveConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[ashraay-agents] Configuration problem: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const db = new PostgresAgentDatabase(config.databaseUrl, { onProblem: (text) => console.error(`[ashraay-agents] ${text}`) });
  if (db.initialize) await db.initialize();

  const provider = config.llmMode === 'github-models'
    ? new GithubModelsProvider(process.env.ASHRAAY_GITHUB_MODELS_TOKEN || '', { model: config.llmModel })
    : null;
  const llm = new LlmGateway({ provider, mode: config.llmMode });
  const runtime = new AgentRuntime({
    db,
    llm,
    config,
    hostLabel: `standalone@${os.hostname()}`,
    apiFactory: (id) => new ApiClient({
      baseUrl: config.apiBaseUrl,
      tokenUrl: config.tokenUrl,
      clientId: config.clientIds[id],
      secret: () => secretFor(id),
    }),
    onProblem: (text) => console.error(`[ashraay-agents] [problem] ${text}`),
    onActivity: () => {},
  });

  const mirror = new LogMirror({
    db,
    filePath: config.logFile,
    sink: (line) => console.log(line),
    onProblem: (text) => console.error(`[ashraay-agents] ${text}`),
  });

  await mirror.start();
  await runtime.start();
  console.log(
    `[ashraay-agents] Agents started. Database: PostgreSQL. ` +
    `Language model: ${llm.label}. Log file: ${config.logFile || 'none'}.`,
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[ashraay-agents] Received ${signal}, stopping agents...`);
    try {
      await runtime.stop();
    } finally {
      try {
        await mirror.stop();
      } finally {
        await db.close();
      }
    }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(`[ashraay-agents] Fatal error: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
});

module.exports = { AGENT_IDS, resolveConfig };
