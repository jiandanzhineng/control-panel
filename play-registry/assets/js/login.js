/* play-registry 登录页逻辑：登录 / 注册 / 找回密码三视图，以及登录态跳转。 */
(function () {
  'use strict';

  var auth = window.SiteAuth;
  var box = document.querySelector('.auth-box');
  if (!auth || !box) return;

  var checking = document.getElementById('auth-checking');
  var views = {};
  Array.prototype.forEach.call(box.querySelectorAll('[data-auth-view]'), function (view) {
    views[view.getAttribute('data-auth-view')] = view;
  });
  var forms = {
    login: document.getElementById('login-form'),
    register: document.getElementById('register-form'),
    recover: document.getElementById('recover-form')
  };
  var done = document.getElementById('recover-done');
  var current = 'login';

  function t(key) { return auth.t(key); }

  function viewOf(hash) {
    if (hash === '#register' || hash === '#recover') return hash.slice(1);
    return 'login';
  }

  function formError(form) { return form ? form.querySelector('.form-error') : null; }

  function showError(form, message, fields) {
    var node = formError(form);
    if (node) {
      node.textContent = message;
      node.hidden = false;
    }
    (fields || []).forEach(function (input) { input.setAttribute('aria-invalid', 'true'); });
  }

  function clearError(form) {
    var node = formError(form);
    if (!node) return;
    node.textContent = '';
    node.hidden = true;
    Array.prototype.forEach.call(form.querySelectorAll('[aria-invalid]'), function (input) {
      input.removeAttribute('aria-invalid');
    });
  }

  function emailInput(view) {
    var form = forms[view];
    return form ? form.querySelector('input[type="email"]') : null;
  }

  function typedEmail() {
    var input = emailInput(current);
    return input ? input.value.trim() : '';
  }

  function switchView(name, updateHash) {
    if (!views[name]) name = 'login';
    var email = typedEmail();
    if (checking) checking.hidden = true;
    Object.keys(views).forEach(function (key) { views[key].hidden = key !== name; });
    if (done) done.hidden = true;
    if (forms.recover) forms.recover.hidden = false;
    current = name;
    if (email) {
      var target = emailInput(name);
      if (target && !target.value) target.value = email;
    }
    if (updateHash !== false) {
      var hash = name === 'login' ? '' : '#' + name;
      try { history.replaceState(null, '', location.pathname + location.search + hash); } catch (_) {}
    }
    focusFirstEmpty(views[name]);
  }

  function focusFirstEmpty(view) {
    if (!view) return;
    var inputs = view.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].value && inputs[i].type !== 'hidden' && !inputs[i].disabled) {
        try { inputs[i].focus(); } catch (_) {}
        return;
      }
    }
  }

  function setBusy(form, busy, labelKey) {
    var button = form.querySelector('button[type="submit"]');
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle('is-loading', busy);
    var key = button.getAttribute('data-i18n');
    if (busy) button.textContent = t(labelKey);
    else button.textContent = key ? t(key) : button.textContent;
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function redirectAfterAuth() {
    location.replace(auth.consumeReturn());
  }

  /* ---------- 密码显示切换 ---------- */

  Array.prototype.forEach.call(box.querySelectorAll('[data-password-toggle]'), function (button) {
    button.addEventListener('click', function () {
      var wrap = button.parentNode;
      var input = wrap ? wrap.querySelector('input') : null;
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.textContent = show ? t('authHide') : t('authShow');
      button.setAttribute('aria-pressed', show ? 'true' : 'false');
    });
  });

  /* ---------- 视图切换 ---------- */

  Array.prototype.forEach.call(box.querySelectorAll('[data-auth-go]'), function (button) {
    button.addEventListener('click', function () {
      switchView(button.getAttribute('data-auth-go'));
    });
  });

  Object.keys(forms).forEach(function (name) {
    var form = forms[name];
    if (!form) return;
    form.addEventListener('input', function () { clearError(form); });
  });

  /* ---------- 登录 ---------- */

  if (forms.login) forms.login.addEventListener('submit', function (event) {
    event.preventDefault();
    var form = forms.login;
    var email = form.email.value.trim();
    var password = form.password.value;
    if (!validEmail(email)) { showError(form, t('authErrEmail'), [form.email]); return; }
    if (password.length < 8) { showError(form, t('authErrPassword'), [form.password]); return; }
    clearError(form);
    setBusy(form, true, 'authLoggingIn');
    auth.login({
      email: email,
      password: password,
      remember: !!(form.remember && form.remember.checked)
    }).then(function () {
      redirectAfterAuth();
    }).catch(function (err) {
      showError(form, err && err.message ? err.message : t('authErrServer'));
      setBusy(form, false);
    });
  });

  /* ---------- 注册 ---------- */

  if (forms.register) forms.register.addEventListener('submit', function (event) {
    event.preventDefault();
    var form = forms.register;
    var email = form.email.value.trim();
    var password = form.password.value;
    var confirm = form.confirm.value;
    if (!validEmail(email)) { showError(form, t('authErrEmail'), [form.email]); return; }
    if (password.length < 8) { showError(form, t('authErrPassword'), [form.password]); return; }
    if (password !== confirm) { showError(form, t('authErrMismatch'), [form.confirm]); return; }
    clearError(form);
    setBusy(form, true, 'authRegistering');
    auth.register({ email: email, password: password, remember: true }).then(function () {
      redirectAfterAuth();
    }).catch(function (err) {
      showError(form, err && err.message ? err.message : t('authErrServer'));
      setBusy(form, false);
    });
  });

  /* ---------- 找回密码 ---------- */

  if (forms.recover) forms.recover.addEventListener('submit', function (event) {
    event.preventDefault();
    var form = forms.recover;
    var email = form.email.value.trim();
    if (!validEmail(email)) { showError(form, t('authErrEmail'), [form.email]); return; }
    clearError(form);
    setBusy(form, true, 'authSubmitting');
    auth.recover(email).then(function () {
      form.hidden = true;
      if (done) done.hidden = false;
      setBusy(form, false);
    }).catch(function (err) {
      showError(form, err && err.message ? err.message : t('authErrServer'));
      setBusy(form, false);
    });
  });

  /* ---------- 初始状态 ---------- */

  if (auth.isLoggedIn()) {
    Object.keys(views).forEach(function (key) { views[key].hidden = true; });
    if (checking) checking.hidden = false;
    auth.verify().then(function (user) {
      if (user) redirectAfterAuth();
      else switchView('login', false);
    });
  } else {
    switchView(viewOf(location.hash), false);
  }
})();
