'use strict';
/* Forgot password: the teacher asks for a 6-digit code (email or SMS), then enters it with a new password. Loaded before app.js. */
(function () {
  var T = window.TT = window.TT || {};
  T.views = T.views || {};
  T.actions = T.actions || {};
  var A = T.actions;

  function esc(s) { return T.esc(s); }
  function $(s) { return document.querySelector(s); }
  var st = { id: '', channel: '', step: 1 };
  var timer = null;

  function mask(id) {
    id = String(id || '').trim();
    if (id.indexOf('@') > -1) { var p = id.toLowerCase().split('@'); return p[0].charAt(0) + '***@' + p[1]; }
    var d = id.replace(/[\s\-().]/g, '');
    return d.length > 6 ? d.slice(0, 4) + ' *** **' + d.slice(-2) : d;
  }
  function helpLink() {
    return '<a href="' + T.waLink('Hello, I forgot my password for SmartClass Teacher AI. Please help me reset it.') + '" target="_blank" rel="noopener" style="color:var(--brand)">Message us on WhatsApp</a>';
  }
  function hero(title, sub) { return '<div class="auth-hero"><img src="/icon-192.png" alt=""><h1>' + title + '</h1><p class="sub">' + sub + '</p></div>'; }

  T.views.forgot = function () {
    clearInterval(timer);
    if (st.step === 2 && st.id) return step2();
    step1();
  };

  function step1(message) {
    T.shell(hero('Forgot your password?', 'We will send a 6-digit code to your email or phone.') +
      '<div class="card"><label for="fg-id" style="margin-top:0">Email or phone number</label><input id="fg-id" autocomplete="username" inputmode="email" placeholder="08012345678 or you@email.com" maxlength="120" value="' + esc(st.id) + '">' +
      '<div class="err" id="fg-err">' + esc(message || '') + '</div><div class="hint" id="fg-note" aria-live="polite"></div>' +
      '<button class="btn block" data-act="fgsend">Send me a code</button>' +
      '<div class="toggle"><button class="link" data-go="auth">Back to log in</button></div></div>' +
      '<p class="hint" style="text-align:center">Cannot get the code? ' + helpLink() + ' and we will reset it for you.</p>', {});
  }
  function step2() {
    var email = st.id.indexOf('@') > -1;
    T.shell(hero('Enter your code', 'If there is an account for <b>' + esc(mask(st.id)) + '</b>, we have sent a 6-digit code to it. It works for 15 minutes.') +
      '<div class="card"><label for="fg-code" style="margin-top:0">6-digit code</label><input id="fg-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="letter-spacing:6px;font-size:1.3rem;text-align:center">' +
      '<label for="fg-pw">New password (at least 8 characters)</label><input id="fg-pw" type="password" autocomplete="new-password" maxlength="100">' +
      '<label class="chk"><input type="checkbox" id="fg-show"> Show the password</label>' +
      '<div class="err" id="fg-err"></div>' +
      '<button class="btn block" data-act="fgconfirm">Change my password</button>' +
      '<div class="toggle"><button class="link" data-act="fgresend" id="fg-resend" disabled>Send the code again (60)</button></div>' +
      '<div class="toggle"><button class="link" data-act="fgback">Use a different ' + (email ? 'email or phone number' : 'phone number or email') + '</button></div></div>' +
      '<p class="hint" style="text-align:center">' + (email ? 'Check your spam folder too. ' : '') + 'No code? ' + helpLink() + ' and we will reset it for you.</p>', {});
    countdown(60);
  }
  function countdown(sec) {
    clearInterval(timer);
    var left = sec;
    timer = setInterval(function () {
      var b = $('#fg-resend');
      if (!b) { clearInterval(timer); return; }
      left--;
      if (left <= 0) { clearInterval(timer); b.disabled = false; b.textContent = 'Send the code again'; }
      else b.textContent = 'Send the code again (' + left + ')';
    }, 1000);
  }
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'fg-show') { var p = $('#fg-pw'); if (p) p.type = e.target.checked ? 'text' : 'password'; }
  });

  async function request(btn, resend) {
    var err = $('#fg-err'), note = $('#fg-note');
    var id = resend ? st.id : ($('#fg-id').value || '').trim();
    if (err) err.textContent = '';
    if (!id) { err.textContent = 'Enter your email or phone number.'; return; }
    if (!navigator.onLine) { if (err) err.textContent = 'You are offline. Please connect to the internet.'; return; }
    btn.disabled = true;
    var label = btn.textContent; btn.textContent = 'Please wait…';
    try {
      var r = await T.api('POST', '/api/auth/reset/request', { identifier: id });
      st.id = id; st.channel = r.channel;
      if (!r.available) {
        if (note) note.innerHTML = (r.channel === 'email' ? 'Codes by email are not available yet.' : 'Codes by SMS are not available yet.') + ' ' + helpLink() + ' and we will reset your password for you.';
        btn.disabled = false; btn.textContent = label; return;
      }
      st.step = 2;
      if (resend) { T.toast('Code sent again'); btn.textContent = 'Send the code again (60)'; countdown(60); } else step2();
    } catch (e) {
      if (err) err.textContent = e.message;
      btn.disabled = false; btn.textContent = label;
    }
  }
  A.fgsend = function (btn) { request(btn, false); };
  A.fgresend = function (btn) { request(btn, true); };
  A.fgback = function () { clearInterval(timer); st.step = 1; step1(); };
  A.fgconfirm = async function (btn) {
    var err = $('#fg-err'); err.textContent = '';
    var code = ($('#fg-code').value || '').replace(/\s+/g, ''), pw = $('#fg-pw').value;
    if (!/^\d{6}$/.test(code)) { err.textContent = 'Enter the 6-digit code.'; return; }
    if (pw.length < 8) { err.textContent = 'The new password must be at least 8 characters.'; return; }
    if (!navigator.onLine) { err.textContent = 'You are offline. Please connect to the internet.'; return; }
    btn.disabled = true; btn.textContent = 'Please wait…';
    try {
      var s = await T.api('POST', '/api/auth/reset/confirm', { identifier: st.id, code: code, newPassword: pw });
      clearInterval(timer); st = { id: '', channel: '', step: 1 };
      T.saveSession(s); T.toast('Password changed. You are logged in.'); T.go('#/home');
    } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = 'Change my password'; }
  };
})();
