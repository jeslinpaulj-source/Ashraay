'use strict';

const os = require('node:os');
const { A1Agent } = require('./agents/a1');
const { A2Agent } = require('./agents/a2');
const { A3Agent } = require('./agents/a3');
const { MAX_ATTEMPTS } = require('./postgres');
const { newId, shortId, safeErrorMessage } = require('./util');
const { GithubModelsProvider } = require('./github-models-provider');

const AGENT_IDS = ['a1', 'a2', 'a3'];
const MAX_HOPS = 6;
const HEARTBEAT_MS = 5_000;
const STALE_CHECK_MS = 30_000;
const LLM_SETTINGS_POLL_MS = 10_000;
const RUN_CONTROL_POLL_MS = 3_000;
const PRUNE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

/**
 * Runs the three agents. Database triggers put work in each agent's inbox; this runtime claims that work
 * (about twice a second), runs the agent, and records every step as a run and as readable log messages.
 * A2 additionally checks the prediction web page on a timer.
 */
class AgentRuntime {
  constructor({ db, apiFactory, llm, config, fetchImpl = fetch, hostLabel = `vscode-extension-host@${os.hostname()}`, onActivity = () => {}, onProblem = () => {} }) {
    this.db = db;
    this.llm = llm;
    this.config = config;
    this.hostLabel = hostLabel;
    this.onActivity = onActivity;
    this.onProblem = onProblem;
    const apis = Object.fromEntries(AGENT_IDS.map((id) => [id, apiFactory(id)]));
    const ctx = { db, llm, config, fetch: fetchImpl, includePrompts: Boolean(config.includePrompts), api: (id) => apis[id] };
    this.agents = { a1: new A1Agent(ctx), a2: new A2Agent(ctx), a3: new A3Agent(ctx) };
    this.busy = new Set();
    this.inFlight = new Set();
    this.timers = [];
    this.startedAt = null;
    this.running = false;
    this.predictionRun = null;
    this.llmSettingsSignature = null;
    // Fails closed: a freshly started process does not claim or process any work until a human enables it.
    this.enabled = false;
  }

