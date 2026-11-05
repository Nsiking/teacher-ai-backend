'use strict';
/* Classroom record screens: classes, pupils, attendance, scores. Loaded before app.js. */
(function () {
  var T = window.TT = window.TT || {};
  T.views = T.views || {};
  T.actions = T.actions || {};
  var A = T.actions;

  // helpers that use the main app (filled in by app.js)
  function esc(s) { return T.esc(s); }
  function api(m, p, b) { return T.api(m, p, b); }
  function $(s, el) { return (el || document).querySelector(s); }
  function all(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function today() { return new Date(Date.now() + 3600000).toISOString().slice(0, 10); }
  function r2(v) { return Math.round(v * 100) / 100; }
  function fmtDay(d) {
    try { return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d; }
  }

  var cur = null;          // the open class {id, name, pupils}
  var attDay = today();    // the date shown on the attendance tab
  var sumFrom = '', sumTo = '';
  var pending = {};        // things waiting for a "yes, delete" tap
  var lastText = '';       // text for the Copy buttons

  function offlineMsg(e) { return e.offline ? 'This part needs the internet. Please connect and try again.' : e.message; }

  async function loadClass(id) {
    var d = await api('GET', '/api/classes/' + id);
    cur = { id: d.class.id, name: d.class.name, pupils: d.pupils };
    return cur;
  }
  function classShell(c, tab, inner) {
    var chips = [['pupils', 'Pupils'], ['attendance', 'Attendance'], ['scores', 'Scores']].map(function (x) {
      return '<button class="chip' + (tab === x[0] ? ' on' : '') + '" data-go="class/' + c.id + '/' + x[0] + '">' + x[1] + '</button>';
    }).join('');
    T.shell('<div class="chips no-print">' + chips + '</div>' + inner, { title: c.name, back: 'classes', nav: 'classes' });
  }
  function reload() { T.route(); }

  // ------------------------------------------------------------ classes list
  T.views.classes = async function () {
    T.shell('<h1>My Classes</h1><p class="sub">Keep your class lists, attendance and scores in one place.</p>' +
      '<div id="cl-list"><p class="hint">Loading…</p></div>' +
      '<button class="btn block" data-act="newclass">+ New class</button>', { title: 'My Classes', nav: 'classes' });
    try {
      var r = await api('GET', '/api/classes');
      $('#cl-list').innerHTML = r.classes.length ? r.classes.map(function (c) {
        return '<button class="item" data-go="class/' + c.id + '"><span class="ico">🏫</span><span><div class="t">' + esc(c.name) +
          '</div><div class="m">' + c.pupilCount + ' pupil' + (c.pupilCount === 1 ? '' : 's') + '</div></span></button>';
      }).join('') : '<div class="empty">No classes yet. Add your first class, then add the pupils.</div>';
    } catch (e) { $('#cl-list').innerHTML = '<div class="empty">' + esc(offlineMsg(e)) + '</div>'; }
  };
  A.newclass = function () {
    T.modal('<h3>New class</h3><input id="nc-name" maxlength="40" placeholder="e.g. JSS 2A or Primary 4 Gold"><div class="err" id="nc-err"></div>' +
      '<button class="btn" data-act="createclass">Create class</button><button class="btn alt" data-act="closemodal">Cancel</button>');
    setTimeout(function () { var i = $('#nc-name'); if (i) i.focus(); }, 50);
  };
  A.createclass = async function (btn) {
    var name = $('#nc-name').value.trim(); $('#nc-err').textContent = '';
    if (!name) { $('#nc-err').textContent = 'Please enter a class name.'; return; }
    btn.disabled = true;
    try { var r = await api('POST', '/api/classes', { name: name }); T.closeModal(); T.go('#/class/' + r.id); }
    catch (e) { $('#nc-err').textContent = offlineMsg(e); btn.disabled = false; }
  };

  // ------------------------------------------------------------ one class
  T.views.class = async function (parts) {
    var id = Number(parts[1]), tab = parts[2] || 'pupils', sub = parts[3];
    T.shell('<div class="empty">Opening…</div>', { title: 'Class', back: 'classes', nav: 'classes' });
    try {
      var c = await loadClass(id);
      if (tab === 'attendance') return sub === 'summary' ? await attSummary(c) : await tabAttendance(c);
      if (tab === 'scores') {
        if (sub === 'sheet') return await scoreSheet(c);
        if (sub) return await scoreEntry(c, Number(sub));
        return await tabScores(c);
      }
      return tabPupils(c);
    } catch (e) {
      T.shell('<div class="empty">' + esc(offlineMsg(e)) + '</div>', { title: 'Class', back: 'classes', nav: 'classes' });
    }
  };

  // ------------------------------------------------------------ pupils tab
  function tabPupils(c) {
    var rows = c.pupils.map(function (p, i) {
      return '<div class="kv"><span>' + (i + 1) + '. ' + esc(p.name) + (p.gender ? ' <small class="hint">(' + p.gender + ')</small>' : '') + '</span><span>' +
        '<button class="link" data-act="editpupil" data-id="' + p.id + '" data-name="' + esc(p.name) + '" data-gender="' + esc(p.gender) + '">Edit</button> · ' +
        '<button class="link danger" data-act="delpupil" data-id="' + p.id + '" data-name="' + esc(p.name) + '">Remove</button></span></div>';
    }).join('');
    classShell(c, 'pupils',
      '<div class="card"><b>Add pupils</b><p class="sub">One name per line. You can paste a whole class list.</p>' +
      '<textarea id="np-names" placeholder="Chidi Obi&#10;Amina Bello&#10;Tunde Ade"></textarea><div class="err" id="np-err"></div>' +
      '<button class="btn block" data-act="addpupils">Add to class</button></div>' +
      '<h2 class="sec">' + c.pupils.length + ' pupil' + (c.pupils.length === 1 ? '' : 's') + '</h2>' +
      (rows ? '<div class="card">' + rows + '</div>' : '<div class="empty">No pupils yet.</div>') +
      '<div class="card"><b>Class settings</b><div class="actions" style="margin:10px 0 0">' +
      '<button class="btn alt small" data-act="renameclass">Rename class</button><button class="btn danger small" data-act="deleteclass">Delete class</button></div></div>');
  }
  A.addpupils = async function (btn) {
    var names = $('#np-names').value; $('#np-err').textContent = '';
    if (!names.trim()) { $('#np-err').textContent = 'Type or paste at least one name.'; return; }
    btn.disabled = true;
    try { await api('POST', '/api/classes/' + cur.id + '/pupils', { names: names }); T.toast('Pupils added'); reload(); }
    catch (e) { $('#np-err').textContent = offlineMsg(e); btn.disabled = false; }
  };
  A.editpupil = function (el) {
    pending.pupil = el.getAttribute('data-id');
    var g = el.getAttribute('data-gender');
    T.modal('<h3>Edit pupil</h3><input id="ep-name" maxlength="60" value="' + esc(el.getAttribute('data-name')) + '">' +
      '<select id="ep-gender" style="margin-top:10px"><option value=""' + (g === '' ? ' selected' : '') + '>Boy or girl? (optional)</option><option value="boy"' + (g === 'boy' ? ' selected' : '') + '>Boy</option><option value="girl"' + (g === 'girl' ? ' selected' : '') + '>Girl</option></select>' +
      '<div class="err" id="ep-err"></div><button class="btn" data-act="savepupil">Save</button><button class="btn alt" data-act="closemodal">Cancel</button>');
  };
  A.savepupil = async function (btn) {
    var name = $('#ep-name').value.trim();
    if (!name) { $('#ep-err').textContent = 'Name cannot be empty.'; return; }
    btn.disabled = true;
    try { await api('PUT', '/api/pupils/' + pending.pupil, { name: name, gender: $('#ep-gender').value }); T.closeModal(); reload(); }
    catch (e) { $('#ep-err').textContent = offlineMsg(e); btn.disabled = false; }
  };
  A.delpupil = function (el) {
    pending.pupil = el.getAttribute('data-id');
    T.modal('<h3>Remove ' + esc(el.getAttribute('data-name')) + '?</h3><p class="sub">Their attendance and scores will be removed too.</p>' +
      '<button class="btn danger" data-act="dodelpupil">Yes, remove</button><button class="btn alt" data-act="closemodal">Keep</button>');
  };
  A.dodelpupil = async function () {
    try { await api('DELETE', '/api/pupils/' + pending.pupil); T.closeModal(); reload(); }
    catch (e) { T.closeModal(); T.toast(offlineMsg(e), true); }
  };
  A.renameclass = function () {
    T.modal('<h3>Rename class</h3><input id="rc-name" maxlength="40" value="' + esc(cur.name) + '"><div class="err" id="rc-err"></div>' +
      '<button class="btn" data-act="saverename">Save</button><button class="btn alt" data-act="closemodal">Cancel</button>');
  };
  A.saverename = async function (btn) {
    var name = $('#rc-name').value.trim();
    if (!name) { $('#rc-err').textContent = 'Please enter a class name.'; return; }
    btn.disabled = true;
    try { await api('PUT', '/api/classes/' + cur.id, { name: name }); T.closeModal(); reload(); }
    catch (e) { $('#rc-err').textContent = offlineMsg(e); btn.disabled = false; }
  };
  A.deleteclass = function () {
    T.modal('<h3>Delete ' + esc(cur.name) + '?</h3><p class="sub">The pupils, attendance and scores of this class will all be deleted. This cannot be undone.</p>' +
      '<button class="btn danger" data-act="dodeleteclass">Yes, delete the class</button><button class="btn alt" data-act="closemodal">Keep it</button>');
  };
  A.dodeleteclass = async function () {
    try { await api('DELETE', '/api/classes/' + cur.id); T.closeModal(); T.toast('Class deleted'); T.go('#/classes'); }
    catch (e) { T.closeModal(); T.toast(offlineMsg(e), true); }
  };

  // ------------------------------------------------------------ attendance tab
  async function tabAttendance(c) {
    var a = await api('GET', '/api/classes/' + c.id + '/attendance?day=' + encodeURIComponent(attDay));
    var has = Object.keys(a.marks).length > 0;
    var rows = c.pupils.map(function (p, i) {
      var st = a.marks[p.id] || (has ? '' : 'P');
      function b(s, label) { return '<button type="button" data-act="mark" data-s="' + s + '" class="' + (st === s ? 'on ' : '') + 's' + s + '" aria-label="' + label + '">' + s + '</button>'; }
      return '<div class="att-row" data-pid="' + p.id + '"><span class="nm">' + (i + 1) + '. ' + esc(p.name) + '</span><span class="seg">' + b('P', 'Present') + b('A', 'Absent') + b('L', 'Late') + '</span></div>';
    }).join('');
    classShell(c, 'attendance',
      '<div class="card"><label for="att-day" style="margin-top:0">Date</label><input id="att-day" type="date" value="' + esc(attDay) + '">' +
      '<p class="hint" id="att-hint">' + (has ? 'Saved for this date. You can change it and save again.' : 'Nothing saved for this date yet. Everyone starts as present; tap A or L for those who are not.') + '</p></div>' +
      (c.pupils.length ? '<div class="actions no-print"><button class="btn small alt" data-act="allpresent">All present</button><button class="btn small alt" data-go="class/' + c.id + '/attendance/summary">Summary</button></div>' +
        '<div class="card">' + rows + '</div><p class="hint">P = present, A = absent, L = late</p>' +
        '<button class="btn block" data-act="saveatt">Save attendance</button>'
        : '<div class="empty">Add pupils first (Pupils tab), then you can take attendance.</div>'));
  }
  A.mark = function (el) {
    all('button', el.parentNode).forEach(function (b) { b.classList.remove('on'); });
    el.classList.add('on');
  };
  A.allpresent = function () {
    all('.att-row').forEach(function (row) {
      all('.seg button', row).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-s') === 'P'); });
    });
  };
  A.saveatt = async function (btn) {
    var marks = {};
    all('.att-row').forEach(function (row) {
      var on = $('.seg button.on', row);
      if (on) marks[row.getAttribute('data-pid')] = on.getAttribute('data-s');
    });
    if (!Object.keys(marks).length) return T.toast('Mark at least one pupil first.', true);
    btn.disabled = true;
    try { await api('PUT', '/api/classes/' + cur.id + '/attendance', { day: attDay, marks: marks }); T.toast('Attendance saved'); var h = $('#att-hint'); if (h) h.textContent = 'Saved for this date. You can change it and save again.'; }
    catch (e) { T.toast(offlineMsg(e), true); }
    btn.disabled = false;
  };
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'att-day' && e.target.value) { attDay = e.target.value; reload(); }
  });

  async function attSummary(c) {
    var q = '?from=' + encodeURIComponent(sumFrom) + '&to=' + encodeURIComponent(sumTo);
    var s = await api('GET', '/api/classes/' + c.id + '/attendance/summary' + q);
    var rows = s.pupils.map(function (p, i) {
      var pc = p.percent === null ? '-' : p.percent + '%';
      return '<tr><td>' + (i + 1) + '. ' + esc(p.name) + '</td><td>' + p.present + '</td><td>' + p.absent + '</td><td>' + p.late + '</td><td>' + pc + '</td></tr>';
    }).join('');
    lastText = c.name + ' attendance summary (' + s.daysRecorded + ' day' + (s.daysRecorded === 1 ? '' : 's') + ' recorded)\n' +
      s.pupils.map(function (p) { return p.name + ': present ' + p.present + ', absent ' + p.absent + ', late ' + p.late + (p.percent === null ? '' : ' (' + p.percent + '%)'); }).join('\n');
    classShell(c, 'attendance',
      '<div class="actions no-print"><button class="btn small alt" data-go="class/' + c.id + '/attendance">← Back to marking</button></div>' +
      '<div class="card"><div class="row2 stack"><div><label for="sm-from" style="margin-top:0">From (optional)</label><input id="sm-from" type="date" value="' + esc(sumFrom) + '"></div>' +
      '<div><label for="sm-to" style="margin-top:0">To (optional)</label><input id="sm-to" type="date" value="' + esc(sumTo) + '"></div></div>' +
      '<button class="btn small block" data-act="showsummary">Show</button></div>' +
      '<p class="sub">Days recorded: <b>' + s.daysRecorded + '</b>. The percentage counts late as present.</p>' +
      (s.pupils.length ? '<div class="doc"><div class="tablewrap"><table><thead><tr><th>Pupil</th><th>Present</th><th>Absent</th><th>Late</th><th>%</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>' +
        '<div class="actions no-print" style="margin-top:12px"><button class="btn small alt" data-act="copysummary">Copy as text</button></div>' : '<div class="empty">No pupils yet.</div>'));
  }
  A.showsummary = function () { sumFrom = $('#sm-from').value; sumTo = $('#sm-to').value; reload(); };
  A.copysummary = function () { T.copyText(lastText); };

  // ------------------------------------------------------------ scores tab
  async function tabScores(c) {
    var r = await api('GET', '/api/classes/' + c.id + '/assessments');
    var list = r.assessments.map(function (a) {
      var avg = a.average === null ? 'no scores yet' : 'average ' + a.average + ' · ' + a.scored + ' scored';
      return '<button class="item" data-go="class/' + c.id + '/scores/' + a.id + '"><span class="ico">📊</span><span><div class="t">' + esc(a.title) +
        '</div><div class="m">out of ' + a.maxScore + ' · ' + fmtDay(a.day) + ' · ' + avg + '</div></span></button>';
    }).join('');
    classShell(c, 'scores',
      '<div class="actions no-print"><button class="btn small" data-act="newassessment">+ New assessment</button>' +
      (r.assessments.length ? '<button class="btn small alt" data-go="class/' + c.id + '/scores/sheet">Overall sheet</button>' : '') + '</div>' +
      (list || '<div class="empty">No assessments yet. Add one, for example "CA1 Maths" out of 20, then enter each pupil\'s score.</div>'));
  }
  A.newassessment = function () {
    T.modal('<h3>New assessment</h3><input id="na-title" maxlength="60" placeholder="e.g. CA1 Maths"><input id="na-max" type="number" inputmode="decimal" min="1" step="any" placeholder="Maximum score, e.g. 20" style="margin-top:10px">' +
      '<input id="na-day" type="date" value="' + today() + '" style="margin-top:10px"><div class="err" id="na-err"></div>' +
      '<button class="btn" data-act="createassessment">Create</button><button class="btn alt" data-act="closemodal">Cancel</button>');
  };
  A.createassessment = async function (btn) {
    var title = $('#na-title').value.trim(), max = Number($('#na-max').value);
    if (!title) { $('#na-err').textContent = 'Please enter a title.'; return; }
    if (!max || max <= 0) { $('#na-err').textContent = 'Enter the maximum score.'; return; }
    btn.disabled = true;
    try { var r = await api('POST', '/api/classes/' + cur.id + '/assessments', { title: title, maxScore: max, day: $('#na-day').value || undefined }); T.closeModal(); T.go('#/class/' + cur.id + '/scores/' + r.id); }
    catch (e) { $('#na-err').textContent = offlineMsg(e); btn.disabled = false; }
  };

  var curAssess = null;
  async function scoreEntry(c, aid) {
    var d = await api('GET', '/api/assessments/' + aid);
    curAssess = d.assessment;
    var max = d.assessment.maxScore;
    var rows = d.pupils.map(function (p, i) {
      var v = d.scores[p.id];
      return '<div class="att-row"><span class="nm">' + (i + 1) + '. ' + esc(p.name) + '</span><input class="sc-in" type="number" inputmode="decimal" step="any" min="0" max="' + max + '" data-pid="' + p.id + '" value="' + (v === undefined ? '' : v) + '" aria-label="Score for ' + esc(p.name) + '"></div>';
    }).join('');
    classShell(c, 'scores',
      '<div class="actions no-print"><button class="btn small alt" data-go="class/' + c.id + '/scores">← All assessments</button></div>' +
      '<h1 style="font-size:1.15rem">' + esc(d.assessment.title) + '</h1><p class="sub">Out of ' + max + ' · ' + fmtDay(d.assessment.day) + '</p>' +
      '<div class="card" id="sc-stats"></div>' +
      (d.pupils.length ? '<div class="card">' + rows + '</div><button class="btn block" data-act="savescores">Save scores</button>' : '<div class="empty">Add pupils first (Pupils tab).</div>') +
      '<div class="actions" style="margin-top:14px"><button class="btn small alt" data-act="editassessment">Edit details</button><button class="btn small danger" data-act="delassessment">Delete assessment</button></div>');
    updateStats();
  }
  function updateStats() {
    var box = $('#sc-stats'); if (!box || !curAssess) return;
    var vals = all('.sc-in').map(function (i) { return i.value === '' ? null : Number(i.value); }).filter(function (v) { return v !== null && isFinite(v); });
    if (!vals.length) { box.innerHTML = '<span class="hint">Enter scores below. The average appears here.</span>'; return; }
    var sum = vals.reduce(function (t, v) { return t + v; }, 0);
    box.innerHTML = '<div class="kv" style="padding-top:0"><span>Scored</span><b>' + vals.length + '</b></div>' +
      '<div class="kv"><span>Average</span><b>' + r2(sum / vals.length) + ' (' + Math.round(sum / vals.length / curAssess.maxScore * 100) + '%)</b></div>' +
      '<div class="kv"><span>Highest</span><b>' + Math.max.apply(null, vals) + '</b></div>' +
      '<div class="kv"><span>Lowest</span><b>' + Math.min.apply(null, vals) + '</b></div>';
  }
  document.addEventListener('input', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('sc-in')) {
      var v = Number(e.target.value);
      e.target.style.borderColor = (e.target.value !== '' && curAssess && (v > curAssess.maxScore || v < 0)) ? '#b42318' : '';
      updateStats();
    }
  });
  A.savescores = async function (btn) {
    var scores = {}, bad = false;
    all('.sc-in').forEach(function (i) {
      if (i.value === '') { scores[i.getAttribute('data-pid')] = null; return; }
      var v = Number(i.value);
      if (!isFinite(v) || v < 0 || v > curAssess.maxScore) bad = true;
      scores[i.getAttribute('data-pid')] = v;
    });
    if (bad) return T.toast('Scores must be between 0 and ' + curAssess.maxScore + '.', true);
    btn.disabled = true;
    try { await api('PUT', '/api/assessments/' + curAssess.id + '/scores', { scores: scores }); T.toast('Scores saved'); }
    catch (e) { T.toast(offlineMsg(e), true); }
    btn.disabled = false;
  };
  A.editassessment = function () {
    T.modal('<h3>Edit assessment</h3><input id="ea-title" maxlength="60" value="' + esc(curAssess.title) + '"><input id="ea-max" type="number" inputmode="decimal" step="any" min="1" value="' + curAssess.maxScore + '" style="margin-top:10px">' +
      '<input id="ea-day" type="date" value="' + esc(curAssess.day) + '" style="margin-top:10px"><div class="err" id="ea-err"></div>' +
      '<button class="btn" data-act="saveassessment">Save</button><button class="btn alt" data-act="closemodal">Cancel</button>');
  };
  A.saveassessment = async function (btn) {
    var title = $('#ea-title').value.trim(), max = Number($('#ea-max').value);
    if (!title || !max) { $('#ea-err').textContent = 'Enter a title and a maximum score.'; return; }
    btn.disabled = true;
    try { await api('PUT', '/api/assessments/' + curAssess.id, { title: title, maxScore: max, day: $('#ea-day').value }); T.closeModal(); reload(); }
    catch (e) { $('#ea-err').textContent = offlineMsg(e); btn.disabled = false; }
  };
  A.delassessment = function () {
    T.modal('<h3>Delete ' + esc(curAssess.title) + '?</h3><p class="sub">All its scores will be deleted. This cannot be undone.</p>' +
      '<button class="btn danger" data-act="dodelassessment">Yes, delete</button><button class="btn alt" data-act="closemodal">Keep it</button>');
  };
  A.dodelassessment = async function () {
    try { await api('DELETE', '/api/assessments/' + curAssess.id); T.closeModal(); T.toast('Deleted'); T.go('#/class/' + cur.id + '/scores'); }
    catch (e) { T.closeModal(); T.toast(offlineMsg(e), true); }
  };

  // ------------------------------------------------------------ overall sheet
  function sheetData(d) {
    return d.pupils.map(function (p) {
      var got = 0, out = 0, cells = d.assessments.map(function (a) {
        var v = (d.scores[a.id] || {})[p.id];
        if (v === undefined) return '';
        got += v; out += a.maxScore; return v;
      });
      return { name: p.name, cells: cells, total: out ? r2(got) + '/' + r2(out) : '', pct: out ? Math.round(got / out * 1000) / 10 : null };
    });
  }
  async function scoreSheet(c) {
    var d = await api('GET', '/api/classes/' + c.id + '/sheet');
    var rows = sheetData(d);
    var head = '<th>Pupil</th>' + d.assessments.map(function (a) { return '<th>' + esc(a.title) + ' (/' + a.maxScore + ')</th>'; }).join('') + '<th>Total</th><th>%</th>';
    var body = rows.map(function (r, i) {
      return '<tr><td>' + (i + 1) + '. ' + esc(r.name) + '</td>' + r.cells.map(function (v) { return '<td>' + v + '</td>'; }).join('') + '<td>' + r.total + '</td><td>' + (r.pct === null ? '' : r.pct + '%') + '</td></tr>';
    }).join('');
    lastText = c.name + ' scores\n' + rows.map(function (r) {
      return r.name + ': ' + d.assessments.map(function (a, i) { return a.title + ' ' + (r.cells[i] === '' ? '-' : r.cells[i]) + '/' + a.maxScore; }).join(', ') + (r.pct === null ? '' : ' | Total ' + r.total + ' (' + r.pct + '%)');
    }).join('\n');
    window.__sheet = { name: c.name, d: d, rows: rows };
    classShell(c, 'scores',
      '<div class="actions no-print"><button class="btn small alt" data-go="class/' + c.id + '/scores">← All assessments</button><button class="btn small alt" data-act="copysummary">Copy as text</button><button class="btn small alt" data-act="csvsheet">Download CSV</button></div>' +
      '<p class="sub">The percentage uses only the assessments each pupil has a score for.</p>' +
      '<div class="doc"><div class="tablewrap"><table' + (d.assessments.length >= 3 ? ' class="wide"' : '') + '><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></div>');
  }
  A.csvsheet = function () {
    var s = window.__sheet; if (!s) return;
    function q(v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var lines = [['Pupil'].concat(s.d.assessments.map(function (a) { return a.title + ' (/' + a.maxScore + ')'; }), ['Total', 'Percent']).map(q).join(',')];
    s.rows.forEach(function (r) { lines.push([r.name].concat(r.cells, [r.total, r.pct === null ? '' : r.pct]).map(q).join(',')); });
    T.saveFile((s.name.replace(/[^\w\- ]+/g, '').trim() || 'class') + '-scores.csv', 'text/csv;charset=utf-8', '\ufeff' + lines.join('\r\n'));
  };
})();
