'use strict';

const { Pool } = require('pg');
const { newId } = require('./util');

const MAX_ATTEMPTS = 5;
const CLAIM_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000];

/** Async PostgreSQL adapter. The agent role cannot modify operational domain tables. */
class PostgresAgentDatabase {
  constructor(url, { clock = Date.now, onProblem = () => {} } = {}) {
    const parsed = new URL(url);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('The agent database must use a PostgreSQL URL.');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && parsed.searchParams.get('sslmode') !== 'verify-full') {
      throw new Error('Remote PostgreSQL requires sslmode=verify-full.');
    }
    this.clock = clock;
    this.pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    this.pool.on('error', (error) => onProblem(error.message));
    this.listener = null;
  }

  async initialize() {
    await this.pool.query('SELECT id FROM demo_state LIMIT 1');
    await this.pool.query('SELECT id FROM agent_inbox LIMIT 1');
  }

  async listen(onWork, onProblem) {
    this.listener = await this.pool.connect();
    this.listener.on('notification', onWork);
    this.listener.on('error', (error) => onProblem(error.message));
    await this.listener.query('LISTEN ashraay_work');
  }

  async close() {
    if (this.listener) {
      this.listener.release(true);
      this.listener = null;
    }
    await this.pool.end();
  }

  async readState() {
    return (await this.pool.query('SELECT payload FROM demo_state WHERE id = 1')).rows[0]?.payload || null;
  }

  /** Read-only: the web-app's admin API writes this row. Returns null if unset or not reachable yet. */
  async getLlmSettings() {
    try {
      const row = (await this.pool.query('SELECT llm_mode, llm_model, github_token FROM agent_llm_settings WHERE id = 1')).rows[0];
      if (!row) return null;
      return { llmMode: row.llm_mode, llmModel: row.llm_model, githubToken: row.github_token || '' };
    } catch {
      return null;
    }
  }

  /** Read-only: whether a human has switched the agents on from the Command Center. Fails closed (disabled). */
  async getRunControl() {
    try {
      const row = (await this.pool.query('SELECT enabled FROM agent_run_control WHERE id = 1')).rows[0];
      return { enabled: Boolean(row && row.enabled) };
    } catch {
      return { enabled: false };
    }
  }

  async getEvent(id) {
    const row = (await this.pool.query('SELECT id, event_type, payload, created_at FROM outbox_event WHERE id = $1', [id])).rows[0];
    return row ? { id: row.id, type: row.event_type, createdAt: row.created_at, payload: row.payload } : null;
  }

  async recoverStaleClaims() {
    return (await this.pool.query(
      "UPDATE agent_inbox SET status = 'pending', claimed_at_ms = NULL WHERE status = 'processing' AND claimed_at_ms < $1",
      [this.clock() - CLAIM_TIMEOUT_MS],
    )).rowCount;
  }

  async claim(agent, limit = 5) {
    const result = await this.pool.query(
      `WITH ready AS (
        SELECT id FROM agent_inbox WHERE agent = $1 AND status = 'pending' AND available_at_ms <= $2
        ORDER BY id LIMIT $3 FOR UPDATE SKIP LOCKED
      ) UPDATE agent_inbox AS inbox SET status = 'processing', attempts = attempts + 1, claimed_at_ms = $2
        FROM ready WHERE inbox.id = ready.id RETURNING inbox.id, inbox.agent, inbox.ref_kind,
        inbox.ref_id, inbox.event_type, inbox.attempts`,
      [agent, this.clock(), limit],
    );
    return result.rows;
  }

  async complete(id, note = null) {
    await this.pool.query("UPDATE agent_inbox SET status = 'done', completed_at = $1, last_error = $2 WHERE id = $3",
      [new Date(this.clock()).toISOString(), note, id]);
  }

  async fail(id, attempts, error) {
    if (attempts >= MAX_ATTEMPTS) {
      await this.pool.query("UPDATE agent_inbox SET status = 'dead_letter', last_error = $1 WHERE id = $2", [error.slice(0, 500), id]);
      return { status: 'dead_letter', retryInMs: null };
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    await this.pool.query("UPDATE agent_inbox SET status = 'pending', available_at_ms = $1, claimed_at_ms = NULL, last_error = $2 WHERE id = $3",
      [this.clock() + delay, error.slice(0, 500), id]);
    return { status: 'pending', retryInMs: delay };
  }

  async prune(days) {
    const client = await this.pool.connect();
    const cutoff = new Date(this.clock() - days * 86400000).toISOString();
    try {
      await client.query('BEGIN');
      const inbox = await client.query("DELETE FROM agent_inbox WHERE status = 'done' AND completed_at < $1", [cutoff]);
      const runs = await client.query('DELETE FROM agent_run WHERE finished_at IS NOT NULL AND finished_at < $1', [cutoff]);
      const messages = await client.query('DELETE FROM agent_message WHERE created_at < $1', [cutoff]);
      await client.query('COMMIT');
      return { inbox: inbox.rowCount, runs: runs.rowCount, messages: messages.rowCount };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async pendingCount(agent) {
    return Number((await this.pool.query("SELECT count(*) AS n FROM agent_inbox WHERE agent = $1 AND status IN ('pending','processing')", [agent])).rows[0].n);
  }

  async deadLetterCount(agent) {
    return Number((await this.pool.query("SELECT count(*) AS n FROM agent_inbox WHERE agent = $1 AND status = 'dead_letter'", [agent])).rows[0].n);
  }

  async heartbeats() {
    return (await this.pool.query('SELECT agent, status, llm_mode, host, last_seen_ms FROM agent_heartbeat ORDER BY agent')).rows;
  }

  async insertMessage({ conversationId, inReplyTo = null, from, to = null, kind, hop = 0, text, data = null, runId = null }) {
    const id = newId();
    const result = await this.pool.query(
      `INSERT INTO agent_message (id, conversation_id, in_reply_to, created_at, from_agent, to_agent, kind, hop, text, data, run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING seq`,
      [id, conversationId, inReplyTo, new Date(this.clock()).toISOString(), from, to, kind, hop, text, JSON.stringify(data), runId],
    );
    return { id, seq: result.rows[0].seq };
  }

  message(row) {
    return { seq: row.seq, id: row.id, conversationId: row.conversation_id, inReplyTo: row.in_reply_to,
      createdAt: row.created_at, from: row.from_agent, to: row.to_agent, kind: row.kind, hop: row.hop,
      text: row.text, data: row.data, runId: row.run_id };
  }

  async getMessage(id) {
    const row = (await this.pool.query('SELECT * FROM agent_message WHERE id = $1', [id])).rows[0];
    return row ? this.message(row) : null;
  }

  async messagesAfter(seq, limit = 200) {
    return (await this.pool.query('SELECT * FROM agent_message WHERE seq > $1 ORDER BY seq LIMIT $2', [seq, limit])).rows.map((row) => this.message(row));
  }

  async maxMessageSeq() {
    return (await this.pool.query('SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_message')).rows[0].seq;
  }

  async heartbeat(agent, { status, llm, host, detail = null, startedAt }) {
    const now = this.clock();
    await this.pool.query(
      `INSERT INTO agent_heartbeat (agent, status, llm_mode, host, started_at, last_seen_at, last_seen_ms, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(agent) DO UPDATE SET status = excluded.status,
       llm_mode = excluded.llm_mode, host = excluded.host, started_at = excluded.started_at,
       last_seen_at = excluded.last_seen_at, last_seen_ms = excluded.last_seen_ms, detail = excluded.detail`,
      [agent, status, llm, host, startedAt, new Date(now).toISOString(), now, detail],
    );
  }

  async startRun(agent, trigger, llm) {
    const id = newId();
    await this.pool.query("INSERT INTO agent_run (id, agent, trigger, status, llm_used, started_at) VALUES ($1,$2,$3,'running',$4,$5)",
      [id, agent, trigger.slice(0, 200), llm, new Date(this.clock()).toISOString()]);
    return id;
  }

  async finishRun(id, status, summary, error = null) {
    await this.pool.query('UPDATE agent_run SET status = $1, finished_at = $2, summary = $3, error = $4 WHERE id = $5',
      [status, new Date(this.clock()).toISOString(), summary, error ? error.slice(0, 500) : null, id]);
  }

  async getAgentState(agent, key) {
    return (await this.pool.query('SELECT value FROM agent_state WHERE agent = $1 AND key = $2', [agent, key])).rows[0]?.value ?? null;
  }

  async setAgentState(agent, key, value) {
    await this.pool.query(`INSERT INTO agent_state (agent, key, value, updated_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT(agent,key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [agent, key, JSON.stringify(value), new Date(this.clock()).toISOString()]);
  }
}

module.exports = { PostgresAgentDatabase, MAX_ATTEMPTS, RETRY_DELAYS_MS, CLAIM_TIMEOUT_MS };
