'use strict';
// Tests nightly backups against a stand-in R2 server that checks every request signature.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const r2 = require('../src/r2');
const backup = require('../src/backup');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACCESS = 'TESTACCESSKEY', SECRET = 'testsecretkey/with+chars', BUCKET = 'test-bucket', ADMIN = 'test-admin-key-123456';
const root = path.join(__dirname, '..');

// ---------------- stand-in R2
const store = new Map();
let badSignatures = 0;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    const auth = req.headers.authorization || '';
    const sigIn = /Signature=([0-9a-f]+)/.exec(auth);
    const credIn = /Credential=([^/]+)\//.exec(auth);
    const signedNames = ((/SignedHeaders=([^,]+)/.exec(auth) || [])[1] || '').split(';');
    const hdrs = {};
    signedNames.forEach((n) => { if (n !== 'host') hdrs[n] = req.headers[n]; });
    const query = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });
    const expect = r2.signRequest({
      method: req.method, host: req.headers.host, path: decodeURIComponent(url.pathname), query, headers: hdrs,
      payloadHash: req.headers['x-amz-content-sha256'], accessKey: ACCESS, secretKey: SECRET, amzDate: req.headers['x-amz-date'],
    });
    const okSig = sigIn && credIn && credIn[1] === ACCESS && sigIn[1] === expect.signature;
    const okHash = req.headers['x-amz-content-sha256'] === r2.sha256Hex(body);
    if (!okSig || !okHash) {
      badSignatures++;
      res.writeHead(403, { 'content-type': 'application/xml' });
      return res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature does not match.</Message></Error>');
    }
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    const key = parts.slice(1).join('/');
    if (req.method === 'PUT') { store.set(key, body); res.writeHead(200); return res.end(); }
    if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && key) {
      if (!store.has(key)) { res.writeHead(404); return res.end('<Error><Message>Not found</Message></Error>'); }
      res.writeHead(200); return res.end(store.get(key));
    }
    if (req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      const keys = Array.from(store.keys()).filter((k) => k.startsWith(prefix)).sort();
      // two per page, to exercise paging
      const start = url.searchParams.get('continuation-token') ? Number(url.searchParams.get('continuation-token')) : 0;
      const page = keys.slice(start, start + 2);
      const more = start + 2 < keys.length;
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end('<ListBucketResult><IsTruncated>' + more + '</IsTruncated>' + (more ? '<NextContinuationToken>' + (start + 2) + '</NextContinuationToken>' : '') +
        page.map((k) => '<Contents><Key>' + k.replace(/&/g, '&amp;') + '</Key><LastModified>2026-11-05T00:00:00.000Z</LastModified><Size>' + store.get(k).length + '</Size></Contents>').join('') + '</ListBucketResult>');
    }
    res.writeHead(400); res.end();
  });
});

function stamp(msAgo) { return new Date(Date.now() - msAgo).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }

function runScript(args, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning'].concat(args), { cwd: root, env: Object.assign({}, process.env, env) });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
function startServer(port, dir, extraEnv) {
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dir, AI_MOCK: '1', ADMIN_KEY: ADMIN }, extraEnv);
  ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENDPOINT'].forEach((k) => { if (!(extraEnv && k in extraEnv)) delete env[k]; });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.getOut = () => out;
  return child;
}
async function waitUp(port) {
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://localhost:' + port + '/health'); if (r.ok) return; } catch (e) { /* retry */ } await sleep(100); }
  throw new Error('server did not start');
}
async function call(port, method, p, body, token, admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = ADMIN;
  const r = await fetch('http://localhost:' + port + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* ignore */ }
  return { status: r.status, body: j };
}

