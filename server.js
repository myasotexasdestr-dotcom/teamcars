'use strict';
// TeamCars — облік автозапчастин. Один процес Node: API + роздача клієнта (public/) + фото.
// Без зовнішніх фреймворків: лише вбудований http і SQLite (better-sqlite3).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- .env (простий завантажувач, щоб не тягнути dotenv) ---
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { openDatabase, loadSecret } = require('./src/db');
const { createLogic, AppError } = require('./src/logic');

const PORT = Number(process.env.PORT || 3010);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const SESSION_TTL_MS = 60 * 24 * 3600 * 1000; // 60 днів без активності

const db = openDatabase(DATA_DIR);
const logic = createLogic(db, loadSecret(DATA_DIR));
const seeded = logic.seedIfEmpty({
  adminName: process.env.ADMIN_NAME || 'Адміністратор',
  adminPin: process.env.ADMIN_PIN || '0000',
  demo: process.env.SEED_DEMO === '1',
});
if (seeded) {
  console.log(process.env.SEED_DEMO === '1'
    ? 'Створено демо-дані. PIN: 1111 (адмін), 2222 (власник).'
    : `Створено першого адміна «${process.env.ADMIN_NAME || 'Адміністратор'}». Увійдіть і одразу змініть PIN у Налаштуваннях.`);
}

// --- sessions ---
const tokenHash = t => crypto.createHash('sha256').update(t).digest('hex');
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(tokenHash(token), userId, now, now);
  return token;
}
function authUser(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  const th = tokenHash(token);
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(th);
  if (!s) return null;
  if (Date.now() - s.last_seen > SESSION_TTL_MS) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(th); return null; }
  const u = logic.getUser(s.user_id);
  if (!u || !u.active || u.deleted) return null;
  if (Date.now() - s.last_seen > 60000) db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), th);
  return { user: u, tokenHash: th };
}

// --- rate limit на вхід: 20 спроб / 15 хв з однієї IP ---
const attempts = new Map();
function rateOk(ip) {
  const now = Date.now(), win = 15 * 60 * 1000;
  const r = attempts.get(ip);
  if (!r || now - r.start > win) { attempts.set(ip, { n: 1, start: now }); return true; }
  r.n++; return r.n <= 20;
}
setInterval(() => { const now = Date.now(); for (const [ip, r] of attempts) if (now - r.start > 15 * 60 * 1000) attempts.delete(ip); }, 600000).unref();
const clientIp = req => (req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?');

// --- helpers ---
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}
function readJson(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new AppError('Запит завеликий', 413, 'too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new AppError('Невірний JSON', 400, 'bad_json')); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveFile(res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  });
}
function safeJoin(root, rel) {
  const p = path.normalize(path.join(root, rel));
  return p.startsWith(root + path.sep) || p === root ? p : null;
}

// --- routes ---
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/health') return send(res, 200, { ok: true, driver: db.driver });

  if (p === '/api/auth/login' && req.method === 'POST') {
    if (!rateOk(clientIp(req))) return send(res, 429, { error: 'too_many_attempts', message: 'Забагато спроб. Спробуйте через 15 хвилин.' });
    const body = await readJson(req, 4096);
    const u = logic.login(String(body.pin || ''));
    if (!u) return send(res, 401, { error: 'invalid_pin', message: 'Невірний PIN-код' });
    const token = createSession(u.id);
    return send(res, 200, { token, ...logic.snapshot(u) });
  }

  if (p.startsWith('/api/')) {
    const auth = authUser(req);
    if (!auth) return send(res, 401, { error: 'unauthorized', message: 'Сесія завершилась. Увійдіть знову.' });
    const user = auth.user;

    if (p === '/api/auth/logout' && req.method === 'POST') {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, logic.snapshot(user));
    if (p === '/api/version' && req.method === 'GET') return send(res, 200, { version: logic.version() });

    if (p === '/api/action' && req.method === 'POST') {
      const body = await readJson(req, 1024 * 1024);
      const result = logic.run(String(body.type || ''), user, body.payload || {});
      const fresh = logic.getUser(user.id);
      return send(res, 200, { ok: true, result, ...logic.snapshot(fresh && fresh.active && !fresh.deleted ? fresh : user) });
    }

    if (p === '/api/photos' && req.method === 'POST') {
      const body = await readJson(req, 8 * 1024 * 1024);
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
      if (!m) return send(res, 400, { error: 'bad_image', message: 'Підтримуються JPG, PNG або WEBP' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 5 * 1024 * 1024) return send(res, 413, { error: 'too_large', message: 'Фото завелике (макс. 5 МБ)' });
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
      return send(res, 200, { url: '/photos/' + name });
    }
    return send(res, 404, { error: 'not_found', message: 'Немає такого запиту' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  if (p.startsWith('/photos/')) {
    const f = safeJoin(PHOTO_DIR, decodeURIComponent(p.slice(8)));
    return f ? serveFile(res, f, 'public, max-age=31536000, immutable') : send(res, 404, 'Not found');
  }
  if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
  const f = safeJoin(PUBLIC_DIR, decodeURIComponent(p.slice(1)));
  if (f && fs.existsSync(f) && fs.statSync(f).isFile()) return serveFile(res, f, 'public, max-age=3600');
  return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), 'no-cache');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (err instanceof AppError) return send(res, err.status, { error: err.code, message: err.message });
    console.error(new Date().toISOString(), req.method, req.url, err);
    send(res, 500, { error: 'server_error', message: 'Помилка сервера. Спробуйте ще раз.' });
  });
});
server.listen(PORT, HOST, () => console.log(`TeamCars: http://${HOST}:${PORT}  (БД: ${path.join(DATA_DIR, 'teamcars.db')}, драйвер ${db.driver})`));

function shutdown() { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
