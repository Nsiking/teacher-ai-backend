'use strict';
// Tests the timetable maker, the teacher's own timetable, and the lesson plan tool.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
process.env.DATA_DIR = path.join(dir, 'unit');           // the unit tests below load the modules directly
const { DatabaseSync } = require('node:sqlite');
const T = require('../src/timetable');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = path.join(__dirname, '..');
const ADMIN = 'test-admin-key-123456';

const TYPICAL = {
  className: 'JSS 1A', days: 5, periodsPerDay: 8, startTime: '08:00', periodMinutes: 40, breaks: [{ afterPeriod: 3, minutes: 30, label: 'Break' }],
  subjects: [
    { name: 'Mathematics', perWeek: 5, core: true, teacher: 'Mr Obi' }, { name: 'English Language', perWeek: 5, core: true },
    { name: 'Basic Science', perWeek: 3 }, { name: 'Basic Technology', perWeek: 2 }, { name: 'Social Studies', perWeek: 2 }, { name: 'Civic Education', perWeek: 2 },
    { name: 'Computer Studies', perWeek: 2 }, { name: 'Agricultural Science', perWeek: 2 }, { name: 'Business Studies', perWeek: 2 },
    { name: 'Christian Religious Studies', perWeek: 2 }, { name: 'Creative Arts', perWeek: 2 }, { name: 'Physical and Health Education', perWeek: 2 },
    { name: 'Yoruba', perWeek: 2 }, { name: 'French', perWeek: 2 },
  ],
};
function stats(t) {
  const inp = t.input, D = inp.days, P = inp.periodsPerDay;
  const counts = inp.subjects.map(() => 0); let freeCount = 0;
  const problems = [];
  for (let d = 0; d < D; d++) {
    const per = {};
    for (let p = 0; p < P; p++) {
      const si = t.grid[d][p];
      if (si === undefined || si === null) { problems.push('empty cell'); continue; }
      if (si < 0) { freeCount++; continue; }
      counts[si]++; (per[si] = per[si] || []).push(p);
    }
    Object.keys(per).forEach((k) => {
      if (per[k].length > 2) problems.push('more than 2 in a day');
      if (per[k].length === 2 && per[k][1] !== per[k][0] + 1) problems.push('double not adjacent');
      if (per[k].length === 2 && inp.breaks.some((b) => b.afterPeriod === per[k][0] + 1)) problems.push('double split by a break');
    });
  }
  const loads = t.grid.map((day) => day.filter((x) => x >= 0).length);
  return { counts, freeCount, problems, loadSpread: Math.max.apply(null, loads) - Math.min.apply(null, loads) };
}

async function startServer(port, extraEnv) {
  const env = Object.assign({}, process.env, { PORT: String(port), DATA_DIR: path.join(dir, 'srv'), AI_MOCK: '1', ADMIN_KEY: ADMIN, FREE_DAILY_LIMIT: '50', FREE_MONTHLY_LIMIT: '500', GEN_PER_MINUTE: '100', AUTH_RATE_MAX: '300' }, extraEnv);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://localhost:' + port + '/health'); if (r.ok) break; } catch (e) { /* retry */ } await sleep(100); }
  return child;
}

