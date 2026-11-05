'use strict';
const { HttpError } = require('./util');

const API_URL = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';

// Returns { text, inputTokens, outputTokens, model, truncated }
async function generate({ system, user, maxTokens, model, mockText }) {
  if (process.env.AI_MOCK === '1') {
    return { text: mockText || '[TEST MODE] Fake AI answer.', inputTokens: 0, outputTokens: 0, model: 'mock', truncated: false };
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(503, 'The AI service is not set up yet. Please try again later.', 'AI_NOT_CONFIGURED');

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
        messages: [{ role: 'user', content: user }],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    console.error('AI request failed:', e && e.name);
    throw new HttpError(504, 'The AI took too long to answer. Please try again.', 'AI_TIMEOUT');
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await r.json(); } catch (e) { /* ignore */ }

  if (!r.ok) {
    console.error('AI error status', r.status, data && data.error && data.error.type);
    const busy = r.status === 429 || r.status >= 500 || r.status === 529;
    throw new HttpError(busy ? 503 : 502, 'The AI service is busy. Please try again in a moment.', 'AI_ERROR');
  }
  const text = ((data && data.content) || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new HttpError(502, 'The AI returned an empty answer. Please try again.', 'AI_EMPTY');

  return {
    text,
    inputTokens: (data.usage && data.usage.input_tokens) || 0,
    outputTokens: (data.usage && data.usage.output_tokens) || 0,
    model,
    truncated: data.stop_reason === 'max_tokens',
  };
}

module.exports = { generate };