  /** Applies the admin console's stored mode/model/token live, without restarting the process. */
  async #syncLlmSettings() {
    if (!this.db.getLlmSettings) return;
    const settings = await this.db.getLlmSettings();
    if (!settings) return;
    const signature = `${settings.llmMode}|${settings.llmModel}|${settings.githubToken ? 'token' : 'no-token'}`;
    if (signature === this.llmSettingsSignature) return;
    this.llmSettingsSignature = signature;
    const provider = settings.llmMode === 'github-models'
      ? new GithubModelsProvider(settings.githubToken || process.env.ASHRAAY_GITHUB_MODELS_TOKEN || '', { model: settings.llmModel })
      : null;
    this.llm.reconfigure({ provider, mode: settings.llmMode });
  }

  /** Applies the Command Center's start/stop toggle live; toggling it records a fresh heartbeat status. */
  async #syncRunControl() {
    if (!this.db.getRunControl) return;
    const control = await this.db.getRunControl();
    const wasEnabled = this.enabled;
    this.enabled = Boolean(control.enabled);
    if (this.enabled !== wasEnabled) await this.#beat(this.enabled ? 'running' : 'paused');
  }

  async start() {
    if (this.running) return;
    this.startedAt = new Date().toISOString();
    await this.db.recoverStaleClaims();
    await this.#prune();
    await this.#syncLlmSettings();
    await this.#syncRunControl();
    await this.#beat(this.enabled ? 'running' : 'paused');
    if (this.db.listen) await this.db.listen(
      () => { if (this.running && this.enabled) this.#track(this.#safe(() => this.tick())); },
      (message) => this.onProblem(`Database notification connection failed; polling remains active: ${message}`),
    );
    this.running = true;
    this.timers.push(setInterval(() => this.#track(this.#safe(() => { if (this.enabled) return this.tick(); })), this.config.inboxPollMs));
    this.timers.push(setInterval(() => this.#track(this.#safe(() => this.#beat(this.enabled ? 'running' : 'paused'))), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.#track(this.#safe(() => this.db.recoverStaleClaims())), STALE_CHECK_MS));
    this.timers.push(setInterval(() => this.#track(this.#safe(() => this.#syncLlmSettings())), LLM_SETTINGS_POLL_MS));
    this.timers.push(setInterval(() => this.#track(this.#safe(() => this.#syncRunControl())), RUN_CONTROL_POLL_MS));
    this.timers.push(setInterval(() => this.#track(this.#safe(() => this.#prune())), PRUNE_MS));
    this.#schedulePrediction(1_000);
  }

  #prune() {
    return this.db.prune(this.config.retentionDays || DEFAULT_RETENTION_DAYS);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    for (const timer of this.timers) { clearInterval(timer); clearTimeout(timer); }
    this.timers = [];
    await Promise.allSettled([...this.inFlight]);
    await this.#beat('stopped');
  }

  async status() {
    return {
      running: this.running,
      llm: this.llm.label,
      agents: Object.fromEntries(await Promise.all(AGENT_IDS.map(async (id) => [id, { pending: await this.db.pendingCount(id), busy: this.busy.has(id) }]))),
    };
  }

  /** Claim and process everything that is ready for all agents once. Exposed for deterministic tests. */
  async tick() {
    await Promise.all(AGENT_IDS.map((id) => this.#processInbox(id)));
  }

  /** Check the prediction page now (the manual "poll now" command). Overlapping checks share one run. */
  pollPredictionNow() {
    if (!this.predictionRun) {
      this.predictionRun = this.#track(this.#runPrediction()).finally(() => { this.predictionRun = null; });
    }
    return this.predictionRun;
  }

  #schedulePrediction(delayMs) {
    if (!this.running) return;
    const timer = setTimeout(async () => {
      this.timers = this.timers.filter((entry) => entry !== timer);
      if (this.enabled) await this.#safe(() => this.pollPredictionNow());
      this.#schedulePrediction(this.config.pollSeconds * 1000);
    }, delayMs);
    this.timers.push(timer);
  }

  async #runPrediction() {
    const agent = this.agents.a2;
    const runId = await this.db.startRun('a2', 'prediction web page check', this.llm.label);
    try {
      const summary = await agent.pollPrediction({ id: runId });
      await this.db.finishRun(runId, 'succeeded', summary);
      this.onActivity({ agent: 'a2', ok: true, summary });
      return summary;
    } catch (error) {
      await this.db.finishRun(runId, 'failed', null, safeErrorMessage(error));
      this.onActivity({ agent: 'a2', ok: false, summary: safeErrorMessage(error) });
      return null;
    }
  }

  async #processInbox(agentId) {
    if (this.busy.has(agentId)) return;
    this.busy.add(agentId);
    try {
      for (const claimed of await this.db.claim(agentId, 5)) await this.#track(this.#handle(agentId, claimed));
    } finally {
      this.busy.delete(agentId);
    }
  }

  async #handle(agentId, claimed) {
    const agent = this.agents[agentId];
    const item = { inbox: claimed };
    if (claimed.ref_kind === 'event') {
      item.event = await this.db.getEvent(claimed.ref_id);
      if (!item.event) return this.db.complete(claimed.id, 'skipped: the event no longer exists');
    } else {
      item.message = await this.db.getMessage(claimed.ref_id);
      if (!item.message) return this.db.complete(claimed.id, 'skipped: the message no longer exists');
      if (item.message.hop > MAX_HOPS) {
        await this.db.insertMessage({ conversationId: item.message.conversationId, from: agentId, kind: 'system', hop: item.message.hop,
          text: `${agent.name} stopped answering because this conversation passed ${MAX_HOPS} replies, which looks like a loop.` });
        return this.db.complete(claimed.id, 'skipped: hop limit');
      }
    }
    const runId = await this.db.startRun(agentId, `${claimed.event_type} ${shortId(claimed.ref_id)}`, this.llm.label);
    try {
      const summary = await agent.process(item, { id: runId });
      await this.db.finishRun(runId, 'succeeded', summary);
      await this.db.complete(claimed.id);
      this.onActivity({ agent: agentId, ok: true, summary });
    } catch (error) {
      const text = safeErrorMessage(error);
      await this.db.finishRun(runId, 'failed', null, text);
      const outcome = await this.db.fail(claimed.id, claimed.attempts, text);
      const next = outcome.status === 'dead_letter'
        ? `It gave up after ${MAX_ATTEMPTS} attempts and moved the item to the dead-letter queue for a person to inspect.`
        : `It will retry in ${Math.round(outcome.retryInMs / 1000)} seconds (attempt ${claimed.attempts} of ${MAX_ATTEMPTS}).`;
      await this.db.insertMessage({ conversationId: item.message ? item.message.conversationId : newId(), from: agentId, kind: 'error', runId,
        text: `${agent.name} could not finish handling ${claimed.event_type}: ${text} ${next}` });
      this.onActivity({ agent: agentId, ok: false, summary: text });
    }
  }

  async #beat(status) {
    for (const id of AGENT_IDS) {
      await this.db.heartbeat(id, { status, llm: this.llm.label, host: this.hostLabel, startedAt: this.startedAt || new Date().toISOString() });
    }
  }

  #track(promise) {
    this.inFlight.add(promise);
    return promise.finally(() => this.inFlight.delete(promise));
  }

  async #safe(work) {
    try {
      await work();
    } catch (error) {
      this.onProblem(safeErrorMessage(error));
    }
  }
}

module.exports = { AgentRuntime, AGENT_IDS, MAX_HOPS };
