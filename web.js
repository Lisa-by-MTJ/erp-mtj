// MTJ Channel Manager — HTTP layer: session auth + login page + router (Blueprint V2.0)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const api = require('./api.js');

const UI_DIR = path.join(__dirname, 'ui');
const USER = process.env.MTJ_USER;
const PASS = process.env.MTJ_PASS;
if (!USER || !PASS) {
  console.error('[MTJ-ERP] MTJ_USER and MTJ_PASS env vars are required (e.g. via --env-file .env)');
  process.exit(1);
}
const EXPECTED = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// ---- stateless session tokens: <exp>.<hmac(secret, user+exp)> ----
const SECRET = crypto.createHash('sha256').update('mtj-erp-session:' + USER + ':' + PASS).digest();
const TTL_MS = 7 * 24 * 3600 * 1000;
const sign = exp => crypto.createHmac('sha256', SECRET).update(USER + ':' + exp).digest('hex');
const newToken = () => { const exp = Date.now() + TTL_MS; return exp + '.' + sign(exp); };
function validToken(tok) {
  if (!tok) return false;
  const dot = tok.lastIndexOf('.');
  if (dot < 1) return false;
  const exp = tok.slice(0, dot), sig = tok.slice(dot + 1);
  const want = sign(exp);
  if (sig.length !== want.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  return Number(exp) > Date.now();
}
const COOKIE = 'mtj_session';
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
function credsOK(user, pass) {
  const a = Buffer.from(String(user || '')), b = Buffer.from(USER);
  const c = Buffer.from(String(pass || '')), d = Buffer.from(PASS);
  return a.length === b.length && c.length === d.length &&
    crypto.timingSafeEqual(a, b) && crypto.timingSafeEqual(c, d);
}

function send(res, code, body, type, headers) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store' }, headers || {}));
  res.end(buf);
}

function start(port) {
  const srv = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;

      // ---- public routes (no session) ----
      // favicon + logo are public so they render on the login page and in
      // browser tabs before auth (browsers fetch /favicon.png pre-login).
      if (p === '/favicon.png') {
        return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'favicon.png')), 'image/png',
          { 'Cache-Control': 'public, max-age=86400' });
      }
      if (p === '/logo.png') {
        return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'logo.png')), 'image/png',
          { 'Cache-Control': 'public, max-age=86400' });
      }
      if (p === '/login' && req.method === 'GET') {
        return send(res, 200, fs.readFileSync(path.join(UI_DIR, 'login.html')), 'text/html; charset=utf-8');
      }
      if (p === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 4096) req.destroy(); });
        return req.on('end', () => {
          const q = new URLSearchParams(body);
          if (credsOK(q.get('username'), q.get('password'))) {
            return send(res, 302, '', 'text/plain', {
              'Set-Cookie': `${COOKIE}=${newToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`,
              'Location': '/' });
          }
          return send(res, 302, '', 'text/plain', { 'Location': '/login?e=1' });
        });
      }
      if (p === '/logout') {
        return send(res, 302, '', 'text/plain', {
          'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
          'Location': '/login' });
      }

      // ---- auth gate: session cookie OR HTTP Basic (for scripts/curl) ----
      const sess = getCookie(req, COOKIE);
      const basic = req.headers.authorization || '';
      if (!validToken(sess) && basic !== EXPECTED) {
        if (p.startsWith('/api/')) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }));
        return send(res, 302, '', 'text/plain', { 'Location': '/login' });
      }

      if (p === '/api/session') return send(res, 200, JSON.stringify({ user: USER }));

      if (p.startsWith('/api/')) return api.handle(req, res, url);
      if (p.startsWith('/uploads/')) { // product photos etc., stored under data/uploads
        const rel = p.replace(/^\/uploads\//, '').replace(/\.\./g, '');
        const full = path.join(process.env.MTJ_DATA_DIR || path.join(__dirname, 'data'), 'uploads', rel);
        if (!fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
        const emime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(full).toLowerCase()];
        return send(res, 200, fs.readFileSync(full), emime || 'application/octet-stream',
          { 'Cache-Control': 'public, max-age=86400' });
      }
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
    console.log(`[MTJ-ERP] listening on http://${host}:${port} (session auth + /login page; Basic Auth kept for scripts; /api/* is local-only)`));
  return srv;
}
module.exports = { start };
