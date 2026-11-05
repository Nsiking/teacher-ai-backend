'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { db } = require('./src/db');
const { HttpError, text } = require('./src/util');
const auth = require('./src/auth');
const plans = require('./src/plans');
const ai = require('./src/ai');
const prompts = require('./src/prompts');
const backup = require('./src/backup');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const MAX_BODY = 300 * 1024;
const AUTH_MAX = parseInt(process.env.AUTH_RATE_MAX, 10) || 10; // sign-ups/log-ins per address per 15 minutes
const startedAt = Date.now();

// ------------------------------------------------------------------ rate limiting (in memory)
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    throw new HttpError(429, 'Too many attempts. Please wait a moment and try again.', 'RATE_LIMIT');
  }
  arr.push(now);
  hits.set(key, arr);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) {
    const fresh = arr.filter((t) => now - t < 15 * 60 * 1000);
    if (fresh.length) hits.set(k, fresh); else hits.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ------------------------------------------------------------------ router
const routes = [];
function add(method, p, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + p.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, opts, handler });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendFile(res, file, type) {
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) {
    sendJson(res, 404, { error: 'Not found.' });
  }
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) { reject(new HttpError(400, 'Invalid request.')); }
    });
    req.on('error', () => reject(new HttpError(400, 'Invalid request.')));
  });
}
function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  if (f) return String(f).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function requireAdmin(req) {
  const expected = process.env.ADMIN_KEY;
  if (!expected || expected.length < 12) throw new HttpError(503, 'Admin access is not set up.', 'ADMIN_OFF');
  const given = String(req.headers['x-admin-key'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) throw new HttpError(403, 'Wrong admin key.', 'ADMIN_DENIED');
}

// ------------------------------------------------------------------ helpers
function publicUser(u) {
  const plan = plans.effective(u);
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone,
    plan, planExpiresAt: plans.isPaid(plan) ? u.plan_expires_at : null, createdAt: u.created_at,
  };
}
function usageInfo(u) {
  const plan = plans.effective(u);
  return { used: plans.used(u.id), limit: plans.dailyLimit(plan), day: plans.today() };
}
function sessionPayload(u) {
  return { token: auth.signToken(u), user: publicUser(u), usage: usageInfo(u) };
}
function itemRow(r, withContent) {
  const o = {
    id: r.id, kind: r.kind, title: r.title,
    meta: r.meta ? JSON.parse(r.meta) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  if (withContent) o.content = r.content;
  return o;
}

// Removes an account and everything linked to it (used by the account page and by admin).
function deleteUserData(id) {
  db.prepare('DELETE FROM items WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM usage WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM gen_log WHERE user_id = ?').run(id);
  for (const t of ['scores', 'attendance', 'assessments', 'pupils', 'classes']) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ------------------------------------------------------------------ public routes
add('GET', '/health', () => ({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));

add('GET', '/api/meta', () => ({
  classes: prompts.CLASSES,
  terms: prompts.TERMS,
  kinds: Object.keys(prompts.builders),
  limits: { free: plans.FREE_LIMIT, paid: plans.PAID_LIMIT },
  plans: ['free', ...plans.PAID_PLANS],
}));

add('POST', '/api/auth/signup', (ctx) => {
  rateLimit(`auth:${ctx.ip}`, AUTH_MAX, 15 * 60 * 1000);
  const b = ctx.body;
  const name = text(b.name, { name: 'Name', min: 2, max: 60, required: true });
  const email = b.email ? auth.normEmail(b.email) : null;
  const phone = b.phone ? auth.normPhone(b.phone) : null;
  if (!email && !phone) throw new HttpError(400, 'Enter an email or a phone number.');
  const pw = auth.checkPasswordRule(b.password);
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with this email already exists. Please log in.', 'EXISTS');
  if (phone && db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) throw new HttpError(409, 'An account with this phone number already exists. Please log in.', 'EXISTS');
  const info = db.prepare('INSERT INTO users (name, email, phone, pass_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, phone, auth.hashPassword(pw), Date.now());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  return sessionPayload(user);
});

add('POST', '/api/auth/login', (ctx) => {
  rateLimit(`auth:${ctx.ip}`, AUTH_MAX, 15 * 60 * 1000);
  const identifier = typeof ctx.body.identifier === 'string' ? ctx.body.identifier.trim().toLowerCase() : '';
  if (identifier) rateLimit(`login:${identifier}`, 10, 15 * 60 * 1000);
  const user = auth.findByIdentifier(ctx.body.identifier);
  const ok = auth.verifyPassword(String(ctx.body.password || ''), user ? user.pass_hash : auth.DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Wrong email/phone or password.', 'BAD_LOGIN');
  return sessionPayload(user);
});

// ------------------------------------------------------------------ account
add('GET', '/api/me', { auth: true }, (ctx) => ({ user: publicUser(ctx.user), usage: usageInfo(ctx.user) }));

add('POST', '/api/me/password', { auth: true }, (ctx) => {
  rateLimit(`pw:${ctx.user.id}`, 5, 15 * 60 * 1000);
  if (!auth.verifyPassword(String(ctx.body.oldPassword || ''), ctx.user.pass_hash)) throw new HttpError(400, 'Your current password is wrong.');
  const pw = auth.checkPasswordRule(ctx.body.newPassword);
  db.prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(auth.hashPassword(pw), ctx.user.id);
  return sessionPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id));
});

// Required by Google Play: users must be able to delete their account and data.
add('DELETE', '/api/me', { auth: true }, (ctx) => {
  rateLimit(`del:${ctx.user.id}`, 5, 15 * 60 * 1000);
  if (!auth.verifyPassword(String(ctx.body.password || ''), ctx.user.pass_hash)) throw new HttpError(400, 'Your password is wrong.');
  deleteUserData(ctx.user.id);
  return { ok: true };
});

// ------------------------------------------------------------------ AI generation
add('POST', '/api/generate/:kind', { auth: true }, async (ctx) => {
  const def = prompts.builders[ctx.params.kind];
  if (!def) throw new HttpError(404, 'Unknown type.');
  const user = ctx.user;
  const plan = plans.effective(user);

  const spec = def.build(ctx.body, { plan, maxPupils: plans.maxPupils(plan), maxAnswers: plans.maxAnswers(plan) });
  rateLimit(`gen:${user.id}`, parseInt(process.env.GEN_PER_MINUTE, 10) || 6, 60 * 1000);
  const limit = plans.dailyLimit(plan);
  if (!plans.reserve(user.id, limit)) {
    throw new HttpError(429, `You have used all ${limit} generations for today. They reset at midnight, or upgrade for more.`, 'LIMIT_REACHED');
  }

  let out, content, extra = {};
  try {
    out = await ai.generate({
      system: prompts.SYSTEM,
      user: spec.prompt,
      maxTokens: spec.maxTokens,
      model: plans.modelFor(plan),
      mockText: spec.mock,
    });
    content = out.text;
    if (spec.post) {
      const p = spec.post(content);
      content = p.content;
      extra = p.extra || {};
    }
  } catch (e) {
    plans.refund(user.id);
    throw e;
  }

  const now = Date.now();
  db.prepare('INSERT INTO gen_log (user_id, kind, model, input_tokens, output_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, def.kind, out.model, out.inputTokens, out.outputTokens, now);
  const info = db.prepare('INSERT INTO items (user_id, kind, title, meta, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(user.id, def.kind, spec.title, JSON.stringify(spec.meta), content, now, now);

  return {
    id: Number(info.lastInsertRowid),
    kind: def.kind,
    title: spec.title,
    content,
    truncated: out.truncated,
    ...extra,
    usage: usageInfo(user),
  };
});

// ------------------------------------------------------------------ library
add('GET', '/api/library', { auth: true }, (ctx) => {
  const limit = Math.min(Math.max(parseInt(ctx.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(ctx.query.offset, 10) || 0, 0);
  const kind = ctx.query.kind;
  const rows = kind
    ? db.prepare('SELECT * FROM items WHERE user_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(ctx.user.id, kind, limit, offset)
    : db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(ctx.user.id, limit, offset);
  return { items: rows.map((r) => itemRow(r, false)) };
});
add('GET', '/api/library/:id', { auth: true }, (ctx) => {
  const r = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), ctx.user.id);
  if (!r) throw new HttpError(404, 'Item not found.');
  return itemRow(r, true);
});
add('PUT', '/api/library/:id', { auth: true }, (ctx) => {
  const r = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), ctx.user.id);
  if (!r) throw new HttpError(404, 'Item not found.');
  const title = ctx.body.title !== undefined ? text(ctx.body.title, { name: 'Title', required: true, max: 150 }) : r.title;
  let content = r.content;
  if (ctx.body.content !== undefined) {
    if (typeof ctx.body.content !== 'string' || !ctx.body.content.trim()) throw new HttpError(400, 'Content cannot be empty.');
    if (ctx.body.content.length > 80000) throw new HttpError(400, 'Content is too long.');
    content = ctx.body.content;
  }
  db.prepare('UPDATE items SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(title, content, Date.now(), r.id);
  return itemRow(db.prepare('SELECT * FROM items WHERE id = ?').get(r.id), true);
});
add('DELETE', '/api/library/:id', { auth: true }, (ctx) => {
  const info = db.prepare('DELETE FROM items WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), ctx.user.id);
  if (!info.changes) throw new HttpError(404, 'Item not found.');
  return { ok: true };
});

// ------------------------------------------------------------------ classroom record
require('./src/classroom').register(add);

// ------------------------------------------------------------------ admin (needs ADMIN_KEY)
add('GET', '/api/admin/stats', { admin: true }, () => {
  const now = Date.now();
  const week = now - 7 * 86400000;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const todayStart = new Date(plans.today() + 'T00:00:00Z').getTime() - 3600 * 1000;
  return {
    users: one('SELECT COUNT(*) c FROM users').c,
    newUsersLast7Days: one('SELECT COUNT(*) c FROM users WHERE created_at > ?', week).c,
    paidUsersNow: one("SELECT COUNT(*) c FROM users WHERE plan != 'free' AND plan_expires_at > ?", now).c,
    generationsToday: one('SELECT COUNT(*) c FROM gen_log WHERE created_at >= ?', todayStart).c,
    generationsLast7Days: one('SELECT COUNT(*) c FROM gen_log WHERE created_at > ?', week).c,
    inputTokensLast7Days: one('SELECT COALESCE(SUM(input_tokens),0) c FROM gen_log WHERE created_at > ?', week).c,
    outputTokensLast7Days: one('SELECT COALESCE(SUM(output_tokens),0) c FROM gen_log WHERE created_at > ?', week).c,
    aiMode: process.env.AI_MOCK === '1' ? 'TEST (fake answers)' : (process.env.ANTHROPIC_API_KEY ? 'REAL' : 'NO KEY'),
  };
});
add('GET', '/api/admin/users', { admin: true }, (ctx) => {
  const limit = Math.min(Math.max(parseInt(ctx.query.limit, 10) || 50, 1), 200);
  const q = ctx.query.q ? `%${String(ctx.query.q).slice(0, 60)}%` : null;
  const rows = q
    ? db.prepare('SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT ?').all(q, q, q, limit)
    : db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT ?').all(limit);
  return { users: rows.map((u) => ({ ...publicUser(u), usedToday: plans.used(u.id) })) };
});
add('POST', '/api/admin/set-plan', { admin: true }, (ctx) => {
  const user = auth.findByIdentifier(ctx.body.identifier);
  if (!user) throw new HttpError(404, 'No user with that email or phone.');
  const plan = String(ctx.body.plan || '');
  if (plan === 'free') {
    db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ?").run(user.id);
  } else if (plans.PAID_PLANS.includes(plan)) {
    const days = Number(ctx.body.days);
    if (!Number.isInteger(days) || days < 1 || days > 400) throw new HttpError(400, 'Days must be a whole number from 1 to 400.');
    // extend from the later of now or the current expiry
    const base = Math.max(Date.now(), plans.isPaid(plans.effective(user)) ? user.plan_expires_at : 0);
    db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').run(plan, base + days * 86400000, user.id);
  } else {
    throw new HttpError(400, 'Plan must be free, monthly or term.');
  }
  return { ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
});
add('GET', '/api/admin/backup', { admin: true }, async (ctx) => backup.status(ctx.query.list === '1'));
add('POST', '/api/admin/backup/run', { admin: true }, async () => {
  try { return Object.assign({ ok: true }, await backup.runBackup('manual')); }
  catch (e) { throw new HttpError(/not set up/.test(e.message) ? 400 : 502, 'Backup failed: ' + e.message, 'BACKUP_FAILED'); }
});
add('POST', '/api/admin/delete-user', { admin: true }, (ctx) => {
  const user = auth.findByIdentifier(ctx.body.identifier);
  if (!user) throw new HttpError(404, 'No user with that email or phone.');
  deleteUserData(user.id);
  return { ok: true };
});
add('POST', '/api/admin/reset-password', { admin: true }, (ctx) => {
  const user = auth.findByIdentifier(ctx.body.identifier);
  if (!user) throw new HttpError(404, 'No user with that email or phone.');
  const pw = auth.checkPasswordRule(ctx.body.newPassword);
  db.prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(auth.hashPassword(pw), user.id);
  return { ok: true };
});

// ------------------------------------------------------------------ app files (the teacher screens)
const STATIC = {
  '/': ['app.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  '/privacy': ['privacy.html', 'text/html; charset=utf-8'],
  '/terms': ['terms.html', 'text/html; charset=utf-8'],
  '/delete-account': ['delete-account.html', 'text/html; charset=utf-8'],
  '/md.js': ['md.js', 'application/javascript; charset=utf-8'],
  '/classes.js': ['classes.js', 'application/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

// ------------------------------------------------------------------ server
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (req.method === 'GET') {
      if (STATIC[p]) return sendFile(res, path.join(__dirname, 'public', STATIC[p][0]), STATIC[p][1]);
      if (p === '/test' && process.env.TEST_PAGE !== 'off') return sendFile(res, path.join(__dirname, 'public', 'test.html'), 'text/html; charset=utf-8');
      if (p === '/admin') return sendFile(res, path.join(__dirname, 'public', 'admin.html'), 'text/html; charset=utf-8');
    }

    let route = null, m = null;
    let pathMatched = false;
    for (const r of routes) {
      const mm = r.re.exec(p);
      if (!mm) continue;
      pathMatched = true;
      if (r.method === req.method) { route = r; m = mm; break; }
    }
    if (!route) return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'Method not allowed.' : 'Not found.' });

    const params = {};
    route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const body = (req.method === 'GET') ? {} : await readBody(req);
    const ctx = { req, res, ip: clientIp(req), query: Object.fromEntries(url.searchParams), params, body, user: null };
    if (route.opts.admin) { rateLimit(`admin:${ctx.ip}`, 60, 15 * 60 * 1000); requireAdmin(req); }
    if (route.opts.auth) ctx.user = auth.authenticate(req);
    const out = await route.handler(ctx);
    sendJson(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) {
      return sendJson(res, e.status, { error: e.message, code: e.code });
    }
    console.error('Unexpected error:', e && e.stack ? e.stack : e);
    sendJson(res, 500, { error: 'Something went wrong on our side. Please try again.', code: 'SERVER_ERROR' });
  }
});
server.requestTimeout = 300000;
server.headersTimeout = 60000;

server.listen(PORT, () => {
  const mode = process.env.AI_MOCK === '1' ? 'TEST MODE (fake AI answers)' : (process.env.ANTHROPIC_API_KEY ? 'REAL AI' : 'NO AI KEY SET');
  console.log(`SmartClass Teacher AI backend running on port ${PORT} | AI: ${mode}`);
  if (!process.env.ADMIN_KEY) console.log('Note: ADMIN_KEY is not set, so /admin is switched off.');
  backup.startScheduler();
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
