'use strict';
/* Time-Table screens: my weekly periods, today's lessons on Home, and the class timetable maker. Loaded before app.js. */
(function () {
  var T = window.TT = window.TT || {};
  T.views = T.views || {};
  T.actions = T.actions || {};
  var A = T.actions;

  function esc(s) { return T.esc(s); }
  function api(m, p, b) { return T.api(m, p, b); }
  function $(s, el) { return (el || document).querySelector(s); }
  function all(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }

  var DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var slots = [];
  function todayNum() { var g = new Date().getDay(); return g === 0 ? 7 : g; }
  var selDay = todayNum();
  function mins(hhmm) { var p = String(hhmm).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
  function nowMins() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function findSlot(id) { return slots.filter(function (s) { return String(s.id) === String(id); })[0]; }
  function offlineMsg(e) { return e.offline ? 'This part needs the internet. Please connect and try again.' : e.message; }

  async function loadSlots() {
    try { var r = await api('GET', '/api/timetable'); slots = r.slots; localStorage.setItem('tt_slots', JSON.stringify(slots)); }
    catch (e) { try { slots = JSON.parse(localStorage.getItem('tt_slots') || '[]'); } catch (x) { slots = []; } }
    return slots;
  }

  // ------------------------------------------------------------ today's lessons (shown on Home)
  T.todayCard = async function () {
    await loadSlots();
    var box = $('#today-box'); if (!box) return;
    var d = todayNum(), now = nowMins();
    var list = slots.filter(function (s) { return s.day === d; });
    if (!slots.length) {
      box.innerHTML = '<div class="banner"><span>Add your timetable to see today\'s lessons here.</span><button class="btn small" data-go="timetable">Add</button></div>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<div class="card"><b>Today\'s lessons</b><p class="hint" style="margin:4px 0 0">No lessons on your timetable for ' + DAYS[d - 1] + '.</p></div>';
      return;
    }
    var nextMarked = false;
    box.innerHTML = '<div class="card" style="padding-bottom:6px"><b>Today\'s lessons · ' + DAYS[d - 1] + '</b><div style="margin-top:8px">' + list.map(function (s) {
      var st = mins(s.start), en = mins(s.end), tag = '', cls = 'item';
      if (now >= st && now < en) tag = '<span class="slot-now">Now</span>';
      else if (now < st && !nextMarked) { tag = '<span class="slot-now" style="background:var(--brand-soft);color:var(--brand)">Next</span>'; nextMarked = true; }
      else if (now >= en) cls += ' done';
      return '<button class="' + cls + '" data-act="slotmenu" data-id="' + s.id + '"><span class="ico">🕒</span><span><div class="t">' + esc(s.start) + ' – ' + esc(s.end) + ' · ' + esc(s.subject) + tag + '</div><div class="m">' + esc([s.className, s.room].filter(Boolean).join(' · ') || ' ') + '</div></span></button>';
    }).join('') + '</div></div>';
  };

  // ------------------------------------------------------------ the screens
  T.views.timetable = async function (parts) {
    if (parts[1] === 'make') return makeView();
    T.shell('<div class="empty">Opening…</div>', { title: 'Time-Table', back: 'home', nav: 'home' });
    await loadSlots();
    drawMy();
  };
  function tabs(on) {
    return '<div class="chips no-print"><button class="chip' + (on === 'my' ? ' on' : '') + '" data-go="timetable">My timetable</button>' +
      '<button class="chip' + (on === 'make' ? ' on' : '') + '" data-go="timetable/make">Class timetable</button></div>';
  }
  function slotRow(s) {
    return '<button class="item" data-act="slotmenu" data-id="' + s.id + '"><span class="ico">🕒</span><span><div class="t">' + esc(s.start) + ' – ' + esc(s.end) + ' · ' + esc(s.subject) +
      '</div><div class="m">' + esc([s.className, s.room].filter(Boolean).join(' · ') || ' ') + '</div></span></button>';
  }
  function drawMy() {
    var chips = SHORT.map(function (n, i) {
      var d = i + 1, c = slots.filter(function (s) { return s.day === d; }).length;
      return '<button class="chip' + (selDay === d ? ' on' : '') + '" data-act="selday" data-d="' + d + '">' + n + (c ? ' (' + c + ')' : '') + '</button>';
    }).join('');
    var list = slots.filter(function (s) { return s.day === selDay; });
    T.shell('<h1>Time-Table</h1>' + tabs('my') + '<div class="chips no-print">' + chips + '</div>' +
      (list.length ? list.map(slotRow).join('') : '<div class="empty">No periods on ' + DAYS[selDay - 1] + '. Tap "Add a period".</div>') +
      '<div class="actions no-print" style="margin-top:12px"><button class="btn small" data-act="addslot">+ Add a period</button>' +
      (slots.length ? '<button class="btn small alt" data-act="copyweek">Copy week</button><button class="btn small alt" data-act="wordweek">Word</button>' : '') + '</div>' +
      (slots.length ? '<p style="margin-top:20px"><button class="link danger" data-act="clearweek">Clear my whole timetable</button></p>' : ''), { title: 'Time-Table', back: 'home', nav: 'home' });
  }
  A.selday = function (el) { selDay = Number(el.getAttribute('data-d')); drawMy(); };

  // ------------------------------------------------------------ add, edit and delete a period
  function slotForm(s) {
    var edit = !!s;
    var dl = '<datalist id="cls-dl">' + T.classNames().map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist>';
    var days = edit
      ? '<label for="sl-day">Day</label><select id="sl-day">' + DAYS.map(function (n, i) { return '<option value="' + (i + 1) + '"' + (s.day === i + 1 ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select>'
      : '<label>Days (tick every day this period happens)</label><div class="chk-row">' + DAYS.map(function (n, i) { return '<label class="chk"><input type="checkbox" class="sl-d" value="' + (i + 1) + '"' + (i + 1 === selDay ? ' checked' : '') + '> ' + SHORT[i] + '</label>'; }).join('') + '</div>';
    function f(id, label, val, ph, max) { return '<label for="' + id + '">' + label + '</label><input id="' + id + '" maxlength="' + max + '" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">'; }
    return '<h3>' + (edit ? 'Edit period' : 'Add a period') + '</h3><div style="text-align:left">' + days +
      '<div class="row2"><div><label for="sl-start">Starts</label><input id="sl-start" type="time" value="' + esc(s ? s.start : '08:00') + '"></div><div><label for="sl-end">Ends</label><input id="sl-end" type="time" value="' + esc(s ? s.end : '08:40') + '"></div></div>' +
      f('sl-subject', 'Subject', s && s.subject, 'e.g. Mathematics', 40) +
      '<label for="sl-class">Class</label><input id="sl-class" list="cls-dl" maxlength="30" value="' + esc((s && s.className) || '') + '" placeholder="e.g. JSS 1 or JSS 1A">' + dl +
      f('sl-room', 'Room (optional)', s && s.room, 'e.g. Room 4', 20) +
      '<div class="err" id="sl-err"></div></div><button class="btn" data-act="saveslot"' + (edit ? ' data-id="' + s.id + '"' : '') + '>Save</button><button class="btn alt" data-act="closemodal">Cancel</button>';
  }
  A.addslot = function () { T.modal(slotForm(null), true); };
  A.editslot = function (el) { var s = findSlot(el.getAttribute('data-id')); if (s) T.modal(slotForm(s), true); };
  A.saveslot = async function (btn) {
    var id = btn.getAttribute('data-id'), err = $('#sl-err'); err.textContent = '';
    var body = { start: $('#sl-start').value, end: $('#sl-end').value, subject: $('#sl-subject').value, className: $('#sl-class').value, room: $('#sl-room').value };
    if (id) body.day = Number($('#sl-day').value);
    else {
      body.days = all('.sl-d:checked').map(function (c) { return Number(c.value); });
      if (!body.days.length) { err.textContent = 'Tick at least one day.'; return; }
    }
    btn.disabled = true;
    try {
      var r = id ? await api('PUT', '/api/timetable/' + id, body) : await api('POST', '/api/timetable', body);
      T.closeModal();
      await loadSlots(); if ($('#today-box')) T.todayCard(); else drawMy();
      if (!id && r.skipped && r.skipped.length) T.toast('Added ' + r.created.length + '. Skipped: ' + r.skipped.map(function (x) { return x.reason; }).join(' '), true);
      else T.toast('Saved');
    } catch (e) { err.textContent = offlineMsg(e); btn.disabled = false; }
  };
  A.slotmenu = function (el) {
    var s = findSlot(el.getAttribute('data-id')); if (!s) return;
    T.modal('<h3>' + esc(s.subject) + '</h3><p class="sub">' + DAYS[s.day - 1] + ' · ' + esc(s.start) + ' – ' + esc(s.end) + (s.className ? ' · ' + esc(s.className) : '') + (s.room ? ' · ' + esc(s.room) : '') + '</p>' +
      '<button class="btn" data-act="slotplan" data-id="' + s.id + '">Make a lesson plan</button>' +
      '<button class="btn alt" data-act="slotnote" data-id="' + s.id + '">Make a lesson note</button>' +
      '<button class="btn alt" data-act="editslot" data-id="' + s.id + '">Edit</button>' +
      '<button class="btn danger" data-act="delslot" data-id="' + s.id + '">Delete</button>' +
      '<button class="btn alt" data-act="closemodal">Close</button>');
  };
  A.slotplan = function (el) { var s = findSlot(el.getAttribute('data-id')); if (!s) return; T.prefill(s.subject, s.className); T.closeModal(); T.go('#/new/lesson-plan'); };
  A.slotnote = function (el) { var s = findSlot(el.getAttribute('data-id')); if (!s) return; T.prefill(s.subject, s.className); T.closeModal(); T.go('#/new/lesson-note'); };
  A.delslot = async function (el) {
    try { await api('DELETE', '/api/timetable/' + el.getAttribute('data-id')); T.closeModal(); await loadSlots(); if ($('#today-box')) T.todayCard(); else drawMy(); T.toast('Deleted'); }
    catch (e) { T.closeModal(); T.toast(offlineMsg(e), true); }
  };
  A.clearweek = function () {
    T.modal('<h3>Clear your whole timetable?</h3><p class="sub">All your periods will be removed. This cannot be undone.</p>' +
      '<button class="btn danger" data-act="doclearweek">Yes, clear it</button><button class="btn alt" data-act="closemodal">Keep it</button>');
  };
  A.doclearweek = async function () {
    try { await api('DELETE', '/api/timetable'); T.closeModal(); await loadSlots(); drawMy(); T.toast('Timetable cleared'); }
    catch (e) { T.closeModal(); T.toast(offlineMsg(e), true); }
  };

  // ------------------------------------------------------------ share my week
  function weekText() {
    return DAYS.map(function (n, i) {
      var l = slots.filter(function (s) { return s.day === i + 1; });
      return l.length ? n + '\n' + l.map(function (s) { return s.start + ' - ' + s.end + '  ' + s.subject + (s.className ? ' (' + s.className + ')' : '') + (s.room ? ' - ' + s.room : ''); }).join('\n') : null;
    }).filter(Boolean).join('\n\n');
  }
  A.copyweek = function () { T.copyText(weekText()); };
  A.wordweek = function () {
    var rows = slots.map(function (s) { return '<tr><td>' + esc(DAYS[s.day - 1]) + '</td><td>' + esc(s.start) + ' - ' + esc(s.end) + '</td><td>' + esc(s.subject) + '</td><td>' + esc(s.className) + '</td><td>' + esc(s.room) + '</td></tr>'; }).join('');
    var doc = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>My timetable</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:12pt}table{border-collapse:collapse;width:100%}td,th{border:1px solid #444;padding:4px}th{background:#eee}h1{text-align:center;font-size:16pt}</style></head><body><h1>My Timetable</h1><table><tr><th>Day</th><th>Time</th><th>Subject</th><th>Class</th><th>Room</th></tr>' + rows + '</table>' +
      (T.isPaid() ? '' : '<p style="margin-top:24pt;color:#777777;font-size:9pt">Made with SmartClass Teacher AI (free plan)</p>') + '</body></html>';
    T.saveFile('My-Timetable.doc', 'application/msword', '\ufeff' + doc);
  };

  // ------------------------------------------------------------ the class timetable maker
  var PRESETS = {
    junior: [['Mathematics', 5, true], ['English Language', 5, true], ['Basic Science', 3], ['Basic Technology', 2], ['Social Studies', 2], ['Civic Education', 2], ['Computer Studies', 2], ['Agricultural Science', 2], ['Business Studies', 2], ['Christian Religious Studies', 2], ['Creative and Cultural Arts', 2], ['Physical and Health Education', 2], ['Nigerian Language', 2], ['French', 2]],
    primary: [['English Language', 5, true], ['Mathematics', 5, true], ['Basic Science and Technology', 3], ['Social Studies', 2], ['Civic Education', 1], ['Christian Religious Studies', 2], ['Creative and Cultural Arts', 2], ['Physical and Health Education', 2], ['Computer Studies', 2], ['Verbal Reasoning', 2], ['Quantitative Reasoning', 2], ['Nigerian Language', 2]]
  };
  function subjRow(name, n, core, teacher) {
    return '<div class="ts"><input class="ts-name" maxlength="40" placeholder="Subject" value="' + esc(name || '') + '">' +
      '<div class="row2"><input class="ts-n" type="number" inputmode="numeric" min="1" max="10" placeholder="Periods a week" value="' + (n || '') + '"><input class="ts-teacher" maxlength="40" placeholder="Teacher (optional)" value="' + esc(teacher || '') + '"></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center"><label class="chk"><input type="checkbox" class="ts-core"' + (core ? ' checked' : '') + '> Early in the day (core)</label><button type="button" class="link danger" data-act="rmsubj">Remove</button></div></div>';
  }
  function breakRow(after, minutes, label) {
    return '<div class="row3 mk-break" style="margin-bottom:8px"><input class="bk-after" type="number" inputmode="numeric" min="1" placeholder="After period" value="' + (after || '') + '"><input class="bk-min" type="number" inputmode="numeric" min="5" placeholder="Minutes" value="' + (minutes || '') + '"><input class="bk-label" maxlength="20" placeholder="Name" value="' + esc(label || '') + '"></div>';
  }
  function savedForm() { try { return JSON.parse(localStorage.getItem('tt_make') || 'null'); } catch (e) { return null; } }
  function makeView() {
    var f = savedForm() || { className: '', days: 5, periodsPerDay: 8, startTime: '08:00', periodMinutes: 40, breaks: [{ afterPeriod: 3, minutes: 30, label: 'Break' }], subjects: [] };
    T.shell('<h1>Time-Table</h1>' + tabs('make') + '<p class="sub">Make a class timetable in seconds. It is free and does not use any of your daily generations.</p>' +
      '<div class="card"><label for="mk-class" style="margin-top:0">Class</label><input id="mk-class" maxlength="30" placeholder="e.g. JSS 1A" value="' + esc(f.className) + '">' +
      '<div class="row2"><div><label for="mk-days">School days</label><select id="mk-days"><option value="5"' + (f.days === 5 ? ' selected' : '') + '>Monday to Friday</option><option value="6"' + (f.days === 6 ? ' selected' : '') + '>Monday to Saturday</option></select></div>' +
      '<div><label for="mk-periods">Periods a day</label><input id="mk-periods" type="number" inputmode="numeric" min="3" max="10" value="' + f.periodsPerDay + '"></div></div>' +
      '<div class="row2"><div><label for="mk-start">First period starts</label><input id="mk-start" type="time" value="' + esc(f.startTime) + '"></div>' +
      '<div><label for="mk-len">Minutes per period</label><input id="mk-len" type="number" inputmode="numeric" min="20" max="90" value="' + f.periodMinutes + '"></div></div>' +
      '<label>Breaks</label><div class="row3 hint" style="margin-bottom:4px"><span>After period</span><span>Minutes</span><span>Name</span></div><div id="mk-breaks">' +
      (f.breaks || []).map(function (b) { return breakRow(b.afterPeriod, b.minutes, b.label); }).join('') + '</div><button type="button" class="link" data-act="addbreak">+ Add another break</button></div>' +
      '<h2 class="sec">Subjects</h2><div class="actions"><button class="btn small alt" data-act="preset" data-p="junior">Typical Junior Secondary</button><button class="btn small alt" data-act="preset" data-p="primary">Typical Primary</button></div>' +
      '<p class="hint">These are only suggestions. Change the subjects and the periods to match your school.</p>' +
      '<div id="mk-subjects">' + (f.subjects && f.subjects.length ? f.subjects.map(function (s) { return subjRow(s.name, s.perWeek, s.core, s.teacher); }).join('') : subjRow('', '', false, '')) + '</div>' +
      '<button class="btn alt small" data-act="addsubj">+ Add a subject</button>' +
      '<div class="card" style="margin-top:14px"><div id="mk-count" class="kv" style="border:0;padding:0"></div><div class="err" id="mk-err"></div>' +
      '<button class="btn block" data-act="maketimetable">Make the timetable</button></div>', { title: 'Time-Table', back: 'home', nav: 'home' });
    updateCount();
  }
  function updateCount() {
    var box = $('#mk-count'); if (!box) return;
    var total = all('.ts-n').reduce(function (t, i) { return t + (Number(i.value) || 0); }, 0);
    var slotsN = Number($('#mk-days').value) * (Number($('#mk-periods').value) || 0);
    var over = total > slotsN;
    box.innerHTML = '<span>Periods used</span><b style="color:' + (over ? 'var(--err)' : 'inherit') + '">' + total + ' of ' + slotsN + (over ? ' (too many)' : (slotsN - total ? ' (' + (slotsN - total) + ' free)' : '')) + '</b>';
  }
  document.addEventListener('input', function (e) { if (e.target && (e.target.classList.contains('ts-n') || e.target.id === 'mk-periods')) updateCount(); });
  document.addEventListener('change', function (e) { if (e.target && e.target.id === 'mk-days') updateCount(); });
  A.addsubj = function () { $('#mk-subjects').insertAdjacentHTML('beforeend', subjRow('', '', false, '')); };
  A.rmsubj = function (el) { var rows = all('.ts'); if (rows.length > 1) { el.closest('.ts').remove(); updateCount(); } else T.toast('Keep at least one subject.', true); };
  A.addbreak = function () { if (all('.mk-break').length >= 3) return T.toast('Up to 3 breaks.', true); $('#mk-breaks').insertAdjacentHTML('beforeend', breakRow('', 20, 'Break')); };
  A.preset = function (el) {
    var list = PRESETS[el.getAttribute('data-p')] || [];
    $('#mk-subjects').innerHTML = list.map(function (x) { return subjRow(x[0], x[1], x[2], ''); }).join('');
    updateCount();
  };
  A.maketimetable = async function (btn) {
    var err = $('#mk-err'); err.textContent = '';
    var subjects = all('.ts').map(function (r) {
      return { name: $('.ts-name', r).value.trim(), perWeek: Number($('.ts-n', r).value), teacher: $('.ts-teacher', r).value.trim(), core: $('.ts-core', r).checked };
    }).filter(function (s) { return s.name || s.perWeek; });
    var breaks = all('.mk-break').map(function (r) {
      return { afterPeriod: Number($('.bk-after', r).value), minutes: Number($('.bk-min', r).value) || 20, label: $('.bk-label', r).value.trim() };
    }).filter(function (b) { return b.afterPeriod; });
    var body = { className: $('#mk-class').value.trim(), days: Number($('#mk-days').value), periodsPerDay: Number($('#mk-periods').value), startTime: $('#mk-start').value, periodMinutes: Number($('#mk-len').value), breaks: breaks, subjects: subjects };
    if (!body.className) { err.textContent = 'Please enter the class name.'; return; }
    if (subjects.some(function (s) { return !s.name || !s.perWeek; })) { err.textContent = 'Every subject needs a name and its periods a week.'; return; }
    btn.disabled = true; btn.textContent = 'Making…';
    try {
      var r = await api('POST', '/api/timetable/make', body);
      try { localStorage.setItem('tt_make', JSON.stringify(body)); } catch (x) { /* ignore */ }
      T.go('#/item/' + r.id);
    } catch (e) { err.textContent = offlineMsg(e); btn.disabled = false; btn.textContent = 'Make the timetable'; }
  };
})();
