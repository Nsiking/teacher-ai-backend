'use strict';
const fs = require('fs');
const path = require('path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  console.error('\nThis app needs Node.js version 22.13 or newer (your version is ' + process.version + ').');
  console.error('Install the newer Node.js LTS from https://nodejs.org and try again.\n');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim()
  ? process.env.DATA_DIR.trim()
  : path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

// A restore prepared by scripts/restore.js is applied here, before the database is opened.
(function applyPendingRestore() {
  const pending = path.join(dataDir, 'restore-pending.db');
  const live = path.join(dataDir, 'teacher.db');
  if (!fs.existsSync(pending)) return;
  let head = Buffer.alloc(15);
  try { const fd = fs.openSync(pending, 'r'); fs.readSync(fd, head, 0, 15, 0); fs.closeSync(fd); } catch (e) { head = Buffer.alloc(15); }
  if (head.toString('utf8') !== 'SQLite format 3') {
    fs.renameSync(pending, path.join(dataDir, 'restore-pending.invalid'));
    console.error('restore-pending.db is not a valid database. It was renamed to restore-pending.invalid and ignored.');
    return;
  }
  if (fs.existsSync(live)) fs.renameSync(live, path.join(dataDir, 'teacher.db.before-restore-' + Date.now()));
  for (const ext of ['-wal', '-shm']) { try { fs.rmSync(live + ext, { force: true }); } catch (e) { /* ignore */ } }
  fs.renameSync(pending, live);
  console.log('Database restored from restore-pending.db. The previous database was kept as teacher.db.before-restore-*');
})();

const db = new DatabaseSync(path.join(dataDir, 'teacher.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  pass_hash TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  plan_expires_at INTEGER,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  meta TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_user ON items (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS gen_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_time ON gen_log (created_at);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_classes_user ON classes (user_id);
CREATE TABLE IF NOT EXISTS pupils (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pupils_class ON pupils (class_id);
CREATE TABLE IF NOT EXISTS attendance (
  pupil_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  class_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (pupil_id, day)
);
CREATE INDEX IF NOT EXISTS idx_att_class_day ON attendance (class_id, day);
CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  class_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  max_score REAL NOT NULL,
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assess_class ON assessments (class_id);
CREATE TABLE IF NOT EXISTS textbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER,
  title TEXT NOT NULL,
  authors TEXT NOT NULL,
  publisher TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  year TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL,
  levels TEXT NOT NULL,
  contents TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tb_owner ON textbooks (owner_user_id);
CREATE TABLE IF NOT EXISTS timetable_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  subject TEXT NOT NULL,
  class_name TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_slots_user ON timetable_slots (user_id, day, start_min);
CREATE TABLE IF NOT EXISTS formats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  is_default INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_formats_user ON formats (user_id, type);
CREATE TABLE IF NOT EXISTS scores (
  assessment_id INTEGER NOT NULL,
  pupil_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (assessment_id, pupil_id)
);
`);

module.exports = { db, dataDir };
