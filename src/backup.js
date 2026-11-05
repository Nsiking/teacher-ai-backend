'use strict';
// Nightly database backup to Cloudflare R2, with 30-day retention.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { db, dataDir } = require('./db');
const r2 = require('./r2');

const STATE_FILE = path.join(dataDir, 'backup-state.json');
const NAME_RE = /teacher-ai-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.gz$/;
let running = false;

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { /* ignore */ } }

// Nigerian time is UTC+1 all year.
function wat(ms) {
  const d = new Date(ms + 3600 * 1000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
function keyTime(key) {
  const m = NAME_RE.exec(key);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

// Is a nightly backup due? (pure function, easy to test)
function isDue(state, now) {
  if (state.lastErrorAt && now - state.lastErrorAt < 60 * 60 * 1000 && (!state.lastSuccessAt || state.lastErrorAt > state.lastSuccessAt)) return false;
  if (!state.lastSuccessAt) return true;                       // never backed up: do one soon to prove it works
  const w = wat(now);
  return wat(state.lastSuccessAt).day !== w.day && w.hour >= 2; // otherwise once a night, after 2:00 am
}

async function runBackup(reason) {
  const cfg = r2.config();
  if (!cfg) throw new Error('Backups are not set up. Add the R2 settings in the service Environment.');
  if (running) throw new Error('A backup is already running.');
  running = true;
  const started = Date.now();
  const tmp = path.join(dataDir, 'backup-tmp-' + started + '.db');
  const prev = readState();
  try {
    db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");     // a clean, consistent copy of the live database
    const gz = zlib.gzipSync(fs.readFileSync(tmp), { level: 6 });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const key = cfg.prefix + 'teacher-ai-' + stamp + '.db.gz';
    await r2.putObject(cfg, key, gz, 'application/gzip');

    let removed = 0, retentionError = null;
    try {
      const cutoff = Date.now() - cfg.keepDays * 86400000;
      for (const o of await r2.listObjects(cfg, cfg.prefix)) {
        const t = keyTime(o.key);
        if (t !== null && t < cutoff && o.key !== key) { await r2.deleteObject(cfg, o.key); removed++; }
      }
    } catch (e) { retentionError = e.message; }

    writeState({ lastSuccessAt: Date.now(), lastKey: key, lastSize: gz.length, lastReason: reason || 'nightly', removedOld: removed, retentionError, lastError: null, lastErrorAt: null });
    console.log('Backup saved: ' + key + ' (' + gz.length + ' bytes, removed ' + removed + ' old)');
    return { key, size: gz.length, removedOld: removed, retentionError };
  } catch (e) {
    writeState(Object.assign({}, prev, { lastError: e.message, lastErrorAt: Date.now() }));
    console.error('Backup failed: ' + e.message);
    throw e;
  } finally {
    running = false;
    try { fs.rmSync(tmp, { force: true }); } catch (e) { /* ignore */ }
  }
}

async function status(withList) {
  const cfg = r2.config();
  const s = readState();
  const out = {
    enabled: !!cfg,
    bucket: cfg ? cfg.bucket : null,
    prefix: cfg ? cfg.prefix : null,
    keepDays: cfg ? cfg.keepDays : null,
    schedule: 'Every night after 2:00 am Nigerian time',
    lastSuccessAt: s.lastSuccessAt || null,
    lastKey: s.lastKey || null,
    lastSize: s.lastSize || null,
    lastError: s.lastError || null,
    lastErrorAt: s.lastErrorAt || null,
    retentionError: s.retentionError || null,
    running,
  };
  if (withList && cfg) {
    try {
      const list = await r2.listObjects(cfg, cfg.prefix);
      out.recent = list.filter((o) => keyTime(o.key) !== null).sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 10).map((o) => ({ key: o.key, size: o.size }));
    } catch (e) { out.listError = e.message; }
  }
  return out;
}

function startScheduler() {
  const cfg = r2.config();
  console.log(cfg ? 'Backups: ON (bucket ' + cfg.bucket + ', folder ' + cfg.prefix + ', keep ' + cfg.keepDays + ' days)' : 'Backups: OFF (R2 settings not set)');
  const tick = () => {
    if (!r2.config() || running) return;
    if (isDue(readState(), Date.now())) runBackup('nightly').catch(() => { /* already logged and saved */ });
  };
  setTimeout(tick, 60 * 1000).unref();
  setInterval(tick, 10 * 60 * 1000).unref();
}

module.exports = { runBackup, status, startScheduler, isDue, keyTime };
