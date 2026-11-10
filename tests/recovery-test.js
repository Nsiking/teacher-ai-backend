'use strict';
// Tests the recovery email: adding and confirming an email, how a forgotten-password request for a PHONE NUMBER is routed
// (confirmed email first, SMS otherwise), and the safety rules around it. Stand-in email and SMS providers.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 800) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'test-admin-key-123456';
const root = path.join(__dirname, '..');

const calls = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(b); } catch (e) { /* ignore */ }
    calls.push({ url: req.url, body });
    res.writeHead(req.url === '/v3/smtp/email' ? 201 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ messageId: 'x', message_id: '1', message: 'Successfully Sent' }));
  });
});
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 3000)) { if (fn()) return true; await sleep(40); } return false; }
async function start(port, env) {
  const e = Object.assign({}, process.env, { PORT: String(port), ADMIN_KEY: ADMIN, AUTH_RATE_MAX: '500', GEN_PER_MINUTE: '200' }, env);
  for (const k of ['EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM', 'EMAIL_API_URL', 'SMS_PROVIDER', 'TERMII_API_KEY', 'TERMII_SENDER_ID', 'TERMII_CHANNEL', 'TERMII_BASE_URL', 'SMS_DAILY_CAP']) if (!(k in env)) delete e[k];
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://localhost:' + port + '/health'); if (r.ok) break; } catch (x) { /* retry */ } await sleep(100); }
  return c;
}
const caller = (base) => async (method, p, body, token, admin, ip) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = ADMIN;
  if (ip) headers['X-Forwarded-For'] = ip;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (x) { /* ignore */ }
  return { status: r.status, body: j };
};
const mailTo = (to) => calls.filter((c) => c.url === '/v3/smtp/email' && c.body.to[0].email === to);
const lastMail = (to) => { const m = mailTo(to); return m.length ? m[m.length - 1] : null; };
const codeIn = (rec) => /\b(\d{6})\b/.exec(rec.body.textContent || rec.body.sms || '')[1];

