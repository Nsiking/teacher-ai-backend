'use strict';
const { db } = require('./db');

function num(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; }

// ---- Limits (each can be changed with an environment setting on Render) ----
const FREE_DAILY = num(process.env.FREE_DAILY_LIMIT, 3);
const FREE_MONTHLY = num(process.env.FREE_MONTHLY_LIMIT, 20);
const PAID_DAILY = num(process.env.PAID_DAILY_LIMIT, 30);
const LIMITS = {
  free: { classes: num(process.env.FREE_MAX_CLASSES, 2), pupils: num(process.env.FREE_MAX_PUPILS, 50), library: num(process.env.FREE_LIBRARY_ITEMS, 30) },
  paid: { classes: num(process.env.PAID_MAX_CLASSES, 10), pupils: num(process.env.PAID_MAX_PUPILS, 80), library: null },
};

// ---- Paid plans (Teacher Plus). Prices are in naira. ----
const PAID_PLANS = ['monthly', 'term', 'year'];
const PLAN_INFO = {
  monthly: { label: 'Monthly', price: num(process.env.PRICE_MONTHLY, 1500), days: 30 },
  term: { label: 'Term (3 months)', price: num(process.env.PRICE_TERM, 3500), days: 91 },
  year: { label: 'Year (3 terms)', price: num(process.env.PRICE_YEAR, 9500), days: 365 },
};

// "Today" in Nigerian time (UTC+1) so limits reset at local midnight.
function today() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
}

function effective(user) {
  if (PAID_PLANS.includes(user.plan) && user.plan_expires_at && user.plan_expires_at > Date.now()) return user.plan;
  return 'free';
}
function isPaid(plan) { return PAID_PLANS.includes(plan); }
function dailyLimit(plan) { return isPaid(plan) ? PAID_DAILY : FREE_DAILY; }
function monthlyLimit(plan) { return isPaid(plan) ? null : FREE_MONTHLY; }
function maxPupils(plan) { return isPaid(plan) ? 40 : 5; }
function maxAnswers(plan) { return isPaid(plan) ? 15 : 3; }
function classLimits(plan) { return isPaid(plan) ? LIMITS.paid : LIMITS.free; }
function maxTextbooks(plan) { return isPaid(plan) ? num(process.env.PAID_MAX_TEXTBOOKS, 30) : num(process.env.FREE_MAX_TEXTBOOKS, 5); }
function libraryLimit(plan) { return isPaid(plan) ? LIMITS.paid.library : LIMITS.free.library; }
function modelFor(plan) {
  return isPaid(plan)
    ? (process.env.AI_MODEL_PAID || 'claude-sonnet-5-5')
    : (process.env.AI_MODEL_FREE || 'claude-haiku-5-5');
}

function used(userId) {
  const r = db.prepare('SELECT count FROM usage WHERE user_id = ? AND day = ?').get(userId, today());
  return r ? r.count : 0;
}
function monthlyUsed(userId) {
  const r = db.prepare('SELECT COALESCE(SUM(count), 0) c FROM usage WHERE user_id = ? AND day LIKE ?').get(userId, today().slice(0, 7) + '-%');
  return r.c;
}
// Reserve one generation before calling the AI; refund it if the AI fails.
// Returns { ok: true } or { ok: false, reason: 'day' | 'month' }.
function reserve(userId, dailyMax, monthlyMax) {
  const day = today();
  db.prepare('INSERT OR IGNORE INTO usage (user_id, day, count) VALUES (?, ?, 0)').run(userId, day);
  const r = db.prepare('SELECT count FROM usage WHERE user_id = ? AND day = ?').get(userId, day);
  if (r.count >= dailyMax) return { ok: false, reason: 'day' };
  if (monthlyMax && monthlyUsed(userId) >= monthlyMax) return { ok: false, reason: 'month' };
  db.prepare('UPDATE usage SET count = count + 1 WHERE user_id = ? AND day = ?').run(userId, day);
  return { ok: true };
}
function refund(userId) {
  db.prepare('UPDATE usage SET count = MAX(count - 1, 0) WHERE user_id = ? AND day = ?').run(userId, today());
}

module.exports = {
  today, effective, isPaid, dailyLimit, monthlyLimit, maxPupils, maxAnswers, classLimits, libraryLimit, maxTextbooks, modelFor,
  used, monthlyUsed, reserve, refund, PAID_PLANS, PLAN_INFO, FREE_DAILY, FREE_MONTHLY, PAID_DAILY, LIMITS,
};
