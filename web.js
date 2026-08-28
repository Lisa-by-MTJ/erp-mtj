// MTJ Channel Manager — HTTP layer: Basic Auth + router + static UI (Blueprint V2.0)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./api.js');

const UI_DIR = path.join(__dirname, 'ui');
const USER = 'mtj';
const PASS = 'REDACTED';
const EXPECTED = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, body, type) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store' });
  res.end(buf);
}

function start(port) {
  const srv = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      // Basic Auth gates EVERYTHING (pages and API) — this port is tunnel-exposed
      const auth = req.headers.authorization || '';
      if (auth !== EXPECTED) {
        res.setHeader('WWW-Authenticate', 'Basic realm="MTJ Channel Manager"');
        return send(res, 401, 'Unauthorized', 'text/plain');
      }
      if (p.startsWith('/api/')) return api.handle(req, res, url);
      let file = p === '/' ? '/index.html' : p;
      file = file.replace(/\.\./g, '');
      const full = path.join(UI_DIR, file);
      if (!fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
      const ext = path.extname(full).toLowerCase();
      return send(res, 200, fs.readFileSync(full), MIME[ext] || 'application/octet-stream');
    } catch (e) {
      return send(res, e.status || 500, JSON.stringify({ error: String(e.message || e) }));
    }
  });
  const host = process.env.MTJ_BIND || '127.0.0.1';
  srv.listen(port, host, () =>
    console.log(`[MTJ-ERP] listening on http://${host}:${port} (Basic Auth mtj/***; /api/* is local-only)`));
  return srv;
}
module.exports = { start };
