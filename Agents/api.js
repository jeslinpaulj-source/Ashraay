'use strict';

const { safeErrorMessage } = require('./util');

class ApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function describeDetail(body) {
  const detail = body && typeof body === 'object' ? body.detail : undefined;
  if (typeof detail === 'string') return detail;
  if (detail !== undefined && detail !== null) return JSON.stringify(detail).slice(0, 300);
  return 'no further detail';
}

/**
 * Calls the ASHRAAY API as one agent. Each agent has its own client credentials, so the API enforces
 * that agent's role; this client never holds a human role and cannot take decisions.
 */
class ApiClient {
  constructor({ baseUrl, tokenUrl, clientId, secret, fetchImpl = fetch, timeoutMs = 15_000, clock = Date.now }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.tokenUrl = tokenUrl;
    this.clientId = clientId;
    this.secret = secret;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.cached = null;
  }

  async #token(force) {
    if (!force && this.cached && this.cached.expiresAt - 30_000 > this.clock()) return this.cached.value;
    const secret = typeof this.secret === 'function' ? await this.secret() : this.secret;
    if (!secret) throw new ApiError(`No credentials are configured for ${this.clientId}.`);
    let response;
    try {
      response = await this.fetch(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: secret }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (error) {
      throw new ApiError(`The identity provider could not be reached (${safeErrorMessage(error)}).`);
    }
    if (!response.ok) throw new ApiError(`The identity provider rejected the credentials for ${this.clientId} (HTTP ${response.status}).`, response.status);
    const body = await response.json();
    if (typeof body.access_token !== 'string' || !body.access_token) throw new ApiError('The identity provider returned no access token.');
    this.cached = { value: body.access_token, expiresAt: this.clock() + Math.max(30, Number(body.expires_in) || 60) * 1000 };
    return this.cached.value;
  }

  async request(method, path, { body, idempotencyKey } = {}, retried = false) {
    const token = await this.#token(retried);
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
    } catch (error) {
      throw new ApiError(`The API could not be reached (${safeErrorMessage(error)}).`);
    }
    if (response.status === 401 && !retried) {
      this.cached = null;
      return this.request(method, path, { body, idempotencyKey }, true);
    }
    let parsed = null;
    try { parsed = await response.json(); } catch { /* an empty or non-JSON body is handled below */ }
    if (!response.ok) throw new ApiError(`The API refused ${method} ${path} (HTTP ${response.status}): ${describeDetail(parsed)}.`, response.status);
    return parsed;
  }
}

module.exports = { ApiClient, ApiError };
