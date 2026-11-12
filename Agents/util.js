'use strict';

const crypto = require('node:crypto');

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const newId = () => crypto.randomUUID();
const shortId = (id) => String(id ?? '').slice(0, 8);

/** Collapse whitespace, drop control characters and cap length. Always returns a string. */
function clampText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Wrap untrusted text so a model sees it as data. Every angle bracket is escaped, so no tag (however split or nested) can survive. */
function untrustedBlock(tag, value, max) {
  const cleaned = clampText(value, max).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<${tag}>${cleaned}</${tag}>`;
}

/** Error text that is safe to store in a readable log: no bearer tokens, bounded length. */
function safeErrorMessage(error) {
  const text = String(error && error.message ? error.message : error);
  return text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]').slice(0, 300);
}

function formatTime(date) {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function withTimeout(promiseFactory, ms, message) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([promiseFactory(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

module.exports = { newId, shortId, clampText, untrustedBlock, safeErrorMessage, formatTime, withTimeout };
