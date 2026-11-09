'use strict';
const { HttpError } = require('./util');
const health = require('./aihealth');

const API_URL = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';

// Returns { text, inputTokens, outputTokens, model, truncated }
async function generate({ system, user, maxTokens, model, mockText, images }) {
  if (process.env.AI_MOCK === '1') {
    return { text: mockText || '[TEST MODE] Fake AI answer.', inputTokens: 0, outputTokens: 0, model: 'mock', truncated: false };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    health.recordError('not_configured', null, 'ANTHROPIC_API_KEY is not set', model);
    throw Object.assign(new HttpError(503, 'The AI service is not set up yet. Please try again later.', 'AI_NOT_CONFIGURED'), { aiKind: 'not_configured' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  let r;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{
          role: 'user',
          content: images && images.length
            ? images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })).concat([{ type: 'text', text: user }])
            : user,
        }],
      }),
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
  const text = ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) {
    health.recordError('other', r.status, 'The AI returned an empty answer', model);
    throw Object.assign(new HttpError(502, 'The AI returned an empty answer. Please try again.', 'AI_EMPTY'), { aiKind: 'other' });
  }
  health.recordOk(model);

  return {
    text,
    inputTokens: (data.usage && data.usage.input_tokens) || 0,
    outputTokens: (data.usage && data.usage.output_tokens) || 0,
    model,
    truncated: data.stop_reason === 'max_tokens',
  };
}

module.exports = { generate };
