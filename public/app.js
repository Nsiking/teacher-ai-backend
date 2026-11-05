'use strict';
/* SmartClass Teacher AI - app screens (works in the browser now, wrapped for Android later). */
(function () {
  // ---- Settings you may change ----
  var API_BASE = window.APP_API_BASE || '';        // '' = same server. The Android wrapper sets the live address.
  var IS_NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  function plugin(name) { return window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins[name] : null; }
  function siteUrl(path) { return API_BASE + path; }   // web pages (privacy, terms) live on the server
  var SUPPORT_WHATSAPP = '2348054801320';          // where teachers message you to upgrade (until in-app payment is added)

  var TT = window.TT = window.TT || {};
  TT.views = TT.views || {}; TT.actions = TT.actions || {};
  var app = document.getElementById('app');
  var S = { token: localStorage.getItem('tt_token') || '', user: null, usage: null, meta: null, installEvt: null };
  var authMode = 'login';
  var KINDS = {
    'lesson-note': { code: 'lesson_note', label: 'Lesson Note', icon: '📘', blurb: 'Full note in the Nigerian format', busy: ['Planning your lesson…', 'Writing the objectives…', 'Building the presentation steps…', 'Preparing the board summary…'] },
    'lesson-plan': { code: 'lesson_plan', label: 'Lesson Plan', icon: '📋', blurb: 'Timed plan, stage by stage', busy: ['Setting the objectives…', 'Planning the stages and timing…', 'Adding support and extension…', 'Preparing the evaluation…'] },
    'scheme-of-work': { code: 'scheme_of_work', label: 'Scheme of Work', icon: '🗓️', blurb: 'A full term plan, week by week', busy: ['Planning the term…', 'Spreading the topics across the weeks…', 'Writing objectives for each week…', 'Adding activities and materials…'] },
    'questions': { code: 'questions', label: 'Questions', icon: '📝', blurb: 'Test or exam with answer key', busy: ['Setting the questions…', 'Checking the options…', 'Writing the marking guide…'] },
    'worksheet': { code: 'worksheet', label: 'Worksheet', icon: '🧩', blurb: 'Printable classroom activities', busy: ['Designing the activities…', 'Adding answer spaces…', 'Writing the answer key…'] },
    'marking': { code: 'marking', label: 'Marking Assistant', icon: '✅', blurb: 'Suggested marks and feedback', busy: ['Reading the answers…', 'Comparing with the marking guide…', 'Giving marks and feedback…'] },
    'report-comments': { code: 'report_comments', label: 'Report Comments', icon: '💬', blurb: 'Comments for the whole class', busy: ['Reading the scores…', 'Writing each comment…', 'Polishing the wording…'] }
    ,'timetable': { code: 'timetable', label: 'Time-Table', icon: '🕒', blurb: 'Your weekly periods and class timetables', route: 'timetable', busy: [] }
  };
  var CODE_TO_KEY = {};
  Object.keys(KINDS).forEach(function (k) { CODE_TO_KEY[KINDS[k].code] = k; });

  // ---------------------------------------------------------------- helpers
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(sel, el) { return (el || document).querySelector(sel); }
  function fmtDate(ms) { try { return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }
  function jget(key, def) { try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; } catch (e) { return def; } }
  function jset(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full: ignore */ } }

  var toastTimer = null;
  function toast(msg, isErr) {
    var old = $('.toast'); if (old) old.remove();
    var t = document.createElement('div'); t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg;
    document.body.appendChild(t);
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.remove(); }, isErr ? 5000 : 2600);
  }
  function modal(html, wide) {
    closeModal();
    var o = document.createElement('div'); o.className = 'overlay'; o.id = 'modal';
    o.innerHTML = '<div class="modal' + (wide ? ' wide' : '') + '">' + html + '</div>';
    document.body.appendChild(o);
    return o;
  }
  function closeModal() { var m = $('#modal'); if (m) m.remove(); }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, function () { fallbackCopy(text); });
    }
    fallbackCopy(text); return Promise.resolve();
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied'); } catch (e) { toast('Copy failed. Please select the text and copy it.', true); }
    ta.remove();
  }

  // ---------------------------------------------------------------- API
  async function api(method, path, body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 175000);
    var r;
    try {
      r = await fetch(API_BASE + path, {
        method: method,
        headers: Object.assign({ 'Content-Type': 'application/json' }, S.token ? { Authorization: 'Bearer ' + S.token } : {}),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      });
    } catch (e) {
      clearTimeout(timer);
      var oe = new Error(navigator.onLine ? 'Could not reach the server. Please try again.' : 'You are offline. Please connect to the internet.');
      oe.offline = true; throw oe;
    }
    clearTimeout(timer);
    var j = {}; try { j = await r.json(); } catch (e) { /* ignore */ }
    if (!r.ok) {
      var err = new Error(j.error || 'Something went wrong. Please try again.');
      err.code = j.code; err.status = r.status;
      if (r.status === 401 && S.token && /^AUTH_/.test(j.code || '')) { clearSession(); location.hash = '#/auth'; }
      throw err;
    }
    return j;
  }

  // ---------------------------------------------------------------- local cache (offline reading)
  function cacheItems() { return jget('tt_items', {}); }
  function putItem(it) {
    var c = cacheItems();
    c[it.id] = { id: it.id, kind: it.kind, title: it.title, content: it.content, meta: it.meta || null, createdAt: it.createdAt || Date.now(), updatedAt: it.updatedAt || Date.now() };
    var ids = Object.keys(c).sort(function (a, b) { return (c[b].updatedAt || 0) - (c[a].updatedAt || 0); });
    ids.slice(60).forEach(function (id) { delete c[id]; });
    jset('tt_items', c);
  }
  function dropItem(id) { var c = cacheItems(); delete c[id]; jset('tt_items', c); }
  function clearSession() {
    S.token = ''; S.user = null; S.usage = null;
    ['tt_token', 'tt_items', 'tt_list', 'tt_user', 'tt_usage', 'tt_slots', 'tt_make'].forEach(function (k) { localStorage.removeItem(k); });
  }
  function saveSession(s) {
    if (s.token) { S.token = s.token; localStorage.setItem('tt_token', s.token); }
    S.user = s.user; S.usage = s.usage; jset('tt_user', s.user); jset('tt_usage', s.usage);
  }
  var lastMe = 0;
  async function loadMe() {
    var me = await api('GET', '/api/me');
    S.user = me.user; S.usage = me.usage; jset('tt_user', me.user); jset('tt_usage', me.usage); lastMe = Date.now();
  }
  // Re-reads the plan and allowance (for example after we activate a plan). Returns true if the plan changed.
  async function refreshMe() {
    var before = S.user && S.user.plan;
    try { await loadMe(); } catch (e) { return false; }
    return !!S.user && before !== S.user.plan;
  }
  async function loadMeta() {
    if (S.meta) return;
    try { S.meta = await api('GET', '/api/meta'); jset('tt_meta', S.meta); }
    catch (e) { S.meta = jget('tt_meta', null); }
    if (!S.meta) S.meta = { classes: ['Primary 1', 'Primary 2', 'Primary 3', 'Primary 4', 'Primary 5', 'Primary 6', 'JSS 1', 'JSS 2', 'JSS 3', 'SS 1', 'SS 2', 'SS 3'], terms: ['First Term', 'Second Term', 'Third Term'], limits: { free: 3, paid: 30 } };
  }
  function plansInfo() {
    return (S.meta && S.meta.plansInfo) || {
      monthly: { label: 'Monthly', price: 1500, days: 30 },
      term: { label: 'Term (3 months)', price: 3500, days: 91 },
      year: { label: 'Year (3 terms)', price: 9500, days: 365 }
    };
  }
  function naira(n) { return '₦' + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function waLink(msg) { return 'https://wa.me/' + SUPPORT_WHATSAPP + '?text=' + encodeURIComponent(msg); }
  function whoAmI() { return (S.user && (S.user.email || S.user.phone)) || ''; }
  function currentTerm() {
    var m = new Date().getMonth() + 1; // Nigerian school year: Sep-Dec, Jan-Mar, Apr-Jul
    return m >= 9 ? 'First Term' : m <= 3 ? 'Second Term' : 'Third Term';
  }
  function isPaid() { return S.user && S.user.plan && S.user.plan !== 'free'; }

  // ---------------------------------------------------------------- page shell
  function navBar(on) {
    function b(id, ico, label) { return '<button data-go="' + id + '" class="' + (on === id ? 'on' : '') + '"><span class="i">' + ico + '</span>' + label + '</button>'; }
    return '<nav class="nav no-print">' + b('home', '🏠', 'Home') + b('classes', '🏫', 'Classes') + b('library', '📚', 'Library') + b('account', '👤', 'Account') + '</nav>';
  }
  function shell(inner, o) {
    o = o || {};
    var pill = (S.usage && o.nav) ? '<div class="pill">' + S.usage.used + ' of ' + S.usage.limit + ' today</div>' : '';
    app.innerHTML =
      '<header class="top no-print">' + (o.back ? '<button class="icon-btn" data-go="' + o.back + '" aria-label="Back">←</button>' : '') +
      '<div class="top-title">' + esc(o.title || 'SmartClass Teacher AI') + '</div>' + pill + '</header>' +
      '<div id="offline" class="offline no-print' + (navigator.onLine ? ' hide' : '') + '">You are offline. You can still open saved items.</div>' +
      '<main class="page">' + inner + '</main>' + (o.nav ? navBar(o.nav) : '');
    window.scrollTo(0, 0);
  }

  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  // ---------------------------------------------------------------- router
  async function route() {
    var parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
    var name = parts[0], arg = parts[1];
    if (!S.token) return viewAuth();
    if (!S.user) {
      try { await loadMe(); }
      catch (e) {
        if (e.offline && jget('tt_user', null)) { S.user = jget('tt_user', null); S.usage = jget('tt_usage', null); }
        else return viewAuth(e.offline ? e.message : '');
      }
    }
    await loadMeta();
    if (name === 'auth') { location.replace('#/home'); return; }
    if (name === 'account' || name === 'home' || Date.now() - lastMe > 5000) await refreshMe();
    switch (name) {
      case 'new': return viewForm(arg);
      case 'item': return viewItem(Number(arg));
      case 'timetable': return TT.views.timetable ? TT.views.timetable(parts) : viewHome();
      case 'classes': return TT.views.classes ? TT.views.classes(parts) : viewHome();
      case 'class': return TT.views.class ? TT.views.class(parts) : viewHome();
      case 'textbooks': return viewTextbooks();
      case 'library': return viewLibrary();
      case 'account': return viewAccount();
      default: return viewHome();
    }
  }

  // ---------------------------------------------------------------- auth
  function viewAuth(message) {
    var signup = authMode === 'signup';
    shell(
      '<div class="auth-hero"><img src="/icon-192.png" alt=""><h1>SmartClass Teacher AI</h1><p class="sub">Lesson notes, questions, worksheets and report comments in minutes.</p></div>' +
      '<div class="card">' +
      (signup ? '<label for="a-name">Your name</label><input id="a-name" autocomplete="name" placeholder="e.g. Mrs Adaeze Obi" maxlength="60">' : '') +
      '<label for="a-id">Phone number or email</label><input id="a-id" autocomplete="username" inputmode="email" placeholder="08012345678 or you@email.com" maxlength="120">' +
      '<label for="a-pw">Password' + (signup ? ' (at least 8 characters)' : '') + '</label><input id="a-pw" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" maxlength="100">' +
      '<div class="err" id="a-err">' + esc(message || '') + '</div>' +
      '<button class="btn block" data-act="auth">' + (signup ? 'Create my account' : 'Log in') + '</button>' +
      '<div class="toggle">' + (signup ? 'Already have an account?' : 'New here?') + ' <button class="link" data-act="authmode">' + (signup ? 'Log in' : 'Create an account') + '</button></div>' +
      '</div>' +
      '<p class="hint" style="text-align:center">By continuing you agree to our <a href="' + siteUrl('/terms') + '" target="_blank" rel="noopener" style="color:var(--brand)">Terms of Use</a> and <a href="' + siteUrl('/privacy') + '" target="_blank" rel="noopener" style="color:var(--brand)">Privacy Policy</a>.</p>',
      {}
    );
  }
  async function doAuth(btn) {
    var id = $('#a-id').value.trim(), pw = $('#a-pw').value, err = $('#a-err');
    err.textContent = '';
    if (!id || !pw) { err.textContent = 'Please fill in all the boxes.'; return; }
    var body, path;
    if (authMode === 'signup') {
      var nm = $('#a-name').value.trim();
      if (nm.length < 2) { err.textContent = 'Please enter your name.'; return; }
      body = { name: nm, password: pw }; if (id.indexOf('@') > -1) body.email = id; else body.phone = id;
      path = '/api/auth/signup';
    } else { body = { identifier: id, password: pw }; path = '/api/auth/login'; }
    btn.disabled = true; btn.textContent = 'Please wait…';
    try { var s = await api('POST', path, body); saveSession(s); go('#/home'); }
    catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = authMode === 'signup' ? 'Create my account' : 'Log in'; }
  }

  // ---------------------------------------------------------------- home
  function viewHome() {
    var u = S.usage || { used: 0, limit: 0 };
    var pct = u.limit ? Math.min(100, Math.round(u.used / u.limit * 100)) : 0;
    var left = Math.max(0, u.limit - u.used);
    var words = (S.user.name || '').trim().split(/\s+/);
    var first = words[0] || '';
    if (/^(mr|mrs|miss|ms|dr|engr|prof|pastor|rev|chief|sir|madam|mal|alh|alhaji|hajia|barr|hon)\.?$/i.test(first) && words[1]) first = words[0] + ' ' + words[1];
    var keys = Object.keys(KINDS);
    var tiles = keys.map(function (k, i) {
      return '<button class="tile' + (i === keys.length - 1 && keys.length % 2 === 1 ? ' full' : '') + '" data-go="' + (KINDS[k].route || 'new/' + k) + '"><span class="ico">' + KINDS[k].icon + '</span><span style="display:flex;flex-direction:column;gap:4px"><b>' + KINDS[k].label + '</b><span class="d">' + KINDS[k].blurb + '</span></span></button>';
    }).join('');
    shell(
      '<h1>Good day, ' + esc(first) + '</h1><p class="sub">What do you want to prepare today?</p>' +
      (S.installEvt ? '<div class="banner"><span>Install this app on your phone for quick access.</span><button class="btn small" data-act="install">Install</button></div>' : '') +
      '<div id="today-box"></div>' +
      '<div class="tiles">' + tiles + '</div>' +
      '<div class="card" style="margin-top:14px"><div class="kv" style="padding-top:0"><span>Today</span><b>' + left + ' of ' + u.limit + ' left</b></div>' +
      (u.monthlyLimit ? '<div class="kv"><span>This month</span><b>' + Math.max(0, u.monthlyLimit - (u.monthlyUsed || 0)) + ' of ' + u.monthlyLimit + ' left</b></div>' : '') +
      '<div class="meter"><i style="width:' + pct + '%"></i></div>' +
      (isPaid() ? '' : '<p class="hint">Free plan. <button class="link" data-go="account" style="padding:0">See how to upgrade</button></p>') + '</div>' +
      '<h2 class="sec">Recent</h2><div id="recent"><p class="hint">Loading…</p></div>',
      { nav: 'home' }
    );
    loadRecent();
    if (TT.todayCard) TT.todayCard();
  }
  async function loadRecent() {
    var box = $('#recent'); if (!box) return;
    var items = null;
    try { var r = await api('GET', '/api/library?limit=3'); items = r.items; }
    catch (e) { items = (jget('tt_list', []) || []).slice(0, 3); }
    if (!$('#recent')) return;
    $('#recent').innerHTML = items.length ? items.map(itemButton).join('') : '<div class="empty">Nothing yet. Pick one of the tools above to start.</div>';
  }
  function itemButton(it) {
    var key = CODE_TO_KEY[it.kind], k = KINDS[key] || { icon: '📄', label: 'Item' };
    if (it.locked) return '<button class="item locked" data-act="lockeditem"><span class="ico">🔒</span><span><div class="t">' + esc(it.title) + '</div><div class="m">' + k.label + ' · locked on the free plan</div></span></button>';
    return '<button class="item" data-go="item/' + it.id + '"><span class="ico">' + k.icon + '</span><span><div class="t">' + esc(it.title) + '</div><div class="m">' + k.label + ' · ' + fmtDate(it.createdAt) + '</div></span></button>';
  }

  // ---------------------------------------------------------------- forms
  function opts(list, sel) { return list.map(function (x) { return '<option' + (x === sel ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join(''); }
  function pupilRow() {
    return '<div class="pupil"><div class="row2"><input class="p-name" placeholder="Pupil\'s name" maxlength="60">' +
      '<select class="p-gender"><option value="">Boy or girl?</option><option value="boy">Boy</option><option value="girl">Girl</option></select></div>' +
      '<input class="p-scores" placeholder="Scores, e.g. Maths 80, English 55 (optional)" maxlength="150">' +
      '<input class="p-notes" placeholder="Notes, e.g. very neat, talkative (optional)" maxlength="250">' +
      '<div class="p-actions"><button type="button" class="link danger" data-act="rmpupil">Remove</button></div></div>';
  }
  function answerRow() {
    return '<div class="ans"><input class="a-name" placeholder="Student\'s name" maxlength="60">' +
      '<textarea class="a-text" maxlength="1500" placeholder="Type or paste this student\'s answer"></textarea>' +
      '<div class="p-actions"><button type="button" class="link danger" data-act="rmanswer">Remove</button></div></div>';
  }
  function viewForm(kind) {
    var def = KINDS[kind];
    if (!def) { location.replace('#/home'); return; }
    var prefs = jget('tt_prefs', {});
    var classes = S.meta.classes, terms = S.meta.terms;
    var cls = prefs.className || 'JSS 1', term = prefs.term || currentTerm();
    var body = '';
    if (kind === 'report-comments') {
      body =
        '<div class="row2 stack"><div><label for="f-class">Class</label><select id="f-class">' + opts(classes, cls) + '</select></div>' +
        '<div><label for="f-term">Term</label><select id="f-term">' + opts(terms, term) + '</select></div></div>' +
        '<div class="row2 stack"><div><label for="f-tone">Tone</label><select id="f-tone"><option value="encouraging">Encouraging</option><option value="balanced">Balanced</option><option value="firm">Firm</option></select></div>' +
        '<div><label for="f-by">Written by</label><select id="f-by"><option value="class teacher">Class teacher</option><option value="head teacher">Head teacher</option></select></div></div>' +
        '<div class="banner" id="cls-box" style="display:block"><b>Load from my class</b><p class="hint" style="margin:2px 0 8px">Fills in the names, boy or girl, scores and attendance from your Classes records.</p>' +
        '<div id="cls-inner"><p class="hint">Checking your classes…</p></div></div>' +
        '<h2 class="sec">Pupils (up to ' + (isPaid() ? 40 : 5) + ' at a time)</h2>' +
        '<div id="pupils">' + pupilRow() + '</div>' +
        '<button class="btn alt small" data-act="addpupil">+ Add pupil</button> <button class="btn alt small" data-act="pastebox">Paste a list of names</button>' +
        '<div id="pastebox" class="hide" style="margin-top:10px"><textarea id="f-paste" placeholder="One name per line"></textarea><button class="btn small" style="margin-top:8px" data-act="pasteadd">Add these names</button></div>';
    } else if (kind === 'marking') {
      body =
        '<label for="f-subject">Subject</label><input id="f-subject" maxlength="60" placeholder="e.g. English Language" value="' + esc(prefs.subject || '') + '">' +
        '<div class="row2 stack"><div><label for="f-class">Class</label><select id="f-class">' + opts(classes, cls) + '</select></div>' +
        '<div><label for="f-total">Total marks</label><input id="f-total" inputmode="numeric" value="10"></div></div>' +
        '<label for="f-question">The question</label><textarea id="f-question" maxlength="1500" placeholder="Type or paste the question"></textarea>' +
        '<label for="f-guide">Marking guide (optional)</label><textarea id="f-guide" maxlength="2000" placeholder="The points that earn marks. Leave empty and the AI will work out a fair guide."></textarea>' +
        '<label for="f-style">Marking style</label><select id="f-style"><option value="fair">Fair</option><option value="strict">Strict</option><option value="lenient">Lenient</option></select>' +
        '<h2 class="sec">Student answers (up to ' + (isPaid() ? 15 : 3) + ' at a time)</h2>' +
        '<div id="answers">' + answerRow() + '</div>' +
        '<button class="btn alt small" data-act="addanswer">+ Add another student</button>' +
        '<p class="hint">These are suggested marks. You always have the final say.</p>';
    } else if (kind === 'scheme-of-work') {
      var wk = ''; for (var w = 8; w <= 14; w++) wk += '<option' + (w === 13 ? ' selected' : '') + '>' + w + '</option>';
      body =
        '<label for="f-subject">Subject</label><input id="f-subject" maxlength="60" placeholder="e.g. Mathematics" value="' + esc(prefs.subject || '') + '">' +
        '<div class="row2 stack"><div><label for="f-class">Class</label><select id="f-class">' + opts(classes, cls) + '</select></div>' +
        '<div><label for="f-term">Term</label><select id="f-term">' + opts(terms, term) + '</select></div></div>' +
        '<div class="row2 stack"><div><label for="f-weeks">Weeks in the term</label><select id="f-weeks">' + wk + '</select></div>' +
        '<div><label for="f-periods">Periods per week (optional)</label><input id="f-periods" inputmode="numeric" placeholder="e.g. 5"></div></div>' +
        '<label for="f-topics">Topics to cover (optional)</label><textarea id="f-topics" maxlength="1000" placeholder="Paste your topics, one per line, if you already have them. Leave empty and the AI will follow the curriculum."></textarea>' +
        '<label for="f-extras">Anything else? (optional)</label><input id="f-extras" maxlength="400" placeholder="e.g. include a revision week after week 6">';
    } else {
      body =
        '<label for="f-subject">Subject</label><input id="f-subject" maxlength="60" placeholder="e.g. Mathematics" value="' + esc(prefs.subject || '') + '">' +
        '<div class="row2 stack"><div><label for="f-class">Class</label><select id="f-class">' + opts(classes, cls) + '</select></div>' +
        ((kind === 'lesson-note' || kind === 'lesson-plan') ? '<div><label for="f-term">Term</label><select id="f-term">' + opts(terms, term) + '</select></div>' : '<div></div>') + '</div>' +
        '<label for="f-topic">Topic</label><input id="f-topic" maxlength="150" placeholder="e.g. Algebraic expressions">';
      if (kind === 'lesson-note' || kind === 'lesson-plan') {
        body += '<div class="row2 stack"><div><label for="f-week">Week (optional)</label><input id="f-week" maxlength="20" placeholder="e.g. Week 3"></div>' +
          '<div><label for="f-duration">Duration (minutes)</label><input id="f-duration" inputmode="numeric" value="40"></div></div>';
        if (kind === 'lesson-plan') body += '<label for="f-method">Teaching method (optional)</label><input id="f-method" maxlength="100" placeholder="e.g. group work, demonstration">';
      } else if (kind === 'questions') {
        body += '<div class="row2 stack"><div><label for="f-type">Type</label><select id="f-type"><option value="mixed">Objective + theory</option><option value="objective">Objective only</option><option value="theory">Theory only</option></select></div>' +
          '<div><label for="f-diff">Difficulty</label><select id="f-diff"><option value="mixed">Mixed</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></div></div>' +
          '<div class="row2 stack"><div id="w-obj"><label for="f-obj">Objective questions</label><input id="f-obj" inputmode="numeric" value="10"></div>' +
          '<div id="w-th"><label for="f-th">Theory questions</label><input id="f-th" inputmode="numeric" value="3"></div></div>';
      } else if (kind === 'worksheet') {
        body += '<label for="f-act">Number of activities</label><input id="f-act" inputmode="numeric" value="10">';
      }
      body += '<label for="f-extras">Anything else? (optional)</label><input id="f-extras" maxlength="400" placeholder="' +
        ((kind === 'lesson-note' || kind === 'lesson-plan') ? 'e.g. include group work, use local examples' : kind === 'questions' ? 'e.g. WAEC style, include calculations' : 'e.g. include a puzzle') + '">';
    }
    if (TB_KINDS.indexOf(kind) > -1) { selTb = []; tbAll = []; tbShowAll = false; body = body.replace('<label for="f-extras">', tbPickerHtml() + '<label for="f-extras">'); }
    shell(
      '<h1>' + def.icon + ' ' + def.label + '</h1><p class="sub">' + def.blurb + '. It takes about a minute.</p>' +
      '<div class="card">' + body +
      '<div class="err" id="f-err"></div>' +
      '<button class="btn block" data-act="generate" data-kind="' + kind + '">Generate</button></div>',
      { title: def.label, back: 'home' }
    );
    if (kind === 'report-comments') fillClassBox();
    if (TB_KINDS.indexOf(kind) > -1) loadTbList();
  }
  async function fillClassBox() {
    var box = $('#cls-inner'); if (!box) return;
    try {
      var r = await api('GET', '/api/classes');
      if (!$('#cls-inner')) return;
      $('#cls-inner').innerHTML = r.classes.length
        ? '<select id="f-loadclass">' + r.classes.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + ' (' + c.pupilCount + ')</option>'; }).join('') + '</select>' +
          '<button class="btn alt small" style="margin-top:8px" data-act="loadclass">Load pupils</button>'
        : '<p class="hint">You have no classes yet. <button class="link" data-go="classes" style="padding:0">Add your class</button> to load pupils and scores automatically.</p>';
    } catch (e) { if ($('#cls-inner')) $('#cls-inner').innerHTML = '<p class="hint">Connect to the internet to load your classes.</p>'; }
  }
  async function loadFromClass(btn) {
    var sel = $('#f-loadclass'); if (!sel) return;
    btn.disabled = true;
    try {
      var d = await api('GET', '/api/classes/' + sel.value + '/sheet');
      var max = isPaid() ? 40 : 5;
      var recent = d.assessments.slice().sort(function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : b.id - a.id; }).slice(0, 5);
      var box = $('#pupils'); box.innerHTML = '';
      d.pupils.slice(0, max).forEach(function (p) {
        box.insertAdjacentHTML('beforeend', pupilRow());
        var row = box.lastElementChild;
        $('.p-name', row).value = p.name; $('.p-gender', row).value = p.gender || '';
        var sc = recent.map(function (a) { var v = (d.scores[a.id] || {})[p.id]; return v === undefined ? null : a.title + ' ' + v + '/' + a.maxScore; }).filter(Boolean).join(', ');
        $('.p-scores', row).value = sc.slice(0, 150);
        var at = d.attendance[p.id], tot = at ? at.P + at.A + at.L : 0;
        if (tot) $('.p-notes', row).value = 'Present ' + (at.P + at.L) + ' of ' + tot + ' days';
      });
      if (!d.pupils.length) { box.innerHTML = pupilRow(); toast('That class has no pupils yet.', true); }
      else if (d.pupils.length > max) toast('Loaded the first ' + max + ' pupils. That is the most your plan allows at a time.', true);
      else toast('Loaded ' + d.pupils.length + ' pupil' + (d.pupils.length === 1 ? '' : 's'));
      var opt = Array.prototype.slice.call($('#f-class').options).filter(function (o) { return o.value === d.class.name; })[0];
      if (opt) $('#f-class').value = d.class.name;
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  }
  // ---------------------------------------------------------------- textbooks
  var TB_KINDS = ['lesson-note', 'lesson-plan', 'scheme-of-work', 'questions', 'worksheet'];
  var selTb = [], tbAll = [], tbShowAll = false, tbTimer = null;
  function tbPickerHtml() {
    return '<div class="tb-box"><label>Textbook references (optional)</label>' +
      '<p class="hint" style="margin:0 0 6px">Pick the book your school uses. The AI will cite it exactly and follow its chapters.</p>' +
      '<div id="tb-list"><p class="hint">Loading your textbooks…</p></div>' +
      '<button type="button" class="link" data-act="addtextbook">+ Add a textbook</button></div>';
  }
  function tbLine(t) {
    var bits = [t.authors]; if (t.edition) bits.push(t.edition); if (t.year) bits.push(t.year);
    return esc(bits.join(' · '));
  }
  async function loadTbList() {
    if (!$('#tb-list')) return;
    var subj = ($('#f-subject') || {}).value || '', cls = ($('#f-class') || {}).value || '';
    try { var r = await api('GET', '/api/textbooks?subject=' + encodeURIComponent(subj) + '&className=' + encodeURIComponent(cls)); tbAll = r.textbooks; }
    catch (e) { if ($('#tb-list')) $('#tb-list').innerHTML = '<p class="hint">Connect to the internet to load your textbooks.</p>'; return; }
    drawTbList();
  }
  function drawTbList() {
    var box = $('#tb-list'); if (!box) return;
    if (!tbAll.length) { box.innerHTML = '<p class="hint">No textbooks yet. Add the book your school uses, and the AI will cite it exactly.</p>'; return; }
    var chosen = tbAll.filter(function (t) { return selTb.indexOf(t.id) > -1; });
    var rest = tbAll.filter(function (t) { return selTb.indexOf(t.id) < 0; });
    var list = tbShowAll ? chosen.concat(rest) : chosen.concat(rest.slice(0, Math.max(0, 5 - chosen.length)));
    var full = selTb.length >= 3;
    box.innerHTML = list.map(function (t) {
      var on = selTb.indexOf(t.id) > -1;
      return '<label class="tb"><input type="checkbox" data-tb="' + t.id + '"' + (on ? ' checked' : '') + (!on && full ? ' disabled' : '') + '><span><b>' + esc(t.title) + '</b>' +
        '<span class="hint" style="display:block;margin:0">' + tbLine(t) + (t.verified ? ' · Verified' : ' · My book') + (t.hasContents ? ' · contents ✓' : '') + '</span></span></label>';
    }).join('') + (tbAll.length > list.length ? '<button type="button" class="link" data-act="tbmore">Show all ' + tbAll.length + '</button>' : '');
  }
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t && t.matches && t.matches('input[data-tb]')) {
      var id = Number(t.getAttribute('data-tb'));
      if (t.checked) { if (selTb.indexOf(id) < 0 && selTb.length < 3) selTb.push(id); }
      else selTb = selTb.filter(function (x) { return x !== id; });
      drawTbList();
    } else if (t && t.id === 'f-class' && $('#tb-list')) loadTbList();
  });
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'f-subject' && $('#tb-list')) { clearTimeout(tbTimer); tbTimer = setTimeout(loadTbList, 600); }
  });

  function tbFormHtml(t) {
    t = t || {};
    var classes = (S.meta && S.meta.classes) || [];
    var lv = t.levels || [], all = lv[0] === 'All';
    var boxes = classes.map(function (c) { return '<label class="chk"><input type="checkbox" class="tb-lv" value="' + esc(c) + '"' + (!all && lv.indexOf(c) > -1 ? ' checked' : '') + '> ' + esc(c) + '</label>'; }).join('');
    function f(id, label, val, ph, max) { return '<label for="' + id + '">' + label + '</label><input id="' + id + '" maxlength="' + max + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">'; }
    return '<h3>' + (t.id ? 'Edit textbook' : 'Add a textbook') + '</h3><div style="text-align:left">' +
      f('tb-title', 'Title', t.title, 'Exactly as on the cover', 150) + f('tb-authors', 'Author(s)', t.authors, 'e.g. A. Writer and B. Author', 150) +
      '<div class="row2"><div>' + f('tb-publisher', 'Publisher', t.publisher, '', 80) + '</div><div>' + f('tb-edition', 'Edition', t.edition, 'e.g. 3rd Edition', 40) + '</div></div>' +
      '<div class="row2"><div>' + f('tb-year', 'Year', t.year, 'e.g. 2019', 4) + '</div><div>' + f('tb-isbn', 'ISBN (optional)', t.isbn, '', 20) + '</div></div>' +
      f('tb-subject', 'Subject', t.subject || (($('#f-subject') || {}).value || ''), 'e.g. Mathematics', 60) +
      '<label>Class(es)</label><div class="chk-row">' + boxes + '<label class="chk"><input type="checkbox" id="tb-all"' + (all ? ' checked' : '') + '> All classes</label></div>' +
      '<label for="tb-contents">Contents list (optional)</label><textarea id="tb-contents" style="min-height:140px" placeholder="Chapter 1 | Whole numbers | pp. 1-20&#10;Chapter 2 | Fractions | pp. 21-45">' + esc(t.contents || '') + '</textarea>' +
      '<p class="hint">Copy the chapter titles and page numbers from the contents page of your own copy. The AI uses only what you type here, so check it against the book.</p>' +
      '<div class="err" id="tb-err"></div></div>' +
      '<button class="btn" data-act="savetextbook"' + (t.id ? ' data-id="' + t.id + '"' : '') + '>Save textbook</button><button class="btn alt" data-act="closemodal">Cancel</button>';
  }
  async function saveTextbook(btn) {
    var id = btn.getAttribute('data-id');
    var levels = $('#tb-all').checked ? ['All'] : Array.prototype.slice.call(document.querySelectorAll('.tb-lv:checked')).map(function (c) { return c.value; });
    var body = { title: $('#tb-title').value, authors: $('#tb-authors').value, publisher: $('#tb-publisher').value, edition: $('#tb-edition').value, year: $('#tb-year').value, isbn: $('#tb-isbn').value, subject: $('#tb-subject').value, levels: levels, contents: $('#tb-contents').value };
    $('#tb-err').textContent = '';
    btn.disabled = true;
    try {
      var r = id ? await api('PUT', '/api/textbooks/' + id, body) : await api('POST', '/api/textbooks', body);
      closeModal(); toast('Textbook saved');
      if ($('#tb-list')) { if (!id && selTb.length < 3) selTb.push(r.id); loadTbList(); }
      else if ($('#tb-screen')) loadTbScreen();
    } catch (e) { $('#tb-err').textContent = e.message; btn.disabled = false; }
  }
  function viewTextbooks() {
    shell('<h1>My textbooks</h1><p class="sub">Add the books your school uses. The AI cites them exactly and follows their chapters. Books marked Verified come from SmartClass.</p>' +
      '<div id="tb-screen"><p class="hint">Loading…</p></div><button class="btn block" data-act="addtextbook">+ Add a textbook</button>', { title: 'Textbooks', back: 'account' });
    loadTbScreen();
  }
  async function loadTbScreen() {
    var box = $('#tb-screen'); if (!box) return;
    try {
      var r = await api('GET', '/api/textbooks');
      box.innerHTML = r.textbooks.length ? r.textbooks.map(function (t) {
        return '<button class="item" data-act="tbdetail" data-id="' + t.id + '"><span class="ico">📗</span><span><div class="t">' + esc(t.title) + '</div><div class="m">' + tbLine(t) + ' · ' + esc(t.subject) + ' · ' + (t.verified ? 'Verified' : 'My book') + '</div></span></button>';
      }).join('') : '<div class="empty">No textbooks yet. Add the first one your school uses.</div>';
    } catch (e) { box.innerHTML = '<div class="empty">' + esc(e.offline ? 'Connect to the internet to see your textbooks.' : e.message) + '</div>'; }
  }
  async function showTbDetail(id) {
    try {
      var t = await api('GET', '/api/textbooks/' + id);
      var cite = t.title + ', ' + t.authors + ([t.publisher, t.edition, t.year].filter(Boolean).length ? ' (' + [t.publisher, t.edition, t.year].filter(Boolean).join(', ') + ')' : '') + (t.isbn ? ', ISBN ' + t.isbn : '');
      modal('<h3>' + esc(t.title) + '</h3><div style="text-align:left"><p class="sub">' + esc(cite) + '</p><p class="hint">' + esc(t.subject) + ' · ' + esc(t.levels.join(', ')) + (t.verified ? ' · Verified by SmartClass' : ' · Added by you') + '</p>' +
        (t.contents ? '<label>Contents list</label><pre class="tb-contents">' + esc(t.contents) + '</pre>' : '<p class="hint">No contents list yet. Add one so the AI can cite chapters and pages.</p>') + '</div>' +
        (t.mine ? '<button class="btn" data-act="tbedit" data-id="' + t.id + '">Edit</button><button class="btn danger" data-act="tbdelete" data-id="' + t.id + '" data-name="' + esc(t.title) + '">Delete</button>' : '') +
        '<button class="btn alt" data-act="closemodal">Close</button>', true);
    } catch (e) { toast(e.message, true); }
  }
  function setPupilLimitCheck() {
    var max = isPaid() ? 40 : 5;
    return { max: max, count: document.querySelectorAll('.pupil').length };
  }
  function collect(kind) {
    var v = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
    var err = function (m) { $('#f-err').textContent = m; return null; };
    $('#f-err').textContent = '';
    if (kind === 'report-comments') {
      var pupils = [];
      document.querySelectorAll('.pupil').forEach(function (p) {
        var name = $('.p-name', p).value.trim();
        if (name) pupils.push({ name: name, gender: $('.p-gender', p).value, scores: $('.p-scores', p).value.trim(), notes: $('.p-notes', p).value.trim() });
      });
      if (!pupils.length) return err('Please add at least one pupil name.');
      jset('tt_prefs', Object.assign(jget('tt_prefs', {}), { className: v('f-class'), term: v('f-term') }));
      return { className: v('f-class'), term: v('f-term'), tone: v('f-tone'), commentBy: v('f-by'), pupils: pupils };
    }
    if (kind === 'marking') {
      if (!v('f-subject')) return err('Please enter the subject.');
      if (!v('f-question')) return err('Please enter the question.');
      var answers = [];
      document.querySelectorAll('.ans').forEach(function (row) {
        var t = $('.a-text', row).value.trim();
        if (t) answers.push({ name: $('.a-name', row).value.trim(), answer: t });
      });
      if (!answers.length) return err('Please add at least one student answer.');
      jset('tt_prefs', Object.assign(jget('tt_prefs', {}), { subject: v('f-subject'), className: v('f-class') }));
      return { subject: v('f-subject'), className: v('f-class'), totalMarks: v('f-total'), question: v('f-question'), guide: v('f-guide'), style: v('f-style'), answers: answers };
    }
    if (kind === 'scheme-of-work') {
      if (!v('f-subject')) return err('Please enter the subject.');
      jset('tt_prefs', Object.assign(jget('tt_prefs', {}), { subject: v('f-subject'), className: v('f-class'), term: v('f-term') }));
      return { subject: v('f-subject'), className: v('f-class'), term: v('f-term'), weeks: v('f-weeks'), periodsPerWeek: v('f-periods'), topics: v('f-topics'), extras: v('f-extras'), textbookIds: selTb.slice() };
    }
    if (!v('f-subject')) return err('Please enter the subject.');
    if (!v('f-topic')) return err('Please enter the topic.');
    jset('tt_prefs', Object.assign(jget('tt_prefs', {}), { subject: v('f-subject'), className: v('f-class'), term: v('f-term') || undefined }));
    var b = { subject: v('f-subject'), className: v('f-class'), topic: v('f-topic'), extras: v('f-extras') };
    if (TB_KINDS.indexOf(kind) > -1) b.textbookIds = selTb.slice();
    if (kind === 'lesson-note' || kind === 'lesson-plan') { b.term = v('f-term'); b.week = v('f-week'); b.duration = v('f-duration'); }
    if (kind === 'lesson-plan') b.method = v('f-method');
    if (kind === 'questions') { b.type = v('f-type'); b.difficulty = v('f-diff'); if (b.type !== 'theory') b.objectiveCount = v('f-obj'); if (b.type !== 'objective') b.theoryCount = v('f-th'); }
    if (kind === 'worksheet') { b.activityCount = v('f-act'); }
    return b;
  }

  var busyTimer = null;
  function showBusy(kind) {
    var msgs = KINDS[kind].busy, i = 0;
    var o = modal('<div class="spin"></div><h3 id="busy-t">' + msgs[0] + '</h3><p class="sub">Please keep this screen open.</p>');
    busyTimer = setInterval(function () { i = (i + 1) % msgs.length; var t = $('#busy-t'); if (t) t.textContent = msgs[i]; }, 4500);
    return o;
  }
  function hideBusy() { clearInterval(busyTimer); closeModal(); }
  function showLimit(message, code) {
    modal('<h3>' + (code === 'LIMIT_REACHED_MONTH' ? 'Monthly limit reached' : 'Daily limit reached') + '</h3><p class="sub">' + esc(message) + '</p>' +
      '<button class="btn" data-act="seeplans">See plans and prices</button><button class="btn alt" data-act="closemodal">Close</button>');
  }
  async function doGenerate(btn) {
    var kind = btn.getAttribute('data-kind');
    var body = collect(kind); if (!body) return;
    if (!navigator.onLine) { $('#f-err').textContent = 'You are offline. Please connect to the internet to generate.'; return; }
    btn.disabled = true; showBusy(kind);
    try {
      var r = await api('POST', '/api/generate/' + kind, body);
      S.usage = r.usage; jset('tt_usage', r.usage);
      putItem({ id: r.id, kind: r.kind, title: r.title, content: r.content, createdAt: Date.now(), updatedAt: Date.now() });
      if (r.truncated) sessionStorage.setItem('tt_trunc', String(r.id));
      hideBusy(); location.hash = '#/item/' + r.id;
    } catch (e) {
      hideBusy(); btn.disabled = false;
      if (e.code === 'LIMIT_REACHED' || e.code === 'LIMIT_REACHED_MONTH') showLimit(e.message, e.code);
      else $('#f-err').textContent = e.message;
    }
  }

  // ---------------------------------------------------------------- result view
  function parseComments(content) {
    var blocks = String(content || '').trim().split(/\n\s*\n/), out = [];
    for (var i = 0; i < blocks.length; i++) {
      var m = /^\*\*(.+?)\*\*\s*\n([\s\S]+)$/.exec(blocks[i].trim());
      if (!m) return null;
      out.push({ name: m[1], comment: m[2].trim() });
    }
    return out.length ? out : null;
  }
  async function getItem(id) {
    var c = cacheItems()[id];
    try {
      var it = await api('GET', '/api/library/' + id);
      putItem(it); return it;
    } catch (e) {
      if (c && e.offline) return c;
      throw e;
    }
  }
  function markingHtml(content) {
    var blocks = String(content || '').trim().split(/\n\s*\n/), out = '', buf = [];
    function flush() { if (buf.length) { out += '<div class="doc">' + window.md(buf.join('\n\n')) + '</div>'; buf = []; } }
    blocks.forEach(function (b) {
      var m = /^\*\*(.+?)\*\*\s·\s(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\n([\s\S]+)$/.exec(b.trim());
      if (m) {
        flush();
        var pct = Number(m[3]) ? Number(m[2]) / Number(m[3]) : 0, cls = pct >= 0.7 ? 'good' : pct >= 0.4 ? 'mid' : 'low';
        out += '<div class="cmt"><div class="mk-head"><b>' + esc(m[1]) + '</b><span class="score ' + cls + '">' + esc(m[2]) + '/' + esc(m[3]) + '</span></div><div>' + esc(m[4]) +
          '</div><button class="btn alt small no-print" data-act="copytext" data-text="' + esc(m[1] + ': ' + m[2] + '/' + m[3] + '. ' + m[4]) + '">Copy feedback</button></div>';
      } else buf.push(b);
    });
    flush();
    return out;
  }
  function itemBodyHtml(it) {
    if (it.kind === 'marking') return markingHtml(it.content);
    if (it.kind === 'report_comments') {
      var list = parseComments(it.content);
      if (list) {
        return list.map(function (c) {
          return '<div class="cmt"><b>' + esc(c.name) + '</b><div>' + esc(c.comment) + '</div><button class="btn alt small no-print" data-act="copytext" data-text="' + esc(c.comment) + '">Copy comment</button></div>';
        }).join('');
      }
    }
    return '<div class="doc">' + window.md(it.content) + '</div>';
  }
  var currentItem = null;
  async function viewItem(id) {
    shell('<div class="empty">Opening…</div>', { title: 'Saved item', back: 'library' });
    var it;
    try { it = await getItem(id); }
    catch (e) {
      shell('<div class="empty">' + esc(e.offline ? 'This item was not saved on this phone. Connect to the internet to open it.' : e.message) +
        (e.code === 'LIBRARY_LOCKED' ? '<br><br><button class="btn" data-act="seeplans">See plans</button>' : '') + '</div>', { title: 'Saved item', back: 'library' }); return;
    }
    currentItem = it;
    var truncated = sessionStorage.getItem('tt_trunc') === String(id);
    var canShare = !!navigator.share || (IS_NATIVE && !!plugin('Share'));
    shell(
      (truncated ? '<div class="warn no-print">This answer may be cut short because it was very long. Try again with fewer items.</div>' : '') +
      '<div class="actions no-print">' +
      '<button class="btn small" data-act="copyitem">Copy</button>' +
      (canShare ? '<button class="btn small alt" data-act="shareitem">Share</button>' : '') +
      '<button class="btn small alt" data-act="wordItem">Word</button>' +
      (IS_NATIVE ? '' : '<button class="btn small alt" data-act="printitem">Print / PDF</button>') +
      '<button class="btn small alt" data-act="edititem">Edit</button>' +
      (it.kind === 'timetable' && it.meta ? '<button class="btn small alt" data-act="ttagain">Another arrangement</button>' : '') +
      '<button class="btn small danger" data-act="deleteitem">Delete</button></div>' +
      '<div id="item-body">' + itemBodyHtml(it) + '</div>' +
      '<p class="hint no-print">Saved in your library. ' + fmtDate(it.createdAt) + '</p>',
      { title: it.title, back: 'library' }
    );
  }
  function plainText(it) {
    if (it.kind === 'report_comments') {
      var list = parseComments(it.content);
      if (list) return list.map(function (c) { return c.name + ': ' + c.comment; }).join('\n\n');
    }
    return it.content;
  }
  // Saves a text file. In a browser it downloads; in the Android app it opens the share sheet
  // so the teacher can save to Drive, send on WhatsApp, open in Word, and so on.
  function saveFile(filename, mime, text) {
    var fs = plugin('Filesystem'), sh = plugin('Share');
    if (IS_NATIVE && fs && sh) {
      return fs.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' })
        .then(function (r) { return sh.share({ title: filename, url: r.uri, dialogTitle: 'Save or share' }); })
        .catch(function (e) { if (!/cancel/i.test(String((e && e.message) || e))) toast('Could not save the file.', true); });
    }
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return Promise.resolve();
  }
  function downloadWord(it) {
    var html = it.kind === 'report_comments' && parseComments(it.content)
      ? '<h1>' + esc(it.title) + '</h1>' + parseComments(it.content).map(function (c) { return '<p><b>' + esc(c.name) + '</b><br>' + esc(c.comment) + '</p>'; }).join('')
      : window.md(it.content);
    if (!isPaid()) html += '<p style="margin-top:24pt;color:#777777;font-size:9pt">Made with SmartClass Teacher AI (free plan)</p>';
    var land = it.kind === 'scheme_of_work' || it.kind === 'timetable';
    var doc = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>' + esc(it.title) +
      '</title><style>' + (land ? '@page WordSection1{size:841.9pt 595.3pt;mso-page-orientation:landscape;margin:36pt}div.WordSection1{page:WordSection1}' : '') +
      'body{font-family:Calibri,Arial,sans-serif;font-size:' + (land ? '10' : '12') + 'pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #444;padding:4px;vertical-align:top}th{background:#eee}h1{text-align:center;font-size:16pt}h2{font-size:13pt}</style></head><body><div class="WordSection1">' + html + '</div></body></html>';
    saveFile((it.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'teacher-ai') + '.doc', 'application/msword', '\ufeff' + doc);
  }
  function startEdit() {
    var it = currentItem;
    $('#item-body').innerHTML =
      '<div class="card"><label for="e-title">Title</label><input id="e-title" maxlength="150" value="' + esc(it.title) + '">' +
      '<label for="e-content">Text</label><textarea id="e-content" style="min-height:360px;font-family:ui-monospace,Consolas,monospace;font-size:.88rem">' + esc(it.content) + '</textarea>' +
      '<div class="err" id="e-err"></div>' +
      '<button class="btn block" data-act="saveedit">Save changes</button><button class="btn alt block" data-act="canceledit">Cancel</button></div>';
  }
  async function saveEdit(btn) {
    var title = $('#e-title').value.trim(), content = $('#e-content').value;
    if (!title || !content.trim()) { $('#e-err').textContent = 'Title and text cannot be empty.'; return; }
    btn.disabled = true;
    try { var it = await api('PUT', '/api/library/' + currentItem.id, { title: title, content: content }); putItem(it); toast('Saved'); viewItem(currentItem.id); }
    catch (e) { $('#e-err').textContent = e.message; btn.disabled = false; }
  }
  function confirmDelete() {
    modal('<h3>Delete this item?</h3><p class="sub">This cannot be undone.</p><button class="btn danger" data-act="dodelete">Yes, delete</button><button class="btn alt" data-act="closemodal">Keep it</button>');
  }
  async function doDelete() {
    try { await api('DELETE', '/api/library/' + currentItem.id); dropItem(currentItem.id); closeModal(); toast('Deleted'); location.hash = '#/library'; }
    catch (e) { closeModal(); toast(e.message, true); }
  }

  // ---------------------------------------------------------------- library
  var libFilter = 'all', libSearch = '';
  async function viewLibrary() {
    shell('<h1>My Library</h1><p class="sub" id="lib-sub">Everything you have made is saved here.</p>' +
      '<div id="lib-banner"></div>' +
      '<div class="chips no-print" id="chips"></div>' +
      '<input id="lib-q" type="search" placeholder="Search by title" value="' + esc(libSearch) + '" style="margin-bottom:12px">' +
      '<div id="lib-list"><p class="hint">Loading…</p></div>', { title: 'My Library', nav: 'library' });
    var items, offline = false;
    window.__libLocked = 0;
    try { var r = await api('GET', '/api/library?limit=100'); items = r.items; window.__libLocked = r.lockedCount || 0; jset('tt_list', items); }
    catch (e) { items = jget('tt_list', []); offline = true; }
    window.__libItems = items;
    if (offline && $('#lib-sub')) $('#lib-sub').textContent = 'Offline: showing what is saved on this phone. Items you opened before can be read offline.';
    drawLibrary();
  }
  function drawLibrary() {
    var items = window.__libItems || [];
    var chips = [['all', 'All'], ['lesson_note', 'Lesson notes'], ['lesson_plan', 'Lesson plans'], ['scheme_of_work', 'Schemes'], ['timetable', 'Timetables'], ['questions', 'Questions'], ['marking', 'Marking'], ['worksheet', 'Worksheets'], ['report_comments', 'Comments']];
    if ($('#chips')) $('#chips').innerHTML = chips.map(function (c) { return '<button class="chip' + (libFilter === c[0] ? ' on' : '') + '" data-act="filter" data-v="' + c[0] + '">' + c[1] + '</button>'; }).join('');
    if ($('#lib-banner')) $('#lib-banner').innerHTML = window.__libLocked
      ? '<div class="banner"><span>' + window.__libLocked + ' older item' + (window.__libLocked === 1 ? ' is' : 's are') + ' locked on the free plan. Nothing is deleted. Upgrade to Teacher Plus to open them.</span><button class="btn small" data-act="seeplans">See plans</button></div>' : '';
    var q = libSearch.toLowerCase();
    var list = items.filter(function (it) { return (libFilter === 'all' || it.kind === libFilter) && (!q || it.title.toLowerCase().indexOf(q) > -1); });
    if ($('#lib-list')) $('#lib-list').innerHTML = list.length ? list.map(itemButton).join('') : '<div class="empty">' + (items.length ? 'No matching items.' : 'Nothing saved yet. Make your first lesson note from the Home screen.') + '</div>';
  }

  // ---------------------------------------------------------------- account
  function viewAccount() {
    var u = S.user, us = S.usage || { used: 0, limit: 0 };
    shell(
      '<h1>Account</h1>' +
      '<div class="card"><div class="kv"><span>Name</span><b>' + esc(u.name) + '</b></div>' +
      (u.email ? '<div class="kv"><span>Email</span><b>' + esc(u.email) + '</b></div>' : '') +
      (u.phone ? '<div class="kv"><span>Phone</span><b>' + esc(u.phone) + '</b></div>' : '') +
      '<div class="kv"><span>Plan</span><b>' + (isPaid() ? 'Teacher Plus (' + esc((plansInfo()[u.plan] || { label: u.plan }).label) + ')' : 'Free') + '</b></div>' +
      (isPaid() && u.planExpiresAt ? '<div class="kv"><span>Valid until</span><b>' + fmtDate(u.planExpiresAt) + '</b></div>' : '') +
      '<div class="kv"><span>Used today</span><b>' + us.used + ' of ' + us.limit + '</b></div>' +
      (us.monthlyLimit ? '<div class="kv"><span>Used this month</span><b>' + (us.monthlyUsed || 0) + ' of ' + us.monthlyLimit + '</b></div>' : '') + '</div>' +
      plansCard() +
      '<div class="card"><b>My textbooks</b><p class="sub">Add the books your school uses, with their contents. The AI will cite them exactly in lesson notes, schemes, questions and worksheets.</p><button class="btn alt" data-go="textbooks">Open my textbooks</button></div>' +
      (S.installEvt ? '<div class="card"><b>Install the app</b><p class="sub">Add it to your home screen.</p><button class="btn alt" data-act="install">Install</button></div>' : '') +
      '<div class="card"><b>Change password</b>' +
      '<label for="c-old">Current password</label><input id="c-old" type="password" autocomplete="current-password">' +
      '<label for="c-new">New password (8+ characters)</label><input id="c-new" type="password" autocomplete="new-password">' +
      '<div class="err" id="c-err"></div><button class="btn block alt" data-act="changepw">Change password</button></div>' +
      '<button class="btn block alt" data-act="logout">Log out</button>' +
      '<p class="hint" style="text-align:center;margin-top:14px"><a href="' + siteUrl('/privacy') + '" target="_blank" rel="noopener" style="color:var(--brand)">Privacy Policy</a> · <a href="' + siteUrl('/terms') + '" target="_blank" rel="noopener" style="color:var(--brand)">Terms of Use</a> · <a href="mailto:support@smartclassaiacademy.com" style="color:var(--brand)">support@smartclassaiacademy.com</a></p>' +
      '<div class="card" style="margin-top:22px"><b>Delete my account</b><p class="sub">This permanently removes your account, your library, your classes, attendance and scores.</p>' +
      '<label for="d-pw">Enter your password to confirm</label><input id="d-pw" type="password" autocomplete="current-password">' +
      '<div class="err" id="d-err"></div><button class="btn block danger" data-act="deleteaccount">Delete my account</button></div>',
      { title: 'Account', nav: 'account' }
    );
  }
  function plansCard() {
    var info = plansInfo(), cl = (S.meta && S.meta.classLimits) || { free: { classes: 2, pupils: 50 }, paid: { classes: 10, pupils: 80 } };
    var lim = (S.meta && S.meta.limits) || { free: 3, paid: 30 };
    var rows = ['monthly', 'term', 'year'].map(function (k) {
      var p = info[k]; if (!p) return '';
      var note = k === 'term' ? 'Save ' + naira(3 * info.monthly.price - p.price) + ' (3 months)' : k === 'year' ? 'Best value: about ' + naira(p.price / 12) + ' a month' : 'Pay month by month';
      var msg = 'Hello, I would like to subscribe to SmartClass Teacher AI Teacher Plus: ' + p.label + ' (' + naira(p.price) + '). My account: ' + whoAmI();
      return '<div class="plan"><div><b>' + esc(p.label) + '</b><div class="hint" style="margin:0">' + esc(note) + '</div></div>' +
        '<div class="plan-r"><b>' + naira(p.price) + '</b><a class="btn small" href="' + waLink(msg) + '" target="_blank" rel="noopener">' + (isPaid() ? 'Renew' : 'Choose') + '</a></div></div>';
    }).join('');
    return '<div class="card"><b>' + (isPaid() ? 'Renew or change your plan' : 'Teacher Plus') + '</b>' +
      '<ul class="perks"><li><b>' + lim.paid + '</b> generations a day (free: ' + lim.free + ' a day, ' + (lim.freeMonthly || 20) + ' a month)</li>' +
      '<li>Report comments for up to <b>40 pupils</b> at once (free: 5)</li>' +
      '<li>Mark up to <b>15 answers</b> at once (free: 3)</li>' +
      '<li><b>' + cl.paid.classes + ' classes</b> of up to ' + cl.paid.pupils + ' pupils (free: ' + cl.free.classes + ' classes of ' + cl.free.pupils + ')</li>' +
      '<li><b>Unlimited library</b> (free: your newest 30 items)</li>' +
      '<li>No “Made with SmartClass Teacher AI” line on Word and Share</li>' +
      '<li>WhatsApp support</li></ul>' + rows +
      '<p class="hint">Payment is by WhatsApp for now. We activate your plan as soon as we confirm it. Online payment is coming soon.</p></div>';
  }
  async function changePw(btn) {
    var o = $('#c-old').value, n = $('#c-new').value; $('#c-err').textContent = '';
    if (!o || n.length < 8) { $('#c-err').textContent = 'Enter your current password and a new one of at least 8 characters.'; return; }
    btn.disabled = true;
    try { var s = await api('POST', '/api/me/password', { oldPassword: o, newPassword: n }); saveSession(s); toast('Password changed'); $('#c-old').value = ''; $('#c-new').value = ''; }
    catch (e) { $('#c-err').textContent = e.message; }
    btn.disabled = false;
  }
  async function deleteAccount(btn) {
    var pw = $('#d-pw').value; $('#d-err').textContent = '';
    if (!pw) { $('#d-err').textContent = 'Enter your password to confirm.'; return; }
    modal('<h3>Delete your account?</h3><p class="sub">Everything will be removed and cannot be recovered.</p><button class="btn danger" data-act="dodeleteaccount">Yes, delete everything</button><button class="btn alt" data-act="closemodal">Cancel</button>');
  }
  async function doDeleteAccount() {
    var pw = ($('#d-pw') || {}).value || '';
    try { await api('DELETE', '/api/me', { password: pw }); closeModal(); clearSession(); toast('Your account has been deleted'); location.hash = '#/auth'; viewAuth(); }
    catch (e) { closeModal(); var el = $('#d-err'); if (el) el.textContent = e.message; }
  }

  // ---------------------------------------------------------------- events
  var actions = {
    auth: doAuth,
    authmode: function () { authMode = authMode === 'signup' ? 'login' : 'signup'; viewAuth(); },
    generate: doGenerate,
    addpupil: function () {
      var c = setPupilLimitCheck();
      if (c.count >= c.max) return toast('You can add up to ' + c.max + ' pupils at a time' + (isPaid() ? '.' : ' on the free plan.'), true);
      $('#pupils').insertAdjacentHTML('beforeend', pupilRow());
    },
    rmpupil: function (el) { var p = el.closest('.pupil'); if (document.querySelectorAll('.pupil').length > 1) p.remove(); else toast('Keep at least one pupil.', true); },
    pastebox: function () { $('#pastebox').classList.toggle('hide'); },
    pasteadd: function () {
      var names = $('#f-paste').value.split('\n').map(function (n) { return n.replace(/^\s*\d+[.)\-\s]+/, '').trim(); }).filter(Boolean);
      var max = setPupilLimitCheck().max, box = $('#pupils');
      var rows = box.querySelectorAll('.pupil');
      if (rows.length === 1 && !$('.p-name', rows[0]).value.trim()) box.innerHTML = '';
      var added = 0;
      names.forEach(function (n) {
        if (box.querySelectorAll('.pupil').length >= max) return;
        box.insertAdjacentHTML('beforeend', pupilRow());
        var all = box.querySelectorAll('.pupil'); $('.p-name', all[all.length - 1]).value = n.slice(0, 60); added++;
      });
      if (!box.querySelector('.pupil')) box.innerHTML = pupilRow();
      if (added < names.length) toast('Only ' + max + ' pupils fit at a time on your plan.', true);
      $('#f-paste').value = ''; $('#pastebox').classList.add('hide');
    },
    addanswer: function () {
      var max = isPaid() ? 15 : 3;
      if (document.querySelectorAll('.ans').length >= max) return toast('You can mark up to ' + max + ' answers at a time' + (isPaid() ? '.' : ' on the free plan.'), true);
      $('#answers').insertAdjacentHTML('beforeend', answerRow());
    },
    rmanswer: function (el) { if (document.querySelectorAll('.ans').length > 1) el.closest('.ans').remove(); else toast('Keep at least one student.', true); },
    loadclass: loadFromClass,
    copyitem: function () { copyText(plainText(currentItem)); },
    copytext: function (el) { copyText(el.getAttribute('data-text')); },
    shareitem: function () {
      var sh = plugin('Share'), txt = plainText(currentItem) + (isPaid() ? '' : '\n\n— Made with SmartClass Teacher AI');
      if (IS_NATIVE && sh) sh.share({ title: currentItem.title, text: txt, dialogTitle: 'Share' }).catch(function () { });
      else if (navigator.share) navigator.share({ title: currentItem.title, text: txt }).catch(function () { });
    },
    wordItem: function () { downloadWord(currentItem); },
    printitem: function () {
      var st = null;
      if (currentItem && (currentItem.kind === 'scheme_of_work' || currentItem.kind === 'timetable')) { st = document.createElement('style'); st.textContent = '@page{size:landscape}'; document.head.appendChild(st); }
      window.print();
      if (st) setTimeout(function () { st.remove(); }, 1500);
    },
    edititem: startEdit,
    canceledit: function () { viewItem(currentItem.id); },
    saveedit: saveEdit,
    deleteitem: confirmDelete,
    dodelete: doDelete,
    closemodal: closeModal,
    ttagain: async function (btn) {
      var m = currentItem && currentItem.meta; if (!m) return;
      btn.disabled = true;
      try {
        var body = Object.assign({}, m, { seed: Math.floor(Math.random() * 2147483647) });
        var r = await api('POST', '/api/timetable/make', body);
        go('#/item/' + r.id); toast('Here is another arrangement');
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    },
    addtextbook: function () { modal(tbFormHtml(null), true); },
    savetextbook: saveTextbook,
    tbmore: function () { tbShowAll = true; drawTbList(); },
    tbdetail: function (el) { showTbDetail(el.getAttribute('data-id')); },
    tbedit: async function (el) {
      try { var t = await api('GET', '/api/textbooks/' + el.getAttribute('data-id')); modal(tbFormHtml(t), true); } catch (e) { toast(e.message, true); }
    },
    tbdelete: function (el) {
      modal('<h3>Delete ' + esc(el.getAttribute('data-name')) + '?</h3><p class="sub">It will be removed from your textbooks. Notes you already made keep their references.</p>' +
        '<button class="btn danger" data-act="dotbdelete" data-id="' + el.getAttribute('data-id') + '">Yes, delete</button><button class="btn alt" data-act="closemodal">Keep it</button>');
    },
    dotbdelete: async function (el) {
      try { await api('DELETE', '/api/textbooks/' + el.getAttribute('data-id')); closeModal(); toast('Deleted'); selTb = selTb.filter(function (x) { return String(x) !== el.getAttribute('data-id'); }); if ($('#tb-screen')) loadTbScreen(); }
      catch (e) { closeModal(); toast(e.message, true); }
    },
    seeplans: function () { closeModal(); go('#/account'); },
    lockeditem: function () {
      modal('<h3>Locked on the free plan</h3><p class="sub">The free plan opens your newest ' + ((S.meta && S.meta.classLimits && S.meta.classLimits.free.library) || 30) + ' items. This older item is safe and nothing is deleted. Upgrade to Teacher Plus to open everything again.</p>' +
        '<button class="btn" data-act="seeplans">See plans and prices</button><button class="btn alt" data-act="closemodal">Close</button>');
    },
    filter: function (el) { libFilter = el.getAttribute('data-v'); drawLibrary(); },
    changepw: changePw,
    logout: function () { clearSession(); authMode = 'login'; location.hash = '#/auth'; viewAuth(); },
    deleteaccount: deleteAccount,
    dodeleteaccount: doDeleteAccount,
    install: function () {
      if (!S.installEvt) return;
      S.installEvt.prompt(); S.installEvt.userChoice.then(function () { S.installEvt = null; route(); });
    }
  };

  Object.keys(TT.actions).forEach(function (k) { actions[k] = TT.actions[k]; });
  TT.api = api; TT.shell = shell; TT.esc = esc; TT.toast = toast; TT.modal = modal; TT.closeModal = closeModal;
  TT.go = go; TT.route = route; TT.copyText = copyText; TT.saveFile = saveFile; TT.isPaid = isPaid;
  TT.classNames = function () { return (S.meta && S.meta.classes) || []; };
  // Fills the subject and class for the next lesson plan or note (used from the timetable).
  TT.prefill = function (subject, className) {
    var pr = jget('tt_prefs', {}), classes = TT.classNames();
    pr.subject = subject || pr.subject;
    var typed = String(className || '').toLowerCase().replace(/\s+/g, ''), best = '';
    classes.forEach(function (c) { var k = c.toLowerCase().replace(/\s+/g, ''); if (typed.indexOf(k) === 0 && k.length > best.length) best = c; });
    if (best) pr.className = best;
    jset('tt_prefs', pr);
  };

  document.addEventListener('click', function (e) {
    var a = e.target.closest('[data-act]');
    if (a) { var fn = actions[a.getAttribute('data-act')]; if (fn) { e.preventDefault(); fn(a); } return; }
    var g = e.target.closest('[data-go]');
    if (g) { e.preventDefault(); var to = '#/' + g.getAttribute('data-go'); if (location.hash === to) route(); else location.hash = to; }
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'f-type') {
      var t = e.target.value;
      $('#w-obj').classList.toggle('hide', t === 'theory'); $('#w-th').classList.toggle('hide', t === 'objective');
    }
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'lib-q') { libSearch = e.target.value; drawLibrary(); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.target.id === 'a-id' || e.target.id === 'a-pw' || e.target.id === 'a-name')) { var b = $('[data-act="auth"]'); if (b) b.click(); }
  });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.token && S.user) refreshMe().then(function (changed) { if (changed) route(); });
  });
  window.addEventListener('online', function () { var o = $('#offline'); if (o) o.classList.add('hide'); });
  window.addEventListener('offline', function () { var o = $('#offline'); if (o) o.classList.remove('hide'); });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); S.installEvt = e; });

  if (!IS_NATIVE && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { }); });
  }
  route();
})();
