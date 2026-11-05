'use strict';
// Light classroom record: classes, pupils, daily attendance, assessments and scores.
const { db } = require('./db');
const { HttpError, text } = require('./util');
const plans = require('./plans');

const MAX_CLASSES = 10;
const MAX_PUPILS = 80;
const MAX_ASSESSMENTS = 60;

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* ignore */ } throw e; }
}
function ownClass(user, id) {
  const c = db.prepare('SELECT * FROM classes WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!c) throw new HttpError(404, 'Class not found.');
  return c;
}
function ownPupil(user, id) {
  const p = db.prepare('SELECT * FROM pupils WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!p) throw new HttpError(404, 'Pupil not found.');
  return p;
}
function ownAssessment(user, id) {
  const a = db.prepare('SELECT * FROM assessments WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!a) throw new HttpError(404, 'Assessment not found.');
  return a;
}
function validDay(s, name) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `${name || 'Date'} is not valid.`);
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new HttpError(400, `${name || 'Date'} is not valid.`);
  return s;
}
function pupilRow(p) { return { id: p.id, name: p.name, gender: p.gender }; }
function pupilsOf(classId) {
  return db.prepare('SELECT * FROM pupils WHERE class_id = ? ORDER BY id').all(classId).map(pupilRow);
}
function normGender(v) {
  const g = String(v || '').toLowerCase();
  if (['boy', 'male', 'm'].includes(g)) return 'boy';
  if (['girl', 'female', 'f'].includes(g)) return 'girl';
  return '';
}
function cleanName(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/^\s*\d+[.)\-\s]+/, '').replace(/[<>]/g, '').trim().slice(0, 60);
}
function scoreNumber(v, max) {
  const n = typeof v === 'string' ? Number(v.trim()) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, 'A score is not a valid number.');
  if (n < 0 || n > max) throw new HttpError(400, `A score must be between 0 and ${max}.`);
  return Math.round(n * 100) / 100;
}
function assessmentRow(a) {
  return { id: a.id, classId: a.class_id, title: a.title, maxScore: a.max_score, day: a.day };
}

