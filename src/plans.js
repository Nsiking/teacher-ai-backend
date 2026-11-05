'use strict';
const { db } = require('./db');

const FREE_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT, 10) || 3;
const PAID_LIMIT = parseInt(process.env.PAID_DAILY_LIMIT, 10) || 30;
const PAID_PLANS = ['monthly', 'term'];

// "Today" in Nigerian time (UTC+1) so limits reset at local midnight.
function today() {
  return new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);
}

function effective(user) {
  if (PAID_PLANS.includes(user.plan) && user.plan_expires_at && user.plan_expires_at > Date.now()) return user.plan;
  return 'free';
}
function isPaid(plan) { return PAID_PLANS.includes(plan); }
function dailyLimit(plan) { return isPaid(plan) ? PAID_LIMIT : FREE_LIMIT; }
function maxPupils(plan) { return isPaid(plan) ? 40 : 5; }
function maxAnswers(plan) { return isPaid(plan) ? 15 : 3; }
function modelFor(plan) {
  return isPaid(plan)
    ? (process.env.AI_MODEL_PAID || 'claude-sonnet-5-5')
    : (process.env.AI_MODEL_FREE || 'claude-haiku-5-5');
}

function used(userId) {
  const r = db.prepare('SELECT count FROM usage WHERE user_id = ? AND day = ?').get(userId, today());
  return r ? r.count : 0;
}
// Reserve one generation before calling the AI; refund it if the AI fails.
function reserve(userId, limit) {
  const day = today();
  db.prepare('INSERT OR IGNORE INTO usage (user_id, day, count) VALUES (?, ?, 0)').run(userId, day);
  const r = db.prepare('SELECT count FROM usage WHERE user_id = ? AND day = ?').get(userId, day);
  if (r.count >= limit) return false;
  db.prepare('UPDATE usage SET count = count + 1 WHERE user_id = ? AND day = ?').run(userId, day);
  return true;
}
function refund(userId) {
  db.prepare('UPDATE usage SET count = MAX(count - 1, 0) WHERE user_id = ? AND day = ?').run(userId, today());
}

module.exports = { today, effective, isPaid, dailyLimit, maxPupils, maxAnswers, modelFor, used, reserve, refund, PAID_PLANS, FREE_LIMIT, PAID_LIMIT };
