'use strict';

/**
 * Minimal static file server shared by command-center and mobile-app. Serves a single app's own
 * directory as its web root, and aliases "/shared/*" to the sibling shared/ folder so both apps can
 * load the common auth/i18n/offline helpers without duplicating them.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function resolveFile(appRoot, sharedRoot, urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const isShared = clean.startsWith('/shared/');
  const base = isShared ? sharedRoot : appRoot;
  const relative = isShared ? clean.slice('/shared'.length) : clean;
  const target = path.normalize(path.join(base, relative === '/' || relative === '' ? 'index.html' : relative));
  if (!target.startsWith(base)) return null; // guard against path traversal
  return target;
}

/**
 * Starts a static server for one app directory.
 * @param {string} appRoot - absolute path to the app's own directory (serves as web root).
 * @param {object} options
 * @param {number} options.port
 * @param {string} [options.sharedRoot] - absolute path to the shared/ folder (defaults to ../shared).
 * @param {string} [options.host]
 */
function serve(appRoot, { port, sharedRoot = path.join(appRoot, '..', 'shared'), host = '127.0.0.1' } = {}) {
  const server = http.createServer((req, res) => {
    const file = resolveFile(appRoot, sharedRoot, req.url || '/');
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
      res.setHeader('content-type', MIME_TYPES[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
    });
  });
  server.listen(port, host, () => {
    console.log(`Serving ${appRoot} on http://${host}:${port}/ (shared assets from ${sharedRoot})`);
  });
  return server;
}

module.exports = { serve, resolveFile };
