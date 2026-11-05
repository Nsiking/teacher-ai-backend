'use strict';
// Prepares a database restore. It does NOT touch the live database.
// The server swaps the file in the next time it starts (the old database is kept as teacher.db.before-restore-...).
//
//   node scripts/restore.js --list                 list the backups in R2
//   node scripts/restore.js --latest               use the newest backup in R2
//   node scripts/restore.js --key <name>           use one backup from R2 (name from --list)
//   node scripts/restore.js --file <path>.db.gz    use a backup file you downloaded
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const r2 = require('../src/r2');

function fail(msg) { console.error('\nERROR: ' + msg + '\n'); process.exit(1); }
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : null; };

const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim() ? process.env.DATA_DIR.trim() : path.join(__dirname, '..', 'data');

(async () => {
  let gz;
  if (val('--file')) {
    try { gz = fs.readFileSync(val('--file')); } catch (e) { fail('Cannot read that file: ' + val('--file')); }
  } else if (has('--list') || has('--latest') || val('--key')) {
    const cfg = r2.config();
    if (!cfg) fail('The R2 settings are missing (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET).');
    const list = (await r2.listObjects(cfg, cfg.prefix)).filter((o) => /\.db\.gz$/.test(o.key)).sort((a, b) => (a.key < b.key ? 1 : -1));
    if (has('--list')) {
      if (!list.length) console.log('No backups found in ' + cfg.bucket + '/' + cfg.prefix);
      list.slice(0, 40).forEach((o) => console.log(o.key + '   ' + o.size + ' bytes'));
      return;
    }
    const key = val('--key') || (list[0] && list[0].key);
    if (!key) fail('No backups found in ' + cfg.bucket + '/' + cfg.prefix);
    console.log('Downloading ' + key + ' ...');
    gz = await r2.getObject(cfg, key);
  } else {
    fail('Choose one: --list, --latest, --key <name>, or --file <path>.db.gz');
  }

  let raw;
  try { raw = zlib.gunzipSync(gz); } catch (e) { fail('That file is not a valid backup (could not unzip it).'); }
  if (raw.slice(0, 15).toString('utf8') !== 'SQLite format 3') fail('That file is not a database backup.');

  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = path.join(dataDir, 'restore-check.db');
  fs.writeFileSync(tmp, raw);
  try {
    const { DatabaseSync } = require('node:sqlite');
    const check = new DatabaseSync(tmp);
    const users = check.prepare('SELECT COUNT(*) c FROM users').get().c;
    const items = check.prepare('SELECT COUNT(*) c FROM items').get().c;
    check.close();
    console.log('Backup looks good: ' + users + ' user(s) and ' + items + ' saved item(s).');
  } catch (e) { fs.rmSync(tmp, { force: true }); fail('The backup could not be opened as a database.'); }
  fs.renameSync(tmp, path.join(dataDir, 'restore-pending.db'));
  console.log('\nReady. The restore happens when the server next starts.');
  console.log('  1. Restart the service (on Render: Manual Deploy, then Deploy latest commit, or Restart service).');
  console.log('  2. The old database is kept next to it as teacher.db.before-restore-<time>.');
})().catch((e) => fail(e.message));
