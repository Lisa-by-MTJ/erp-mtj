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
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json' };

// ---- stateless session tokens: <exp>.<hmac(secret, user+exp)> ----
// Report fix: secret must not be derived from the Basic-Auth password (rotation/
// disclosure coupling). Prefer MTJ_SESSION_SECRET env; else persist a random key
// per data dir; last resort derives from credentials (pre-2016 Node fallback).
const SECRET = (() => {
  if (process.env.MTJ_SESSION_SECRET && process.env.MTJ_SESSION_SECRET.length >= 32)
    return crypto.createHash('sha256').update(process.env.MTJ_SESSION_SECRET).digest();
  try {
    const dataDir = process.env.MTJ_DATA_DIR || path.join(__dirname, 'data');
    const kf = path.join(dataDir, 'session_secret.key');
    let k = null;
    try { k = fs.readFileSync(kf, 'utf8').trim(); } catch (e) { /* first boot */ }
    if (!k || k.length < 64) {
      k = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(kf, k + '\n', { mode: 0o600 });
    }
    return crypto.createHash('sha256').update('mtj-erp-session:' + k).digest();
  } catch (e) {
    console.error('[MTJ-ERP] WARN: could not persist session secret, deriving from credentials');
    return crypto.createHash('sha256').update('mtj-erp-session:' + USER + ':' + PASS).digest();
  }
})();
const TTL_MS = 7 * 24 * 3600 * 1000;
const { db, verifyPassword } = require('./db.js');
// username-bound token: <username>.<exp>.<hmac(secret, username+exp)>
const signFor = (user, exp) => crypto.createHmac('sha256', SECRET).update(user + ':' + exp).digest('hex');
const newTokenFor = user => { const exp = Date.now() + TTL_MS; return `${user}.${exp}.${signFor(user, exp)}`; };
function validToken(tok) {
  return decodeToken(tok) !== null;
}
// ---- who is logged in? session cookie user OR Basic (env admin) ----
function decodeToken(tok) {
  if (!tok) return null;
  const i1 = tok.lastIndexOf('.'), i2 = i1 > 0 ? tok.lastIndexOf('.', i1 - 1) : -1;
  if (i1 < 1 || i2 < 0) return null;
  const user = tok.slice(0, i2), exp = tok.slice(i2 + 1, i1), sig = tok.slice(i1 + 1);
  const want = signFor(user, exp);
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return Number(exp) > Date.now() ? user : null;
}
function sessionUser(req) {
  const tok = getCookie(req, COOKIE);
  const u = decodeToken(tok);
  if (u) {
    const row = db.prepare(`SELECT * FROM users WHERE username=? AND is_active=1`).get(u);
    if (row) return row;
    if (u === USER) return { id: 1, username: USER, full_name: 'Administrator', role: 'ADMIN', is_active: 1 };
    return null;
  }
  if ((req.headers.authorization || '') === EXPECTED)
    return { id: 1, username: USER, full_name: 'Administrator', role: 'ADMIN', is_active: 1 };
  return null;
}
const COOKIE = 'mtj_session';
let MANIFEST = null; // doc_no -> pdf filename, loaded lazily from data/invoices/manifest.json
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
    'Cache-Control': 'no-store' }, SECURITY_HEADERS, headers || {}));
  res.end(buf);
}

// ---- security headers (report P1) — applied to every response via send() ----
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
};

