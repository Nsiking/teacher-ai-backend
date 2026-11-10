'use strict';
// Timetables: (1) the teacher's own weekly periods, (2) a class timetable maker (no AI, so it costs nothing).
const { db } = require('./db');
const { HttpError, text, int } = require('./util');
const plans = require('./plans');

const MAX_SLOTS = parseInt(process.env.TIMETABLE_MAX_SLOTS, 10) || 80;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function parseTime(s, name) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s === undefined || s === null ? '' : s).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new HttpError(400, `${name || 'Time'} must look like 08:30.`);
  return Number(m[1]) * 60 + Number(m[2]);
}
function fmt(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function clean(v, name, max, required) { return text(v, { name, required, max }).replace(/[|*\[\]]/g, '').replace(/\s+/g, ' ').trim(); }

// ---------------------------------------------------------------- the teacher's own timetable
function slotRow(r) { return { id: r.id, day: r.day, start: fmt(r.start_min), end: fmt(r.end_min), subject: r.subject, className: r.class_name, room: r.room }; }
function slotFields(b) {
  const start = parseTime(b.start, 'Start time'), end = parseTime(b.end, 'End time');
  if (end <= start) throw new HttpError(400, 'The end time must be after the start time.');
  return { start, end, subject: clean(b.subject, 'Subject', 40, true), className: clean(b.className, 'Class', 30, false), room: clean(b.room, 'Room', 20, false) };
}
function conflict(userId, day, start, end, exceptId) {
  return db.prepare('SELECT * FROM timetable_slots WHERE user_id = ? AND day = ? AND start_min < ? AND end_min > ? AND id != ?').get(userId, day, end, start, exceptId || 0);
}

// ---------------------------------------------------------------- the class timetable maker
function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function shuffle(arr, rnd) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; }

function normalizeInput(b) {
  const className = clean(b.className, 'Class', 30, true);
  const days = int(b.days, { name: 'School days', min: 5, max: 6, def: 5 });
  const periodsPerDay = int(b.periodsPerDay, { name: 'Periods a day', min: 3, max: 10, def: 8 });
  const startMin = parseTime(b.startTime || '08:00', 'Start time');
  const periodMinutes = int(b.periodMinutes, { name: 'Period length', min: 20, max: 90, def: 40 });
  let breaks = Array.isArray(b.breaks) ? b.breaks : [];
  if (breaks.length > 3) throw new HttpError(400, 'Up to 3 breaks.');
  const seen = new Set();
  breaks = breaks.map((x) => {
    const afterPeriod = int(x && x.afterPeriod, { name: 'Break after period', min: 1, max: periodsPerDay - 1, def: null });
    if (afterPeriod === null) throw new HttpError(400, 'Each break needs the period it comes after.');
    if (seen.has(afterPeriod)) throw new HttpError(400, 'Two breaks cannot come after the same period.');
    seen.add(afterPeriod);
    return { afterPeriod, minutes: int(x.minutes, { name: 'Break length', min: 5, max: 90, def: 20 }), label: clean(x.label, 'Break name', 20, false) || 'Break' };
  }).sort((a, b2) => a.afterPeriod - b2.afterPeriod);
  if (!Array.isArray(b.subjects) || !b.subjects.length) throw new HttpError(400, 'Add at least one subject.');
  if (b.subjects.length > 20) throw new HttpError(400, 'Up to 20 subjects.');
  const names = new Set();
  const subjects = b.subjects.map((x, i) => {
    if (!x || typeof x !== 'object') throw new HttpError(400, `Subject ${i + 1} is not valid.`);
    const name = clean(x.name, `Subject ${i + 1} name`, 40, true);
    if (names.has(name.toLowerCase())) throw new HttpError(400, `${name} is listed twice.`);
    names.add(name.toLowerCase());
    const perWeek = int(x.perWeek, { name: `${name}: periods a week`, min: 1, max: 10, def: null });
    if (perWeek === null) throw new HttpError(400, `${name} needs its number of periods a week.`);
    if (perWeek > 2 * days) throw new HttpError(400, `${name} has ${perWeek} periods but a subject can have at most 2 a day (${2 * days} a week).`);
    return { name, perWeek, teacher: clean(x.teacher, `${name}: teacher`, 40, false), core: x.core === true };
  });
  const total = subjects.reduce((t, s) => t + s.perWeek, 0), slots = days * periodsPerDay;
  if (total > slots) throw new HttpError(400, `You asked for ${total} periods but the week has only ${slots} (${days} days x ${periodsPerDay} periods). Remove ${total - slots} or add periods.`, 'TOO_MANY_PERIODS');
  return { className, days, periodsPerDay, startMin, periodMinutes, breaks, subjects, total, slots };
}

