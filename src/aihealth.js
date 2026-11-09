'use strict';
// Remembers how the AI service is doing, so the admin page can say in plain words what is wrong.
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./db');

const FILE = path.join(dataDir, 'ai-health.json');
const ADVICE = {
  key_invalid: 'The Anthropic key is wrong, deleted or expired. Make a new key in the console (Keys & access) and paste it into ANTHROPIC_API_KEY in Render.',
  credits: 'The Anthropic credits have finished, or the monthly spend limit was reached. Open Spending in the console, then buy credits or raise the limit.',
  model: 'Anthropic does not know the model name. Check AI_MODEL_FREE and AI_MODEL_PAID in Render (for example claude-haiku-5-5).',
  permission: 'This key is not allowed to use that model or feature. Check the key and its workspace in the console.',
  rate_limit: 'Too many requests at the same moment. It usually clears by itself. If it keeps happening, ask Anthropic for a higher limit.',
  overloaded: 'Anthropic is busy. It usually clears by itself, and teachers are told to try again.',
  timeout: 'Anthropic took too long to answer. It usually clears by itself.',
  network: 'This server could not reach Anthropic. Check Render status and your internet.',
  bad_request: 'Anthropic refused the request. If it keeps happening, send me the text shown as the last problem.',
  not_configured: 'No ANTHROPIC_API_KEY is set on the server. Add it in Render and save.',
  other: 'An unexpected problem. If it keeps happening, send me the text shown as the last problem.',
};

function wat(ms) { return new Date(ms + 3600 * 1000).toISOString().slice(0, 10); }
function read() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return { days: {} }; } }
function write(s) { try { fs.writeFileSync(FILE, JSON.stringify(s)); } catch (e) { /* ignore */ } }
function trimDays(days) {
  const keys = Object.keys(days).sort();
  while (keys.length > 7) delete days[keys.shift()];
}

function classify(status, data) {
  const type = (data && data.error && data.error.type) || '';
  const msg = String((data && data.error && data.error.message) || '');
  let kind = 'other';
  if (/credit balance is too low|purchase credits|plans\s*&\s*billing|monthly (spend|usage) limit|spend limit|reached your (specified |workspace )?(api )?usage limits?|usage limits? (has|have) been reached/i.test(msg) || type === 'billing_error' || status === 402) kind = 'credits';
  else if (status === 401 || type === 'authentication_error') kind = 'key_invalid';
  else if (status === 403 || type === 'permission_error') kind = 'permission';
  else if (status === 404 || type === 'not_found_error') kind = 'model';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 529 || status >= 500) kind = 'overloaded';
  else if (status === 400) kind = 'bad_request';
  return { kind, status, text: (type ? type + ': ' : '') + msg.slice(0, 200) };
}

function recordOk(model) {
  const s = read(), d = wat(Date.now());
  s.lastOkAt = Date.now(); s.lastOkModel = model; s.consecutiveErrors = 0;
  s.days = s.days || {}; s.days[d] = s.days[d] || { ok: 0, err: 0 }; s.days[d].ok++;
  trimDays(s.days); write(s);
}
function recordError(kind, status, text, model) {
  const s = read(), d = wat(Date.now());
  s.lastError = { at: Date.now(), kind, status: status || null, text: String(text || '').slice(0, 220), model: model || null };
  s.consecutiveErrors = (s.consecutiveErrors || 0) + 1;
  s.days = s.days || {}; s.days[d] = s.days[d] || { ok: 0, err: 0 }; s.days[d].err++;
  trimDays(s.days); write(s);
}

function snapshot() {
  const s = read();
  const key = process.env.ANTHROPIC_API_KEY || '';
  const mode = process.env.AI_MOCK === '1' ? 'TEST' : (key ? 'REAL' : 'NO KEY');
  const lastError = s.lastError ? Object.assign({}, s.lastError, { advice: ADVICE[s.lastError.kind] || ADVICE.other }) : null;
  const days = Object.keys(s.days || {}).sort().map((day) => ({ day, ok: s.days[day].ok, err: s.days[day].err }));
  return {
    mode,
    keyEnds: key.length > 10 ? key.slice(-4) : null,
    models: { free: process.env.AI_MODEL_FREE || 'claude-haiku-5-5', paid: process.env.AI_MODEL_PAID || 'claude-sonnet-5-5' },
    lastOkAt: s.lastOkAt || null, lastOkModel: s.lastOkModel || null,
    lastError,
    problemNow: !!(lastError && (!s.lastOkAt || lastError.at > s.lastOkAt)),
    consecutiveErrors: s.consecutiveErrors || 0,
    days,
  };
}

module.exports = { classify, recordOk, recordError, snapshot, ADVICE };