// ---- login rate limiting (report P1): 10 failures / 15 min / IP+username ----
const LOGIN_FAILS = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000, RATE_MAX_FAILS = 10;
function loginBlocked(key) {
  const e = LOGIN_FAILS.get(key);
  return !!e && e.count >= RATE_MAX_FAILS && (Date.now() - e.first) < RATE_WINDOW_MS;
}
function loginFail(key) {
  const now = Date.now();
  const e = LOGIN_FAILS.get(key);
  if (!e || (now - e.first) >= RATE_WINDOW_MS) LOGIN_FAILS.set(key, { first: now, count: 1 });
  else e.count++;
  if (LOGIN_FAILS.size > 1000) for (const [k, v] of LOGIN_FAILS) if ((now - v.first) >= RATE_WINDOW_MS) LOGIN_FAILS.delete(k);
}
const loginKey = (req, u) => {
  // All public traffic arrives via the Cloudflare tunnel (socket addr is 127.0.0.1),
  // so use the real client IP when Cloudflare provides it.
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?';
  return `${ip}|${String(u || '').toLowerCase()}`;
};

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
          const u = String(q.get('username') || ''), pw = String(q.get('password') || '');
          const key = loginKey(req, u);
          // brute-force guard: 10 failed attempts / 15 min per IP+username
          if (loginBlocked(key)) {
            console.log(`[MTJ-ERP] login rate-limited: ${key.split('|')[0]} (user=${u})`);
            return send(res, 302, '', 'text/plain', { 'Location': '/login?e=1' });
          }
          // 1) DB users (scrypt-hashed, role-backed)
          const row = db.prepare(`SELECT * FROM users WHERE username=? AND is_active=1`).get(u);
          if (row && verifyPassword(pw, row.password_hash)) {
            LOGIN_FAILS.delete(key);
            return send(res, 302, '', 'text/plain', {
              'Set-Cookie': `${COOKIE}=${newTokenFor(u)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`,
              'Location': '/' });
          }
          // 2) legacy env admin fallback (kept so --env-file credentials always work)
          if (credsOK(u, pw)) {
            LOGIN_FAILS.delete(key);
            return send(res, 302, '', 'text/plain', {
              'Set-Cookie': `${COOKIE}=${newTokenFor(u)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`,
              'Location': '/' });
          }
          loginFail(key);
          return send(res, 302, '', 'text/plain', { 'Location': '/login?e=1' });
        });
      }
      if (p === '/logout') {
        return send(res, 302, '', 'text/plain', {
          'Set-Cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
          'Location': '/login' });
      }

      // ---- auth gate: session cookie OR HTTP Basic (for scripts/curl) ----
      const user = sessionUser(req);
      if (!user) {
        if (p.startsWith('/api/')) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }));
        return send(res, 302, '', 'text/plain', { 'Location': '/login' });
      }
      if (p === '/api/session') return send(res, 200, JSON.stringify(
        { user: user.username, full_name: user.full_name, role: user.role, id: user.id }));

      if (p.startsWith('/api/')) return api.handle(req, res, url, user);
      if (p.startsWith('/invoice-pdf/')) { // historical ASJ invoice PDFs (session-gated)
        const doc = decodeURIComponent(p.slice('/invoice-pdf/'.length));
        if (!MANIFEST) {
          try { MANIFEST = JSON.parse(fs.readFileSync(path.join(process.env.MTJ_DATA_DIR || path.join(__dirname, 'data'), 'invoices', 'manifest.json'), 'utf8')); }
          catch (e) { MANIFEST = {}; }
        }
        const fn = /^[A-Za-z0-9\-]+$/.test(doc) ? MANIFEST[doc] : null;
        const full = fn && path.join(process.env.MTJ_DATA_DIR || path.join(__dirname, 'data'), 'invoices', fn);
        if (!fn || !/\.pdf$/i.test(fn) || !full || !fs.existsSync(full)) return send(res, 404, 'Invoice PDF not found', 'text/plain');
        return send(res, 200, fs.readFileSync(full), 'application/pdf',
          { 'Content-Disposition': `inline; filename="${encodeURIComponent(fn)}"`, 'Cache-Control': 'private, max-age=86400' });
      }
      if (p.startsWith('/uploads/')) { // product photos etc., stored under data/uploads
        const rel = p.replace(/^\/uploads\//, '').replace(/\.\./g, '');
        const full = path.join(process.env.MTJ_DATA_DIR || path.join(__dirname, 'data'), 'uploads', rel);
        if (!fs.existsSync(full)) return send(res, 404, 'Not found', 'text/plain');
        const emime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' }[path.extname(full).toLowerCase()];
        if (full.includes('/attachments/') && !p.includes('/api/')) {
          // attachment downloads require a session; enforce here (route is past auth gate already)
          if (!user) return send(res, 401, 'Unauthorized', 'text/plain');
        }
        return send(res, 200, fs.readFileSync(full), emime || 'application/octet-stream',
          emime === 'application/pdf'
            ? { 'Content-Disposition': `inline; filename="${encodeURIComponent(path.basename(full))}"`, 'Cache-Control': 'private, max-age=86400' }
            : { 'Cache-Control': 'public, max-age=86400' });
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
