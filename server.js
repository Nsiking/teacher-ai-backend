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
const textbooks = require('./src/textbooks');
const formats = require('./src/formats');
const aihealth = require('./src/aihealth');
const packs = require('./src/packs');
const passwordReset = require('./src/passwordreset');
const recoveryEmail = require('./src/recoveryemail');

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
function readBody(req, limit) {
  const max = limit || MAX_BODY;
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (over) { if (size > max * 4) req.destroy(); return; }   // keep reading so we can answer properly; stop only for absurd sizes
      if (size > max) { over = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return reject(new HttpError(413, 'That is too large. Please try a smaller photo.', 'TOO_LARGE'));
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
    id: u.id, name: u.name, email: u.email, phone: u.phone, emailVerified: recoveryEmail.isVerified(u),
    plan, planExpiresAt: plans.isPaid(plan) ? u.plan_expires_at : null, createdAt: u.created_at,
  };
}
function usageInfo(u) {
  const plan = plans.effective(u);
  return { used: plans.used(u.id), limit: plans.dailyLimit(plan), monthlyUsed: plans.monthlyUsed(u.id), monthlyLimit: plans.monthlyLimit(plan), day: plans.today() };
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
  for (const t of ['scores', 'attendance', 'assessments', 'pupils', 'classes', 'timetable_slots', 'formats', 'packs', 'reset_codes', 'email_codes', 'email_verified']) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(id);
  }
  db.prepare('DELETE FROM textbooks WHERE owner_user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ------------------------------------------------------------------ public routes
add('GET', '/health', () => ({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));

add('GET', '/api/meta', () => ({
  classes: prompts.CLASSES,
  terms: prompts.TERMS,
  kinds: Object.keys(prompts.builders),
  limits: { free: plans.FREE_DAILY, paid: plans.PAID_DAILY, freeMonthly: plans.FREE_MONTHLY },
  textbookLimits: { free: plans.maxTextbooks('free'), paid: plans.maxTextbooks('monthly') },
  plans: ['free', ...plans.PAID_PLANS],
  plansInfo: plans.PLAN_INFO,
  classLimits: plans.LIMITS,
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

  const chosenBooks = textbooks.resolveForUser(user, ctx.body.textbookIds);
  const chosenFormat = formats.resolveForGenerate(user, ctx.body.formatId, ctx.params.kind);
  const spec = def.build(ctx.body, { plan, maxPupils: plans.maxPupils(plan), maxAnswers: plans.maxAnswers(plan), textbooks: chosenBooks, format: chosenFormat });
  const packLink = packs.linkMeta(user, ctx.body, ctx.params.kind);
  if (packLink) spec.meta = Object.assign({}, spec.meta, packLink);
  rateLimit(`gen:${user.id}`, parseInt(process.env.GEN_PER_MINUTE, 10) || 6, 60 * 1000);
  const limit = plans.dailyLimit(plan);
  const mLimit = plans.monthlyLimit(plan);
  const got = plans.reserve(user.id, limit, mLimit);
  if (!got.ok && got.reason === 'month') {
    throw new HttpError(429, `You have used all ${mLimit} free generations for this month. They reset on the 1st, or upgrade to Teacher Plus for more.`, 'LIMIT_REACHED_MONTH');
  }
  if (!got.ok) {
    throw new HttpError(429, `You have used all ${limit} generations for today. They reset at midnight, or upgrade for more.`, 'LIMIT_REACHED');
  }

  let out, content, extra = {}, formatCheck = null;
  try {
    out = await ai.generate({
      system: prompts.SYSTEM,
      user: spec.prompt,
      maxTokens: spec.maxTokens,
      model: plans.modelFor(plan),
      mockText: spec.mock,
    });
    content = out.text;
    if (spec.textbooks && spec.textbooks.length) content = textbooks.applyRefs(content, spec.textbooks);
    if (spec.format) formatCheck = formats.checkOutput(spec.format.spec, content);
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
    formatCheck,
    usage: usageInfo(user),
  };
});

// ------------------------------------------------------------------ library
// On the free plan only the newest N items can be opened. Older ones are locked, never deleted.
function openableIds(user) {
  const lim = plans.libraryLimit(plans.effective(user));
  if (!lim) return null;
  return new Set(db.prepare('SELECT id FROM items WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(user.id, lim).map((r) => r.id));
}
function lockedError() {
  return new HttpError(403, 'This older item is locked on the free plan. Upgrade to Teacher Plus to open it.', 'LIBRARY_LOCKED');
}
add('GET', '/api/library', { auth: true }, (ctx) => {
  const limit = Math.min(Math.max(parseInt(ctx.query.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(ctx.query.offset, 10) || 0, 0);
  const kind = ctx.query.kind;
  const rows = kind
    ? db.prepare('SELECT * FROM items WHERE user_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(ctx.user.id, kind, limit, offset)
    : db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(ctx.user.id, limit, offset);
  const open = openableIds(ctx.user);
  const total = db.prepare('SELECT COUNT(*) c FROM items WHERE user_id = ?').get(ctx.user.id).c;
  return {
    items: rows.map((r) => Object.assign(itemRow(r, false), { locked: open ? !open.has(r.id) : false })),
    lockedCount: open ? Math.max(0, total - open.size) : 0,
    libraryLimit: plans.libraryLimit(plans.effective(ctx.user)),
  };
});
add('GET', '/api/library/:id', { auth: true }, (ctx) => {
  const r = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), ctx.user.id);
  if (!r) throw new HttpError(404, 'Item not found.');
  const open = openableIds(ctx.user);
  if (open && !open.has(r.id)) throw lockedError();
  return itemRow(r, true);
});
add('PUT', '/api/library/:id', { auth: true }, (ctx) => {
  const r = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), ctx.user.id);
  if (!r) throw new HttpError(404, 'Item not found.');
  const openForEdit = openableIds(ctx.user);
  if (openForEdit && !openForEdit.has(r.id)) throw lockedError();
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
textbooks.register(add, { rateLimit, usageInfo });
formats.register(add, { rateLimit, usageInfo });
packs.register(add, { rateLimit, usageInfo });
passwordReset.register(add, { rateLimit, sessionPayload });
recoveryEmail.register(add, { rateLimit, publicUser });
require('./src/quality').register(add, { rateLimit, usageInfo, isOpenable: (user, id) => { const open = openableIds(user); return !open || open.has(id); } });
require('./src/timetable').register(add, { rateLimit });

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
// Gives a user a plan. Days are added after the current expiry if they are already on a paid plan.
function applyPlan(user, plan, daysIn) {
  if (plan === 'free') {
    db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ?").run(user.id);
  } else if (plans.PAID_PLANS.includes(plan)) {
    const days = daysIn === undefined || daysIn === null || daysIn === '' ? plans.PLAN_INFO[plan].days : Number(daysIn);
    if (!Number.isInteger(days) || days < 1 || days > 400) throw new HttpError(400, 'Days must be a whole number from 1 to 400.');
    const base = Math.max(Date.now(), plans.isPaid(plans.effective(user)) ? user.plan_expires_at : 0);
    db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').run(plan, base + days * 86400000, user.id);
  } else {
    throw new HttpError(400, 'Plan must be free, monthly, term or year.');
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
}
add('POST', '/api/admin/set-plan', { admin: true }, (ctx) => {
  const user = auth.findByIdentifier(ctx.body.identifier);
  if (!user) throw new HttpError(404, 'No user with that email or phone.');
  return { ok: true, user: publicUser(applyPlan(user, String(ctx.body.plan || ''), ctx.body.days)) };
});
// School licences: give many teachers the same plan at once.
add('POST', '/api/admin/set-plan-bulk', { admin: true }, (ctx) => {
  const plan = String(ctx.body.plan || '');
  if (plan !== 'free' && !plans.PAID_PLANS.includes(plan)) throw new HttpError(400, 'Plan must be free, monthly, term or year.');
  let list = ctx.body.identifiers;
  if (typeof list === 'string') list = list.split(/[\r\n,;]+/);
  if (!Array.isArray(list)) throw new HttpError(400, 'Give a list of emails or phone numbers.');
  list = list.map((x) => String(x).trim()).filter(Boolean);
  if (!list.length) throw new HttpError(400, 'Give at least one email or phone number.');
  if (list.length > 200) throw new HttpError(400, 'Up to 200 teachers at a time.');
  const results = list.map((identifier) => {
    const user = auth.findByIdentifier(identifier);
    if (!user) return { identifier, ok: false, error: 'No account with that email or phone.' };
    try { const u = applyPlan(user, plan, ctx.body.days); return { identifier, ok: true, name: u.name, planExpiresAt: plan === 'free' ? null : u.plan_expires_at }; }
    catch (e) { return { identifier, ok: false, error: e.message }; }
  });
  return { ok: true, done: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
});
add('GET', '/api/admin/ai-health', { admin: true }, () => aihealth.snapshot());
// A tiny real call to each model (costs a fraction of a cent) to prove the key, the credits and the model names work.
add('POST', '/api/admin/ai-test', { admin: true }, async () => {
  const snap = aihealth.snapshot();
  const models = Array.from(new Set([snap.models.free, snap.models.paid]));
  const results = [];
  for (const model of models) {
    const t0 = Date.now();
    try {
      const out = await ai.generate({ system: 'Reply with exactly one word.', user: 'Say OK.', maxTokens: 20, model, mockText: 'OK', think: 'off' });
      results.push({ model, ok: true, ms: Date.now() - t0, reply: out.text.slice(0, 40), mock: out.model === 'mock' });
    } catch (e) {
      results.push({ model, ok: false, ms: Date.now() - t0, kind: e.aiKind || 'other', advice: aihealth.ADVICE[e.aiKind || 'other'] });
    }
  }
  return { results, health: aihealth.snapshot() };
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
  '/timetable.js': ['timetable.js', 'application/javascript; charset=utf-8'],
  '/formats.js': ['formats.js', 'application/javascript; charset=utf-8'],
  '/packs.js': ['packs.js', 'application/javascript; charset=utf-8'],
  '/reset.js': ['reset.js', 'application/javascript; charset=utf-8'],
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
    const body = (req.method === 'GET') ? {} : await readBody(req, route.opts.maxBody);
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
