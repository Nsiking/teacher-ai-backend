'use strict';

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || null;
  }
}

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64u(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// Clean text input: must be text, trimmed, no angle brackets, length-checked.
function text(v, { name = 'Field', min = 0, max = 200, required = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${name} is required.`);
    return '';
  }
  if (typeof v !== 'string') throw new HttpError(400, `${name} must be text.`);
  v = v.replace(/[<>]/g, '').trim();
  if (required && v.length === 0) throw new HttpError(400, `${name} is required.`);
  if (v.length < min) throw new HttpError(400, `${name} is too short.`);
  if (v.length > max) throw new HttpError(400, `${name} is too long (maximum ${max} characters).`);
  return v;
}

function int(v, { name = 'Number', min = 0, max = 1000, def = null } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be a whole number.`);
  if (n < min || n > max) throw new HttpError(400, `${name} must be between ${min} and ${max}.`);
  return n;
}

module.exports = { HttpError, b64u, fromB64u, text, int };
