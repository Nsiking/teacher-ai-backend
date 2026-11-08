'use strict';
/* School formats: the teacher's own layout for schemes of work, lesson plans and lesson notes. Loaded before app.js. */
(function () {
  var T = window.TT = window.TT || {};
  T.views = T.views || {};
  T.actions = T.actions || {};
  var A = T.actions;

  function esc(s) { return T.esc(s); }
  function api(m, p, b) { return T.api(m, p, b); }
  function $(s, el) { return (el || document).querySelector(s); }
  function all(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }

  var LABEL = { 'lesson-note': 'Lesson note', 'lesson-plan': 'Lesson plan', 'scheme-of-work': 'Scheme of work' };
  var TYPES = ['scheme-of-work', 'lesson-plan', 'lesson-note'];
  var KIND_LABEL = [['text', 'Paragraph'], ['numbered', 'Numbered list'], ['bullets', 'Bulleted list'], ['table', 'Table']];
  var pending = null;     // a layout learned from a sample, waiting for the teacher to review it
  var learnFiles = [];
  var cur = null;         // the format being edited
  function offlineMsg(e) { return e.offline ? 'This part needs the internet. Please connect and try again.' : e.message; }
  function seePlans(e) { return (e.code === 'LIMIT' || e.code === 'LIMIT_REACHED' || e.code === 'LIMIT_REACHED_MONTH') ? ' <button type="button" class="link" data-act="seeplans" style="padding:0">See plans</button>' : ''; }

  T.views.formats = async function (parts) {
    if (parts[0] === 'format') {
      if (parts[1] === 'learn') return learnView(parts[2]);
      if (parts[1] === 'new') return editView(null, parts[2]);
      return editView(Number(parts[1]), null);
    }
    return listView();
  };

  // ------------------------------------------------------------ the list
  async function listView() {
    T.shell('<h1>My school formats</h1><p class="sub">Make the app write schemes of work, lesson plans and lesson notes in your school\'s own layout. <b>You approve each format before it is used.</b></p>' +
      '<div id="fm-list"><p class="hint">Loading…</p></div><button class="btn block" data-act="newformat">+ New format</button>', { title: 'School formats', back: 'account', nav: 'home' });
    try {
      var r = await api('GET', '/api/formats');
      var html = '';
      TYPES.forEach(function (t) {
        var list = r.formats.filter(function (f) { return f.type === t; });
        if (!list.length) return;
        html += '<h2 class="sec">' + LABEL[t] + '</h2>' + list.map(function (f) {
          return '<button class="item" data-go="format/' + f.id + '"><span class="ico">📐</span><span><div class="t">' + esc(f.name) +
            (f.status === 'approved' ? '<span class="badge ok">Approved</span>' : '<span class="badge draft">Draft</span>') + (f.isDefault ? '<span class="badge def">My default</span>' : '') +
            '</div><div class="m">' + f.spec.sections.length + ' sections · ' + (f.source === 'sample' ? 'learned from a sample' : f.source === 'standard' ? 'from the standard layout' : 'made by hand') + '</div></span></button>';
        }).join('');
      });
      $('#fm-list').innerHTML = (html || '<div class="empty">No formats yet. Tap "New format" to add your school\'s layout.</div>') +
        '<p class="hint">Your plan keeps ' + r.limit + ' school format' + (r.limit === 1 ? '' : 's') + '. ' + (r.formats.length >= r.limit ? 'You have used them all.' : '') + '</p>';
    } catch (e) { $('#fm-list').innerHTML = '<div class="empty">' + esc(offlineMsg(e)) + '</div>'; }
  }
  A.newformat = function () {
    T.modal('<h3>What is the format for?</h3>' + TYPES.map(function (t) { return '<button class="btn alt" data-act="newtype" data-t="' + t + '">' + LABEL[t] + '</button>'; }).join('') + '<button class="btn alt" data-act="closemodal" style="border-color:transparent">Cancel</button>');
  };
  A.newtype = function (el) {
    var t = el.getAttribute('data-t');
    T.modal('<h3>' + LABEL[t] + ': how do you want to start?</h3>' +
      '<button class="btn" data-act="startlearn" data-t="' + t + '">📷 Learn from my school\'s sample</button><p class="hint">Photograph or paste a sample your school uses. Uses 1 generation.</p>' +
      '<button class="btn alt" data-act="startstandard" data-t="' + t + '">Start from the standard layout</button><p class="hint">Free. Then change it to match your school.</p>' +
      '<button class="btn alt" data-act="closemodal" style="border-color:transparent">Cancel</button>');
  };
  A.startlearn = function (el) { pending = null; learnFiles = []; T.closeModal(); T.go('#/format/learn/' + el.getAttribute('data-t')); };
  A.startstandard = function (el) { pending = null; T.closeModal(); T.go('#/format/new/' + el.getAttribute('data-t')); };

  // ------------------------------------------------------------ learn from a sample
  function learnView(type) {
    if (!LABEL[type]) { T.go('#/formats'); return; }
    T.shell('<h1>Learn my school\'s ' + LABEL[type].toLowerCase() + ' format</h1>' +
      '<p class="sub">Show me a sample your school uses. I copy only the <b>layout</b>: the headings, the table columns and the top lines. I do not keep your sample or its content.</p>' +
      '<div class="card"><button class="btn alt small" data-act="fmphoto">📷 Choose photos of the sample</button><input type="file" id="fm-photos" accept="image/*" multiple class="hide">' +
      '<div id="fm-photo-count" class="hint" style="margin:6px 0">No photos chosen. You can choose up to 3.</div>' +
      '<label for="fm-text">Or paste the text of the sample</label><textarea id="fm-text" maxlength="8000" placeholder="Paste a sample scheme, plan or note here"></textarea>' +
      '<p class="hint">Please leave out pupils\' names. This uses 1 generation.</p><div class="err" id="fm-err"></div>' +
      '<button class="btn block" data-act="learnformat" data-t="' + type + '">Read my format</button></div>', { title: 'Learn a format', back: 'formats', nav: 'home' });
  }
  A.fmphoto = function () { var i = $('#fm-photos'); if (i) i.click(); };
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'fm-photos') {
      learnFiles = Array.prototype.slice.call(e.target.files || []);
      var c = $('#fm-photo-count'); if (!c) return;
      if (learnFiles.length > 3) { learnFiles = []; c.textContent = 'Please choose up to 3 photos.'; return; }
      c.textContent = learnFiles.length ? learnFiles.length + ' photo' + (learnFiles.length === 1 ? '' : 's') + ' chosen.' : 'No photos chosen. You can choose up to 3.';
    }
  });
  A.learnformat = async function (btn) {
    var type = btn.getAttribute('data-t'), err = $('#fm-err'); err.innerHTML = '';
    var txt = ($('#fm-text').value || '').trim();
    if (!learnFiles.length && !txt) { err.textContent = 'Choose a photo of the sample, or paste its text.'; return; }
    for (var i = 0; i < learnFiles.length; i++) if (!/^image\//.test(learnFiles[i].type)) { err.textContent = 'Please choose pictures only.'; return; }
    if (!navigator.onLine) { err.textContent = 'You are offline. Please connect to the internet.'; return; }
    btn.disabled = true; btn.textContent = 'Reading… this can take up to a minute';
    try {
      var images = learnFiles.length ? await T.prepareImages(learnFiles) : [];
      var r = await api('POST', '/api/formats/learn', { type: type, images: images, text: txt });
      pending = { type: type, spec: r.spec };
      T.go('#/format/new/' + type);
    } catch (e) {
      err.innerHTML = esc(offlineMsg(e)) + seePlans(e);
      btn.disabled = false; btn.textContent = 'Read my format';
    }
  };

  // ------------------------------------------------------------ the editor
  async function editView(id, type) {
    T.shell('<div class="empty">Opening…</div>', { title: 'School format', back: 'formats', nav: 'home' });
    try {
      if (id) { cur = await api('GET', '/api/formats/' + id); }
      else if (!LABEL[type]) { T.go('#/formats'); return; }
      else if (pending && pending.type === type) { cur = { type: type, name: 'My school ' + LABEL[type].toLowerCase() + ' format', spec: pending.spec, status: 'draft', source: 'sample', learned: true }; }
      else { var r = await api('GET', '/api/formats/standard/' + type); cur = { type: type, name: r.name, spec: r.spec, status: 'draft', source: 'standard', fromStandard: true }; }
    } catch (e) { T.shell('<div class="empty">' + esc(offlineMsg(e)) + '</div>', { title: 'School format', back: 'formats', nav: 'home' }); return; }
    drawEditor();
  }
  function sectionHtml(s) {
    var kinds = KIND_LABEL.map(function (k) { return '<option value="' + k[0] + '"' + (s.kind === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('');
    return '<div class="fs"><input class="fs-h" maxlength="60" placeholder="Section heading, as your school writes it" value="' + esc(s.heading) + '">' +
      '<select class="fs-k" aria-label="Kind of section">' + kinds + '</select>' +
      '<input class="fs-c' + (s.kind === 'table' ? '' : ' hide') + '" maxlength="300" placeholder="Column names, separated by commas" value="' + esc((s.columns || []).join(', ')) + '">' +
      '<input class="fs-i" maxlength="200" placeholder="What to write here (optional)" value="' + esc(s.instructions || '') + '">' +
      '<div class="fs-tools"><button type="button" class="btn small alt" data-act="fsup" aria-label="Move up">↑ Up</button><button type="button" class="btn small alt" data-act="fsdown" aria-label="Move down">↓ Down</button><button type="button" class="link danger" data-act="fsrm">Remove</button></div></div>';
  }
  function drawEditor() {
    var f = cur, spec = f.spec, existing = !!f.id;
    var banner = f.learned ? '<div class="banner" style="display:block"><b>I read your sample.</b> Please check every heading, column and top line carefully. Fix anything that is wrong, then approve.</div>'
      : f.fromStandard ? '<div class="banner" style="display:block">This is the standard layout. Change it to match your school\'s layout, then approve it.</div>'
      : existing && f.status === 'approved' ? '<div class="banner" style="display:block"><span><b>Approved.</b> If you change the layout, you will need to approve it again.</span></div>'
      : existing ? '<div class="banner" style="display:block"><b>Draft.</b> It is not used until you approve it.</div>' : '';
    T.shell('<h1>' + (existing ? 'Edit' : 'New') + ' ' + LABEL[f.type].toLowerCase() + ' format</h1>' + banner +
      '<div class="card"><label for="fm-name" style="margin-top:0">Name of this format</label><input id="fm-name" maxlength="60" value="' + esc(f.name) + '">' +
      '<label for="fm-title">Title at the top of the document</label><input id="fm-title" maxlength="60" value="' + esc(spec.title) + '">' +
      '<label for="fm-header">Lines in the top block (one per line)</label><textarea id="fm-header" style="min-height:110px" placeholder="School&#10;Subject&#10;Class&#10;Date">' + esc(spec.header.join('\n')) + '</textarea>' +
      '<p class="hint">These are the labels at the top, such as School, Subject, Class. Leave empty for none.</p></div>' +
      '<h2 class="sec">Sections, in order</h2><div id="fm-sections">' + spec.sections.map(sectionHtml).join('') + '</div>' +
      '<button class="btn alt small" data-act="fsadd">+ Add a section</button>' +
      '<div class="card" style="margin-top:14px"><label for="fm-notes" style="margin-top:0">Other rules for this format (optional)</label><textarea id="fm-notes" maxlength="600" placeholder="For example: times must add up to the lesson time; the last section is for the head teacher\'s remarks">' + esc(spec.notes || '') + '</textarea></div>' +
      '<div class="err" id="fm-err"></div>' +
      '<button class="btn block" data-act="fmapprove">Save and approve</button><button class="btn alt block" data-act="fmdraft">Save as a draft</button>' +
      (existing && f.status === 'approved' ? '<button class="btn alt block" data-act="fmdefault">' + (f.isDefault ? 'Stop using it as my default' : 'Make it my default for ' + LABEL[f.type].toLowerCase() + 's') + '</button>' : '') +
      (existing ? '<button class="btn danger block" data-act="fmdelete">Delete this format</button>' : ''), { title: 'School format', back: 'formats', nav: 'home' });
  }
  document.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('fs-k')) {
      var c = $('.fs-c', e.target.closest('.fs')); if (c) c.classList.toggle('hide', e.target.value !== 'table');
    }
  });
  A.fsadd = function () { $('#fm-sections').insertAdjacentHTML('beforeend', sectionHtml({ heading: '', kind: 'text', instructions: '' })); var last = all('.fs-h'); last[last.length - 1].focus(); };
  A.fsrm = function (el) { if (all('.fs').length > 1) el.closest('.fs').remove(); else T.toast('Keep at least one section.', true); };
  A.fsup = function (el) { var r = el.closest('.fs'), p = r.previousElementSibling; if (p) r.parentNode.insertBefore(r, p); };
  A.fsdown = function (el) { var r = el.closest('.fs'), n = r.nextElementSibling; if (n) r.parentNode.insertBefore(n, r); };

  function collect() {
    var sections = all('.fs').map(function (r) {
      var kind = $('.fs-k', r).value, o = { heading: $('.fs-h', r).value.trim(), kind: kind, instructions: $('.fs-i', r).value.trim() };
      if (kind === 'table') o.columns = $('.fs-c', r).value.split(/[|,\n]+/).map(function (c) { return c.trim(); }).filter(Boolean);
      return o;
    });
    return { title: $('#fm-title').value.trim(), header: $('#fm-header').value.split('\n').map(function (h) { return h.trim(); }).filter(Boolean), sections: sections, notes: $('#fm-notes').value.trim() };
  }
  function problem(spec, name) {
    if (!name) return 'Please give this format a name.';
    if (!spec.title) return 'Please enter the title that goes at the top of the document.';
    for (var i = 0; i < spec.sections.length; i++) {
      var s = spec.sections[i];
      if (!s.heading) return 'Section ' + (i + 1) + ' needs a heading. Remove it if you do not need it.';
      if (s.kind === 'table' && s.columns.length < 2) return 'The table "' + s.heading + '" needs at least 2 column names.';
    }
    return '';
  }
  async function save(approve, makeDefault) {
    var err = $('#fm-err'); err.innerHTML = '';
    var spec = collect(), name = $('#fm-name').value.trim(), p = problem(spec, name);
    if (p) { err.textContent = p; return; }
    try {
      var saved = cur.id ? await api('PUT', '/api/formats/' + cur.id, { name: name, spec: spec }) : await api('POST', '/api/formats', { type: cur.type, name: name, spec: spec, source: cur.source });
      cur.id = saved.id;
      if (approve) {
        saved = await api('POST', '/api/formats/' + saved.id + '/approve');
        if (makeDefault) await api('POST', '/api/formats/' + saved.id + '/default', { value: true });
      }
      pending = null;
      T.closeModal();
      T.toast(approve ? 'Approved. It is ready to use.' : 'Saved as a draft. It is not used until you approve it.');
      T.go('#/formats');
    } catch (e) { T.closeModal(); err.innerHTML = esc(offlineMsg(e)) + seePlans(e); window.scrollTo(0, document.body.scrollHeight); }
  }
  A.fmdraft = function () { save(false, false); };
  A.fmapprove = function () {
    var spec = collect(), name = $('#fm-name').value.trim(), p = problem(spec, name);
    if (p) { $('#fm-err').textContent = p; return; }
    $('#fm-err').textContent = '';
    T.modal('<h3>Approve this format?</h3><p class="sub">The app will write your ' + LABEL[cur.type].toLowerCase() + 's in exactly this layout. You can change it later, but you will need to approve it again.</p>' +
      '<label class="chk" style="justify-content:center;margin:6px 0"><input type="checkbox" id="fm-def" checked> Use it automatically for my ' + LABEL[cur.type].toLowerCase() + 's</label>' +
      '<button class="btn" data-act="fmdoapprove">Yes, approve it</button><button class="btn alt" data-act="closemodal">Not yet</button>');
  };
  A.fmdoapprove = function () { var d = $('#fm-def'); save(true, !!(d && d.checked)); };
  A.fmdefault = async function () {
    try { await api('POST', '/api/formats/' + cur.id + '/default', { value: !cur.isDefault }); T.toast(cur.isDefault ? 'No longer your default' : 'Now your default'); editView(cur.id, null); }
    catch (e) { T.toast(offlineMsg(e), true); }
  };
  A.fmdelete = function () {
    T.modal('<h3>Delete this format?</h3><p class="sub">Documents you already made keep their layout. This cannot be undone.</p>' +
      '<button class="btn danger" data-act="fmdodelete">Yes, delete it</button><button class="btn alt" data-act="closemodal">Keep it</button>');
  };
  A.fmdodelete = async function () {
    try { await api('DELETE', '/api/formats/' + cur.id); T.closeModal(); T.toast('Deleted'); T.go('#/formats'); }
    catch (e) { T.closeModal(); T.toast(offlineMsg(e), true); }
  };
})();
