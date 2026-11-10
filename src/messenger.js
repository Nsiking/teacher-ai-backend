'use strict';
// Sends email (Brevo or Resend) and SMS (Termii). Never throws: it returns { ok, kind, detail } and remembers how it is going,
// so the admin page can say in plain words what is wrong.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./db');

const FILE = path.join(dataDir, 'messaging-health.json');
const ADVICE = {
  not_configured: 'Not set up yet. Add the settings in Render (see the README) and save.',
  key: 'The provider refused the key. Check the API key in Render, and that it is the right kind of key.',
  sender: 'The provider refused the sender. For email, verify the sender address in your provider account. For SMS, use an approved Sender ID.',
  balance: 'The SMS credit is finished. Top up your Termii wallet.',
  limit: 'The provider says too many messages were sent. It usually clears by itself.',
  cap: 'The daily SMS safety limit was reached, so no more codes are sent today. Raise SMS_DAILY_CAP in Render if this is real use, not abuse.',
  network: 'This server could not reach the provider. It usually clears by itself.',
  timeout: 'The provider took too long to answer. It usually clears by itself.',
  other: 'An unexpected problem. If it keeps happening, send me the technical text shown with it.',
};

function cfg() {
  return {
    emailProvider: (process.env.EMAIL_PROVIDER || '').toLowerCase(),
    emailKey: process.env.EMAIL_API_KEY || '',
    emailFrom: process.env.EMAIL_FROM || '',
    emailUrl: process.env.EMAIL_API_URL || '',
    smsProvider: (process.env.SMS_PROVIDER || '').toLowerCase(),
    termiiKey: process.env.TERMII_API_KEY || '',
    termiiSender: process.env.TERMII_SENDER_ID || 'talert',
    termiiChannel: process.env.TERMII_CHANNEL || 'dnd',
    termiiUrl: (process.env.TERMII_BASE_URL || 'https://api.ng.termii.com').replace(/\/$/, ''),
    smsCap: parseInt(process.env.SMS_DAILY_CAP, 10) || 300,
  };
}
function channels() {
  const c = cfg();
  return { email: ['brevo', 'resend'].includes(c.emailProvider) && !!c.emailKey && !!c.emailFrom, sms: c.smsProvider === 'termii' && !!c.termiiKey };
}

function wat(ms) { return new Date(ms + 3600 * 1000).toISOString().slice(0, 10); }
function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return { email: {}, sms: {}, days: {} }; } }
function write(s) { try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { /* ignore */ } }
function record(channel, ok, kind, detail) {
  const s = read(), d = wat(Date.now());
  s[channel] = s[channel] || {};
  if (ok) s[channel].lastOkAt = Date.now();
  else s[channel].lastError = { at: Date.now(), kind, detail: String(detail || '').slice(0, 220) };
  s.days = s.days || {}; s.days[d] = s.days[d] || { emailOk: 0, emailErr: 0, smsOk: 0, smsErr: 0 };
  s.days[d][channel + (ok ? 'Ok' : 'Err')]++;
  const keys = Object.keys(s.days).sort(); while (keys.length > 7) delete s.days[keys.shift()];
  write(s);
}
function smsToday() { const s = read(), d = (s.days || {})[wat(Date.now())]; return d ? d.smsOk + d.smsErr : 0; }

function parseFrom(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
  return m ? { name: m[1].trim() || 'SmartClass Teacher AI', email: m[2].trim() } : { name: 'SmartClass Teacher AI', email: String(from || '').trim() };
}
async function post(url, headers, body) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, headers), body: JSON.stringify(body), signal: ctrl.signal });
    let data = null; try { data = await r.json(); } catch (e) { /* ignore */ }
    return { r, data };
  } finally { clearTimeout(timer); }
}
function failKind(status, data) {
  const msg = String((data && (data.message || data.error)) || '');
  if (/balance|insufficient|low credit/i.test(msg)) return 'balance';
  if (/sender/i.test(msg)) return 'sender';
  if (status === 401 || status === 403) return 'key';
  if (status === 429) return 'limit';
  return 'other';
}

async function sendEmail(to, subject, text, html) {
  const c = cfg();
  if (!channels().email) { record('email', false, 'not_configured', 'No email provider is set'); return { ok: false, kind: 'not_configured' }; }
  try {
    let res;
    if (c.emailProvider === 'brevo') {
      const f = parseFrom(c.emailFrom);
      res = await post((c.emailUrl || 'https://api.brevo.com') + '/v3/smtp/email', { 'api-key': c.emailKey },
        { sender: { name: f.name, email: f.email }, to: [{ email: to }], subject, textContent: text, htmlContent: html });
    } else {
      res = await post((c.emailUrl || 'https://api.resend.com') + '/emails', { authorization: 'Bearer ' + c.emailKey },
        { from: c.emailFrom, to: [to], subject, text, html });
    }
    if (res.r.ok) { record('email', true); return { ok: true }; }
    const kind = failKind(res.r.status, res.data), detail = res.r.status + ' ' + JSON.stringify(res.data || {}).slice(0, 160);
    record('email', false, kind, detail); return { ok: false, kind, detail };
  } catch (e) {
    const kind = e && e.name === 'AbortError' ? 'timeout' : 'network';
    record('email', false, kind, e && e.name); return { ok: false, kind };
  }
}

async function sendSms(to, text) {
  const c = cfg();
  if (!channels().sms) { record('sms', false, 'not_configured', 'No SMS provider is set'); return { ok: false, kind: 'not_configured' }; }
  if (smsToday() >= c.smsCap) { record('sms', false, 'cap', 'Daily SMS safety limit of ' + c.smsCap + ' reached'); return { ok: false, kind: 'cap' }; }
  try {
    const { r, data } = await post(c.termiiUrl + '/api/sms/send', {}, { to: String(to).replace(/^\+/, ''), from: c.termiiSender, sms: text, type: 'plain', channel: c.termiiChannel, api_key: c.termiiKey });
    if (r.ok && data && (data.message_id || /success|sent/i.test(String(data.message || '')))) { record('sms', true); return { ok: true }; }
    const kind = failKind(r.status, data), detail = r.status + ' ' + JSON.stringify(data || {}).slice(0, 160);
    record('sms', false, kind, detail); return { ok: false, kind, detail };
  } catch (e) {
    const kind = e && e.name === 'AbortError' ? 'timeout' : 'network';
    record('sms', false, kind, e && e.name); return { ok: false, kind };
  }
}

function snapshot() {
  const c = cfg(), s = read(), ch = channels();
  const fix = (x) => (x && x.lastError ? { at: x.lastError.at, kind: x.lastError.kind, detail: x.lastError.detail, advice: ADVICE[x.lastError.kind] || ADVICE.other } : null);
  const email = s.email || {}, sms = s.sms || {};
  const bad = (x) => !!(x.lastError && (!x.lastOkAt || x.lastError.at > x.lastOkAt));
  return {
    channels: ch,
    email: { provider: c.emailProvider || null, from: c.emailFrom || null, keySet: !!c.emailKey, lastOkAt: email.lastOkAt || null, lastError: fix(email), problemNow: bad(email) },
    sms: { provider: c.smsProvider || null, senderId: c.termiiSender, route: c.termiiChannel, keySet: !!c.termiiKey, lastOkAt: sms.lastOkAt || null, lastError: fix(sms), problemNow: bad(sms), today: smsToday(), cap: c.smsCap },
    days: Object.keys(s.days || {}).sort().map((day) => Object.assign({ day }, s.days[day])),
  };
}

module.exports = { channels, sendEmail, sendSms, snapshot, ADVICE };
