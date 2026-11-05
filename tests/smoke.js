'use strict';
// Starts the server in TEST MODE (fake AI) on a temporary database and checks every main feature.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { DatabaseSync } = require('node:sqlite');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teacher-ai-'));
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'test-admin-key-123456';
let pass = 0, fail = 0;

function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
async function call(method, p, body, token, admin) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = ADMIN;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

(async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, AI_MOCK: '1', ADMIN_KEY: ADMIN, FREE_DAILY_LIMIT: '3', PAID_DAILY_LIMIT: '9', GEN_PER_MINUTE: '60', AUTH_RATE_MAX: '200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    console.log('Basics');
    let r = await call('GET', '/health');
    check('health ok', r.status === 200 && r.body.ok === true);
    r = await call('GET', '/api/meta');
    check('meta lists classes', r.status === 200 && r.body.classes.includes('JSS 2'));

    console.log('Accounts');
    r = await call('POST', '/api/auth/signup', { name: 'Mrs Ade', phone: '08031234567', password: 'short' });
    check('short password rejected', r.status === 400);
    r = await call('POST', '/api/auth/signup', { name: 'Mrs Ade', phone: '12345', password: 'goodpass123' });
    check('bad phone rejected', r.status === 400);
    r = await call('POST', '/api/auth/signup', { name: 'Mrs Ade', phone: '0803 123 4567', email: 'Ade@Example.com', password: 'goodpass123' });
    check('signup works', r.status === 200 && r.body.token && r.body.user.phone === '+2348031234567' && r.body.user.email === 'ade@example.com', r.body);
    const token = r.body.token;
    r = await call('POST', '/api/auth/signup', { name: 'Other', phone: '+2348031234567', password: 'goodpass123' });
    check('duplicate phone rejected', r.status === 409);
    r = await call('POST', '/api/auth/login', { identifier: '08031234567', password: 'wrongpass' });
    check('wrong password rejected', r.status === 401);
    r = await call('POST', '/api/auth/login', { identifier: 'ADE@example.com', password: 'goodpass123' });
    check('login by email works', r.status === 200 && r.body.token);
    r = await call('POST', '/api/auth/login', { identifier: '2348031234567', password: 'goodpass123' });
    check('login by phone (234 format) works', r.status === 200);
    r = await call('GET', '/api/me');
    check('me needs login', r.status === 401);
    r = await call('GET', '/api/me', null, token);
    check('me works', r.status === 200 && r.body.user.plan === 'free' && r.body.usage.limit === 3 && r.body.usage.used === 0, r.body);

    console.log('Generation');
    r = await call('POST', '/api/generate/lesson-note', { subject: 'Mathematics' }, token);
    check('missing fields rejected', r.status === 400);
    r = await call('POST', '/api/generate/lesson-note', { subject: 'Mathematics', className: 'JSS 2', topic: 'Algebraic Expressions', duration: 40 }, token);
    check('lesson note generated + saved', r.status === 200 && r.body.id && r.body.content.includes('LESSON NOTE') && r.body.usage.used === 1, r.body);
    const noteId = r.body.id;
    r = await call('POST', '/api/generate/questions', { subject: 'English', className: 'SS 1', topic: 'Tenses', type: 'mixed', objectiveCount: 10, theoryCount: 2 }, token);
    check('questions generated', r.status === 200 && r.body.kind === 'questions');
    r = await call('POST', '/api/generate/worksheet', { subject: 'Basic Science', className: 'Primary 4', topic: 'Living things' }, token);
    check('worksheet generated', r.status === 200 && r.body.kind === 'worksheet');
    r = await call('POST', '/api/generate/lesson-note', { subject: 'Civic', className: 'SS 2', topic: 'Democracy' }, token);
    check('free limit blocks 4th generation', r.status === 429 && r.body.code === 'LIMIT_REACHED', r.body);
    r = await call('GET', '/api/me', null, token);
    check('usage shows 3 of 3', r.body.usage.used === 3);

    console.log('Report comments (free plan max 5 pupils)');
    r = await call('POST', '/api/generate/report-comments', { className: 'Primary 5', pupils: Array.from({ length: 6 }, (_, i) => ({ name: 'P' + i })) }, token);
    check('6 pupils blocked on free plan', r.status === 400 && r.body.code === 'TOO_MANY_PUPILS', r.body);

    console.log('Admin: upgrade the user');
    r = await call('GET', '/api/admin/stats');
    check('admin needs key', r.status === 403);
    r = await call('POST', '/api/admin/set-plan', { identifier: '08031234567', plan: 'monthly', days: 30 }, null, true);
    check('set plan monthly', r.status === 200 && r.body.user.plan === 'monthly' && r.body.user.planExpiresAt > Date.now(), r.body);
    r = await call('GET', '/api/me', null, token);
    check('limit is now paid limit (9), used 3', r.body.user.plan === 'monthly' && r.body.usage.limit === 9 && r.body.usage.used === 3, r.body);

    r = await call('POST', '/api/generate/report-comments', {
      className: 'Primary 5', term: 'First Term', tone: 'encouraging',
      pupils: [{ name: 'Chidi Obi', gender: 'M', scores: 'Maths 80, English 55' }, { name: 'Amina Bello', gender: 'F', notes: 'very neat' }],
    }, token);
    check('report comments generated for 2 pupils', r.status === 200 && Array.isArray(r.body.comments) && r.body.comments.length === 2 && r.body.comments[0].name === 'Chidi Obi', r.body);

    console.log('Scheme of work');
    r = await call('POST', '/api/generate/scheme-of-work', { subject: 'Mathematics', className: 'Primary 5', term: 'First Term', weeks: 20 }, token);
    check('weeks out of range rejected (and no credit used)', r.status === 400, r.body);
    r = await call('POST', '/api/generate/scheme-of-work', { subject: 'Mathematics', className: 'Primary 5' }, token);
    check('term is required', r.status === 400, r.body);
    r = await call('POST', '/api/generate/scheme-of-work', { subject: 'Mathematics', className: 'Primary 5', term: 'First Term', weeks: 12, periodsPerWeek: 5, topics: 'Whole numbers\nFractions\nLCM and HCF' }, token);
    check('scheme of work generated (12 week rows)', r.status === 200 && r.body.kind === 'scheme_of_work' && (r.body.content.match(/^\| \d+ \|/gm) || []).length === 12, r.body);

    console.log('Marking assistant');
    const mk = { subject: 'English', className: 'JSS 1', question: 'Define a noun.', totalMarks: 10 };
    r = await call('POST', '/api/generate/marking', { ...mk, answers: [] }, token);
    check('marking needs at least one answer', r.status === 400);
    r = await call('POST', '/api/generate/marking', { ...mk, answers: Array.from({ length: 16 }, (_, i) => ({ name: 'S' + i, answer: 'x' })) }, token);
    check('paid plan: 16 answers blocked (max 15)', r.status === 400 && r.body.code === 'TOO_MANY_ANSWERS', r.body);
    r = await call('POST', '/api/generate/marking', { ...mk, style: 'harsh', answers: [{ name: 'A', answer: 'x' }] }, token);
    check('bad marking style rejected', r.status === 400);
    r = await call('POST', '/api/generate/marking', { ...mk, answers: [{ name: 'Chidi Obi', answer: 'A noun is a naming word.' }, { answer: 'A person, place or thing.' }] }, token);
    check('marking works: 2 results, scores within 0-10, average line, default name', r.status === 200 && r.body.kind === 'marking' && r.body.results.length === 2 && r.body.results.every((x) => x.score >= 0 && x.score <= 10) && r.body.content.includes('**Class average:**') && r.body.results[1].name === 'Student 2', r.body);

    console.log('Library');
    r = await call('GET', '/api/library', null, token);
    check('library lists 6 items', r.status === 200 && r.body.items.length === 6, r.body);
    r = await call('GET', '/api/library/' + noteId, null, token);
    check('open item', r.status === 200 && r.body.content.includes('LESSON NOTE'));
    r = await call('PUT', '/api/library/' + noteId, { title: 'My edited title', content: 'Edited note text' }, token);
    check('edit item', r.status === 200 && r.body.title === 'My edited title' && r.body.content === 'Edited note text');

    console.log('Classroom: classes and pupils');
    r = await call('POST', '/api/classes', { name: 'JSS 2A' }, token);
    check('class created', r.status === 200 && r.body.id, r.body);
    const classId = r.body.id;
    r = await call('POST', '/api/classes', { name: 'jss 2a' }, token);
    check('duplicate class name rejected', r.status === 409);
    r = await call('POST', `/api/classes/${classId}/pupils`, { names: '1. Chidi Obi\nAmina Bello\n\n  \nTunde Ade' }, token);
    check('3 pupils added (numbering and blank lines cleaned)', r.status === 200 && r.body.added === 3 && r.body.pupils[0].name === 'Chidi Obi', r.body);
    const [p1, p2, p3] = r.body.pupils.map((p) => p.id);
    r = await call('POST', `/api/classes/${classId}/pupils`, { pupils: [{ name: 'Ngozi Eze', gender: 'F' }] }, token);
    check('pupil with gender added', r.status === 200 && r.body.pupils[3].gender === 'girl', r.body);
    const p4 = r.body.pupils[3].id;
    r = await call('PUT', `/api/pupils/${p4}`, { name: 'Ngozi Eze-Obi' }, token);
    check('rename pupil', r.status === 200 && r.body.name === 'Ngozi Eze-Obi' && r.body.gender === 'girl');
    r = await call('DELETE', `/api/pupils/${p4}`, null, token);
    check('delete pupil', r.status === 200);
    r = await call('POST', `/api/classes/${classId}/pupils`, { names: Array.from({ length: 78 }, (_, i) => 'P' + i).join('\n') }, token);
    check('over 80 pupils blocked', r.status === 400 && r.body.code === 'LIMIT', r.body);

    console.log('Classroom: attendance');
    r = await call('PUT', `/api/classes/${classId}/attendance`, { day: '2026-11-02', marks: { [p1]: 'P', [p2]: 'A', [p3]: 'L' } }, token);
    check('attendance saved', r.status === 200 && r.body.saved === 3, r.body);
    r = await call('PUT', `/api/classes/${classId}/attendance`, { day: '2026-11-02', marks: { [p1]: 'X' } }, token);
    check('bad status rejected', r.status === 400);
    r = await call('PUT', `/api/classes/${classId}/attendance`, { day: '2026-13-45', marks: { [p1]: 'P' } }, token);
    check('bad date rejected', r.status === 400);
    r = await call('PUT', `/api/classes/${classId}/attendance`, { day: '2026-11-02', marks: { 999999: 'P' } }, token);
    check('pupil from elsewhere rejected', r.status === 400);
    r = await call('PUT', `/api/classes/${classId}/attendance`, { day: '2026-11-02', marks: { [p2]: 'P' } }, token);
    check('attendance can be corrected (upsert)', r.status === 200);
    r = await call('GET', `/api/classes/${classId}/attendance?day=2026-11-02`, null, token);
    check('attendance read back', r.status === 200 && r.body.marks[p1] === 'P' && r.body.marks[p2] === 'P' && r.body.marks[p3] === 'L', r.body);
    await call('PUT', `/api/classes/${classId}/attendance`, { day: '2026-11-03', marks: { [p1]: 'A', [p2]: 'P' } }, token);
    r = await call('GET', `/api/classes/${classId}/attendance/summary`, null, token);
    const sm = r.body.pupils || [];
    check('summary: 2 days; Chidi 1P 1A 50%; Amina 100%; Tunde 1 late 100%',
      r.status === 200 && r.body.daysRecorded === 2 && sm[0].present === 1 && sm[0].absent === 1 && sm[0].percent === 50 && sm[1].percent === 100 && sm[2].late === 1 && sm[2].percent === 100, r.body);
    r = await call('GET', `/api/classes/${classId}/attendance/summary?from=2026-11-03&to=2026-11-03`, null, token);
    check('summary date range works', r.status === 200 && r.body.daysRecorded === 1 && r.body.pupils[0].absent === 1, r.body);

    console.log('Classroom: assessments and scores');
    r = await call('POST', `/api/classes/${classId}/assessments`, { title: 'CA1 Maths', maxScore: 0 }, token);
    check('zero max score rejected', r.status === 400);
    r = await call('POST', `/api/classes/${classId}/assessments`, { title: 'CA1 Maths', maxScore: 20, day: '2026-11-03' }, token);
    check('assessment created', r.status === 200 && r.body.id, r.body);
    const aId = r.body.id;
    r = await call('PUT', `/api/assessments/${aId}/scores`, { scores: { [p1]: 25 } }, token);
    check('score above maximum rejected', r.status === 400);
    r = await call('PUT', `/api/assessments/${aId}/scores`, { scores: { [p1]: 15, [p2]: '18', [p3]: '' } }, token);
    check('scores saved (text number accepted, blank skipped)', r.status === 200, r.body);
    r = await call('GET', `/api/assessments/${aId}`, null, token);
    check('scores read back', r.status === 200 && r.body.scores[p1] === 15 && r.body.scores[p2] === 18 && r.body.scores[p3] === undefined && r.body.pupils.length === 3, r.body);
    r = await call('GET', `/api/classes/${classId}/assessments`, null, token);
    check('assessment list shows average 16.5 of 2 scored', r.status === 200 && r.body.assessments[0].average === 16.5 && r.body.assessments[0].scored === 2, r.body);
    r = await call('PUT', `/api/assessments/${aId}`, { maxScore: 10 }, token);
    check('cannot lower maximum below saved scores', r.status === 400);
    r = await call('PUT', `/api/assessments/${aId}`, { title: 'CA1 Mathematics' }, token);
    check('rename assessment', r.status === 200 && r.body.title === 'CA1 Mathematics');
    r = await call('GET', `/api/classes/${classId}/sheet`, null, token);
    check('sheet has pupils, assessments, scores and attendance', r.status === 200 && r.body.pupils.length === 3 && r.body.assessments.length === 1 && r.body.scores[aId][p1] === 15 && r.body.attendance[p1].P === 1, r.body);
    r = await call('DELETE', `/api/pupils/${p3}`, null, token);
    r = await call('GET', `/api/classes/${classId}/attendance/summary`, null, token);
    check('removing a pupil removes their records', r.body.pupils.length === 2);
    for (let i = 1; i <= 9; i++) await call('POST', '/api/classes', { name: 'Extra ' + i }, token);
    r = await call('POST', '/api/classes', { name: 'One too many' }, token);
    check('11th class blocked (max 10)', r.status === 400 && r.body.code === 'LIMIT', r.body);

    console.log('Privacy between users');
    r = await call('POST', '/api/auth/signup', { name: 'Mr Okon', email: 'okon@example.com', password: 'anotherpass1' });
    const token2 = r.body.token;
    r = await call('GET', `/api/classes/${classId}`, null, token2);
    check('other user cannot open my class', r.status === 404);
    r = await call('PUT', `/api/classes/${classId}/attendance`, { day: '2026-11-02', marks: { [p1]: 'A' } }, token2);
    check('other user cannot change my attendance', r.status === 404);
    r = await call('GET', `/api/assessments/${aId}`, null, token2);
    check('other user cannot open my assessment', r.status === 404);
    r = await call('PUT', `/api/assessments/${aId}/scores`, { scores: { [p1]: 1 } }, token2);
    check('other user cannot change my scores', r.status === 404);
    r = await call('DELETE', `/api/pupils/${p1}`, null, token2);
    check('other user cannot delete my pupil', r.status === 404);
    r = await call('GET', '/api/classes', null, token2);
    check('other user sees no classes', r.status === 200 && r.body.classes.length === 0);
    r = await call('POST', '/api/generate/marking', { ...mk, answers: Array.from({ length: 4 }, (_, i) => ({ name: 'S' + i, answer: 'x' })) }, token2);
    check('free plan: 4 answers blocked (max 3)', r.status === 400 && r.body.code === 'TOO_MANY_ANSWERS', r.body);
    r = await call('GET', '/api/library/' + noteId, null, token2);
    check('other user cannot open item', r.status === 404);
    r = await call('DELETE', '/api/library/' + noteId, null, token2);
    check('other user cannot delete item', r.status === 404);
    r = await call('GET', '/api/library', null, token2);
    check('other user library is empty', r.body.items.length === 0);

    console.log('Password change, admin tools, delete');
    r = await call('POST', '/api/me/password', { oldPassword: 'goodpass123', newPassword: 'brandnewpass9' }, token);
    check('change password', r.status === 200 && r.body.token);
    const newToken = r.body.token;
    r = await call('GET', '/api/me', null, token);
    check('old token stops working', r.status === 401);
    r = await call('POST', '/api/admin/reset-password', { identifier: 'okon@example.com', newPassword: 'resetbyadmin1' }, null, true);
    check('admin reset password', r.status === 200);
    r = await call('POST', '/api/auth/login', { identifier: 'okon@example.com', password: 'resetbyadmin1' });
    check('login with reset password', r.status === 200);
    r = await call('GET', '/api/admin/stats', null, null, true);
    check('admin stats', r.status === 200 && r.body.users === 2 && r.body.generationsLast7Days >= 6 && r.body.paidUsersNow === 1, r.body);
    r = await call('GET', '/api/admin/users?q=ade', null, null, true);
    check('admin user search', r.status === 200 && r.body.users.length === 1);
    r = await call('DELETE', '/api/library/' + noteId, null, newToken);
    check('delete own item', r.status === 200);
    r = await call('DELETE', '/api/me', { password: 'wrong' }, newToken);
    check('delete account needs right password', r.status === 400);
    r = await call('DELETE', '/api/me', { password: 'brandnewpass9' }, newToken);
    check('delete account works', r.status === 200);
    r = await call('POST', '/api/auth/login', { identifier: '08031234567', password: 'brandnewpass9' });
    check('deleted account cannot log in', r.status === 401);
    const chk = new DatabaseSync(path.join(dir, 'teacher.db'));
    const left = ['classes', 'pupils', 'attendance', 'assessments', 'scores', 'items'].map((t) => chk.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id = 1`).get().c);
    chk.close();
    check('deleting the account removes all classroom data too', left.every((n) => n === 0), left);

    console.log('Pages');
    let pr = await fetch(BASE + '/test'); check('/test page served', pr.status === 200 && (await pr.text()).includes('SmartClass Teacher AI'));
    pr = await fetch(BASE + '/admin'); check('/admin page served', pr.status === 200);
    for (const [path_, words] of [['/privacy', ['Privacy Policy', 'support@smartclassaiacademy.com', 'Nigeria Data Protection Act']], ['/terms', ['Terms of Use', 'support@smartclassaiacademy.com', 'Federal Republic of Nigeria']], ['/delete-account', ['Delete my account', 'support@smartclassaiacademy.com', '/api/auth/login']]]) {
      pr = await fetch(BASE + path_); const t = await pr.text();
      check('legal page ' + path_ + ' served with its key text', pr.status === 200 && words.every((w) => t.includes(w)));
    }
    r = await call('POST', '/api/auth/signup', { name: 'To Delete', email: 'gone@example.com', password: 'password123' });
    const tokenX = r.body.token, idX = r.body.user.id;
    await call('POST', '/api/classes', { name: 'Gone class' }, tokenX);
    await call('POST', '/api/generate/worksheet', { subject: 'Maths', className: 'JSS 1', topic: 'Fractions' }, tokenX);
    r = await call('POST', '/api/admin/delete-user', { identifier: 'nobody@example.com' }, null, true);
    check('admin delete: unknown user -> 404', r.status === 404);
    r = await call('POST', '/api/admin/delete-user', { identifier: 'gone@example.com' });
    check('admin delete needs the admin key', r.status === 403);
    r = await call('POST', '/api/admin/delete-user', { identifier: 'GONE@example.com' }, null, true);
    check('admin can delete an account', r.status === 200 && r.body.ok === true, r.body);
    r = await call('POST', '/api/auth/login', { identifier: 'gone@example.com', password: 'password123' });
    check('admin-deleted account cannot log in', r.status === 401);
    const chk2 = new DatabaseSync(path.join(dir, 'teacher.db'));
    const left2 = ['classes', 'items', 'usage', 'gen_log'].map((t) => chk2.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id = ?`).get(idX).c);
    chk2.close();
    check('admin delete removes classes, library and usage too', left2.every((n) => n === 0), left2);
    pr = await fetch(BASE + '/'); check('app home page served', pr.status === 200 && (await pr.text()).includes('id="app"'));
    for (const f of ['/app.js', '/app.css', '/md.js', '/classes.js', '/sw.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon.svg']) {
      pr = await fetch(BASE + f); check('app file served: ' + f, pr.status === 200);
    }
  } catch (e) {
    fail++; console.log('  ERROR', e);
  }
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