(async () => {
  await new Promise((r) => fake.listen(0, r));
  const U = 'http://localhost:' + fake.address().port;
  const base = 5800 + Math.floor(Math.random() * 20);
  const dA = path.join(dir, 'a'), dB = path.join(dir, 'b'), dC = path.join(dir, 'c');
  const both = { EMAIL_PROVIDER: 'brevo', EMAIL_API_KEY: 'k', EMAIL_FROM: 'SmartClass Teacher AI <no-reply@example.com>', EMAIL_API_URL: U, SMS_PROVIDER: 'termii', TERMII_API_KEY: 't', TERMII_BASE_URL: U };
  const s1 = await start(base, Object.assign({ DATA_DIR: dA }, both));
  const s2 = await start(base + 20, { DATA_DIR: dB, EMAIL_PROVIDER: 'brevo', EMAIL_API_KEY: 'k', EMAIL_FROM: 'no-reply@example.com', EMAIL_API_URL: U });
  const s3 = await start(base + 40, { DATA_DIR: dC });
  const A = caller('http://localhost:' + base), B = caller('http://localhost:' + (base + 20)), C = caller('http://localhost:' + (base + 40));
  let ipn = 10; const ip = () => '10.2.2.' + (ipn++);
  try {
    console.log('Signing up with a phone number and a recovery email');
    let r = await A('POST', '/api/auth/signup', { name: 'Ada Obi', phone: '08031234567', email: 'ada@example.com', password: 'password123' });
    const adaTok = r.body.token, adaId = r.body.user.id;
    check('an account can have a phone number and an email, and the email starts as NOT confirmed', r.status === 200 && r.body.user.phone === '+2348031234567' && r.body.user.email === 'ada@example.com' && r.body.user.emailVerified === false, r.body.user);
    r = await A('POST', '/api/auth/signup', { name: 'Other', phone: '08039990000', email: 'ada@example.com', password: 'password123' });
    check('an email already used by another account is refused at sign-up', r.status === 409);
    r = await A('POST', '/api/auth/signup', { name: 'Bola Eze', phone: '08051112222', password: 'password123' });
    let bolaTok = r.body.token; const bolaId = r.body.user.id;
    check('a phone-only account has no email', r.body.user.email === null && r.body.user.emailVerified === false);
    const db = new DatabaseSync(path.join(dA, 'teacher.db'));
    const rewindReset = (id) => db.prepare('UPDATE reset_codes SET sent_at = sent_at - 120000 WHERE user_id = ?').run(id);
    const rewindMail = (id) => db.prepare('UPDATE email_codes SET sent_at = sent_at - 120000 WHERE user_id = ?').run(id);

    console.log('Before the email is confirmed, a phone number is served by SMS only');
    let n = calls.length;
    r = await A('POST', '/api/auth/reset/request', { identifier: '08031234567' }, null, false, ip());
    await waitFor(() => calls.length > n); await sleep(200);
    check('the unconfirmed email is NOT used (it might belong to a stranger): the code goes by SMS', calls.length === n + 1 && calls[calls.length - 1].url === '/api/sms/send' && mailTo('ada@example.com').length === 0, calls.slice(n));
    check('and the answer lists which ways are set up', r.body.channels.email === true && r.body.channels.sms === true && r.body.channel === 'sms');
    r = await B('POST', '/api/auth/signup', { name: 'Ngozi', phone: '08031230000', email: 'ngozi@example.com', password: 'password123' });
    const nTokB = r.body.token;
    n = calls.length;
    await B('POST', '/api/auth/reset/request', { identifier: '08031230000' }, null, false, ip());
    await sleep(500);
    check('on a server with email only and an unconfirmed email, nothing is sent at all', calls.length === n);

    console.log('Adding and confirming an email');
    r = await A('POST', '/api/me/email/request', { email: 'bola@example.com', password: 'wrongpass' }, bolaTok);
    check('the password is needed (a stolen session cannot add the thief\'s email)', r.status === 400 && /password is wrong/.test(r.body.error));
    r = await A('POST', '/api/me/email/request', { email: 'bola@example.com', password: 'password123' });
    check('you must be logged in', r.status === 401);
    r = await A('POST', '/api/me/email/request', { email: 'nonsense', password: 'password123' }, bolaTok);
    check('a broken email is refused', r.status === 400 && /Email is not valid/.test(r.body.error));
    n = calls.length;
    r = await A('POST', '/api/me/email/request', { email: 'Bola@Example.com ', password: 'password123' }, bolaTok);
    check('a code is requested: the answer shows the hidden address and 15 minutes', r.status === 200 && r.body.sentTo === 'b***@example.com' && r.body.minutes === 15, r.body);
    await waitFor(() => mailTo('bola@example.com').length > 0);
    const m1 = lastMail('bola@example.com'), bolaCode = codeIn(m1);
    check('the confirmation email goes to the NEW address (lowercased), with the code, and says what confirming does', m1.body.to[0].email === 'bola@example.com' && /confirm your email/i.test(m1.body.subject) && /^\d{6}$/.test(bolaCode) && /log in and to reset your password/.test(m1.body.textContent) && /Hello Bola/.test(m1.body.textContent), m1.body);
    const row = db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(bolaId);
    check('the code is not stored, only a fingerprint', row && !JSON.stringify(row).includes(bolaCode) && row.email === 'bola@example.com');
    r = await A('GET', '/api/me', null, bolaTok);
    check('nothing changes on the account until the code is entered', r.body.user.email === null && r.body.user.emailVerified === false);
    r = await A('POST', '/api/me/email/request', { email: 'bola@example.com', password: 'password123' }, bolaTok);
    check('asking again within a minute is refused politely', r.status === 429 && r.body.code === 'COOLDOWN');
    r = await A('POST', '/api/me/email/confirm', { code: '000000' }, bolaTok);
    check('a wrong code: a plain message, and the tries are counted', r.status === 400 && r.body.code === 'BAD_CODE' && db.prepare('SELECT attempts FROM email_codes WHERE user_id = ?').get(bolaId).attempts === 1);
    r = await A('POST', '/api/me/email/confirm', { code: '12' }, bolaTok);
    check('a code that is not 6 digits is refused the same way', r.status === 400 && r.body.code === 'BAD_CODE');
    r = await A('POST', '/api/me/email/confirm', { code: bolaCode }, bolaTok);
    check('the right code: the email is saved on the account and confirmed', r.status === 200 && r.body.user.email === 'bola@example.com' && r.body.user.emailVerified === true, r.body);
    check('the code is used up', db.prepare('SELECT COUNT(*) c FROM email_codes WHERE user_id = ?').get(bolaId).c === 0 && (await A('POST', '/api/me/email/confirm', { code: bolaCode }, bolaTok)).status === 400);
    r = await A('POST', '/api/auth/login', { identifier: 'bola@example.com', password: 'password123' });
    check('the email can now be used to log in', r.status === 200 && r.body.user.id === bolaId);
    r = await A('POST', '/api/me/email/request', { email: 'bola@example.com', password: 'password123' }, bolaTok);
    check('confirming the same email again is refused ("already confirmed")', r.status === 400 && r.body.code === 'ALREADY');

    console.log('Now a phone number is served by the confirmed email');
    n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: '0805 111 2222' }, null, false, ip());
    await waitFor(() => calls.length > n); await sleep(200);
    check('the reset code goes to the confirmed email, not by SMS (free, and the address is known to be hers)', calls.length === n + 1 && calls[calls.length - 1].url === '/v3/smtp/email' && calls[calls.length - 1].body.to[0].email === 'bola@example.com' && /password reset code/.test(calls[calls.length - 1].body.subject), calls.slice(n));
    const resetCode = codeIn(calls[calls.length - 1]);
    r = await A('POST', '/api/auth/reset/confirm', { identifier: '08051112222', code: resetCode, newPassword: 'brandnew123' }, null, false, ip());
    check('the code typed with the PHONE number resets the password and logs her in', r.status === 200 && r.body.user.id === bolaId && r.body.token, r.body);
    bolaTok = r.body.token;   // her old session was (correctly) signed out by the reset
    r = await A('POST', '/api/auth/login', { identifier: '08051112222', password: 'brandnew123' });
    check('the new password works with the phone number', r.status === 200);

    console.log('A confirmed email also serves servers with no SMS at all');
    r = await B('POST', '/api/me/email/request', { email: 'ngozi@example.com', password: 'password123' }, nTokB);
    await waitFor(() => mailTo('ngozi@example.com').length > 0);
    const ngCode = codeIn(lastMail('ngozi@example.com'));
    r = await B('POST', '/api/me/email/confirm', { code: ngCode }, nTokB);
    check('Ngozi confirms the email she signed up with', r.status === 200 && r.body.user.emailVerified === true);
    n = calls.length;
    r = await B('POST', '/api/auth/reset/request', { identifier: '08031230000' }, null, false, ip());
    await waitFor(() => calls.length > n);
    check('with no SMS set up, her phone number still gets a code, by email', r.body.available === true && r.body.channels.sms === false && calls[calls.length - 1].body.to[0].email === 'ngozi@example.com', calls.slice(n));

    console.log('Changing an email');
    r = await A('POST', '/api/me/email/request', { email: 'bola.new@example.com', password: 'brandnew123' }, bolaTok);
    check('a different email can be requested', r.status === 200 && r.body.sentTo === 'b***@example.com');
    r = await A('GET', '/api/me', null, bolaTok);
    check('until the new code is entered, the old confirmed email stays', r.body.user.email === 'bola@example.com' && r.body.user.emailVerified === true);
    await waitFor(() => mailTo('bola.new@example.com').length > 0);
    n = calls.length;
    r = await A('POST', '/api/me/email/confirm', { code: codeIn(lastMail('bola.new@example.com')) }, bolaTok);
    check('after entering it, the new email replaces the old one, confirmed', r.status === 200 && r.body.user.email === 'bola.new@example.com' && r.body.user.emailVerified === true);
    await waitFor(() => mailTo('bola@example.com').some((m) => /was changed/.test(m.body.subject)));
    const note = mailTo('bola@example.com').filter((m) => /was changed/.test(m.body.subject)).pop();
    check('the OLD address gets a notice that it was changed (so a hijack would be noticed), without the new address in full', note && /was changed/.test(note.body.subject) && /b\*\*\*@example\.com/.test(note.body.textContent) && !/bola\.new/.test(note.body.textContent), note && note.body);
    r = await A('POST', '/api/auth/login', { identifier: 'bola@example.com', password: 'brandnew123' });
    check('the old email no longer logs in', r.status === 401);

    console.log('An email that belongs to someone else');
    rewindMail(bolaId);
    r = await A('POST', '/api/me/email/request', { email: 'ada@example.com', password: 'brandnew123' }, bolaTok);
    check('asking for it looks exactly like asking for a free address (nothing is revealed yet)', r.status === 200 && r.body.sentTo === 'a***@example.com');
    await waitFor(() => mailTo('ada@example.com').length > 0);
    await sleep(100);
    // the code went to the real owner's mailbox; this account cannot read it, so it cannot get further. Prove the "taken" rule with the code anyway:
    const takenCode = codeIn(lastMail('ada@example.com'));
    r = await A('POST', '/api/me/email/confirm', { code: takenCode }, bolaTok);
    check('even with the code, an address another account already uses is refused', r.status === 409 && r.body.code === 'EMAIL_TAKEN', r.body);
    r = await A('GET', '/api/me', null, bolaTok);
    check('and nothing changed', r.body.user.email === 'bola.new@example.com');

    console.log('Limits');
    r = await A('POST', '/api/me/email/request', { email: 'x1@example.com', password: 'password123' }, adaTok);
    await waitFor(() => mailTo('x1@example.com').length > 0);
    for (let i = 0; i < 5; i++) await A('POST', '/api/me/email/confirm', { code: '111111' }, adaTok);
    const rowA = db.prepare('SELECT * FROM email_codes WHERE user_id = ?').get(adaId);
    check('5 wrong tries cancel the code', !rowA || rowA.expires_at === 0);
    r = await A('POST', '/api/me/email/request', { email: 'x1@example.com', password: 'password123' }, adaTok);
    check('and cancelling does not clear the one-a-minute limit (asking at once is refused)', r.status === 429 && r.body.code === 'COOLDOWN', r.body);
    rewindMail(adaId);
    await A('POST', '/api/me/email/request', { email: 'x1@example.com', password: 'password123' }, adaTok);
    db.prepare('UPDATE email_codes SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, adaId);
    await waitFor(() => mailTo('x1@example.com').length > 1);
    r = await A('POST', '/api/me/email/confirm', { code: codeIn(lastMail('x1@example.com')) }, adaTok);
    check('an expired code is refused', r.status === 400 && r.body.code === 'BAD_CODE');
    db.prepare("INSERT OR REPLACE INTO email_codes (user_id, email, code_hash, expires_at, attempts, sent_at, sends_today, sends_day) VALUES (?, 'x1@example.com', 'x', ?, 0, 0, 5, ?)").run(adaId, Date.now() + 100000, new Date(Date.now() + 3600 * 1000).toISOString().slice(0, 10));
    r = await A('POST', '/api/me/email/request', { email: 'x1@example.com', password: 'password123' }, adaTok);
    check('after 5 codes in a day, no more until tomorrow', r.status === 429 && r.body.code === 'TOO_MANY');

    console.log('Ada confirms hers by resetting her password');
    db.prepare('DELETE FROM reset_codes WHERE user_id = ?').run(adaId);
    n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: 'ada@example.com' }, null, false, ip());
    const resetMail = () => mailTo('ada@example.com').filter((m) => /password reset code/.test(m.body.subject)).pop();
    await waitFor(() => !!resetMail());
    const adaReset = codeIn(resetMail());
    check('an account whose email was never confirmed can still reset by that email (nothing breaks)', !!adaReset);
    r = await A('GET', '/api/me', null, adaTok);
    check('and before the reset it is still unconfirmed', r.body.user.emailVerified === false);
    r = await A('POST', '/api/auth/reset/confirm', { identifier: 'ada@example.com', code: adaReset, newPassword: 'adanew12345' }, null, false, ip());
    const adaNewTok = r.body.token;
    r = await A('GET', '/api/me', null, adaNewTok);
    check('reading the code from that mailbox proves it is hers, so the email becomes confirmed', r.body.user.emailVerified === true, r.body.user);
    n = calls.length;
    rewindReset(adaId); db.prepare('DELETE FROM reset_codes WHERE user_id = ?').run(adaId);
    await A('POST', '/api/auth/reset/request', { identifier: '08031234567' }, null, false, ip());
    await waitFor(() => calls.length > n); await sleep(150);
    check('from then on her phone number gets codes by email too', calls[calls.length - 1].url === '/v3/smtp/email' && calls[calls.length - 1].body.to[0].email === 'ada@example.com');

    console.log('When email is not set up');
    r = await C('POST', '/api/auth/signup', { name: 'No Mail', phone: '08031110000', password: 'password123' });
    r = await C('POST', '/api/me/email/request', { email: 'a@example.com', password: 'password123' }, r.body.token);
    check('the request says email is not available right now, with the WhatsApp suggestion', r.status === 503 && r.body.code === 'EMAIL_UNAVAILABLE' && /WhatsApp/.test(r.body.error), r.body);

    console.log('Deleting an account');
    await A('POST', '/api/me/email/request', { email: 'bola.second@example.com', password: 'brandnew123' }, bolaTok);
    const had = db.prepare('SELECT COUNT(*) c FROM email_verified WHERE user_id = ?').get(bolaId).c + db.prepare('SELECT COUNT(*) c FROM email_codes WHERE user_id = ?').get(bolaId).c;
    await A('DELETE', '/api/me', { password: 'brandnew123' }, bolaTok);
    const left = db.prepare('SELECT COUNT(*) c FROM email_verified WHERE user_id = ?').get(bolaId).c + db.prepare('SELECT COUNT(*) c FROM email_codes WHERE user_id = ?').get(bolaId).c;
    check('a deleted account leaves no confirmation records behind', had >= 2 && left === 0, [had, left]);
    db.close();
  } catch (e) {
    fail++; console.log('  ERROR', e);
  }
  s1.kill(); s2.kill(); s3.kill(); fake.close();
  await sleep(300);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
