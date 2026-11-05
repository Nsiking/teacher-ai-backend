'use strict';
// Minimal Cloudflare R2 (S3-compatible) client using AWS Signature V4. No extra libraries needed.
const crypto = require('crypto');

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function sha256Hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function enc(s) { return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function encPath(p) { return p.split('/').map(enc).join('/'); }

// Builds the Authorization header for one request.
function signRequest({ method, host, path, query = {}, headers = {}, payloadHash, accessKey, secretKey, region = 'auto', service = 's3', amzDate }) {
  const day = amzDate.slice(0, 8);
  const all = Object.assign({}, headers, { host: host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate });
  const lower = {};
  Object.keys(all).forEach((k) => { lower[k.toLowerCase()] = String(all[k]).trim().replace(/\s+/g, ' '); });
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => n + ':' + lower[n] + '\n').join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query).sort().map((k) => enc(k) + '=' + enc(query[k])).join('&');
  const canonicalRequest = [method, encPath(path), canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = day + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  return { authorization, signature, signedHeaders, headers: lower };
}

function config() {
  const e = process.env;
  const accessKey = (e.R2_ACCESS_KEY_ID || '').trim();
  const secretKey = (e.R2_SECRET_ACCESS_KEY || '').trim();
  const bucket = (e.R2_BUCKET || '').trim();
  const account = (e.R2_ACCOUNT_ID || '').trim();
  const endpointEnv = (e.R2_ENDPOINT || '').trim().replace(/\/+$/, '');
  if (!accessKey || !secretKey || !bucket || (!account && !endpointEnv)) return null;
  let prefix = (e.R2_BACKUP_PREFIX || 'teacher-ai-backups/').trim().replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  const keepDays = Math.max(1, parseInt(e.BACKUP_KEEP_DAYS, 10) || 30);
  return { accessKey, secretKey, bucket, prefix, keepDays, endpoint: endpointEnv || ('https://' + account + '.r2.cloudflarestorage.com') };
}

async function request(cfg, method, key, opts) {
  opts = opts || {};
  const body = opts.body || Buffer.alloc(0);
  const url = new URL(cfg.endpoint);
  const path = '/' + cfg.bucket + (key ? '/' + key : '');
  const payloadHash = sha256Hex(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const headers = Object.assign({}, opts.headers || {});
  const signed = signRequest({ method, host: url.host, path, query: opts.query || {}, headers, payloadHash, accessKey: cfg.accessKey, secretKey: cfg.secretKey, amzDate });
  const send = Object.assign({}, signed.headers, { authorization: signed.authorization });
  delete send.host;
  const qs = Object.keys(opts.query || {}).sort().map((k) => enc(k) + '=' + enc(opts.query[k])).join('&');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 120000);
  let res;
  try {
    res = await fetch(url.origin + encPath(path) + (qs ? '?' + qs : ''), { method, headers: send, body: method === 'PUT' ? body : undefined, signal: ctrl.signal });
  } catch (e) {
    throw new Error('Could not reach R2 (' + (e && e.name === 'AbortError' ? 'timed out' : 'network error') + ').');
  } finally { clearTimeout(timer); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    const m = /<Message>([^<]*)<\/Message>/.exec(buf.toString('utf8'));
    throw new Error('R2 said ' + res.status + (m ? ': ' + m[1] : '') + '.');
  }
  return buf;
}

function putObject(cfg, key, buf, contentType) {
  return request(cfg, 'PUT', key, { body: buf, headers: { 'content-type': contentType || 'application/octet-stream' } });
}
function getObject(cfg, key) { return request(cfg, 'GET', key, {}); }
function deleteObject(cfg, key) { return request(cfg, 'DELETE', key, {}); }

function unxml(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }

async function listObjects(cfg, prefix) {
  const out = [];
  let token = null;
  for (let page = 0; page < 50; page++) {
    const query = { 'list-type': '2', prefix: prefix || '' };
    if (token) query['continuation-token'] = token;
    const xml = (await request(cfg, 'GET', '', { query })).toString('utf8');
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m;
    while ((m = re.exec(xml))) {
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]);
      const size = /<Size>(\d+)<\/Size>/.exec(m[1]);
      const lm = /<LastModified>([^<]*)<\/LastModified>/.exec(m[1]);
      if (key) out.push({ key: unxml(key[1]), size: size ? Number(size[1]) : 0, lastModified: lm ? lm[1] : null });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
    if (!truncated || !next) break;
    token = unxml(next[1]);
  }
  return out;
}

module.exports = { signRequest, sha256Hex, config, putObject, getObject, deleteObject, listObjects };
