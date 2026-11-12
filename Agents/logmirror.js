'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { formatTime, shortId } = require('./util');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const KIND_LABELS = {
  notification: 'NOTE', query: 'QUERY', response: 'RESPONSE', llm_query: 'ASKS MODEL', llm_response: 'MODEL ANSWERS',
  action: 'ACTION', system: 'SYSTEM', error: 'ERROR',
};

/** One readable English line per message, e.g. "2026-10-31 07:30:12Z  conv 3f2a9c1e  A3 -> A1  QUERY  ...". */
function formatMessage(message) {
  const from = String(message.from).toUpperCase();
  const to = message.to ? String(message.to).toUpperCase() : 'ALL';
  const kind = KIND_LABELS[message.kind] || String(message.kind).toUpperCase();
  const text = String(message.text).replace(/\s*\n\s*/g, ' ');
  return `${formatTime(new Date(message.createdAt))}  conv ${shortId(message.conversationId)}  ${from} -> ${to}  ${kind}: ${text}`;
}

/**
 * Copies new agent_message rows to an append-only text file and to a live sink (the Output channel).
 * The database table stays the source of truth; the file is a durable, human-readable archive that
 * survives a simulation reset. A cursor file avoids duplicate lines after a restart.
 */
class LogMirror {
  constructor({ db, filePath, sink = () => {}, onProblem = () => {} }) {
    this.db = db;
    this.filePath = filePath;
    this.sink = sink;
    this.onProblem = onProblem;
    this.cursorPath = filePath ? `${filePath}.cursor` : null;
    this.cursor = 0;
    this.timer = null;
    this.flushing = null;
  }

  async start(intervalMs = 500) {
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.cursor = this.#readCursor();
      if (await this.db.maxMessageSeq() < this.cursor) {
        this.cursor = 0;
        this.#append('--- The database was replaced or reset; its message numbering restarted. ---');
      }
    } else {
      this.cursor = await this.db.maxMessageSeq();
    }
    await this.flush();
    this.timer = setInterval(() => { this.flush().catch((error) => this.onProblem(`Conversation log refresh failed: ${error.message}`)); }, intervalMs);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  flush() {
    if (!this.flushing) this.flushing = this.flushBatch().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async flushBatch() {
    let written = 0;
    for (;;) {
      const batch = await this.db.messagesAfter(this.cursor, 200);
      if (!batch.length) break;
      for (const message of batch) {
        const line = formatMessage(message);
        this.#append(line);
        this.sink(line);
        this.cursor = message.seq;
        written += 1;
      }
      this.#writeCursor();
    }
    return written;
  }

  #append(line) {
    if (!this.filePath) return;
    try {
      if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > MAX_FILE_BYTES) fs.renameSync(this.filePath, `${this.filePath}.old`);
    } catch { /* rotation is best effort */ }
    fs.appendFileSync(this.filePath, `${line}\n`, 'utf8');
  }

  #readCursor() {
    try { return Math.max(0, Number.parseInt(fs.readFileSync(this.cursorPath, 'utf8'), 10) || 0); } catch { return 0; }
  }

  #writeCursor() {
    if (this.cursorPath) fs.writeFileSync(this.cursorPath, String(this.cursor), 'utf8');
  }
}

module.exports = { LogMirror, formatMessage };
