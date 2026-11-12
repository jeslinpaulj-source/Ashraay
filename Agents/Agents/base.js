'use strict';

const NAMES = { a1: 'A1', a2: 'A2', a3: 'A3' };

/**
 * Shared behaviour for the three agents. Agents never write domain data directly: they read the database,
 * act through the API with their own credentials, and record every exchange as an English log message.
 */
class BaseAgent {
  constructor(id, ctx) {
    this.id = id;
    this.name = NAMES[id];
    this.ctx = ctx;
  }

  get db() { return this.ctx.db; }
  get api() { return this.ctx.api(this.id); }

  say({ runId, conversationId, from = this.id, to = null, kind, text, data = null, inReplyTo = null, hop = 0 }) {
    return this.db.insertMessage({ conversationId, inReplyTo, from, to, kind, hop, text, data, runId });
  }

  /**
   * Ask the language model for advisory analysis. Returns the validated answer, or null when the model is
   * off, unavailable or answered badly; the caller then relies on its deterministic rules.
   */
  async consult({ run, conversationId, purpose, system, user, validate, describe }) {
    const llm = this.ctx.llm;
    if (!llm.provider) {
      await this.say({ runId: run.id, conversationId, kind: 'system', text: `${this.name} used its built-in rules for this step because ${llm.mode === 'rules' ? 'language-model use is switched off' : 'no language model is connected'}.` });
      return null;
    }
    const prompt = this.ctx.includePrompts ? ` Prompt: ${user}` : '';
    await this.say({ runId: run.id, conversationId, to: 'llm', kind: 'llm_query', text: `${this.name} asks ${llm.label}: ${purpose}.${prompt}` });
    const result = await llm.ask({ system, user, validate });
    if (result.ok) {
      await this.say({ runId: run.id, conversationId, from: 'llm', to: this.id, kind: 'llm_response', text: `${llm.label} (${result.model}) answered ${this.name}: ${describe(result.value)}`, data: { model: result.model } });
      return result.value;
    }
    await this.say({ runId: run.id, conversationId, kind: 'system', text: `${this.name} could not use the language model for this step (${result.reason}). It used its built-in rules instead.` });
    return null;
  }
}

module.exports = { BaseAgent, NAMES };
