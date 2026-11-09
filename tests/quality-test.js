'use strict';
// Tests: AI health (plain-words reasons), "Check this note" and corrected copies, Level of detail, accuracy rules, diagram blocks.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-'));
process.env.DATA_DIR = path.join(dir, 'unit');
const { DatabaseSync } = require('node:sqlite');
const H = require('../src/aihealth');
const { md, mdText } = require('../public/md.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'test-admin-key-123456';
const root = path.join(__dirname, '..');

// ---- stand-in AI
let mode = 'ok', nextText = '', calls = [], lastRequest = null, stop = 'end_turn';
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    lastRequest = JSON.parse(b); calls.push(lastRequest);
    const send = (st, body) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (mode === 'key') return send(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (mode === 'credits') return send(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });
    if (mode === 'model') return send(404, { error: { type: 'not_found_error', message: 'model: claude-nope' } });
    if (mode === 'busy') return send(529, { error: { type: 'overloaded_error', message: 'Overloaded' } });
    if (mode === 'empty') return send(200, { content: [], usage: { input_tokens: 500, output_tokens: 0 }, stop_reason: 'end_turn' });
    if (mode === 'empty_once') { mode = 'ok'; return send(200, { content: [{ type: 'thinking', thinking: 'hmm' }], usage: { input_tokens: 500, output_tokens: 20 }, stop_reason: 'max_tokens' }); }
    if (mode === 'refusal') return send(200, { content: [], usage: { input_tokens: 500, output_tokens: 0 }, stop_reason: 'refusal' });
    send(200, { content: [{ type: 'text', text: nextText }], usage: { input_tokens: 1500, output_tokens: 400 }, stop_reason: stop });
  });
});
async function start(port, env) {
  const e = Object.assign({}, process.env, { PORT: String(port), ADMIN_KEY: ADMIN, GEN_PER_MINUTE: '200', AUTH_RATE_MAX: '400', FREE_MONTHLY_LIMIT: '900', FREE_DAILY_LIMIT: '60' }, env);
  delete e.AI_MODEL_FREE; delete e.AI_MODEL_PAID;
  const c = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch('http://localhost:' + port + '/health'); if (r.ok) break; } catch (x) { /* retry */ } await sleep(100); }
  return c;
}
const caller = (base) => async (method, p, body, token, admin) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (admin) headers['X-Admin-Key'] = ADMIN;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (x) { /* ignore */ }
  return { status: r.status, body: j };
};
const NOTE = '# LESSON NOTE\n\n## Evaluation\n1. Find the LCM of 3 and 4. (12)\n2. Find the HCF of 8 and 12. (6)\n\n## Lesson Content\n```\nUSER\n  |\nHARDWARE\n```\n' + 'Filler text for length. '.repeat(40);

