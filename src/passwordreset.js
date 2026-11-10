'use strict';
// Password reset by a 6-digit code sent to the teacher's email or phone.
// Safety: the code is never stored (only a fingerprint), works for 15 minutes, allows 5 tries, one new code a minute,
// 5 codes a day per account; the answer is the same whether or not the account exists, and the message is sent in the
// background so the speed of the answer does not give the account away. A reset signs out every old session.
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

function register(add, helpers) {
  add('GET', '/api/auth/reset/config', {}, () => messenger.channels());

  add('POST', '/api/auth/reset/request', { maxBody: 5000 }, (ctx) => {
    helpers.rateLimit('resetip:' + ctx.ip, 10, 60 * 60 * 1000);
    const idRaw = typeof ctx.body.identifier === 'string' ? ctx.body.identifier.trim() : '';
    if (!idRaw) throw new HttpError(400, 'Enter your email or phone number.');
    const isEmail = idRaw.includes('@');
    if (isEmail) auth.normEmail(idRaw); else auth.normPhone(idRaw);   // only checks the shape, never whether it exists
    helpers.rateLimit('reset:' + idRaw.toLowerCase().replace(/\s+/g, ''), 5, 60 * 60 * 1000);
    const channel = isEmail ? 'email' : 'sms';
    const res = { ok: true, channel, available: !!messenger.channels()[channel], minutes: MINUTES };
    if (!res.available) return res;
    const user = auth.findByIdentifier(idRaw);
    if (!user) return res;                                            // same answer; nothing is sent

    const now = Date.now(), today = dayKey();
    const row = db.prepare('SELECT * FROM reset_codes WHERE user_id = ?').get(user.id);
    if (row && now - row.sent_at < COOLDOWN_MS) return res;           // too soon: quietly keep the code already sent
    const sends = row && row.sends_day === today ? row.sends_today : 0;
    if (sends >= MAX_SENDS_PER_DAY) return res;

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare(`INSERT INTO reset_codes (user_id, code_hash, channel, expires_at, attempts, sent_at, sends_today, sends_day)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, channel = excluded.channel, expires_at = excluded.expires_at,
                  attempts = 0, sent_at = excluded.sent_at, sends_today = excluded.sends_today, sends_day = excluded.sends_day`)
      .run(user.id, auth.codeHash(user.id, code), channel, now + MINUTES * 60 * 1000, now, sends + 1, today);

    const first = String(user.name || '').trim().split(/\s+/)[0] || 'there';
    if (channel === 'email') {
      const text = `Hello ${first},\n\nYour SmartClass Teacher AI password reset code is ${code}.\nIt works for ${MINUTES} minutes.\n\nIf you did not ask for this, ignore this email. Your password has not been changed.\n\nSmartClass Teacher AI`;
      const html = `<p>Hello ${first.replace(/[<>&"]/g, '')},</p><p>Your SmartClass Teacher AI password reset code is:</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p><p>It works for ${MINUTES} minutes.</p><p>If you did not ask for this, ignore this email. Your password has not been changed.</p><p>SmartClass Teacher AI</p>`;
      messenger.sendEmail(user.email, 'Your SmartClass Teacher AI password reset code', text, html).catch(() => {});
    } else {
      messenger.sendSms(user.phone, `SmartClass Teacher AI: your password reset code is ${code}. It works for ${MINUTES} minutes. Do not share it.`).catch(() => {});
    }
    return res;
  });

  add('POST', '/api/auth/reset/confirm', { maxBody: 5000 }, (ctx) => {
    helpers.rateLimit('resetc:' + ctx.ip, 20, 60 * 60 * 1000);
    const idRaw = typeof ctx.body.identifier === 'string' ? ctx.body.identifier.trim() : '';
    helpers.rateLimit('resetc:' + idRaw.toLowerCase().replace(/\s+/g, ''), 10, 15 * 60 * 1000);
    const code = String(ctx.body.code === undefined || ctx.body.code === null ? '' : ctx.body.code).replace(/\s+/g, '');
    const bad = () => new HttpError(400, 'That code is wrong or has expired. Please check it, or ask for a new one.', 'BAD_CODE');
    const user = auth.findByIdentifier(idRaw);
    if (!user) throw bad();
    const row = db.prepare('SELECT * FROM reset_codes WHERE user_id = ?').get(user.id);
    if (!row) throw bad();
    if (row.expires_at < Date.now()) { db.prepare('DELETE FROM reset_codes WHERE user_id = ?').run(user.id); throw bad(); }
    const given = Buffer.from(auth.codeHash(user.id, /^\d{6}$/.test(code) ? code : 'x')), want = Buffer.from(row.code_hash);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want) || !/^\d{6}$/.test(code)) {
      if (row.attempts + 1 >= MAX_TRIES) db.prepare('DELETE FROM reset_codes WHERE user_id = ?').run(user.id);
      else db.prepare('UPDATE reset_codes SET attempts = attempts + 1 WHERE user_id = ?').run(user.id);
      throw bad();
    }
    const pw = auth.checkPasswordRule(ctx.body.newPassword);          // only checked once the code is right
    db.prepare('UPDATE users SET pass_hash = ?, token_version = token_version + 1 WHERE id = ?').run(auth.hashPassword(pw), user.id);
    db.prepare('DELETE FROM reset_codes WHERE user_id = ?').run(user.id);
    return helpers.sessionPayload(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
  });

  // ---- admin: is messaging working? ----
  add('GET', '/api/admin/messaging', { admin: true }, () => messenger.snapshot());
  add('POST', '/api/admin/messaging/test', { admin: true }, async (ctx) => {
    const kind = ctx.body.kind;
    let result;
    if (kind === 'email') {
      const to = auth.normEmail(ctx.body.to);
      result = await messenger.sendEmail(to, 'SmartClass Teacher AI test message', 'This is a test message from SmartClass Teacher AI. Password reset emails are working.', '<p>This is a test message from <b>SmartClass Teacher AI</b>. Password reset emails are working.</p>');
    } else if (kind === 'sms') {
      const to = auth.normPhone(ctx.body.to);
      result = await messenger.sendSms(to, 'SmartClass Teacher AI: this is a test message. Password reset codes by SMS are working.');
    } else throw new HttpError(400, 'Choose email or sms.');
    return Object.assign({ advice: result.ok ? null : (messenger.ADVICE[result.kind] || messenger.ADVICE.other) }, result, { status: messenger.snapshot() });
  });
}

module.exports = { register };
