'use strict';
const { HttpError } = require('./util');
const health = require('./aihealth');

const API_URL = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The newer models (5.x) think before they write, and the thinking counts against max_tokens. So each request gets
// room to think, and a choice of how much: think = 'off' (plain extraction), or { effort: 'low'|'medium', headroom: tokens }.
const NEW_MODEL = /claude-(haiku|sonnet|opus|fable|mythos)-5/;
const DEFAULT_THINK = { effort: 'low', headroom: 3000 };
function requestFor(model, maxTokens, think, forceOff) {
  const off = forceOff || think === 'off';
  const t = off ? null : Object.assign({}, DEFAULT_THINK, think || {});
  // about 30% more tokens per text than older models, so the answer budget is raised
  const budget = Math.min(16000, Math.ceil(maxTokens * 1.25) + (off ? 0 : t.headroom));
  const extra = {};
  if (off) extra.thinking = { type: 'disabled' };
  else if (NEW_MODEL.test(model)) extra.output_config = { effort: t.effort };
  return { max_tokens: budget, extra };
}

// Returns { text, inputTokens, outputTokens, model, truncated }
async function generate({ system, user, maxTokens, model, mockText, images, think }) {
  if (process.env.AI_MOCK === '1') {
    return { text: mockText || '[TEST MODE] Fake AI answer.', inputTokens: 0, outputTokens: 0, model: 'mock', truncated: false };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    health.recordError('not_configured', null, 'ANTHROPIC_API_KEY is not set', model);
    throw Object.assign(new HttpError(503, 'The AI service is not set up yet. Please try again later.', 'AI_NOT_CONFIGURED'), { aiKind: 'not_configured' });
  }
  const content = images && images.length
    ? images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })).concat([{ type: 'text', text: user }])
    : user;

  // A blank answer is tried once more on its own, this time with thinking switched off so that text is certain. Real errors are not retried.
  for (let attempt = 0; attempt < 2; attempt++) {
    const rq = requestFor(model, maxTokens, think, attempt > 0);
    const body = JSON.stringify(Object.assign({ model, max_tokens: rq.max_tokens, system, messages: [{ role: 'user', content }] }, rq.extra));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);
    let r;
    try {
      r = await fetch(API_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      console.error('AI request failed:', e && e.name);
      const kind = e && e.name === 'AbortError' ? 'timeout' : 'network';
      health.recordError(kind, null, e && e.name, model);
      throw Object.assign(new HttpError(504, 'The AI took too long to answer. Please try again.', 'AI_TIMEOUT'), { aiKind: kind });
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    try { data = await r.json(); } catch (e) { /* ignore */ }

    if (!r.ok) {
      console.error('AI error status', r.status, data && data.error && data.error.type);
      const info = health.classify(r.status, data);
      health.recordError(info.kind, info.status, info.text, model);
      const busy = r.status === 429 || r.status >= 500 || r.status === 529;
      throw Object.assign(new HttpError(busy ? 503 : 502, 'The AI service is busy. Please try again in a moment.', 'AI_ERROR'), { aiKind: info.kind });
    }
    const blocks = (data && data.content) || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (text) {
      health.recordOk(model);
      return {
        text,
        inputTokens: (data.usage && data.usage.input_tokens) || 0,
        outputTokens: (data.usage && data.usage.output_tokens) || 0,
        model,
        truncated: data.stop_reason === 'max_tokens',
      };
    }
    const stopReason = (data && data.stop_reason) || 'none';
    const diag = (attempt > 0 ? 'retry without thinking: ' : '') + 'stop_reason=' + stopReason + ', blocks=' + (blocks.map((b) => b.type).join(',') || 'none') + ', output_tokens=' + ((data && data.usage && data.usage.output_tokens) || 0) + (images && images.length ? ', with_photos=' + images.length : '');
    console.error('AI empty answer:', diag);
    if (stopReason === 'refusal') {
      health.recordError('refusal', 200, 'The AI declined this request (' + diag + ')', model);
      throw Object.assign(new HttpError(502, 'The AI could not help with this request. Please change the wording and try again.', 'AI_REFUSED'), { aiKind: 'refusal' });
    }
    if (attempt === 0) { await sleep(800); continue; }
    health.recordError('empty', 200, 'The AI returned an empty answer (' + diag + ')', model);
    throw Object.assign(new HttpError(502, 'The AI returned an empty answer. Please try again.', 'AI_EMPTY'), { aiKind: 'empty' });
  }
}

module.exports = { generate, requestFor };
