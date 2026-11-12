'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { resolveFile } = require('../shared/static-server');

const PORT = Number(process.env.PORT) || 5175;
// Listen on all interfaces so other devices on the same network/hotspot can open the event simulator.
const HOST = process.env.HOST || '0.0.0.0';
const API_TARGET = new URL(process.env.API_TARGET || 'http://127.0.0.1:8000');
const SHARED_ROOT = path.join(__dirname, '..', 'shared');
// Reuse sockets to the backend instead of opening one per request, which avoids
// intermittent ECONNRESET under rapid polling (seen on Windows loopback connections).
const apiAgent = new http.Agent({ keepAlive: true, maxSockets: 32 });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function proxyApi(req, res) {
  const headers = { ...req.headers, host: API_TARGET.host };
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    sendUpstream(req, res, headers, body, true);
  });
}

// Node's keep-alive socket pool can race with uvicorn's keep-alive timeout: the
// agent may hand out a pooled socket at (almost) the same moment the backend
// closes it for being idle, which surfaces as ECONNRESET before any response
// bytes arrive. That race never sent any data, so retrying once on a brand new
// (non-pooled) connection is safe here too.
function sendUpstream(req, res, headers, body, allowRetry) {
  const upstream = http.request({
    hostname: API_TARGET.hostname,
    port: API_TARGET.port || 80,
    path: req.url,
    method: req.method,
    headers,
    agent: allowRetry ? apiAgent : false,
  }, (response) => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
  });
  upstream.on('error', (error) => {
    if (allowRetry && error.code === 'ECONNRESET') {
      sendUpstream(req, res, headers, body, false);
      return;
    }
    console.error(`API proxy error for ${req.method} ${req.url}: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'The ASHRAAY server is not reachable. Try again shortly.' }));
  });
  upstream.end(body);
}

function serveStatic(req, res) {
  let file;
  try {
    file = resolveFile(__dirname, SHARED_ROOT, req.url || '/');
  } catch {
    file = null;
  }
  if (!file) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('content-type', MIME_TYPES[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if ((req.url || '').startsWith('/api/')) proxyApi(req, res);
  else serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`ASHRAAY event simulator on http://${HOST}:${PORT}/ (API proxied to ${API_TARGET.origin})`);
  if (HOST === '0.0.0.0') {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family === 'IPv4' && !address.internal) {
          console.log(`  Open on another device on the same network: http://${address.address}:${PORT}/`);
        }
      }
    }
  }
});