// Spreads every subject across the days, then orders each day: core subjects early, free periods last,
// doubles never split by a break, and the same subject is not at the same time two days running.
function arrange(inp, seed) {
  const rnd = mulberry32(seed);
  const D = inp.days, P = inp.periodsPerDay;
  const dayLoad = new Array(D).fill(0);
  const dayCounts = Array.from({ length: D }, () => ({}));
  const order = inp.subjects.map((s, i) => i).sort((a, b) => inp.subjects[b].perWeek - inp.subjects[a].perWeek || rnd() - 0.5);
  for (const si of order) {
    const n = inp.subjects[si].perWeek, base = Math.floor(n / D), extra = n % D;
    for (let d = 0; d < D; d++) { dayCounts[d][si] = base; dayLoad[d] += base; }
    const cand = shuffle(Array.from({ length: D }, (_, i) => i), rnd).sort((a, b) => dayLoad[a] - dayLoad[b]);
    for (let k = 0; k < extra; k++) { dayCounts[cand[k]][si] += 1; dayLoad[cand[k]] += 1; }
  }
  const breaksAfter = new Set(inp.breaks.map((x) => x.afterPeriod));
  const grid = [];
  let prev = null;
  for (let d = 0; d < D; d++) {
    const blocks = [];
    Object.keys(dayCounts[d]).forEach((k) => { const c = dayCounts[d][k]; if (c >= 2) blocks.push({ si: Number(k), size: 2 }); else if (c === 1) blocks.push({ si: Number(k), size: 1 }); });
    for (let i = 0; i < P - dayLoad[d]; i++) blocks.push({ si: -1, size: 1 });
    let best = null, bestScore = Infinity;
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (let t = 0; t < 400; t++) {
        const ord = shuffle(blocks.slice(), rnd);
        let pos = 0, ok = true;
        const arr = [];
        for (const blk of ord) {
          if (pass === 0 && blk.size === 2 && breaksAfter.has(pos + 1)) { ok = false; break; }
          for (let k = 0; k < blk.size; k++) arr.push(blk.si);
          pos += blk.size;
        }
        if (!ok) continue;
        let score = 0;
        for (let p = 0; p < P; p++) {
          const si = arr[p];
          if (si >= 0 && inp.subjects[si].core) score += p * 3;
          if (si < 0) score += (P - 1 - p) * 2;
          if (prev && si >= 0 && si === prev[p]) score += 4;
        }
        if (score < bestScore) { bestScore = score; best = arr; }
      }
    }
    grid.push(best);
    prev = best;
  }
  return grid;
}

function makeTimetable(body, seedIn) {
  const inp = normalizeInput(body);
  const seed = Number.isInteger(seedIn) ? seedIn : Math.floor(Math.random() * 2147483647);
  const grid = arrange(inp, seed);
  const D = inp.days, P = inp.periodsPerDay;
  const cell = (si) => si < 0 ? 'Free period' : inp.subjects[si].name + (inp.subjects[si].teacher ? ' (' + inp.subjects[si].teacher + ')' : '');
  const header = '| Time | ' + DAY_NAMES.slice(0, D).join(' | ') + ' |\n|---|' + '---|'.repeat(D);
  const rows = [];
  let t = inp.startMin;
  for (let p = 0; p < P; p++) {
    rows.push('| ' + fmt(t) + ' - ' + fmt(t + inp.periodMinutes) + ' | ' + grid.map((day) => cell(day[p])).join(' | ') + ' |');
    t += inp.periodMinutes;
    const br = inp.breaks.find((x) => x.afterPeriod === p + 1);
    if (br) { rows.push('| ' + fmt(t) + ' - ' + fmt(t + br.minutes) + ' | ' + new Array(D).fill(br.label).join(' | ') + ' |'); t += br.minutes; }
  }
  const free = inp.slots - inp.total;
  const subj = inp.subjects.map((s) => '| ' + s.name + ' | ' + s.perWeek + ' | ' + (s.teacher || '') + ' |').join('\n');
  const content =
    '# TIMETABLE\n\n| Item | Details |\n|---|---|\n| Class | ' + inp.className + ' |\n| School days | ' + DAY_NAMES[0] + ' to ' + DAY_NAMES[D - 1] + ' |\n| Periods | ' + P + ' a day, ' + inp.periodMinutes + ' minutes each, starting at ' + fmt(inp.startMin) + ' |\n' +
    '| Free periods | ' + free + ' |\n\n## Timetable\n\n' + header + '\n' + rows.join('\n') + '\n\n## Subjects\n\n| Subject | Periods a week | Teacher |\n|---|---|---|\n' + subj + '\n\n' +
    '*Check this timetable against your school\'s arrangements. Use Edit to change any cell.*';
  return { content, grid, seed, stats: { total: inp.total, slots: inp.slots, free }, input: inp };
}

