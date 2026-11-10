'use strict';
// Tests password reset by a code sent to email (Brevo / Resend) or SMS (Termii), using stand-in providers.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 800) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'test-admin-key-123456';
const root = path.join(__dirname, '..');

// ---- stand-in providers
let mode = 'ok', delay = 0; const calls = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(b); } catch (e) { /* ignore */ }
    const rec = { url: req.url, headers: req.headers, body };
    calls.push(rec);
    const send = (st, j) => setTimeout(() => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); }, delay);
    if (mode === 'key') return send(401, { code: 'unauthorized', message: 'Invalid API key provided' });
    if (mode === 'sender') return send(400, { code: 'invalid_parameter', message: 'Sender not valid' });
    if (mode === 'balance') return send(400, { message: 'Insufficient balance' });
    if (req.url === '/v3/smtp/email') return send(201, { messageId: '<x@y>' });
    if (req.url === '/emails') return send(200, { id: 'abc' });
    if (req.url === '/api/sms/send') return send(200, { message_id: '123', message: 'Successfully Sent', balance: 10, user: 'Termii' });
    send(404, {});
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
const codeOf = (rec) => /\b(\d{6})\b/.exec(rec.body.textContent || rec.body.text || rec.body.sms || '')[1];

(async () => {
  await new Promise((r) => fake.listen(0, r));
  const FP = fake.address().port, U = 'http://localhost:' + FP;
  const base = 5600 + Math.floor(Math.random() * 20);
  const dA = path.join(dir, 'a'), dB = path.join(dir, 'b'), dC = path.join(dir, 'c'), dD = path.join(dir, 'd');
  const s1 = await start(base, { DATA_DIR: dA, EMAIL_PROVIDER: 'brevo', EMAIL_API_KEY: 'xkeysib-test', EMAIL_FROM: 'SmartClass Teacher AI <no-reply@example.com>', EMAIL_API_URL: U, SMS_PROVIDER: 'termii', TERMII_API_KEY: 'tk-test', TERMII_SENDER_ID: 'talert', TERMII_BASE_URL: U });
  const s2 = await start(base + 20, { DATA_DIR: dB, EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 're_test', EMAIL_FROM: 'no-reply@example.com', EMAIL_API_URL: U });
  const s3 = await start(base + 40, { DATA_DIR: dC });
  const s4 = await start(base + 60, { DATA_DIR: dD, SMS_PROVIDER: 'termii', TERMII_API_KEY: 'tk-test', TERMII_BASE_URL: U, SMS_DAILY_CAP: '2' });
  const A = caller('http://localhost:' + base), B = caller('http://localhost:' + (base + 20)), C = caller('http://localhost:' + (base + 40)), D = caller('http://localhost:' + (base + 60));
  let ipn = 10; const ip = () => '10.1.1.' + (ipn++);
  try {
    console.log('Nothing set up yet');
    let r = await C('GET', '/api/auth/reset/config');
    check('the app can ask which ways are available: none', r.status === 200 && r.body.email === false && r.body.sms === false, r.body);
    await C('POST', '/api/auth/signup', { name: 'Ada Obi', email: 'ada@example.com', password: 'oldpassword1' });
    r = await C('POST', '/api/auth/reset/request', { identifier: 'ada@example.com' }, null, false, ip());
    check('a request says "not available" and sends nothing', r.status === 200 && r.body.available === false && r.body.channel === 'email' && calls.length === 0, r.body);
    const dbC = new DatabaseSync(path.join(dC, 'teacher.db'));
    check('and no code is stored', dbC.prepare('SELECT COUNT(*) c FROM reset_codes').get().c === 0); dbC.close();
    r = await C('GET', '/api/admin/messaging', null, null, true);
    check('the admin card says nothing is configured', r.body.channels.email === false && r.body.sms.provider === null && r.body.email.provider === null, r.body);

    console.log('Email by Resend only');
    r = await B('GET', '/api/auth/reset/config');
    check('email is available, SMS is not', r.body.email === true && r.body.sms === false, r.body);
    await B('POST', '/api/auth/signup', { name: 'Ngozi', email: 'ngozi@example.com', phone: '08031230000', password: 'oldpassword1' });
    let n = calls.length;
    r = await B('POST', '/api/auth/reset/request', { identifier: 'ngozi@example.com' }, null, false, ip());
    await waitFor(() => calls.length > n);
    const rc = calls[calls.length - 1];
    check('the code goes out through Resend, with the key as a Bearer token and the "from" address', rc.url === '/emails' && rc.headers.authorization === 'Bearer re_test' && rc.body.from === 'no-reply@example.com' && rc.body.to[0] === 'ngozi@example.com' && /\b\d{6}\b/.test(rc.body.text), rc);
    n = calls.length;
    r = await B('POST', '/api/auth/reset/request', { identifier: '08031230000' }, null, false, ip());
    await sleep(300);
    check('a phone number is "not available" there, and nothing is sent', r.body.available === false && r.body.channel === 'sms' && calls.length === n, r.body);

    console.log('Email by Brevo and SMS by Termii');
    r = await A('GET', '/api/auth/reset/config');
    check('both ways are available', r.body.email === true && r.body.sms === true, r.body);
    r = await A('POST', '/api/auth/signup', { name: 'Ada Obi', email: 'ada@example.com', phone: '08031234567', password: 'oldpassword1' });
    const oldToken = r.body.token, adaId = r.body.user.id;
    await A('POST', '/api/auth/signup', { name: 'Bola Eze', phone: '08051112222', password: 'oldpassword1' });
    const chiId = (await A('POST', '/api/auth/signup', { name: 'Chi Okon', email: 'chi@example.com', password: 'oldpassword1' })).body.user.id;
    await A('POST', '/api/auth/signup', { name: 'Emeka', email: 'emeka@example.com', password: 'oldpassword1' });
    await A('POST', '/api/auth/signup', { name: 'Femi', email: 'femi@example.com', password: 'oldpassword1' });
    const db = new DatabaseSync(path.join(dA, 'teacher.db'));
    const rewind = (id) => db.prepare('UPDATE reset_codes SET sent_at = sent_at - 120000 WHERE user_id = ?').run(id);
    n = calls.length;
    let t0 = Date.now();
    r = await A('POST', '/api/auth/reset/request', { identifier: 'Ada@Example.com ' }, null, false, ip());
    const dt = Date.now() - t0;
    check('a request for an email gives the same simple answer', r.status === 200 && r.body.ok === true && r.body.channel === 'email' && r.body.available === true && r.body.minutes === 15, r.body);
    await waitFor(() => calls.length > n);
    const e1 = calls[calls.length - 1], code1 = codeOf(e1);
    check('the email goes through Brevo: the key in the "api-key" header, the sender, the recipient, a subject and the code in text and HTML', e1.url === '/v3/smtp/email' && e1.headers['api-key'] === 'xkeysib-test' && e1.body.sender.email === 'no-reply@example.com' && e1.body.sender.name === 'SmartClass Teacher AI' && e1.body.to[0].email === 'ada@example.com' && /password reset code/.test(e1.body.subject) && /^\d{6}$/.test(code1) && e1.body.htmlContent.includes(code1) && /15 minutes/.test(e1.body.textContent) && /Hello Ada/.test(e1.body.textContent), e1.body);
    const row = db.prepare('SELECT * FROM reset_codes WHERE user_id = ?').get(adaId);
    check('the code itself is not stored, only a fingerprint; it expires in 15 minutes', row && !JSON.stringify(row).includes(code1) && row.code_hash.length >= 40 && Math.abs(row.expires_at - Date.now() - 15 * 60 * 1000) < 5000 && row.attempts === 0, row);
    n = calls.length;
    r = await A('POST', '/api/auth/reset/request', { identifier: 'nobody@example.com' }, null, false, ip());
    await sleep(400);
    check('an email with no account gets exactly the same answer, and nothing is sent', JSON.stringify(r.body) === JSON.stringify({ ok: true, channel: 'email', available: true, minutes: 15 }) && calls.length === n, r.body);
    n = calls.length;
    r = await A('POST', '/api/auth/reset/request', { identifier: '08051112222' }, null, false, ip());
    await waitFor(() => calls.length > n);
    const s1c = calls[calls.length - 1], code2 = codeOf(s1c);
    check('an SMS goes through Termii on the transactional route, to the number without "+", from the Sender ID, with the code and "do not share"', s1c.url === '/api/sms/send' && s1c.body.to === '2348051112222' && s1c.body.from === 'talert' && s1c.body.channel === 'dnd' && s1c.body.type === 'plain' && s1c.body.api_key === 'tk-test' && /^\d{6}$/.test(code2) && /Do not share it/.test(s1c.body.sms) && s1c.body.sms.length <= 160, s1c.body);
    check('the answer for a phone says channel "sms"', r.body.channel === 'sms' && r.body.available === true);
    n = calls.length;
    await A('POST', '/api/auth/signup', { name: 'Dayo', phone: '08061113333', password: 'oldpassword1' });
    await A('POST', '/api/auth/reset/request', { identifier: '0806 111 3333' }, null, false, ip());
    await waitFor(() => calls.length > n);
    check('a number typed with spaces is understood', calls[calls.length - 1].body.to === '2348061113333');
    rewind(adaId); n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: '+2348031234567' }, null, false, ip());
    await waitFor(() => calls.length > n);
    check('a teacher with both an email and a phone gets the code where they asked (SMS here), not both', calls.length === n + 1 && calls[calls.length - 1].url === '/api/sms/send' && calls[calls.length - 1].body.to === '2348031234567');
    const codeAda = codeOf(calls[calls.length - 1]);

    console.log('Slow providers do not slow the answer or give anything away');
    mode = 'ok'; delay = 1500; rewind(adaId);
    t0 = Date.now(); await A('POST', '/api/auth/reset/request', { identifier: 'ada@example.com' }, null, false, ip()); const slowKnown = Date.now() - t0;
    t0 = Date.now(); await A('POST', '/api/auth/reset/request', { identifier: 'ghost@example.com' }, null, false, ip()); const slowUnknown = Date.now() - t0;
    check('the answer comes straight back (under 0.8 s) even when the provider takes 1.5 s, for an account that exists and one that does not', slowKnown < 800 && slowUnknown < 800, [slowKnown, slowUnknown]);
    delay = 0; await sleep(1800);
    const freshAda = (() => { const rec = calls.filter((c) => c.url === '/v3/smtp/email').pop(); return codeOf(rec); })();

    console.log('Using the code');
    const conf = (id, code, pw) => A('POST', '/api/auth/reset/confirm', { identifier: id, code, newPassword: pw }, null, false, ip());
    r = await conf('ada@example.com', '000000', 'newpassword9');
    check('a wrong code: a plain message, and the tries are counted', r.status === 400 && r.body.code === 'BAD_CODE' && /wrong or has expired/.test(r.body.error) && db.prepare('SELECT attempts FROM reset_codes WHERE user_id = ?').get(adaId).attempts === 1, r.body);
    r = await conf('ada@example.com', '12345', 'newpassword9');
    check('a code that is not 6 digits is refused the same way', r.status === 400 && r.body.code === 'BAD_CODE');
    r = await conf('ghost@example.com', freshAda, 'newpassword9');
    check('an unknown account gets the very same message (nothing is revealed)', r.status === 400 && r.body.code === 'BAD_CODE' && r.body.error === 'That code is wrong or has expired. Please check it, or ask for a new one.');
    for (let i = 0; i < 3; i++) await conf('ada@example.com', '111111', 'newpassword9');
    check('after 5 wrong tries the code is destroyed', r.status === 400 && db.prepare('SELECT COUNT(*) c FROM reset_codes WHERE user_id = ?').get(adaId).c === 0);
    r = await conf('ada@example.com', freshAda, 'newpassword9');
    check('even the right code no longer works then', r.status === 400 && r.body.code === 'BAD_CODE');
    n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: 'ada@example.com' }, null, false, ip());
    await waitFor(() => calls.length > n);
    const newCode = codeOf(calls[calls.length - 1]);
    db.prepare('UPDATE reset_codes SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, adaId);
    r = await conf('ada@example.com', newCode, 'newpassword9');
    check('an expired code is refused, and removed', r.status === 400 && r.body.code === 'BAD_CODE' && db.prepare('SELECT COUNT(*) c FROM reset_codes WHERE user_id = ?').get(adaId).c === 0);

    console.log('One new code a minute, and five a day');
    n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: 'chi@example.com' }, null, false, ip());
    await waitFor(() => calls.length > n);
    const codeA = codeOf(calls[calls.length - 1]); n = calls.length;
    r = await A('POST', '/api/auth/reset/request', { identifier: 'chi@example.com' }, null, false, ip());
    await sleep(400);
    check('asking again within a minute sends nothing new (the first code still works), with the same answer', r.status === 200 && r.body.ok === true && calls.length === n);
    rewind(chiId);
    await A('POST', '/api/auth/reset/request', { identifier: 'chi@example.com' }, null, false, ip());
    await waitFor(() => calls.length > n);
    const codeB0 = codeOf(calls[calls.length - 1]);
    check('after a minute a new code is sent, and it replaces the old one', calls.length === n + 1 && codeB0 !== codeA, [codeA, codeB0]);
    r = await conf('chi@example.com', codeA, 'newpassword9');
    check('the old code no longer works', r.status === 400);
    db.prepare("UPDATE reset_codes SET sends_today = 5, sent_at = sent_at - 120000 WHERE user_id = ?").run(chiId); n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: 'chi@example.com' }, null, false, ip());
    await sleep(400);
    check('after 5 codes in one day nothing more is sent to that account', calls.length === n);

    // a fresh code for Ada, for the password change below
    rewind(adaId); n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: 'ada@example.com' }, null, false, ip());
    await waitFor(() => calls.length > n);
    const codeB = codeOf(calls[calls.length - 1]);

    console.log('Changing the password');
    r = await conf('ada@example.com', codeB, 'short');
    check('the right code with a too-short password: the password rule is explained, and the code stays valid', r.status === 400 && /at least 8 characters/.test(r.body.error) && db.prepare('SELECT COUNT(*) c FROM reset_codes WHERE user_id = ?').get(adaId).c === 1, r.body);
    r = await conf('ada@example.com', codeB, 'newpassword9');
    check('the right code and a good password: the password is changed and the teacher is logged in', r.status === 200 && r.body.token && r.body.user.id === adaId && r.body.usage, r.body);
    const newToken = r.body.token;
    check('the used code is gone', db.prepare('SELECT COUNT(*) c FROM reset_codes WHERE user_id = ?').get(adaId).c === 0 && (await conf('ada@example.com', codeB, 'anotherpass9')).status === 400);
    r = await A('GET', '/api/me', null, oldToken);
    check('the old session (a phone that was already logged in) is signed out', r.status === 401 && r.body.code === 'AUTH_INVALID', r.body);
    r = await A('GET', '/api/me', null, newToken);
    check('the new session works', r.status === 200 && r.body.user.id === adaId);
    check('the old password no longer logs in, the new one does, by email and by phone', (await A('POST', '/api/auth/login', { identifier: 'ada@example.com', password: 'oldpassword1' })).status === 401 && (await A('POST', '/api/auth/login', { identifier: 'ada@example.com', password: 'newpassword9' })).status === 200 && (await A('POST', '/api/auth/login', { identifier: '08031234567', password: 'newpassword9' })).status === 200);

    console.log('Abuse limits');
    const sameIp = '7.7.7.7'; let last;
    for (let i = 0; i < 11; i++) last = await A('POST', '/api/auth/reset/request', { identifier: 'x' + i + '@example.com' }, null, false, sameIp);
    check('from one address, only 10 requests an hour (the 11th is refused)', last.status === 429 && /Too many attempts/.test(last.body.error), last);
    for (let i = 0; i < 6; i++) last = await A('POST', '/api/auth/reset/request', { identifier: 'target@example.com' }, null, false, ip());
    check('for one email or number, only 5 requests an hour', last.status === 429);
    r = await A('POST', '/api/auth/reset/request', { identifier: '' }, null, false, ip());
    check('an empty box is refused', r.status === 400);
    r = await A('POST', '/api/auth/reset/request', { identifier: 'abc' }, null, false, ip());
    check('something that is not an email or a Nigerian phone number is refused', r.status === 400 && /phone number/.test(r.body.error), r.body);
    r = await A('POST', '/api/auth/reset/request', { identifier: 'a@' }, null, false, ip());
    check('a broken email is refused', r.status === 400 && /Email is not valid/.test(r.body.error), r.body);
    last = null; for (let i = 0; i < 21; i++) last = await A('POST', '/api/auth/reset/confirm', { identifier: 'z' + i + '@example.com', code: '123456', newPassword: 'newpassword9' }, null, false, '8.8.8.8');
    check('guessing codes is limited too (20 an hour from one address)', last.status === 429);

    console.log('When a provider has a problem');
    mode = 'key'; rewind(await (async () => 0)()); db.prepare('UPDATE reset_codes SET sent_at = 0').run();
    n = calls.length;
    r = await A('POST', '/api/auth/reset/request', { identifier: 'emeka@example.com' }, null, false, ip());
    await waitFor(() => calls.length > n); await sleep(200);
    check('the teacher still gets the same simple answer', r.status === 200 && r.body.ok === true);
    r = await A('GET', '/api/admin/messaging', null, null, true);
    check('the admin sees a wrong key in plain words', r.body.email.problemNow === true && r.body.email.lastError.kind === 'key' && /API key/.test(r.body.email.lastError.advice), r.body.email);
    mode = 'sender'; db.prepare('UPDATE reset_codes SET sent_at = 0').run(); n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: 'femi@example.com' }, null, false, ip());
    await waitFor(() => calls.length > n); await sleep(200);
    r = await A('GET', '/api/admin/messaging', null, null, true);
    check('an unverified sender is recognised, with the advice to verify it', r.body.email.lastError.kind === 'sender' && /verify the sender/i.test(r.body.email.lastError.advice));
    mode = 'balance'; db.prepare('UPDATE reset_codes SET sent_at = 0').run(); n = calls.length;
    await A('POST', '/api/auth/reset/request', { identifier: '08051112222' }, null, false, ip());
    await waitFor(() => calls.length > n); await sleep(200);
    r = await A('GET', '/api/admin/messaging', null, null, true);
    check('SMS credit finished is recognised: "top up your Termii wallet"', r.body.sms.lastError.kind === 'balance' && /Termii wallet/.test(r.body.sms.lastError.advice) && r.body.sms.problemNow === true, r.body.sms);
    mode = 'ok';

    console.log('The admin card and test messages');
    r = await A('GET', '/api/admin/messaging');
    check('only the admin can see it', r.status === 401 || r.status === 403);
    r = await A('GET', '/api/admin/messaging', null, null, true);
    check('it shows the provider, the sender, the Sender ID and the route, and says the keys are set but never shows them', r.body.email.provider === 'brevo' && r.body.email.from.includes('no-reply@example.com') && r.body.sms.senderId === 'talert' && r.body.sms.route === 'dnd' && r.body.email.keySet === true && r.body.sms.keySet === true && !JSON.stringify(r.body).includes('xkeysib-test') && !JSON.stringify(r.body).includes('tk-test'), r.body);
    n = calls.length;
    r = await A('POST', '/api/admin/messaging/test', { kind: 'email', to: 'me@example.com' }, null, true);
    check('"Send a test email" works and clears the problem', r.status === 200 && r.body.ok === true && calls.length === n + 1 && calls[calls.length - 1].body.to[0].email === 'me@example.com' && r.body.status.email.problemNow === false, r.body);
    r = await A('POST', '/api/admin/messaging/test', { kind: 'sms', to: '08012345678' }, null, true);
    check('"Send a test SMS" works too', r.body.ok === true && calls[calls.length - 1].body.to === '2348012345678');
    r = await A('POST', '/api/admin/messaging/test', { kind: 'email', to: 'bad' }, null, true);
    check('a bad address is refused', r.status === 400);
    mode = 'key';
    r = await A('POST', '/api/admin/messaging/test', { kind: 'email', to: 'me@example.com' }, null, true);
    check('a failed test says why in plain words', r.body.ok === false && r.body.kind === 'key' && /API key/.test(r.body.advice), r.body);
    mode = 'ok';

    console.log('The daily SMS safety limit');
    r = await D('POST', '/api/auth/signup', { name: 'P1', phone: '08070000001', password: 'oldpassword1' });
    await D('POST', '/api/auth/signup', { name: 'P2', phone: '08070000002', password: 'oldpassword1' });
    await D('POST', '/api/auth/signup', { name: 'P3', phone: '08070000003', password: 'oldpassword1' });
    n = calls.length;
    for (const p of ['08070000001', '08070000002', '08070000003']) { await D('POST', '/api/auth/reset/request', { identifier: p }, null, false, ip()); await sleep(250); }
    await waitFor(() => calls.length >= n + 2); await sleep(400);
    check('with a limit of 2 a day, the third SMS is not sent', calls.length === n + 2, calls.length - n);
    r = await D('GET', '/api/admin/messaging', null, null, true);
    check('and the admin is told why', r.body.sms.lastError.kind === 'cap' && /safety limit/.test(r.body.sms.lastError.advice) && r.body.sms.today === 3, r.body.sms);

    console.log('Deleting an account');
    const before = db.prepare('SELECT COUNT(*) c FROM reset_codes').get().c;
    const bolaLogin = await A('POST', '/api/auth/login', { identifier: '08051112222', password: 'oldpassword1' });
    await A('DELETE', '/api/me', { password: 'oldpassword1' }, bolaLogin.body.token);
    const bolaId = bolaLogin.body.user.id;
    check('a deleted account leaves no reset code behind', db.prepare('SELECT COUNT(*) c FROM reset_codes WHERE user_id = ?').get(bolaId).c === 0 && before >= 1);
    db.close();
  } catch (e) {
    fail++; console.log('  ERROR', e);
  }
  s1.kill(); s2.kill(); s3.kill(); s4.kill(); fake.close();
  await sleep(300);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
