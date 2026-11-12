'use strict';

const { LlmUnavailable } = require('./llm');

const INFERENCE_URL = 'https://models.github.ai/inference/chat/completions';
const MAX_ANSWER_CHARS = 20_000;

/**
 * Calls a language model through GitHub Models (https://docs.github.com/en/github-models) - the
 * documented, backend-callable inference API tied to a GitHub account. This is not GitHub Copilot
 * itself: Copilot's completions are only exposed through supported IDE/chat integrations, with no
 * public REST endpoint for standalone server use.
 */
class GithubModelsProvider {
  constructor(token, { model = 'openai/gpt-4o-mini' } = {}) {
    this.token = token;
    this.model = model;
  }

  get label() {
    return `GitHub Models (${this.model})`;
  }

  async complete({ system, user, signal }) {
    if (!this.token) {
      throw new LlmUnavailable('no GitHub Models token is configured; set ASHRAAY_GITHUB_MODELS_TOKEN to a PAT with "models: read" permission, or set the language-model mode to "rules"');
    }
    let response;
    try {
      response = await fetch(INFERENCE_URL, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
    } catch (error) {
      throw new LlmUnavailable(`GitHub Models could not be reached (${String(error && error.message || error).slice(0, 160)})`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new LlmUnavailable(`GitHub Models rejected the token (HTTP ${response.status}); check ASHRAAY_GITHUB_MODELS_TOKEN has "models: read" permission`);
    }
    if (response.status === 429) {
      throw new LlmUnavailable('GitHub Models rate-limited this request; try again later');
    }
    if (!response.ok) {
      throw new LlmUnavailable(`GitHub Models returned HTTP ${response.status}`);
    }
    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text) throw new Error('GitHub Models returned no answer text');
    if (text.length > MAX_ANSWER_CHARS) throw new Error('the language model answer was too long');
    return { text, model: this.model };
  }
}

module.exports = { GithubModelsProvider };