// ---------------------------------------------------------------- routes
function register(add, helpers) {
  helpers = helpers || {};
  add('GET', '/api/timetable', { auth: true }, (ctx) => {
    const rows = db.prepare('SELECT * FROM timetable_slots WHERE user_id = ? ORDER BY day, start_min').all(ctx.user.id);
    return { slots: rows.map(slotRow), max: MAX_SLOTS };
  });
  add('POST', '/api/timetable', { auth: true }, (ctx) => {
    const f = slotFields(ctx.body);
    let days = Array.isArray(ctx.body.days) ? ctx.body.days : [ctx.body.day];
    days = Array.from(new Set(days.map(Number)));
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw new HttpError(400, 'Choose at least one day.');
    const have = db.prepare('SELECT COUNT(*) c FROM timetable_slots WHERE user_id = ?').get(ctx.user.id).c;
    if (have + days.length > MAX_SLOTS) throw new HttpError(400, `You can keep up to ${MAX_SLOTS} periods in your timetable.`, 'LIMIT');
    const created = [], skipped = [];
    const ins = db.prepare('INSERT INTO timetable_slots (user_id, day, start_min, end_min, subject, class_name, room, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const d of days) {
      const c = conflict(ctx.user.id, d, f.start, f.end);
      if (c) { skipped.push({ day: d, reason: `Overlaps ${c.subject} (${fmt(c.start_min)} to ${fmt(c.end_min)}) on ${DAY_NAMES[d - 1]}.` }); continue; }
      const info = ins.run(ctx.user.id, d, f.start, f.end, f.subject, f.className, f.room, Date.now());
      created.push(slotRow(db.prepare('SELECT * FROM timetable_slots WHERE id = ?').get(Number(info.lastInsertRowid))));
    }
    if (!created.length) throw new HttpError(409, skipped[0].reason, 'OVERLAP');
    return { created, skipped };
  });
  add('PUT', '/api/timetable/:id', { auth: true }, (ctx) => {
    const r = db.prepare('SELECT * FROM timetable_slots WHERE id = ? AND user_id = ?').get(Number(ctx.params.id), ctx.user.id);
    if (!r) throw new HttpError(404, 'Period not found.');
    const f = slotFields(ctx.body);
    const day = ctx.body.day === undefined ? r.day : Number(ctx.body.day);
    if (!Number.isInteger(day) || day < 1 || day > 7) throw new HttpError(400, 'Choose a day.');
    const c = conflict(ctx.user.id, day, f.start, f.end, r.id);
    if (c) throw new HttpError(409, `Overlaps ${c.subject} (${fmt(c.start_min)} to ${fmt(c.end_min)}) on ${DAY_NAMES[day - 1]}.`, 'OVERLAP');
    db.prepare('UPDATE timetable_slots SET day = ?, start_min = ?, end_min = ?, subject = ?, class_name = ?, room = ? WHERE id = ?').run(day, f.start, f.end, f.subject, f.className, f.room, r.id);
    return slotRow(db.prepare('SELECT * FROM timetable_slots WHERE id = ?').get(r.id));
  });
  add('DELETE', '/api/timetable/:id', { auth: true }, (ctx) => {
    const info = db.prepare('DELETE FROM timetable_slots WHERE id = ? AND user_id = ?').run(Number(ctx.params.id), ctx.user.id);
    if (!info.changes) throw new HttpError(404, 'Period not found.');
    return { ok: true };
  });
  add('DELETE', '/api/timetable', { auth: true }, (ctx) => {
    const info = db.prepare('DELETE FROM timetable_slots WHERE user_id = ?').run(ctx.user.id);
    return { ok: true, removed: info.changes };
  });

  // Make a class timetable. No AI is used, so it does not count against the daily limit. It is saved to the library.
  add('POST', '/api/timetable/make', { auth: true }, (ctx) => {
    if (helpers.rateLimit) helpers.rateLimit('tt:' + ctx.user.id, 30, 60 * 1000);
    const seed = ctx.body.seed === undefined || ctx.body.seed === null ? undefined : Number(ctx.body.seed);
    let t = makeTimetable(ctx.body, Number.isInteger(seed) ? seed : undefined);
    // "Another arrangement": keep trying until it really differs from the one on screen (a small timetable can repeat by chance)
    let sameAsBefore = false;
    if (ctx.body.differentFrom !== undefined && ctx.body.differentFrom !== null) {
      const prev = db.prepare("SELECT content FROM items WHERE id = ? AND user_id = ? AND kind = 'timetable'").get(Number(ctx.body.differentFrom), ctx.user.id);
      if (prev) {
        for (let i = 0; i < 40 && t.content === prev.content; i++) t = makeTimetable(ctx.body, undefined);
        sameAsBefore = t.content === prev.content;
      }
    }
    const now = Date.now();
    const title = 'Timetable: ' + t.input.className;
    const meta = {
      className: t.input.className, days: t.input.days, periodsPerDay: t.input.periodsPerDay, startTime: fmt(t.input.startMin), periodMinutes: t.input.periodMinutes,
      breaks: t.input.breaks, subjects: t.input.subjects, seed: t.seed,
    };
    const info = db.prepare('INSERT INTO items (user_id, kind, title, meta, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctx.user.id, 'timetable', title, JSON.stringify(meta), t.content, now, now);
    return { id: Number(info.lastInsertRowid), kind: 'timetable', title, content: t.content, stats: t.stats, seed: t.seed, sameAsBefore };
  });
}

module.exports = { register, makeTimetable, normalizeInput, arrange, parseTime, fmt, DAY_NAMES };
