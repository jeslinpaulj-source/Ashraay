'use strict';

const { parseJsonObject } = require('./schemas');
const { safeErrorMessage, withTimeout } = require('./util');

/** Thrown by a provider when no language model can be used at all (not signed in, no consent, none installed). */
class LlmUnavailable extends Error {}

/**
 * The only route to a language model. Output is advisory: it must parse as JSON and pass a strict
 * validator that keeps known fields only. Agents fall back to deterministic rules when it returns not-ok.
 */
class LlmGateway {
  constructor({ provider = null, mode = 'rules', timeoutMs = 45_000 } = {}) {
    this.provider = mode === 'rules' ? null : provider;
    this.mode = mode;
    this.timeoutMs = timeoutMs;
    this.lastModel = null;
  }

  get label() {
    return this.provider ? this.provider.label : 'built-in rules';
  }

  /** Applied live by AgentRuntime when the admin console changes the stored LLM settings. */
  reconfigure({ provider, mode }) {
    this.provider = mode === 'rules' ? null : provider;
    this.mode = mode;
  }

  async ask({ system, user, validate }) {
    if (!this.provider) return { ok: false, reason: 'language-model use is switched off (rules-only mode)' };
    let lastProblem = 'no answer';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const suffix = attempt === 1 ? '' : '\n\nYour previous answer was not valid. Reply with ONE JSON object only.';
        const answer = await withTimeout(
          (signal) => this.provider.complete({ system, user: user + suffix, signal }),
          this.timeoutMs,
          `the language model did not answer within ${this.timeoutMs >= 1000 ? `${Math.round(this.timeoutMs / 1000)} seconds` : `${this.timeoutMs} milliseconds`}`,
        );
        const value = validate(parseJsonObject(answer.text));
        this.lastModel = answer.model;
        return { ok: true, value, model: answer.model };
      } catch (error) {
        if (error instanceof LlmUnavailable) return { ok: false, reason: error.message, unavailable: true };
        lastProblem = safeErrorMessage(error);
        if (/did not answer within/.test(lastProblem)) return { ok: false, reason: lastProblem };
      }
    }
    return { ok: false, reason: `the language model answered, but not in the required format (${lastProblem})` };
  }
}

module.exports = { LlmGateway, LlmUnavailable };