(async () => {
  console.log('Signing (Amazon test examples)');
  const aws = (o) => r2.signRequest(Object.assign({ host: 'examplebucket.s3.amazonaws.com', accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', amzDate: '20130524T000000Z', query: {}, headers: {} }, o)).signature;
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  check('GET Object matches Amazon', aws({ method: 'GET', path: '/test.txt', headers: { Range: 'bytes=0-9' }, payloadHash: EMPTY }) === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  check('PUT Object matches Amazon', aws({ method: 'PUT', path: '/test$file.text', headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadHash: '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072' }) === '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  check('List matches Amazon', aws({ method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, payloadHash: EMPTY }) === '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');

  console.log('When is a backup due?');
  const NOW = Date.UTC(2026, 10, 5, 3, 30, 0); // 5 Nov 2026 03:30 UTC = 04:30 Nigerian time
  check('never backed up -> due', backup.isDue({}, NOW));
  check('backed up earlier today -> not due', !backup.isDue({ lastSuccessAt: Date.UTC(2026, 10, 5, 1, 30, 0) }, NOW));
  check('last backup was yesterday, after 2am -> due', backup.isDue({ lastSuccessAt: Date.UTC(2026, 10, 4, 1, 30, 0) }, NOW));
  check('last backup was yesterday, before 2am -> not yet', !backup.isDue({ lastSuccessAt: Date.UTC(2026, 10, 4, 1, 30, 0) }, Date.UTC(2026, 10, 5, 0, 10, 0)));
  check('failed 10 minutes ago -> wait before retrying', !backup.isDue({ lastSuccessAt: Date.UTC(2026, 10, 4, 1, 0, 0), lastError: 'x', lastErrorAt: NOW - 10 * 60000 }, NOW));
  check('failed 2 hours ago -> retry', backup.isDue({ lastSuccessAt: Date.UTC(2026, 10, 4, 1, 0, 0), lastError: 'x', lastErrorAt: NOW - 120 * 60000 }, NOW));
  check('file name date is read correctly', backup.keyTime('teacher-ai-backups/teacher-ai-20261105T013000Z.db.gz') === Date.UTC(2026, 10, 5, 1, 30, 0) && backup.keyTime('teacher-ai-backups/notes.txt') === null);

  await new Promise((r) => mock.listen(0, r));
  const R2PORT = mock.address().port;
  const endpoint = 'http://localhost:' + R2PORT;
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-b-'));
  const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-c-'));
  const dirD = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-d-'));
  const children = [];
  const goodEnv = { R2_ENDPOINT: endpoint, R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: ACCESS, R2_SECRET_ACCESS_KEY: SECRET, R2_BUCKET: BUCKET };
  try {
    console.log('Backups switched off');
    const P0 = 4100 + Math.floor(Math.random() * 50);
    const s0 = startServer(P0, dirC, {}); children.push(s0); await waitUp(P0);
    let r = await call(P0, 'GET', '/api/admin/backup', null, null, true);
    check('status says OFF when R2 settings are missing', r.status === 200 && r.body.enabled === false, r.body);
    r = await call(P0, 'POST', '/api/admin/backup/run', null, null, true);
    check('Back up now explains what is missing', r.status === 400 && /not set up/i.test(r.body.error), r.body);
    r = await call(P0, 'GET', '/api/admin/backup');
    check('backup status needs the admin key', r.status === 403);
    check('log says backups are OFF', /Backups: OFF/.test(s0.getOut()));
    s0.kill();

    console.log('Backup, upload and clean-up');
    store.set('teacher-ai-backups/teacher-ai-20250101T010101Z.db.gz', Buffer.from('very old'));
    store.set('teacher-ai-backups/teacher-ai-' + stamp(40 * 86400000) + '.db.gz', Buffer.from('40 days old'));
    store.set('teacher-ai-backups/teacher-ai-' + stamp(5 * 86400000) + '.db.gz', Buffer.from('5 days old'));
    store.set('teacher-ai-backups/notes.txt', Buffer.from('not a backup'));
    store.set('other-app/teacher-ai-20240101T010101Z.db.gz', Buffer.from('another app'));
    const PA = 4150 + Math.floor(Math.random() * 50);
    const sA = startServer(PA, dirA, goodEnv); children.push(sA); await waitUp(PA);
    check('log says backups are ON', /Backups: ON/.test(sA.getOut()));
    let u = await call(PA, 'POST', '/api/auth/signup', { name: 'Backup Teacher', email: 'bk@example.com', password: 'password123' });
    const tok = u.body.token;
    const cl = await call(PA, 'POST', '/api/classes', { name: 'JSS 1A' }, tok);
    await call(PA, 'POST', '/api/classes/' + cl.body.id + '/pupils', { names: 'Ada\nBola' }, tok);
    await call(PA, 'POST', '/api/generate/worksheet', { subject: 'Maths', className: 'JSS 1', topic: 'Fractions' }, tok);

    r = await call(PA, 'GET', '/api/admin/backup', null, null, true);
    check('status says ON and never leaks the secret', r.body.enabled === true && r.body.bucket === BUCKET && !JSON.stringify(r.body).includes(SECRET) && !JSON.stringify(r.body).includes(ACCESS), r.body);
    r = await call(PA, 'POST', '/api/admin/backup/run', null, null, true);
    check('Back up now works', r.status === 200 && r.body.ok === true && /teacher-ai-backups\/teacher-ai-\d{8}T\d{6}Z\.db\.gz$/.test(r.body.key), r.body);
    const newKey = r.body.key;
    check('every request to R2 had a valid signature', badSignatures === 0, badSignatures);
    check('the new backup is in the bucket', store.has(newKey));
    check('backups older than 30 days were deleted', !store.has('teacher-ai-backups/teacher-ai-20250101T010101Z.db.gz') && r.body.removedOld === 2, r.body);
    check('a 5-day-old backup, a non-backup file and another app\'s file were kept', store.size === 4 && store.has('teacher-ai-backups/notes.txt') && store.has('other-app/teacher-ai-20240101T010101Z.db.gz'), Array.from(store.keys()));

    const restored = path.join(dirA, 'check-backup.db');
    fs.writeFileSync(restored, zlib.gunzipSync(store.get(newKey)));
    const chk = new DatabaseSync(restored);
    const counts = ['users', 'classes', 'pupils', 'items'].map((t) => chk.prepare('SELECT COUNT(*) c FROM ' + t).get().c);
    chk.close();
    check('the backup opens as a database with the real data (1 user, 1 class, 2 pupils, 1 item)', counts.join(',') === '1,1,2,1', counts);

    r = await call(PA, 'GET', '/api/admin/backup?list=1', null, null, true);
    check('status shows last backup and the recent list', r.body.lastKey === newKey && r.body.lastSuccessAt > 0 && r.body.recent && r.body.recent[0].key === newKey, r.body);
    check('no leftover temporary files in the data folder', fs.readdirSync(dirA).every((f) => !f.startsWith('backup-tmp-')), fs.readdirSync(dirA));

    console.log('A backup that fails');
    const PB = 4200 + Math.floor(Math.random() * 50);
    const sB = startServer(PB, dirB, Object.assign({}, goodEnv, { R2_SECRET_ACCESS_KEY: 'the-wrong-secret' })); children.push(sB); await waitUp(PB);
    r = await call(PB, 'POST', '/api/admin/backup/run', null, null, true);
    check('wrong key: backup fails with a clear message', r.status === 502 && /signature/i.test(r.body.error) && !r.body.error.includes('the-wrong-secret'), r.body);
    r = await call(PB, 'GET', '/api/admin/backup', null, null, true);
    check('the failure is recorded in the status', !!r.body.lastError && !r.body.lastSuccessAt, r.body);
    sB.kill();

    console.log('Restore');
    const lst = await runScript(['scripts/restore.js', '--list'], Object.assign({}, goodEnv, { DATA_DIR: dirD }));
    check('restore --list shows the backups', lst.status === 0 && lst.stdout.includes(newKey), lst.stdout + lst.stderr);
    // a different database that the restore will replace
    const sD = startServer(4260 + Math.floor(Math.random() * 40), dirD, {}); children.push(sD);
    const PD = Number(/port (\d+)/.exec((await (async () => { for (let i = 0; i < 50 && !/port \d+/.test(sD.getOut()); i++) await sleep(100); return sD.getOut(); })()))[1]);
    await call(PD, 'POST', '/api/auth/signup', { name: 'Someone Else', email: 'else@example.com', password: 'password123' });
    sD.kill(); await sleep(400);
    const rs = await runScript(['scripts/restore.js', '--latest'], Object.assign({}, goodEnv, { DATA_DIR: dirD }));
    check('restore --latest downloads and checks the newest backup', rs.status === 0 && /1 user\(s\)/.test(rs.stdout) && fs.existsSync(path.join(dirD, 'restore-pending.db')), rs.stdout + rs.stderr);
    check('the live database is not touched yet', fs.existsSync(path.join(dirD, 'teacher.db')));
    const sD2 = startServer(PD, dirD, {}); children.push(sD2); await waitUp(PD);
    check('server log says the database was restored', /Database restored/.test(sD2.getOut()));
    r = await call(PD, 'POST', '/api/auth/login', { identifier: 'bk@example.com', password: 'password123' });
    check('after restart, the backed-up teacher can log in', r.status === 200);
    const clsAfter = await call(PD, 'GET', '/api/classes', null, r.body.token);
    check('and their class is back', clsAfter.body.classes.length === 1 && clsAfter.body.classes[0].pupilCount === 2, clsAfter.body);
    r = await call(PD, 'POST', '/api/auth/login', { identifier: 'else@example.com', password: 'password123' });
    check('the database from before the restore is replaced', r.status === 401);
    check('the old database was kept as a safety copy', fs.readdirSync(dirD).some((f) => f.startsWith('teacher.db.before-restore-')), fs.readdirSync(dirD));
    check('restore-pending.db is gone after use', !fs.existsSync(path.join(dirD, 'restore-pending.db')));
    sD2.kill();
    const bad = await runScript(['scripts/restore.js', '--file', path.join(dirA, '.jwt_secret')], { DATA_DIR: dirD });
    check('restore refuses a file that is not a backup', bad.status !== 0 && /not a valid backup|not a database/.test(bad.stdout + bad.stderr), bad.stdout + bad.stderr);
    sA.kill();
  } catch (e) {
    fail++; console.log('  ERROR', e);
  }
  children.forEach((c) => { try { c.kill(); } catch (e) { /* ignore */ } });
  mock.close();
  await sleep(300);
  [dirA, dirB, dirC, dirD].forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
