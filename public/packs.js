'use strict';
/* Term Pack: plan a whole term (or year): the topics of each term, the three schemes of work, then a lesson for every week. */
(function () {
  var T = window.TT = window.TT || {};
  T.views = T.views || {};
  T.actions = T.actions || {};
  var A = T.actions;

  function esc(s) { return T.esc(s); }
  function api(m, p, b) { return T.api(m, p, b); }
  function $(s, el) { return (el || document).querySelector(s); }
  function all(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function offlineMsg(e) { return e.offline ? 'This part needs the internet. Please connect and try again.' : e.message; }
  function seePlans(e) { return (e.code === 'LIMIT_REACHED' || e.code === 'LIMIT_REACHED_MONTH' || e.code === 'PLUS_ONLY' || e.code === 'LIMIT') ? ' <button type="button" class="link" data-act="seeplans" style="padding:0">See plans</button>' : ''; }

  var cur = null;          // the pack being shown
  var ticks = {};          // which weeks the teacher has ticked or unticked, kept when the page redraws
  var stopFlag = false;
  var DOC = { 'lesson-plan': { code: 'lesson_plan', label: 'lesson plan', field: 'plan' }, 'lesson-note': { code: 'lesson_note', label: 'lesson note', field: 'note' } };

  T.views.packs = function (parts) {
    if (parts[0] === 'pack') {
      if (parts[1] === 'new') return editView(null);
      if (parts[2] === 'edit') return editView(Number(parts[1]));
      return detailView(Number(parts[1]));
    }
    return listView();
  };

  // ------------------------------------------------------------ the list
  async function listView() {
    T.shell('<h1>Term Pack</h1><p class="sub">Plan a whole term at once: the AI suggests which topics go in each term, makes the three schemes of work, then a lesson plan or lesson note for every week.</p>' +
      '<div id="pk-list"><p class="hint">Loading…</p></div><button class="btn block" data-act="newpack" id="pk-new">+ New Term Pack</button>', { title: 'Term Pack', back: 'home', nav: 'home' });
    try {
      var r = await api('GET', '/api/packs');
      if (r.limit < 1) {
        $('#pk-new').style.display = 'none';
        $('#pk-list').innerHTML = '<div class="card"><b>Term Pack is part of Teacher Plus</b><p class="sub">With Teacher Plus you can plan a whole term in a few taps: split the topics across the three terms, make the three schemes of work, then a lesson for every week, in your school\'s own format.</p><button class="btn" data-act="seeplans">See plans and prices</button></div>';
        return;
      }
      $('#pk-list').innerHTML = r.packs.length ? r.packs.map(function (p) {
        return '<button class="item" data-go="pack/' + p.id + '"><span class="ico">📦</span><span><div class="t">' + esc(p.name) + '</div><div class="m">' + esc(p.className) + ' · ' + p.schemes + ' of 3 schemes · ' + p.lessons + ' week' + (p.lessons === 1 ? '' : 's') + ' with lessons</div></span></button>';
      }).join('') : '<div class="empty">No Term Packs yet. Tap "New Term Pack" to start.</div>';
    } catch (e) { $('#pk-list').innerHTML = '<div class="empty">' + esc(offlineMsg(e)) + '</div>'; }
  }
  A.newpack = function () { T.go('#/pack/new'); };

  // ------------------------------------------------------------ the editor
  async function editView(id) {
    T.shell('<div class="empty">Opening…</div>', { title: 'Term Pack', back: id ? 'pack/' + id : 'packs', nav: 'home' });
    var pack = null, books = [], fmts = [];
    try {
      var calls = [api('GET', '/api/textbooks'), api('GET', '/api/formats')];
      if (id) calls.push(api('GET', '/api/packs/' + id));
      var rs = await Promise.all(calls);
      books = rs[0].textbooks || []; fmts = (rs[1].formats || []).filter(function (f) { return f.status === 'approved'; });
      if (id) pack = rs[2];
    } catch (e) { T.shell('<div class="empty">' + esc(offlineMsg(e)) + seePlans(e) + '</div>', { title: 'Term Pack', back: 'packs', nav: 'home' }); return; }
    var p = pack || { name: '', subject: '', className: '', weeks: [13, 13, 12], topics: [[], [], []], textbookIds: [], settings: { detail: 'standard', duration: 40 } };
    var s = p.settings || {};
    function fmtSel(type, sel, idn) {
      return '<select id="' + idn + '"><option value="">Standard format</option>' + fmts.filter(function (f) { return f.type === type; }).map(function (f) { return '<option value="' + f.id + '"' + (sel === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</select>';
    }
    var classes = T.classNames();
    var weekSel = [0, 1, 2].map(function (i) {
      var o = ''; for (var w = 8; w <= 14; w++) o += '<option value="' + w + '"' + (p.weeks[i] === w ? ' selected' : '') + '>' + w + '</option>';
      return '<div><label for="pk-w' + i + '">' + ['First', 'Second', 'Third'][i] + ' term</label><select id="pk-w' + i + '">' + o + '</select></div>';
    }).join('');
    T.shell('<h1>' + (id ? 'Edit' : 'New') + ' Term Pack</h1>' +
      '<div class="card"><label for="pk-subject" style="margin-top:0">Subject</label><input id="pk-subject" maxlength="60" placeholder="e.g. Mathematics" value="' + esc(p.subject) + '">' +
      '<label for="pk-class">Class</label><select id="pk-class"><option value="">Choose the class</option>' + classes.map(function (c) { return '<option' + (p.className === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select>' +
      '<label for="pk-name">Name (optional)</label><input id="pk-name" maxlength="80" placeholder="e.g. JSS 3 Mathematics, 2026/2027" value="' + esc(pack ? p.name : '') + '">' +
      '<label>Weeks in each term</label><div class="pk-row3">' + weekSel + '</div></div>' +
      '<div class="card"><b>Textbook (optional)</b><p class="hint" style="margin:4px 0">Pick up to 3. The AI follows its chapters and cites it exactly.</p>' +
      (books.length ? books.map(function (b) { return '<label class="chk"><input type="checkbox" class="pk-book" value="' + b.id + '"' + ((p.textbookIds || []).indexOf(b.id) > -1 ? ' checked' : '') + '> ' + esc(b.title) + (b.hasContents ? ' <span class="hint">· contents ✓</span>' : '') + '</label>'; }).join('')
        : '<p class="hint">No textbooks yet. <button type="button" class="link" data-go="textbooks" style="padding:0">Add the book your school uses</button> and the AI will cite it exactly.</p>') + '</div>' +
      '<div class="card"><b>Topics for each term</b><p class="hint" style="margin:4px 0">Type them, one per line, or let the AI suggest the split. Suggesting uses 1 generation.</p>' +
      '<label for="pk-syl">Topics from your syllabus (optional)</label><textarea id="pk-syl" maxlength="3000" style="min-height:90px" placeholder="Paste or type the topics for the whole year. The AI will spread them over the three terms."></textarea>' +
      '<button type="button" class="btn alt small" data-act="pksuggest">✨ Suggest the split</button><div id="pk-split-msg" class="hint" aria-live="polite"></div>' +
      [0, 1, 2].map(function (i) { return '<label for="pk-t' + i + '">' + ['First', 'Second', 'Third'][i] + ' term topics</label><textarea id="pk-t' + i + '" style="min-height:110px" placeholder="One topic per line">' + esc((p.topics[i] || []).join('\n')) + '</textarea>'; }).join('') + '</div>' +
      '<div class="card"><b>How the documents are written</b>' +
      '<label for="pk-fs">Scheme of work layout</label>' + fmtSel('scheme-of-work', s.schemeFormatId, 'pk-fs') +
      '<label for="pk-fp">Lesson plan layout</label>' + fmtSel('lesson-plan', s.planFormatId, 'pk-fp') +
      '<label for="pk-fn">Lesson note layout</label>' + fmtSel('lesson-note', s.noteFormatId, 'pk-fn') +
      '<p class="hint" style="margin:6px 0 0">Your school formats are under <button type="button" class="link" data-go="formats" style="padding:0">Account, My school formats</button>.</p>' +
      '<label for="pk-detail">Level of detail</label><select id="pk-detail">' + [['simple', 'Simple (shorter)'], ['standard', 'Standard'], ['detailed', 'Detailed (more examples)']].map(function (d) { return '<option value="' + d[0] + '"' + (s.detail === d[0] ? ' selected' : '') + '>' + d[1] + '</option>'; }).join('') + '</select>' +
      '<label for="pk-dur">Lesson time (minutes)</label><input id="pk-dur" type="number" inputmode="numeric" min="15" max="180" value="' + (s.duration || 40) + '"></div>' +
      '<div class="err" id="pk-err"></div><button class="btn block" data-act="pksave" data-id="' + (id || '') + '">Save Term Pack</button>', { title: id ? 'Edit Term Pack' : 'New Term Pack', back: id ? 'pack/' + id : 'packs', nav: 'home' });
  }
  function collectEditor() {
    function lines(id) { return ($(id).value || '').split('\n').map(function (x) { return x.trim(); }).filter(Boolean); }
    function sel(id) { var v = $(id).value; return v ? Number(v) : null; }
    return {
      subject: $('#pk-subject').value.trim(), className: $('#pk-class').value, name: $('#pk-name').value.trim(),
      weeks: [0, 1, 2].map(function (i) { return Number($('#pk-w' + i).value); }),
      textbookIds: all('.pk-book').filter(function (c) { return c.checked; }).map(function (c) { return Number(c.value); }),
      terms: [lines('#pk-t0'), lines('#pk-t1'), lines('#pk-t2')],
      settings: { schemeFormatId: sel('#pk-fs'), planFormatId: sel('#pk-fp'), noteFormatId: sel('#pk-fn'), detail: $('#pk-detail').value, duration: Number($('#pk-dur').value) || 40 },
    };
  }
  document.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('pk-book')) {
      if (all('.pk-book').filter(function (c) { return c.checked; }).length > 3) { e.target.checked = false; T.toast('Pick up to 3 textbooks.', true); }
    }
  });
  A.pksuggest = async function (btn) {
    var msg = $('#pk-split-msg'), b = collectEditor();
    msg.className = 'hint'; msg.innerHTML = '';
    if (!b.subject || !b.className) { msg.className = 'hint err'; msg.textContent = 'Please enter the subject and choose the class first.'; return; }
    if (!navigator.onLine) { msg.className = 'hint err'; msg.textContent = 'You are offline. Please connect to the internet.'; return; }
    btn.disabled = true; msg.textContent = 'Planning the year… this can take up to a minute.';
    try {
      var r = await api('POST', '/api/packs/suggest-split', { subject: b.subject, className: b.className, weeks: b.weeks, textbookIds: b.textbookIds, topicsText: ($('#pk-syl').value || '').trim() });
      T.setUsage(r.usage);
      r.terms.forEach(function (list, i) { $('#pk-t' + i).value = list.join('\n'); });
      msg.innerHTML = '✓ Suggested. <b>Please read each term and change anything you want</b> before you save.';
    } catch (e) { msg.className = 'hint err'; msg.innerHTML = esc(offlineMsg(e)) + seePlans(e); }
    btn.disabled = false;
  };
  A.pksave = async function (btn) {
    var err = $('#pk-err'); err.innerHTML = '';
    var b = collectEditor(), id = btn.getAttribute('data-id');
    if (!b.subject) { err.textContent = 'Please enter the subject.'; return; }
    if (!b.className) { err.textContent = 'Please choose the class.'; return; }
    btn.disabled = true;
    try {
      var r = id ? await api('PUT', '/api/packs/' + id, b) : await api('POST', '/api/packs', b);
      T.toast('Saved'); T.go('#/pack/' + r.id);
    } catch (e) { err.innerHTML = esc(offlineMsg(e)) + seePlans(e); btn.disabled = false; }
  };

  // ------------------------------------------------------------ the pack page
  async function detailView(id) {
    T.shell('<div class="empty">Opening…</div>', { title: 'Term Pack', back: 'packs', nav: 'home' });
    try { cur = await api('GET', '/api/packs/' + id); }
    catch (e) { T.shell('<div class="empty">' + esc(offlineMsg(e)) + '</div>', { title: 'Term Pack', back: 'packs', nav: 'home' }); return; }
    ticks = {};
    draw();
  }
  function draw() {
    var p = cur, missing = p.terms.filter(function (t) { return !t.scheme; }).length;
    var html = '<h1>' + esc(p.name) + '</h1><p class="sub">' + esc(p.className) + ' · ' + p.weeks.join(' + ') + ' weeks · ' + p.settings.duration + ' minutes a lesson</p>' +
      '<div class="fs-tools" style="margin-bottom:10px"><button class="btn small alt" data-go="pack/' + p.id + '/edit">Edit</button><button class="link danger" data-act="pkdelete">Delete this pack</button></div>';
    if (missing) html += '<button class="btn block" data-act="pkallschemes">Make ' + (missing === 3 ? 'the 3 schemes of work' : 'the ' + missing + ' missing scheme' + (missing === 1 ? '' : 's')) + ' (uses ' + missing + ' generation' + (missing === 1 ? '' : 's') + ')</button>';
    html += p.terms.map(termHtml).join('');
    T.shell(html, { title: 'Term Pack', back: 'packs', nav: 'home' });
    refreshCounts();
  }
  function termHtml(t) {
    var tops = t.topics.slice(0, 4).map(esc).join('; ') + (t.topics.length > 4 ? ' and ' + (t.topics.length - 4) + ' more' : '');
    var h = '<div class="card pk-term" data-n="' + t.n + '"><h2 style="margin:0 0 4px">' + t.name + ' <span class="hint">· ' + t.weeks + ' weeks</span></h2>' +
      '<p class="hint" style="margin:0 0 8px">' + (tops ? 'Topics: ' + tops : 'No topics listed: the standard curriculum will be used.') + '</p>';
    if (!t.scheme) return h + '<button class="btn small" data-act="pkscheme" data-n="' + t.n + '">Make this scheme of work (1 generation)</button></div>';
    h += '<div class="fs-tools"><button class="btn small alt" data-go="item/' + t.scheme.id + '">Open the scheme</button><button class="btn small alt" data-act="pkscheme" data-n="' + t.n + '" data-again="1">Make it again</button></div>';
    if (t.parseFailed || !t.lessons.length) return h + '<p class="hint">I could not read the weeks of this scheme, so the weekly lessons cannot be listed here. You can still make lessons one at a time from Lesson Plan or Lesson Note.</p></div>';
    h += '<h3 style="margin:12px 0 4px;font-size:1rem">Weekly lessons</h3><p class="hint" style="margin:0 0 4px">Tick the weeks you want. Revision, test and exam weeks are not ticked.</p><div class="pk-weeks">' + t.lessons.map(function (l) {
      return '<div class="pk-wk' + (l.skip ? ' skip' : '') + '"><input type="checkbox" class="pk-tick" data-n="' + t.n + '" data-w="' + l.week + '"' + ((ticks[t.n + ':' + l.week] !== undefined ? ticks[t.n + ':' + l.week] : !l.skip) ? ' checked' : '') + ' aria-label="Week ' + l.week + '">' +
        '<div class="pk-wt"><b>Week ' + l.week + '</b> · ' + esc(l.topic || 'No topic') + (l.skip ? '<div class="m">Not ticked: looks like a revision, test or exam week</div>' : '') + '</div>' +
        '<div class="pk-st">' + (l.plan ? '<button class="link" data-go="item/' + l.plan.id + '">✓ Plan</button>' : '<span class="hint">no plan</span>') + (l.note ? '<button class="link" data-go="item/' + l.note.id + '">✓ Note</button>' : '<span class="hint">no note</span>') + '</div></div>';
    }).join('') + '</div>' +
      '<div class="fs-tools"><button class="link" data-act="pktick" data-n="' + t.n + '" data-v="1">Tick all</button><button class="link" data-act="pktick" data-n="' + t.n + '" data-v="0">Untick all</button></div>' +
      '<button class="btn block" data-act="pklessons" data-n="' + t.n + '" data-kind="lesson-plan" id="pk-bp' + t.n + '">Make lesson plans</button>' +
      '<button class="btn alt block" data-act="pklessons" data-n="' + t.n + '" data-kind="lesson-note" id="pk-bn' + t.n + '">Make lesson notes</button>' +
      '<div class="fs-tools" style="margin-top:6px"><button class="btn small alt" data-act="pkword" data-n="' + t.n + '" data-kind="lesson-plan" id="pk-wp' + t.n + '">Word: all lesson plans</button><button class="btn small alt" data-act="pkword" data-n="' + t.n + '" data-kind="lesson-note" id="pk-wn' + t.n + '">Word: all lesson notes</button></div>';
    return h + '</div>';
  }
  function term(n) { return cur.terms[n - 1]; }
  function ticked(n) { return all('.pk-tick[data-n="' + n + '"]').filter(function (c) { return c.checked; }).map(function (c) { return Number(c.getAttribute('data-w')); }); }
  function refreshCounts() {
    cur.terms.forEach(function (t) {
      if (!t.scheme || !t.lessons.length) return;
      var tk = ticked(t.n);
      Object.keys(DOC).forEach(function (kind) {
        var d = DOC[kind];
        var todo = t.lessons.filter(function (l) { return tk.indexOf(l.week) > -1 && !l[d.field]; }).length;
        var b = $('#pk-b' + d.field.charAt(0) + t.n); if (!b) return;
        b.textContent = todo ? 'Make ' + d.label + 's for ' + todo + ' ticked week' + (todo === 1 ? '' : 's') + ' (uses ' + todo + ')' : (tk.length ? 'All ticked weeks have a ' + d.label : 'Tick the weeks you want');
        b.disabled = !todo;
        var w = $('#pk-w' + d.field.charAt(0) + t.n); if (w) w.disabled = !t.lessons.some(function (l) { return l[d.field]; });
      });
    });
  }
  function remember(c) { ticks[c.getAttribute('data-n') + ':' + c.getAttribute('data-w')] = c.checked; }
  document.addEventListener('change', function (e) { if (e.target && e.target.classList && e.target.classList.contains('pk-tick') && cur) { remember(e.target); refreshCounts(); } });
  A.pktick = function (el) { var v = el.getAttribute('data-v') === '1'; all('.pk-tick[data-n="' + el.getAttribute('data-n') + '"]').forEach(function (c) { c.checked = v; remember(c); }); refreshCounts(); };

  // ------------------------------------------------------------ making documents, one after another
  function schemeJob(t) {
    var p = cur;
    var b = { subject: p.subject, className: p.className, term: t.name, weeks: t.weeks, topics: t.topics.join('\n'), textbookIds: p.textbookIds, packId: p.id, packTerm: t.n };
    if (p.settings.schemeFormatId) b.formatId = p.settings.schemeFormatId;
    return { kind: 'scheme-of-work', label: t.name + ' scheme of work', body: b };
  }
  function lessonJob(t, l, kind) {
    var p = cur, s = p.settings;
    var b = { subject: p.subject, className: p.className, topic: (l.topic || 'Week ' + l.week).slice(0, 150), term: t.name, week: String(l.week), duration: s.duration, textbookIds: p.textbookIds, detail: s.detail,
      extras: l.objectives ? ('Follow this week of the scheme of work. Objectives: ' + l.objectives).slice(0, 420) : '', packId: p.id, packTerm: t.n, packWeek: l.week };
    var fid = kind === 'lesson-plan' ? s.planFormatId : s.noteFormatId;
    if (fid) b.formatId = fid;
    return { kind: kind, label: t.name + ', week ' + l.week + ': ' + (l.topic || ''), body: b };
  }
  async function runJob(job) {
    for (var attempt = 0; attempt < 5; attempt++) {
      try { var r = await api('POST', '/api/generate/' + job.kind, job.body); T.setUsage(r.usage); return r; }
      catch (e) { if (e.code === 'RATE_LIMIT' && attempt < 4) { await sleep(15000); continue; } throw e; }
    }
  }
  async function runBatch(jobs, title) {
    if (!navigator.onLine) { T.toast('You are offline. Please connect to the internet.', true); return; }
    stopFlag = false;
    T.modal('<h3>' + esc(title) + '</h3><div class="meter"><i id="pk-bar" style="width:0%"></i></div><p id="pk-now" class="sub">Starting…</p><p class="hint">Keep this screen open. Each document is saved as soon as it is made, so nothing is lost if you stop.</p><button class="btn alt" data-act="pkstop" id="pk-stop">Stop after this one</button>');
    var done = 0, failed = null;
    for (var i = 0; i < jobs.length; i++) {
      if (stopFlag) break;
      var now = $('#pk-now'); if (now) now.textContent = 'Making ' + (i + 1) + ' of ' + jobs.length + ': ' + jobs[i].label;
      try { await runJob(jobs[i]); done++; } catch (e) { failed = e; break; }
      var bar = $('#pk-bar'); if (bar) bar.style.width = Math.round(done / jobs.length * 100) + '%';
    }
    T.closeModal();
    try { cur = await api('GET', '/api/packs/' + cur.id); draw(); } catch (e) { /* offline: leave the screen as it is */ }
    var left = jobs.length - done;
    if (failed) {
      var limit = failed.code === 'LIMIT_REACHED' || failed.code === 'LIMIT_REACHED_MONTH';
      T.modal('<h3>' + (done ? 'Made ' + done + ' of ' + jobs.length : 'Nothing was made') + '</h3><p class="sub">' + esc(limit ? 'You have used all of today\'s generations. Your progress is saved: come back and tap the same button to carry on with the ' + left + ' that are left.' : failed.message) + '</p>' +
        (limit ? '<button class="btn" data-act="seeplans">See plans and prices</button>' : '') + '<button class="btn alt" data-act="closemodal">Close</button>');
    } else if (stopFlag && left) {
      T.toast('Stopped. ' + done + ' made, ' + left + ' left. Tap the button to carry on.');
    } else T.toast(done + ' made');
  }
  A.pkstop = function () { stopFlag = true; var b = $('#pk-stop'); if (b) { b.disabled = true; b.textContent = 'Stopping…'; } };
  A.pkscheme = function (el) {
    var t = term(Number(el.getAttribute('data-n')));
    runBatch([schemeJob(t)], 'Making the ' + t.name + ' scheme');
  };
  A.pkallschemes = function () {
    runBatch(cur.terms.filter(function (t) { return !t.scheme; }).map(schemeJob), 'Making the schemes of work');
  };
  A.pklessons = function (el) {
    var t = term(Number(el.getAttribute('data-n'))), kind = el.getAttribute('data-kind'), d = DOC[kind], tk = ticked(t.n);
    var jobs = t.lessons.filter(function (l) { return tk.indexOf(l.week) > -1 && !l[d.field]; }).map(function (l) { return lessonJob(t, l, kind); });
    if (!jobs.length) return;
    runBatch(jobs, 'Making ' + d.label + 's for the ' + t.name);
  };

  // ------------------------------------------------------------ the whole term in one Word file
  A.pkword = async function (el) {
    var t = term(Number(el.getAttribute('data-n'))), kind = el.getAttribute('data-kind'), d = DOC[kind];
    var list = t.lessons.filter(function (l) { return l[d.field]; });
    if (!list.length) { T.toast('No ' + d.label + 's made yet for this term.', true); return; }
    T.toast('Preparing the file…');
    try {
      var docs = [];
      for (var i = 0; i < list.length; i++) docs.push(await api('GET', '/api/library/' + list[i][d.field].id));
      var html = '<h1>' + esc(cur.name) + '</h1><p style="text-align:center">' + esc(t.name) + ' · ' + d.label.charAt(0).toUpperCase() + d.label.slice(1) + 's</p>' +
        docs.map(function (doc) { return '<br clear=all style="mso-special-character:line-break;page-break-before:always">' + window.md(doc.content); }).join('');
      T.wordFile(cur.name + ' ' + t.name + ' ' + d.label + 's', html, false);
    } catch (e) { T.toast(offlineMsg(e), true); }
  };

  A.pkdelete = function () {
    T.modal('<h3>Delete this Term Pack?</h3><p class="sub">The schemes and lessons already made stay in your Library. Only the pack and its topic split are removed.</p><button class="btn danger" data-act="pkdodelete">Yes, delete it</button><button class="btn alt" data-act="closemodal">Keep it</button>');
  };
  A.pkdodelete = async function () {
    try { await api('DELETE', '/api/packs/' + cur.id); T.closeModal(); T.toast('Deleted'); T.go('#/packs'); }
    catch (e) { T.closeModal(); T.toast(offlineMsg(e), true); }
  };
})();