(async () => {
  console.log('Timetable maker: rules hold for a typical JSS class over 40 different arrangements');
  let allOk = true, firstProblem = null, coreSum = 0, coreN = 0, otherSum = 0, otherN = 0, freeN = 0, freeSum = 0, freeLastTwo = 0, repeat = 0, cells = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const t = T.makeTimetable(TYPICAL, seed), s = stats(t);
    const exact = s.counts.every((c, i) => c === TYPICAL.subjects[i].perWeek);
    if (!exact || s.problems.length || s.loadSpread > 1 || s.freeCount !== 40 - 35) { allOk = false; firstProblem = firstProblem || { seed, counts: s.counts, problems: s.problems, spread: s.loadSpread, free: s.freeCount }; }
    for (let d = 0; d < 5; d++) for (let p = 0; p < 8; p++) {
      const si = t.grid[d][p];
      if (si >= 0 && TYPICAL.subjects[si].core) { coreSum += p; coreN++; } else if (si >= 0) { otherSum += p; otherN++; }
      if (si < 0) { freeN++; freeSum += p; if (p >= 6) freeLastTwo++; }
      if (d > 0 && si >= 0 && si === t.grid[d - 1][p]) repeat++; cells++;
    }
  }
  check('every subject gets exactly its periods, never more than 2 a day, doubles side by side and not split by a break, days evenly loaded', allOk, firstProblem);
  check('core subjects (Maths, English) sit early: average position ' + (coreSum / coreN).toFixed(2) + ' vs ' + (otherSum / otherN).toFixed(2) + ' for the rest', coreSum / coreN < 2.2 && coreSum / coreN < otherSum / otherN - 1.5);
  check('free periods sit at the end of the day (' + Math.round(freeLastTwo / freeN * 100) + '% in the last two periods)', freeLastTwo / freeN >= 0.9 && freeSum / freeN > 6, [freeLastTwo, freeN, freeSum / freeN]);
  check('the same subject is rarely at the same time two days running (' + Math.round(repeat / cells * 100) + '% of cells)', repeat / cells < 0.2, repeat / cells);

  console.log('Timetable maker: many different setups');
  let ok2 = true, bad = null;
  for (let i = 0; i < 80; i++) {
    const days = i % 2 ? 5 : 6, P = 4 + (i % 7);
    const subjects = []; let total = 0; const cap = days * P - (i % 5);
    for (let k = 0; k < 4 + (i % 8); k++) { const n = 1 + ((i + k * 3) % Math.min(5, 2 * days)); if (total + n <= cap) { subjects.push({ name: 'Subject ' + k, perWeek: n, core: k < 2 }); total += n; } }
    const body = { className: 'X', days, periodsPerDay: P, startTime: '07:30', periodMinutes: 35, breaks: P > 3 ? [{ afterPeriod: 2, minutes: 20 }] : [], subjects };
    const t = T.makeTimetable(body, 1000 + i), s = stats(t);
    if (!s.counts.every((c, j) => c === subjects[j].perWeek) || s.problems.some((x) => x !== 'double split by a break') || s.loadSpread > 1) { ok2 = false; bad = { i, counts: s.counts, problems: s.problems, spread: s.loadSpread }; break; }
  }
  check('80 random setups (5 or 6 days, 4 to 10 periods) always give exact counts, the 2-a-day rule and balanced days', ok2, bad);

  console.log('Timetable maker: layout and repeatability');
  const t1 = T.makeTimetable(TYPICAL, 7), t2 = T.makeTimetable(TYPICAL, 7), t3 = T.makeTimetable(TYPICAL, 8);
  check('the same seed gives the same timetable', t1.content === t2.content);
  check('a different seed gives a different arrangement', t1.content !== t3.content);
  check('header has Time and five days', /\| Time \| Monday \| Tuesday \| Wednesday \| Thursday \| Friday \|/.test(t1.content));
  check('times run correctly, with the break row (10:00 - 10:30) before the 4th period (10:30 - 11:10)', t1.content.includes('| 08:00 - 08:40 |') && t1.content.includes('| 09:20 - 10:00 |') && /\| 10:00 - 10:30 \| Break \| Break \| Break \| Break \| Break \|/.test(t1.content) && t1.content.includes('| 10:30 - 11:10 |') && t1.content.includes('| 13:10 - 13:50 |'), t1.content.split('\n').filter((l) => /^\| \d\d:/.test(l)).map((l) => l.slice(0, 22)));
  check('teacher names show in brackets and the subject list is included', t1.content.includes('Mathematics (Mr Obi)') && /\| Mathematics \| 5 \| Mr Obi \|/.test(t1.content));
  check('free periods are named and counted (5 free in a 40-slot week)', t1.content.includes('Free period') && /\| Free periods \| 5 \|/.test(t1.content));
  const six = T.makeTimetable(Object.assign({}, TYPICAL, { days: 6 }), 3);
  check('a six-day week adds Saturday', /Friday \| Saturday \|/.test(six.content) && six.stats.slots === 48 && six.stats.free === 13);

  console.log('Timetable maker: clear messages for bad input');
  const err = (mut) => { try { T.makeTimetable(Object.assign({}, TYPICAL, mut), 1); return null; } catch (e) { return e; } };
  let e = err({ subjects: TYPICAL.subjects.concat([{ name: 'Extra', perWeek: 9 }]) });
  check('too many periods: says how many too many', e && e.status === 400 && /has only 40/.test(e.message) && /Remove 4/.test(e.message), e && e.message);
  e = err({ subjects: [{ name: 'Maths', perWeek: 11 }] });
  check('more than 10 periods a week for one subject is refused', e && /between 1 and 10/.test(e.message), e && e.message);
  e = err({ days: 5, periodsPerDay: 3, breaks: [], subjects: [{ name: 'A', perWeek: 10 }, { name: 'B', perWeek: 10 }] });
  check('a week that is too small says so', e && /only 15/.test(e.message), e && e.message);
  e = err({ subjects: [{ name: 'Maths', perWeek: 2 }, { name: 'maths', perWeek: 2 }] });
  check('a subject listed twice is refused', e && /listed twice/.test(e.message), e && e.message);
  e = err({ startTime: '25:00' }); check('a wrong start time is refused', e && /Start time/.test(e.message), e && e.message);
  e = err({ breaks: [{ afterPeriod: 8, minutes: 20 }] }); check('a break after the last period is refused', e && e.status === 400, e && e.message);
  e = err({ subjects: [] }); check('no subjects is refused', e && /at least one subject/.test(e.message));
  e = err({ className: '' }); check('a missing class name is refused', e && e.status === 400);

  console.log('Server: my own timetable');
  const PORT = 4600 + Math.floor(Math.random() * 100), BASE = 'http://localhost:' + PORT;
  const call = async (method, p, body, token, admin) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (admin) headers['X-Admin-Key'] = ADMIN;
    const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (x) { /* ignore */ }
    return { status: r.status, body: j };
  };
  const child = await startServer(PORT, { TIMETABLE_MAX_SLOTS: '12' });
  try {
    let r = await call('POST', '/api/auth/signup', { name: 'Time Teacher', email: 'tt@example.com', password: 'password123' });
    const tok = r.body.token;
    r = await call('POST', '/api/auth/signup', { name: 'Other One', email: 'o1@example.com', password: 'password123' });
    const tok2 = r.body.token;
    r = await call('POST', '/api/timetable', { days: [1, 3, 5], start: '08:00', end: '08:40', subject: 'Mathematics', className: 'JSS 1', room: 'Room 4' }, tok);
    check('one period on Monday, Wednesday and Friday is created in one go', r.status === 200 && r.body.created.length === 3 && r.body.skipped.length === 0 && r.body.created[0].start === '08:00', r.body);
    const monId = r.body.created[0].id;
    r = await call('POST', '/api/timetable', { days: [1, 2], start: '08:30', end: '09:10', subject: 'English', className: 'JSS 2' }, tok);
    check('an overlapping day is skipped with the reason, the free day is created', r.status === 200 && r.body.created.length === 1 && r.body.created[0].day === 2 && r.body.skipped.length === 1 && /Overlaps Mathematics/.test(r.body.skipped[0].reason), r.body);
    r = await call('POST', '/api/timetable', { day: 1, start: '08:20', end: '08:50', subject: 'Biology' }, tok);
    check('if every day overlaps, it is refused (409)', r.status === 409 && r.body.code === 'OVERLAP', r.body);
    r = await call('POST', '/api/timetable', { day: 1, start: '08:40', end: '09:20', subject: 'Biology' }, tok);
    check('a period starting exactly when another ends is fine', r.status === 200);
    r = await call('POST', '/api/timetable', { day: 1, start: '10:00', end: '09:00', subject: 'X' }, tok);
    check('end before start is refused', r.status === 400 && /after the start/.test(r.body.error));
    r = await call('POST', '/api/timetable', { day: 9, start: '10:00', end: '11:00', subject: 'X' }, tok);
    check('a wrong day is refused', r.status === 400);
    r = await call('POST', '/api/timetable', { day: 1, start: '10:00', end: '11:00', subject: '' }, tok);
    check('a missing subject is refused', r.status === 400);
    r = await call('PUT', '/api/timetable/' + monId, { start: '13:00', end: '13:40', subject: 'Mathematics', className: 'JSS 1' }, tok);
    check('a period can be moved', r.status === 200 && r.body.start === '13:00');
    r = await call('PUT', '/api/timetable/' + monId, { start: '08:30', end: '09:10', subject: 'Mathematics' }, tok);
    check('moving onto another period is refused', r.status === 409);
    r = await call('PUT', '/api/timetable/' + monId, { start: '08:00', end: '08:40', subject: 'Mathematics', className: 'JSS 1' }, tok);
    check('and it can be moved back', r.status === 200 && r.body.start === '08:00');
    r = await call('GET', '/api/timetable', null, tok);
    check('the list comes back in day and time order', r.status === 200 && r.body.slots.length === 5 && r.body.slots.every((s, i, a) => i === 0 || a[i - 1].day < s.day || (a[i - 1].day === s.day && a[i - 1].start <= s.start)), r.body.slots.map((x) => x.day + x.start));
    r = await call('GET', '/api/timetable', null, tok2);
    check('another teacher sees nothing of mine', r.body.slots.length === 0);
    r = await call('PUT', '/api/timetable/' + monId, { start: '09:00', end: '09:40', subject: 'Hacked' }, tok2);
    check('another teacher cannot edit mine', r.status === 404);
    r = await call('DELETE', '/api/timetable/' + monId, null, tok2);
    check('another teacher cannot delete mine', r.status === 404);
    r = await call('POST', '/api/timetable', { days: [1, 2, 3, 4, 5, 6, 7], start: '14:00', end: '14:40', subject: 'Club' }, tok);
    check('7 more fit up to the limit (12 in this test)', r.status === 200 && r.body.created.length === 7, r.body);
    r = await call('POST', '/api/timetable', { day: 1, start: '15:00', end: '15:40', subject: 'One more' }, tok);
    check('one more than the limit is refused', r.status === 400 && r.body.code === 'LIMIT', r.body);
    r = await call('DELETE', '/api/timetable/' + monId, null, tok);
    check('a period can be deleted', r.status === 200);

    console.log('Server: the class timetable maker');
    r = await call('GET', '/api/me', null, tok);
    const usedBefore = r.body.usage.used;
    r = await call('POST', '/api/timetable/make', Object.assign({ seed: 42 }, TYPICAL), tok);
    check('it makes a timetable and saves it to the library', r.status === 200 && r.body.kind === 'timetable' && r.body.id && r.body.seed === 42 && r.body.stats.free === 5 && /# TIMETABLE/.test(r.body.content), r.body);
    const ttId = r.body.id, first = r.body.content;
    r = await call('GET', '/api/me', null, tok);
    check('it is free: no generation used up', r.body.usage.used === usedBefore, [usedBefore, r.body.usage.used]);
    r = await call('GET', '/api/library/' + ttId, null, tok);
    check('the saved timetable remembers its settings and seed', r.status === 200 && r.body.kind === 'timetable' && r.body.meta.seed === 42 && r.body.meta.subjects.length === 14 && r.body.meta.className === 'JSS 1A', r.body.meta);
    r = await call('POST', '/api/timetable/make', Object.assign({}, r.body.meta, { seed: 42 }), tok);
    check('the saved settings make the same timetable again (same seed)', r.status === 200 && r.body.content === first);
    r = await call('POST', '/api/timetable/make', Object.assign({}, TYPICAL, { seed: 43 }), tok);
    check('another seed makes another arrangement', r.status === 200 && r.body.content !== first);
    r = await call('POST', '/api/timetable/make', Object.assign({}, TYPICAL, { subjects: TYPICAL.subjects.concat([{ name: 'Extra', perWeek: 9 }]) }), tok);
    check('bad input gives a clear message over the web too', r.status === 400 && r.body.code === 'TOO_MANY_PERIODS' && /Remove 4/.test(r.body.error), r.body);

    console.log('Server: lesson plan');
    r = await call('POST', '/api/textbooks', { title: 'Test Mathematics for JSS 1', authors: 'A. Writer and B. Author', publisher: 'Sample Press', edition: '3rd Edition', year: '2019', subject: 'Mathematics', levels: ['JSS 1'], contents: 'Chapter 2 | Fractions | pp. 21-45' }, tok);
    const bookId = r.body.id;
    r = await call('GET', '/api/me', null, tok);
    const u0 = r.body.usage.used;
    r = await call('POST', '/api/generate/lesson-plan', { subject: 'Mathematics', className: 'JSS 1', topic: 'Fractions', duration: 40, textbookIds: [bookId] }, tok);
    check('a lesson plan is made, saved as its own kind, with the exact book citation', r.status === 200 && r.body.kind === 'lesson_plan' && /# LESSON PLAN/.test(r.body.content) && r.body.content.includes('*Test Mathematics for JSS 1*, A. Writer and B. Author (Sample Press, 3rd Edition, 2019)') && !/\[BOOK1\]/.test(r.body.content), r.body.content);
    check('it uses one generation like the other AI tools', r.body.usage.used === u0 + 1, r.body.usage);
    r = await call('POST', '/api/generate/lesson-plan', { subject: 'English', className: 'Primary 4', topic: 'Nouns' }, tok);
    check('a lesson plan works without a textbook', r.status === 200 && r.body.title === 'English lesson plan: Nouns (Primary 4)');
    r = await call('POST', '/api/generate/lesson-plan', { subject: 'English' }, tok);
    check('missing details are refused', r.status === 400);
    r = await call('GET', '/api/library?kind=lesson_plan', null, tok);
    check('lesson plans appear in the library', r.status === 200 && r.body.items.length === 2 && r.body.items.every((x) => x.kind === 'lesson_plan'), r.body.items.map((x) => x.kind));
    r = await call('GET', '/api/meta');
    check('lesson-plan is listed as a tool', r.body.kinds.includes('lesson-plan'));

    console.log('Deleting an account removes the timetable too');
    const db = new DatabaseSync(path.join(dir, 'srv', 'teacher.db'));
    const before = db.prepare('SELECT COUNT(*) c FROM timetable_slots').get().c;
    r = await call('DELETE', '/api/me', { password: 'password123' }, tok);
    const after = db.prepare('SELECT COUNT(*) c FROM timetable_slots').get().c;
    db.close();
    check('account deleted and its timetable periods removed', r.status === 200 && before === 11 && after === 0, { before, after });
  } catch (x) {
    fail++; console.log('  ERROR', x);
  }
  child.kill();
  await sleep(300);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (x) { /* ignore */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
