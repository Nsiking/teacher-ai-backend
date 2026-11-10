'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, dataDir } = require('./db');
const { HttpError, b64u, fromB64u } = require('./util');

// ---- JWT secret: from env, otherwise created once and kept in the data folder ----
function loadSecret() {
  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16) return process.env.JWT_SECRET;
  const file = path.join(dataDir, '.jwt_secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    const s = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();
const TOKEN_DAYS = 90;

// ---- Passwords (scrypt) ----
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [algo, saltHex, hashHex] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(expected, actual);
  } catch (e) {
    return false;
  }
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

function checkPasswordRule(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (pw.length > 100) throw new HttpError(400, 'Password is too long.');
  return pw;
}

// ---- Tokens (HS256 JWT) ----
function sign(data) {
  return b64u(crypto.createHmac('sha256', SECRET).update(data).digest());
}
function signToken(user) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + TOKEN_DAYS * 86400;
  const payload = b64u(JSON.stringify({ uid: user.id, tv: user.token_version, exp }));
  return `${header}.${payload}.${sign(header + '.' + payload)}`;
}
function authenticate(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) throw new HttpError(401, 'Please log in.', 'AUTH_REQUIRED');
  const parts = m[1].split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Please log in again.', 'AUTH_INVALID');
  const expected = Buffer.from(sign(parts[0] + '.' + parts[1]));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    throw new HttpError(401, 'Please log in again.', 'AUTH_INVALID');
  }
  let payload;
  try { payload = JSON.parse(fromB64u(parts[1]).toString('utf8')); } catch (e) {
    throw new HttpError(401, 'Please log in again.', 'AUTH_INVALID');
  }
  if (!payload.exp || payload.exp < Date.now() / 1000) throw new HttpError(401, 'Your session has expired. Please log in again.', 'AUTH_EXPIRED');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user || user.token_version !== payload.tv) throw new HttpError(401, 'Please log in again.', 'AUTH_INVALID');
  return user;
}

// ---- Email / phone ----
function normEmail(v) {
  if (typeof v !== 'string') throw new HttpError(400, 'Email is not valid.');
  const e = v.trim().toLowerCase();
  if (e.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) throw new HttpError(400, 'Email is not valid.');
  return e;
}
// Nigerian numbers -> +234XXXXXXXXXX
function normPhone(v) {
  if (typeof v !== 'string') throw new HttpError(400, 'Phone number is not valid.');
  let p = v.replace(/[\s\-().]/g, '');
  if (/^0\d{10}$/.test(p)) p = '+234' + p.slice(1);
  else if (/^234\d{10}$/.test(p)) p = '+' + p;
  if (!/^\+234\d{10}$/.test(p)) throw new HttpError(400, 'Enter a valid Nigerian phone number, e.g. 08012345678.');
  return p;
}
function findByIdentifier(identifier) {
  if (typeof identifier !== 'string' || !identifier.trim()) return null;
  const id = identifier.trim();
  if (id.includes('@')) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(id.toLowerCase()) || null;
  }
  let p;
  try { p = normPhone(id); } catch (e) { return null; }
  return db.prepare('SELECT * FROM users WHERE phone = ?').get(p) || null;
}

// A one-way fingerprint of a reset code (the code itself is never stored).
function codeHash(userId, code) { return sign('reset:' + userId + ':' + code); }

module.exports = {
  codeHash,
  hashPassword, verifyPassword, DUMMY_HASH, checkPasswordRule,
  signToken, authenticate, normEmail, normPhone, findByIdentifier,
};