function register(add) {
  // ---------------------------------------------------------------- classes
  add('GET', '/api/classes', { auth: true }, (ctx) => {
    const rows = db.prepare(
      'SELECT c.*, (SELECT COUNT(*) FROM pupils p WHERE p.class_id = c.id) AS pupil_count FROM classes c WHERE c.user_id = ? ORDER BY c.id'
    ).all(ctx.user.id);
    return { classes: rows.map((c) => ({ id: c.id, name: c.name, pupilCount: c.pupil_count, createdAt: c.created_at })) };
  });
  add('POST', '/api/classes', { auth: true }, (ctx) => {
    const name = text(ctx.body.name, { name: 'Class name', required: true, max: 40 });
    const n = db.prepare('SELECT COUNT(*) c FROM classes WHERE user_id = ?').get(ctx.user.id).c;
    if (n >= MAX_CLASSES) throw new HttpError(400, `You can keep up to ${MAX_CLASSES} classes.`, 'LIMIT');
    if (db.prepare('SELECT 1 FROM classes WHERE user_id = ? AND LOWER(name) = LOWER(?)').get(ctx.user.id, name)) {
      throw new HttpError(409, 'You already have a class with that name.', 'EXISTS');
    }
    const info = db.prepare('INSERT INTO classes (user_id, name, created_at) VALUES (?, ?, ?)').run(ctx.user.id, name, Date.now());
    return { id: Number(info.lastInsertRowid), name };
  });
  add('GET', '/api/classes/:id', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    return { class: { id: c.id, name: c.name }, pupils: pupilsOf(c.id) };
  });
  add('PUT', '/api/classes/:id', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    const name = text(ctx.body.name, { name: 'Class name', required: true, max: 40 });
    if (db.prepare('SELECT 1 FROM classes WHERE user_id = ? AND LOWER(name) = LOWER(?) AND id != ?').get(ctx.user.id, name, c.id)) {
      throw new HttpError(409, 'You already have a class with that name.', 'EXISTS');
    }
    db.prepare('UPDATE classes SET name = ? WHERE id = ?').run(name, c.id);
    return { id: c.id, name };
  });
  add('DELETE', '/api/classes/:id', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    tx(() => {
      for (const t of ['scores', 'attendance']) {
        // scores are tied to assessments of this class; attendance carries class_id
        if (t === 'scores') db.prepare('DELETE FROM scores WHERE assessment_id IN (SELECT id FROM assessments WHERE class_id = ?)').run(c.id);
        else db.prepare('DELETE FROM attendance WHERE class_id = ?').run(c.id);
      }
      db.prepare('DELETE FROM assessments WHERE class_id = ?').run(c.id);
      db.prepare('DELETE FROM pupils WHERE class_id = ?').run(c.id);
      db.prepare('DELETE FROM classes WHERE id = ?').run(c.id);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- pupils
  add('POST', '/api/classes/:id/pupils', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    let list;
    if (Array.isArray(ctx.body.pupils)) list = ctx.body.pupils.map((p) => ({ name: cleanName(p && p.name), gender: normGender(p && p.gender) }));
    else if (typeof ctx.body.names === 'string') list = ctx.body.names.split(/\r?\n/).map((n) => ({ name: cleanName(n), gender: '' }));
    else throw new HttpError(400, 'Enter at least one name.');
    list = list.filter((p) => p.name);
    if (!list.length) throw new HttpError(400, 'Enter at least one name.');
    const have = db.prepare('SELECT COUNT(*) c FROM pupils WHERE class_id = ?').get(c.id).c;
    if (have + list.length > MAX_PUPILS) {
      throw new HttpError(400, `A class can hold up to ${MAX_PUPILS} pupils. You can add ${Math.max(0, MAX_PUPILS - have)} more.`, 'LIMIT');
    }
    tx(() => {
      const ins = db.prepare('INSERT INTO pupils (user_id, class_id, name, gender, created_at) VALUES (?, ?, ?, ?, ?)');
      const now = Date.now();
      for (const p of list) ins.run(ctx.user.id, c.id, p.name, p.gender, now);
    });
    return { added: list.length, pupils: pupilsOf(c.id) };
  });
  add('PUT', '/api/pupils/:id', { auth: true }, (ctx) => {
    const p = ownPupil(ctx.user, ctx.params.id);
    const name = ctx.body.name !== undefined ? text(ctx.body.name, { name: 'Name', required: true, max: 60 }) : p.name;
    const gender = ctx.body.gender !== undefined ? normGender(ctx.body.gender) : p.gender;
    db.prepare('UPDATE pupils SET name = ?, gender = ? WHERE id = ?').run(name, gender, p.id);
    return pupilRow({ id: p.id, name, gender });
  });
  add('DELETE', '/api/pupils/:id', { auth: true }, (ctx) => {
    const p = ownPupil(ctx.user, ctx.params.id);
    tx(() => {
      db.prepare('DELETE FROM attendance WHERE pupil_id = ?').run(p.id);
      db.prepare('DELETE FROM scores WHERE pupil_id = ?').run(p.id);
      db.prepare('DELETE FROM pupils WHERE id = ?').run(p.id);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- attendance
  add('GET', '/api/classes/:id/attendance', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    const day = ctx.query.day ? validDay(ctx.query.day) : plans.today();
    const rows = db.prepare('SELECT pupil_id, status FROM attendance WHERE class_id = ? AND day = ?').all(c.id, day);
    const marks = {};
    rows.forEach((r) => { marks[r.pupil_id] = r.status; });
    return { day, marks };
  });
  add('PUT', '/api/classes/:id/attendance', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    const day = validDay(ctx.body.day);
    const marks = ctx.body.marks;
    if (!marks || typeof marks !== 'object' || Array.isArray(marks)) throw new HttpError(400, 'No attendance to save.');
    const ids = new Set(pupilsOf(c.id).map((p) => String(p.id)));
    const entries = Object.entries(marks);
    for (const [pid, st] of entries) {
      if (!ids.has(String(pid))) throw new HttpError(400, 'A pupil does not belong to this class.');
      if (!['P', 'A', 'L'].includes(st)) throw new HttpError(400, 'Attendance must be P, A or L.');
    }
    tx(() => {
      const up = db.prepare(
        'INSERT INTO attendance (pupil_id, day, class_id, user_id, status) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pupil_id, day) DO UPDATE SET status = excluded.status'
      );
      for (const [pid, st] of entries) up.run(Number(pid), day, c.id, ctx.user.id, st);
    });
    return { ok: true, saved: entries.length };
  });
  add('GET', '/api/classes/:id/attendance/summary', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    const from = ctx.query.from ? validDay(ctx.query.from, 'From date') : '0000-01-01';
    const to = ctx.query.to ? validDay(ctx.query.to, 'To date') : '9999-12-31';
    const days = db.prepare('SELECT COUNT(DISTINCT day) d FROM attendance WHERE class_id = ? AND day >= ? AND day <= ?').get(c.id, from, to).d;
    const rows = db.prepare('SELECT pupil_id, status, COUNT(*) n FROM attendance WHERE class_id = ? AND day >= ? AND day <= ? GROUP BY pupil_id, status').all(c.id, from, to);
    const by = {};
    rows.forEach((r) => { (by[r.pupil_id] = by[r.pupil_id] || { P: 0, A: 0, L: 0 })[r.status] = r.n; });
    const pupils = pupilsOf(c.id).map((p) => {
      const t = by[p.id] || { P: 0, A: 0, L: 0 };
      const total = t.P + t.A + t.L;
      return { id: p.id, name: p.name, present: t.P, absent: t.A, late: t.L, percent: total ? Math.round(((t.P + t.L) / total) * 100) : null };
    });
    return { daysRecorded: days, pupils };
  });

  // ---------------------------------------------------------------- assessments and scores
  add('GET', '/api/classes/:id/assessments', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    const rows = db.prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM scores s WHERE s.assessment_id = a.id) AS scored,
              (SELECT AVG(score) FROM scores s WHERE s.assessment_id = a.id) AS avg
       FROM assessments a WHERE a.class_id = ? ORDER BY a.day DESC, a.id DESC`
    ).all(c.id);
    return { assessments: rows.map((a) => ({ ...assessmentRow(a), scored: a.scored, average: a.avg == null ? null : Math.round(a.avg * 100) / 100 })) };
  });
  add('POST', '/api/classes/:id/assessments', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    const title = text(ctx.body.title, { name: 'Title', required: true, max: 60 });
    const max = Number(ctx.body.maxScore);
    if (!Number.isFinite(max) || max <= 0 || max > 1000) throw new HttpError(400, 'Maximum score must be a number from 1 to 1000.');
    const day = ctx.body.day ? validDay(ctx.body.day) : plans.today();
    const n = db.prepare('SELECT COUNT(*) c FROM assessments WHERE class_id = ?').get(c.id).c;
    if (n >= MAX_ASSESSMENTS) throw new HttpError(400, `A class can hold up to ${MAX_ASSESSMENTS} assessments.`, 'LIMIT');
    const info = db.prepare('INSERT INTO assessments (user_id, class_id, title, max_score, day, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ctx.user.id, c.id, title, max, day, Date.now());
    return { id: Number(info.lastInsertRowid), title, maxScore: max, day };
  });
  add('GET', '/api/assessments/:id', { auth: true }, (ctx) => {
    const a = ownAssessment(ctx.user, ctx.params.id);
    const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(a.class_id);
    const scores = {};
    db.prepare('SELECT pupil_id, score FROM scores WHERE assessment_id = ?').all(a.id).forEach((r) => { scores[r.pupil_id] = r.score; });
    return { assessment: assessmentRow(a), className: cls ? cls.name : '', pupils: pupilsOf(a.class_id), scores };
  });
  add('PUT', '/api/assessments/:id', { auth: true }, (ctx) => {
    const a = ownAssessment(ctx.user, ctx.params.id);
    const title = ctx.body.title !== undefined ? text(ctx.body.title, { name: 'Title', required: true, max: 60 }) : a.title;
    let max = a.max_score;
    if (ctx.body.maxScore !== undefined) {
      max = Number(ctx.body.maxScore);
      if (!Number.isFinite(max) || max <= 0 || max > 1000) throw new HttpError(400, 'Maximum score must be a number from 1 to 1000.');
      const over = db.prepare('SELECT COUNT(*) c FROM scores WHERE assessment_id = ? AND score > ?').get(a.id, max).c;
      if (over) throw new HttpError(400, 'Some saved scores are higher than that maximum. Fix those scores first.');
    }
    const day = ctx.body.day !== undefined ? validDay(ctx.body.day) : a.day;
    db.prepare('UPDATE assessments SET title = ?, max_score = ?, day = ? WHERE id = ?').run(title, max, day, a.id);
    return assessmentRow({ ...a, title, max_score: max, day });
  });
  add('DELETE', '/api/assessments/:id', { auth: true }, (ctx) => {
    const a = ownAssessment(ctx.user, ctx.params.id);
    tx(() => {
      db.prepare('DELETE FROM scores WHERE assessment_id = ?').run(a.id);
      db.prepare('DELETE FROM assessments WHERE id = ?').run(a.id);
    });
    return { ok: true };
  });
  add('PUT', '/api/assessments/:id/scores', { auth: true }, (ctx) => {
    const a = ownAssessment(ctx.user, ctx.params.id);
    const scores = ctx.body.scores;
    if (!scores || typeof scores !== 'object' || Array.isArray(scores)) throw new HttpError(400, 'No scores to save.');
    const ids = new Set(pupilsOf(a.class_id).map((p) => String(p.id)));
    const todo = [];
    for (const [pid, v] of Object.entries(scores)) {
      if (!ids.has(String(pid))) throw new HttpError(400, 'A pupil does not belong to this class.');
      if (v === null || v === '') todo.push([Number(pid), null]);
      else todo.push([Number(pid), scoreNumber(v, a.max_score)]);
    }
    tx(() => {
      const up = db.prepare('INSERT INTO scores (assessment_id, pupil_id, user_id, score) VALUES (?, ?, ?, ?) ON CONFLICT(assessment_id, pupil_id) DO UPDATE SET score = excluded.score');
      const del = db.prepare('DELETE FROM scores WHERE assessment_id = ? AND pupil_id = ?');
      for (const [pid, sc] of todo) { if (sc === null) del.run(a.id, pid); else up.run(a.id, pid, ctx.user.id, sc); }
    });
    return { ok: true, saved: todo.length };
  });

  // ---------------------------------------------------------------- whole-class sheet
  add('GET', '/api/classes/:id/sheet', { auth: true }, (ctx) => {
    const c = ownClass(ctx.user, ctx.params.id);
    const pupils = pupilsOf(c.id);
    const assessments = db.prepare('SELECT * FROM assessments WHERE class_id = ? ORDER BY day, id').all(c.id).map(assessmentRow);
    const scores = {};
    db.prepare('SELECT s.assessment_id, s.pupil_id, s.score FROM scores s JOIN assessments a ON a.id = s.assessment_id WHERE a.class_id = ?')
      .all(c.id).forEach((r) => { (scores[r.assessment_id] = scores[r.assessment_id] || {})[r.pupil_id] = r.score; });
    const att = {};
    db.prepare('SELECT pupil_id, status, COUNT(*) n FROM attendance WHERE class_id = ? GROUP BY pupil_id, status').all(c.id)
      .forEach((r) => { (att[r.pupil_id] = att[r.pupil_id] || { P: 0, A: 0, L: 0 })[r.status] = r.n; });
    return { class: { id: c.id, name: c.name }, pupils, assessments, scores, attendance: att };
  });
}

module.exports = { register };