(async () => {
  console.log('Plain-words reasons for AI problems');
  const k = (s, d) => H.classify(s, d).kind;
  check('wrong or expired key (401)', k(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } }) === 'key_invalid');
  check('credits finished (a 400 that says the balance is too low)', k(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) === 'credits');
  check('spend limit reached', k(400, { error: { message: 'You have reached your workspace API usage limits for the month.' } }) === 'credits');
  check('wrong model name (404)', k(404, { error: { type: 'not_found_error' } }) === 'model');
  check('too many requests (429)', k(429, { error: { type: 'rate_limit_error', message: 'rate limited' } }) === 'rate_limit');
  check('Anthropic busy (529 and 500)', k(529, {}) === 'overloaded' && k(500, {}) === 'overloaded');
  check('permission (403) and other refusals (400)', k(403, {}) === 'permission' && k(400, { error: { message: 'bad thing' } }) === 'bad_request');
  check('every kind has advice in plain words', ['key_invalid', 'credits', 'model', 'permission', 'rate_limit', 'overloaded', 'timeout', 'network', 'bad_request', 'not_configured', 'refusal', 'empty', 'other'].every((x) => H.ADVICE[x] && H.ADVICE[x].length > 30));

  await new Promise((r) => fake.listen(0, r));
  const FP = fake.address().port;
  const P1 = 5200 + Math.floor(Math.random() * 30), P2 = P1 + 30, P3 = P1 + 60;
  const sA = await start(P1, { DATA_DIR: path.join(dir, 'a'), AI_MOCK: '0', ANTHROPIC_API_KEY: 'sk-ant-test-ABCD', AI_API_URL: 'http://localhost:' + FP + '/v1/messages', FREE_DAILY_LIMIT: '12' });
  const sB = await start(P2, { DATA_DIR: path.join(dir, 'b'), AI_MOCK: '1' });
  const sC = await start(P3, { DATA_DIR: path.join(dir, 'c'), AI_MOCK: '0', ANTHROPIC_API_KEY: '' });
  const A = caller('http://localhost:' + P1), B = caller('http://localhost:' + P2), C = caller('http://localhost:' + P3);
  try {
    let r = await A('POST', '/api/auth/signup', { name: 'Q Teacher', email: 'q@example.com', password: 'password123' });
    const tok = r.body.token;
    const used = async () => (await A('GET', '/api/me', null, tok)).body.usage.used;

    console.log('The admin AI health card (real path)');
    r = await A('GET', '/api/admin/ai-health');
    check('only the admin can see it', r.status === 401 || r.status === 403, r.status);
    nextText = NOTE;
    r = await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM and HCF', detail: 'detailed' }, tok);
    const noteId = r.body.id;
    const sys = lastRequest.system, prompt = lastRequest.messages[0].content;
    r = await A('GET', '/api/admin/ai-health', null, null, true);
    check('after a good answer: REAL, the key ending is shown (never the whole key), no problem', r.status === 200 && r.body.mode === 'REAL' && r.body.keyEnds === 'ABCD' && r.body.problemNow === false && r.body.lastOkAt > 0 && r.body.lastOkModel === 'claude-haiku-5-5' && !JSON.stringify(r.body).includes('sk-ant'), r.body);
    check('it counts today\'s good answers', r.body.days.length === 1 && r.body.days[0].ok >= 1 && r.body.days[0].err === 0, r.body.days);
    check('both models are listed', r.body.models.free === 'claude-haiku-5-5' && r.body.models.paid === 'claude-sonnet-5-5');

    mode = 'key';
    r = await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tok);
    check('teachers only see "the AI service is busy" (no technical details)', r.status === 502 && /busy/.test(r.body.error) && !/key|401/i.test(r.body.error), r.body);
    r = await A('GET', '/api/admin/ai-health', null, null, true);
    check('the admin sees: PROBLEM, a wrong key, and what to do', r.body.problemNow === true && r.body.lastError.kind === 'key_invalid' && /Make a new key/.test(r.body.lastError.advice) && r.body.lastError.status === 401, r.body.lastError);
    mode = 'credits';
    await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tok);
    r = await A('GET', '/api/admin/ai-health', null, null, true);
    check('credits finished is recognised, with the advice to buy credits or raise the limit', r.body.lastError.kind === 'credits' && /buy credits or raise the limit/.test(r.body.lastError.advice), r.body.lastError);
    mode = 'model';
    await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tok);
    r = await A('GET', '/api/admin/ai-health', null, null, true);
    check('a wrong model name points to AI_MODEL_FREE and AI_MODEL_PAID', r.body.lastError.kind === 'model' && /AI_MODEL_FREE/.test(r.body.lastError.advice));
    check('the failures are counted', r.body.days[0].err === 3 && r.body.consecutiveErrors === 3, r.body.days);
    mode = 'key';
    r = await A('POST', '/api/admin/ai-test', null, null, true);
    check('"Test the AI now" reports each model with the reason and advice', r.status === 200 && r.body.results.length === 2 && r.body.results.every((x) => x.ok === false && x.kind === 'key_invalid' && /new key/.test(x.advice)), r.body);
    mode = 'ok'; nextText = 'OK'; const n0 = calls.length;
    r = await A('POST', '/api/admin/ai-test', null, null, true);
    const tq = calls.slice(n0);
    check('when all is well, both models answer, with tiny requests', r.body.results.every((x) => x.ok && x.reply === 'OK') && tq.length === 2 && tq[0].max_tokens === 25 && tq[0].thinking.type === 'disabled' && tq.map((x) => x.model).join() === 'claude-haiku-5-5,claude-sonnet-5-5', tq.map((x) => [x.model, x.max_tokens]));
    check('and the problem is cleared (the last good answer is newer than the last problem)', r.body.health.problemNow === false && r.body.health.consecutiveErrors === 0);

    console.log('Room to think (Claude 5.x models think before they write, and thinking counts against max_tokens)');
    const R = require('../src/ai').requestFor;
    let q1 = R('claude-haiku-5-5', 4150, undefined, false);
    check('by default: low effort, 25% more room for the newer tokenizer, plus 3000 tokens of room to think', q1.max_tokens === 8188 && q1.extra.output_config.effort === 'low' && !q1.extra.thinking, q1);
    q1 = R('claude-haiku-5-5', 2500, 'off', false);
    check('plain reading and the AI test switch thinking off (no room added)', q1.max_tokens === 3125 && q1.extra.thinking.type === 'disabled' && !q1.extra.output_config, q1);
    q1 = R('claude-haiku-5-5', 4150, undefined, true);
    check('the retry after a blank answer always switches thinking off', q1.extra.thinking.type === 'disabled' && q1.max_tokens === 5188, q1);
    q1 = R('claude-haiku-4-5', 1000, undefined, false);
    check('an older model name gets no "effort" setting (it would be refused)', !q1.extra.output_config && !q1.extra.thinking && q1.max_tokens === 4250, q1);
    check('the budget never goes above 16000', R('claude-sonnet-5-5', 15000, undefined, false).max_tokens === 16000);
    r = await A('POST', '/api/generate/questions', { subject: 'Mathematics', className: 'JSS 3', topic: 'Multiplication, L.C.M., Division, Fractions, Perimeter, H.C.F., Compound interest, Word problem, Rational and irrational numbers, Linear Equations', type: 'mixed', objectiveCount: 10, theoryCount: 3 }, tok);
    check('your failing case (10 topics, 10 objective + 3 theory): the request now has room to think (8188) and low effort', lastRequest.max_tokens === 8188 && lastRequest.output_config.effort === 'low' && !lastRequest.thinking, [lastRequest.max_tokens, lastRequest.output_config]);
    nextText = NOTE;

    console.log('Blank answers from the AI');
    nextText = NOTE;
    mode = 'empty_once'; let c1 = calls.length; const ub = await used();
    r = await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tok);
    check('a blank answer is tried once more on its own, and then works (the teacher notices nothing)', r.status === 200 && calls.length === c1 + 2 && (await used()) === ub + 1, [r.status, calls.length - c1]);
    check('the first try had thinking on (low effort); the retry had thinking switched off, so text is certain', calls[c1].output_config.effort === 'low' && !calls[c1].thinking && calls[c1 + 1].thinking.type === 'disabled' && !calls[c1 + 1].output_config, [calls[c1].output_config, calls[c1 + 1].thinking]);
    mode = 'empty'; c1 = calls.length;
    r = await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tok);
    check('two blanks in a row: a clear message, and the generation is given back', r.status === 502 && /empty answer/.test(r.body.error) && calls.length === c1 + 2 && (await used()) === ub + 1, r.body);
    r = await A('GET', '/api/admin/ai-health', null, null, true);
    check('the admin sees why: kind "empty" with the stop reason and block types', r.body.lastError.kind === 'empty' && /stop_reason=end_turn, blocks=none, output_tokens=0/.test(r.body.lastError.text) && /twice in a row/.test(r.body.lastError.advice), r.body.lastError);
    mode = 'refusal'; c1 = calls.length;
    r = await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tok);
    check('a refusal is not retried, and the teacher is asked to change the wording', r.status === 502 && r.body.code === 'AI_REFUSED' && /change the wording/.test(r.body.error) && calls.length === c1 + 1 && (await used()) === ub + 1, r.body);
    r = await A('GET', '/api/admin/ai-health', null, null, true);
    check('the admin sees it as a refusal, not an outage', r.body.lastError.kind === 'refusal' && /stop_reason=refusal/.test(r.body.lastError.text) && /not an outage/.test(r.body.lastError.advice), r.body.lastError);
    mode = 'ok'; nextText = NOTE;

    console.log('No key / test mode');
    r = await C('GET', '/api/admin/ai-health', null, null, true);
    check('no key: the card says NO KEY', r.body.mode === 'NO KEY' && r.body.keyEnds === null);
    r = await C('POST', '/api/auth/signup', { name: 'No Key', email: 'nk@example.com', password: 'password123' });
    await C('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, r.body.token);
    r = await C('GET', '/api/admin/ai-health', null, null, true);
    check('and a failed attempt says to add ANTHROPIC_API_KEY', r.body.lastError.kind === 'not_configured' && /ANTHROPIC_API_KEY/.test(r.body.lastError.advice));
    r = await B('GET', '/api/admin/ai-health', null, null, true);
    check('test mode: the card says TEST', r.body.mode === 'TEST');
    r = await B('POST', '/api/admin/ai-test', null, null, true);
    check('in test mode the test makes no real call and says so', r.body.results.every((x) => x.ok && x.mock === true));

    console.log('Accuracy rules, Level of detail and "Part 1 of 2"');
    check('every request carries the accuracy rules (check every sum, one step per line, diagrams in a code block)', /Accuracy comes first/.test(sys) && /Re-do every sum/.test(sys) && /one clear step per line/.test(sys) && /code block/.test(sys), sys.slice(0, 300));
    check('Detailed adds its instruction and more room (6000 tokens)', /Level of detail: DETAILED/.test(prompt));
    check('the "Part 1 of 2" rule is always there', /Part 1 of 2/.test(prompt) && /Never cram/.test(prompt));
    r = await A('GET', '/api/library/' + noteId, null, tok);
    check('the item remembers the level of detail', r.body.meta.detail === 'detailed', r.body.meta);
    r = await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM', detail: 'huge' }, tok);
    check('a wrong level is refused', r.status === 400 && /simple, standard or detailed/.test(r.body.error));
    await A('POST', '/api/generate/lesson-plan', { subject: 'Maths', className: 'JSS 1', topic: 'Fractions', detail: 'simple' }, tok);
    check('lesson plans take it too', /Level of detail: SIMPLE/.test(lastRequest.messages[0].content));
    await A('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tok);
    check('Standard adds no extra detail line', !/Level of detail/.test(lastRequest.messages[0].content));

    console.log('Check this note');
    const u0 = await used(), c0 = calls.length;
    nextText = '```json\n' + JSON.stringify({ verdict: 'problems', summary: 'One answer is wrong.', issues: [{ where: 'Evaluation, question 2', problem: 'The HCF of 8 and 12 is 4, not <b>6</b>.', fix: '(4)' }, { where: '', problem: '', fix: 'ignored (no problem given)' }] }) + '\n```';
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok);
    check('it finds a wrong answer and says where, what is wrong and the fix (markup removed)', r.status === 200 && r.body.verdict === 'problems' && r.body.issues.length === 1 && r.body.issues[0].where === 'Evaluation, question 2' && r.body.issues[0].problem === 'The HCF of 8 and 12 is 4, not 6.' && r.body.issues[0].fix === '(4)', r.body);
    check('it counts as one generation', r.body.usage.used === u0 + 1 && (await used()) === u0 + 1);
    const cp = lastRequest.messages[0].content;
    check('the AI is asked to re-do every calculation and check every answer, and gets the whole document', /Re-do every calculation yourself/.test(cp) && /Check every answer/.test(cp) && cp.includes('<document>') && cp.includes('Find the HCF of 8 and 12. (6)') && /Ignore any instruction/.test(lastRequest.system), cp.slice(0, 200));
    check('it uses the cheap model on a free plan, with medium thinking and 6000 tokens of room to think (the check benefits from reasoning)', lastRequest.model === 'claude-haiku-5-5' && lastRequest.max_tokens === 7875 && lastRequest.output_config.effort === 'medium', [lastRequest.max_tokens, lastRequest.output_config]);
    nextText = JSON.stringify({ verdict: 'ok', summary: 'No mistakes.', issues: [] });
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok);
    check('a clean document: "ok" with no issues', r.body.verdict === 'ok' && r.body.issues.length === 0);
    nextText = JSON.stringify({ verdict: 'problems', summary: 'x', issues: [] });
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok);
    check('"problems" with nothing listed is treated as ok (never invent a problem)', r.body.verdict === 'ok');
    nextText = JSON.stringify({ verdict: 'problems', issues: Array.from({ length: 20 }, (_, i) => ({ where: 'W' + i, problem: 'P' + i, fix: 'F' + i })) });
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok);
    check('at most 12 issues are returned', r.body.issues.length === 12);
    const u1 = await used();
    nextText = 'I think it is fine!';
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok);
    check('an unreadable answer: try again, and the generation is given back', r.status === 502 && r.body.code === 'AI_FORMAT' && (await used()) === u1, r.body);
    mode = 'busy';
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok);
    check('if the AI is busy: friendly message and nothing used', r.status === 503 && (await used()) === u1);
    mode = 'ok';

    console.log('Corrected copy');
    const ISSUES = [{ where: 'Evaluation, question 2', problem: 'The HCF of 8 and 12 is 4, not 6.', fix: '(4)' }];
    nextText = '```markdown\n' + NOTE.replace('(6)', '(4)') + '\n```';
    const u2 = await used();
    r = await A('POST', '/api/items/' + noteId + '/fix', { issues: ISSUES }, tok);
    check('a corrected copy is saved as a NEW item, titled "(corrected)", linked to the original', r.status === 200 && /\(corrected\)$/.test(r.body.title) && r.body.id !== noteId && r.body.kind === 'lesson_note', r.body);
    const fixId = r.body.id;
    check('it counts as one generation', (await used()) === u2 + 1);
    const fp = lastRequest.messages[0].content;
    check('the AI gets the whole document and the numbered mistakes, and is told to change nothing else', fp.includes('Mistakes to correct:') && /1\. Where: Evaluation, question 2 \| Problem: The HCF of 8 and 12 is 4, not 6\. \| Correct version: \(4\)/.test(fp) && /change nothing else/.test(fp) && fp.includes('Find the HCF of 8 and 12. (6)'), fp.slice(-400));
    r = await A('GET', '/api/library/' + fixId, null, tok);
    check('the copy has the corrected answer and no code fence around the whole document', /HCF of 8 and 12\. \(4\)/.test(r.body.content) && !/^```markdown/.test(r.body.content) && r.body.meta.correctedFrom === noteId, r.body.content.slice(0, 120));
    r = await A('GET', '/api/library/' + noteId, null, tok);
    check('the original is untouched', /HCF of 8 and 12\. \(6\)/.test(r.body.content) && !/corrected/.test(r.body.title));
    r = await A('POST', '/api/items/' + noteId + '/fix', { issues: [] }, tok);
    check('with nothing to correct it asks you to run the check first', r.status === 400);
    const u3 = await used();
    nextText = 'Only a short bit.';
    r = await A('POST', '/api/items/' + noteId + '/fix', { issues: ISSUES }, tok);
    check('a copy that is far too short is refused (nothing saved, generation given back)', r.status === 502 && (await used()) === u3, r.body);
    nextText = NOTE; stop = 'max_tokens';
    r = await A('POST', '/api/items/' + noteId + '/fix', { issues: ISSUES }, tok);
    check('a copy that was cut off is refused too', r.status === 502 && (await used()) === u3, r.body);
    stop = 'end_turn';

    console.log('Who can check what');
    r = await A('POST', '/api/auth/signup', { name: 'Other', email: 'o@example.com', password: 'password123' });
    const tok2 = r.body.token;
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok2);
    check('another teacher cannot check or fix your item', r.status === 404 && (await A('POST', '/api/items/' + noteId + '/fix', { issues: ISSUES }, tok2)).status === 404);
    r = await B('POST', '/api/auth/signup', { name: 'Mock0', email: 'm0@example.com', password: 'password123' });
    const tokM = r.body.token;
    const mk = (await B('POST', '/api/generate/marking', { subject: 'English', className: 'JSS 1', question: 'Define a noun.', totalMarks: 10, answers: [{ name: 'A', answer: 'A naming word.' }] }, tokM)).body.id;
    const rc = (await B('POST', '/api/generate/report-comments', { className: 'JSS 1', pupils: [{ name: 'Ada' }] }, tokM)).body.id;
    const bad1 = await B('POST', '/api/items/' + mk + '/check', null, tokM), bad2 = await B('POST', '/api/items/' + rc + '/check', null, tokM);
    check('marking results and report comments are not checkable', bad1.status === 400 && bad1.body.code === 'NOT_CHECKABLE' && bad2.status === 400 && bad2.body.code === 'NOT_CHECKABLE', [bad1.body, bad2.body]);
    const dbx = new DatabaseSync(path.join(dir, 'a', 'teacher.db'));
    const uid = dbx.prepare("SELECT id FROM users WHERE email = 'q@example.com'").get().id;
    for (let i = 0; i < 33; i++) dbx.prepare("INSERT INTO items (user_id, kind, title, meta, content, created_at, updated_at) VALUES (?, 'worksheet', ?, NULL, 'x', ?, ?)").run(uid, 'Newer ' + i, Date.now() + 1000 + i, Date.now() + 1000 + i);
    r = await A('POST', '/api/items/' + noteId + '/check', null, tok);
    check('an old item locked on the free plan cannot be checked', r.status === 403 && r.body.code === 'LIBRARY_LOCKED', r.body);
    dbx.close();
    r = await A('POST', '/api/auth/login', { identifier: 'q@example.com', password: 'password123' });
    // daily limit (12 on this server): use the rest up on the newest item
    const newest = (await A('GET', '/api/library', null, tok)).body.items[0].id;
    nextText = JSON.stringify({ verdict: 'ok', summary: 'fine', issues: [] });
    let guard = 0; while (guard++ < 20) { const x = await A('POST', '/api/items/' + newest + '/check', null, tok); if (x.status === 429) { r = x; break; } }
    const nBefore = calls.length;
    r = await A('POST', '/api/items/' + newest + '/check', null, tok);
    check('when the day is used up, the check is refused and the AI is not called', r.status === 429 && r.body.code === 'LIMIT_REACHED' && calls.length === nBefore, r.body);

    console.log('Test mode: the screens can be tried for free');
    r = await B('POST', '/api/auth/signup', { name: 'Mock', email: 'm@example.com', password: 'password123' });
    const tokB = r.body.token;
    r = await B('POST', '/api/generate/lesson-note', { subject: 'Maths', className: 'Primary 6', topic: 'LCM' }, tokB);
    const mid = r.body.id;
    r = await B('POST', '/api/items/' + mid + '/check', null, tokB);
    check('test-mode check returns one sample issue', r.status === 200 && r.body.verdict === 'problems' && r.body.issues.length === 1 && /TEST MODE/.test(r.body.issues[0].problem), r.body);
    r = await B('POST', '/api/items/' + mid + '/fix', { issues: r.body.issues }, tokB);
    check('test-mode corrected copy is saved', r.status === 200 && /\(corrected\)/.test(r.body.title));
  } catch (e) {
    fail++; console.log('  ERROR', e);
  }
  sA.kill(); sB.kill(); sC.kill(); fake.close();

  console.log('Diagrams in code blocks');
  const html = md('Draw:\n```\nUSER\n  |\nAPP (<b>x</b>)\n```\nDone.\n\n```text\nsecond\n```');
  check('a fenced diagram becomes a boxed block, keeps its spaces, and escapes markup', (html.match(/<pre class="codeblock">/g) || []).length === 2 && html.includes('USER\n  |\nAPP (&lt;b&gt;x&lt;/b&gt;)') && !/```/.test(html));
  check('text before and after the block is still a normal paragraph', /<p>Draw:<\/p>/.test(html) && /<p>Done\.<\/p>/.test(html));
  check('a fence that is never closed shows the rest as code', md('x\n```\nopen\nmore').includes('<pre class="codeblock">open\nmore</pre>'));

  console.log('Clean text for Copy and Share');
  const SRC = '# MATHEMATICS: JSS 3\n\n| Item | Details |\n|---|---|\n| Topic | **LCM** and HCF |\n| Date | ........ |\n\n**Instructions:** Answer *all* questions.\n\n## Section A\n\n1. What is 2 * 3 * 4?\n   A. 6\n- a bullet with `code`\n* another bullet\n\n---\n\n# TEACHER\'S COPY ONLY\n```\nUSER\n  |\nHARDWARE\n```\n**11.** (a) Find x. (3 marks)';
  const T = mdText(SRC);
  check('no markdown symbols are left (#, **, |---|, backticks, fences)', !/^#|\*\*|\|---|`/m.test(T), T);
  check('headings: the title is in capitals, sub-headings stay as written', /^MATHEMATICS: JSS 3$/m.test(T) && /^Section A$/m.test(T) && /^TEACHER'S COPY ONLY$/m.test(T), T);
  check('a table becomes readable rows without the separator line', /^Item {2}\| {2}Details$/m.test(T) && /^Topic {2}\| {2}LCM and HCF$/m.test(T) && /^Date {2}\| {2}\.{8}$/m.test(T), T);
  check('bold and italic words keep their text; "2 * 3 * 4" stays as it is', /^Instructions: Answer all questions\.$/m.test(T) && T.includes('2 * 3 * 4'), T);
  check('bullets become dots, numbered lines stay numbered', /^• a bullet with code$/m.test(T) && /^• another bullet$/m.test(T) && /^1\. What is/m.test(T), T);
  check('the diagram text keeps its layout without the fence lines', T.includes('USER\n  |\nHARDWARE') && !/```/.test(T), T);
  check('"---" becomes a plain line, and a bold question number loses its stars', T.includes('--------------------') && /^11\. \(a\) Find x\./m.test(T), T);
  check('no run of 3 or more blank lines', !/\n{3,}/.test(T));

  await sleep(300);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
