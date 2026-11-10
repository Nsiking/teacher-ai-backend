'use strict';
// Recovery email: a teacher adds an email address and confirms it once with a code. A confirmed email can be used to log in and to
// reset the password, even when the teacher typed their phone number. A change needs the password, so a stolen session cannot
// quietly add the thief's own email. Codes: never stored (only a fingerprint), 15 minutes, 5 tries, one a minute, 5 a day.
const crypto = require('crypto');
const { db } = require('./db');
const { HttpError } = require('./util');
const auth = require('./auth');
const messenger = require('./messenger');

const MINUTES = 15;
const MAX_TRIES = 5;
const COOLDOWN_MS = 60 * 1000;
const MAX_SENDS_PER_DAY = 5;
const dayKey = () => new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10);

// An email counts as confirmed only while it is still the very address that was confirmed.
function isVerified(user) {
  if (!user || !user.email) return false;
  const r = db.prepare('SELECT email FROM email_verified WHERE user_id = ?').get(user.id);
  return !!r && r.email === user.email;
}
function markVerified(userId, email) {
  db.prepare(`INSERT INTO email_verified (user_id, email, verified_at) VALUES (?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, verified_at = excluded.verified_at`).run(userId, email, Date.now());
}
function mask(email) { const p = String(email).toLowerCase().split('@'); return p[0].charAt(0) + '***@' + p[1]; }

function register(add, helpers) {
  add('POST', '/api/me/email/request', { auth: true, maxBody: 5000 }, (ctx) => {
    const user = ctx.user;
    helpers.rateLimit('emailreq:' + user.id, 10, 60 * 60 * 1000);
    if (!messenger.channels().email) throw new HttpError(503, 'Email is not available right now. Please try again later, or message us on WhatsApp.', 'EMAIL_UNAVAILABLE');
    if (!auth.verifyPassword(String(ctx.body.password || ''), user.pass_hash)) throw new HttpError(400, 'Your password is wrong.');
    const email = auth.normEmail(ctx.body.email);
    if (user.email === email && isVerified(user)) throw new HttpError(400, 'This email is already confirmed.', 'ALREADY');
    const now = Date.now(), today = dayKey();
    const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(user.id);
    if (row && now - row.sent_at < COOLDOWN_MS) throw new HttpError(429, 'Please wait a minute before asking for another code.', 'COOLDOWN');
    const sends = row && row.sends_day === today ? row.sends_today : 0;
    if (sends >= MAX_SENDS_PER_DAY) throw new HttpError(429, 'You have asked for too many codes today. Please try again tomorrow.', 'TOO_MANY');
    // Whether the address is used by another account is not revealed here: that is only decided after the code is entered.
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare(`INSERT INTO email_codes (user_id, email, code_hash, expires_at, attempts, sent_at, sends_today, sends_day) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, code_hash = excluded.code_hash, expires_at = excluded.expires_at,
                  attempts = 0, sent_at = excluded.sent_at, sends_today = excluded.sends_today, sends_day = excluded.sends_day`)
      .run(user.id, email, auth.codeHash('mail' + user.id, code), now + MINUTES * 60 * 1000, now, sends + 1, today);
    const first = String(user.name || '').trim().split(/\s+/)[0] || 'there';
    const text = `Hello ${first},\n\nYour SmartClass Teacher AI email confirmation code is ${code}.\nIt works for ${MINUTES} minutes.\n\nOnce confirmed, you can use this email to log in and to reset your password yourself.\n\nIf you did not ask for this, ignore this email.\n\nSmartClass Teacher AI`;
    const html = `<p>Hello ${first.replace(/[<>&"]/g, '')},</p><p>Your SmartClass Teacher AI email confirmation code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p><p>It works for ${MINUTES} minutes.</p><p>Once confirmed, you can use this email to log in and to reset your password yourself.</p><p>If you did not ask for this, ignore this email.</p><p>SmartClass Teacher AI</p>`;
    messenger.sendEmail(email, 'Confirm your email for SmartClass Teacher AI', text, html).catch(() => {});
    return { ok: true, sentTo: mask(email), minutes: MINUTES };
  });

  add('POST', '/api/me/email/confirm', { auth: true, maxBody: 5000 }, (ctx) => {
    const user = ctx.user;
    helpers.rateLimit('emailconf:' + user.id, 20, 60 * 60 * 1000);
    const code = String(ctx.body.code === undefined || ctx.body.code === null ? '' : ctx.body.code).replace(/\s+/g, '');
    const bad = () => new HttpError(400, 'That code is wrong or has expired. Please check it, or ask for a new one.', 'BAD_CODE');
    const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(user.id);
    if (!row) throw bad();
    if (row.expires_at < Date.now()) throw bad();
    const given = Buffer.from(auth.codeHash('mail' + user.id, /^\d{6}$/.test(code) ? code : 'x')), want = Buffer.from(row.code_hash);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want) || !/^\d{6}$/.test(code)) {
      // after too many tries the code is cancelled, but the record stays so the one-a-minute and five-a-day limits keep counting
      if (row.attempts + 1 >= MAX_TRIES) db.prepare("UPDATE email_codes SET code_hash = 'x', expires_at = 0, attempts = 0 WHERE user_id = ?").run(user.id);
      else db.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
      throw bad();
    }
    // The code proves this person can read the mailbox. Only now do we say whether another account already uses the address.
    const other = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(row.email, user.id);
    if (other) { db.prepare("UPDATE email_codes SET code_hash = 'x', expires_at = 0, attempts = 0 WHERE user_id = ?").run(user.id); throw new HttpError(409, 'This email address is already used by another account.', 'EMAIL_TAKEN'); }
    const old = user.email;
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(row.email, user.id);
    markVerified(user.id, row.email);
    db.prepare('DELETE FROM email_codes WHERE user_id = ?').run(user.id);
    if (old && old !== row.email) {
      messenger.sendEmail(old, 'Your SmartClass Teacher AI email was changed',
        'Hello,\n\nThe email on your SmartClass Teacher AI account was changed to ' + mask(row.email) + '.\n\nIf this was you, you do not need to do anything. If it was not you, message us on WhatsApp straight away.\n\nSmartClass Teacher AI',
        '<p>Hello,</p><p>The email on your SmartClass Teacher AI account was changed to <b>' + mask(row.email) + '</b>.</p><p>If this was you, you do not need to do anything. If it was not you, message us on WhatsApp straight away.</p><p>SmartClass Teacher AI</p>').catch(() => {});
    }
    return { ok: true, user: helpers.publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
  });
}

module.exports = { register, isVerified, markVerified };
