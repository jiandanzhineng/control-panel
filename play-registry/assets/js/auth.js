/* play-registry 站点登录态（window.SiteAuth）。
 * 凭证只存本浏览器：勾选「保持登录」写 localStorage，否则写 sessionStorage。
 * 公开页面只读缓存渲染导航，不发网络请求；只有登录/投稿/审核页才会调用 API。 */
(function (root) {
  'use strict';

  var TOKEN_KEY = 'game-platform-mobile-token';
  var USER_KEY = 'game-platform-user';
  var RETURN_KEY = 'auth-return';
  var DEFAULT_RETURN = 'submit.html';

  var ZH_FALLBACK = {
    navLogin: '登录',
    roleAdmin: '管理员',
    roleCreator: '创作者',
    menuSubmit: '投稿工作台',
    menuAuthor: '作者管理',
    menuAdmin: '审核后台',
    menuLogout: '退出登录',
    authErrNetwork: '网络连接失败，请检查网络后重试。',
    authErrInvalid: '邮箱或密码不正确。',
    authErrExists: '该邮箱已注册，请直接登录。',
    authErrInput: '提交的内容不符合要求，请检查后重试。',
    authErrRate: '操作过于频繁，请稍后再试。',
    authErrServer: '服务器开小差了，请稍后再试。',
    authErrExpired: '登录已过期，请重新登录。'
  };

  var script = document.currentScript;
  if (!script) {
    var scripts = document.querySelectorAll('script[src]');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (/\/auth\.js(\?|$)/.test(scripts[i].getAttribute('src') || '')) { script = scripts[i]; break; }
    }
  }
  var SITE_ROOT = '/';
  try {
    SITE_ROOT = new URL('../../', (script && script.src) || root.location.href).href;
  } catch (_) {
    SITE_ROOT = '/';
  }

  function t(key, vars) {
    if (root.SiteI18n && typeof root.SiteI18n.t === 'function') {
      // 旧版 i18n.js 可能还在浏览器缓存里，查不到键时会原样返回键名，此时退回内置中文。
      try {
        var translated = root.SiteI18n.t(key, vars);
        if (translated !== key || !ZH_FALLBACK[key]) return translated;
      } catch (_) {}
    }
    var text = ZH_FALLBACK[key] || key;
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k] == null ? '' : String(vars[k]);
    });
  }

  /* ---------- storage（全部 try/catch，隐私模式下不抛） ---------- */

  function readStore(key) {
    try {
      var value = root.localStorage.getItem(key);
      if (value != null) return value;
    } catch (_) {}
    try { return root.sessionStorage.getItem(key); } catch (_) {}
    return null;
  }

  function writeStore(key, value, remember) {
    var target = remember ? root.localStorage : root.sessionStorage;
    var other = remember ? root.sessionStorage : root.localStorage;
    try { other.removeItem(key); } catch (_) {}
    try { target.setItem(key, value); } catch (_) {}
  }

  function removeStore(key) {
    try { root.localStorage.removeItem(key); } catch (_) {}
    try { root.sessionStorage.removeItem(key); } catch (_) {}
  }

  function readUser() {
    var raw = readStore(USER_KEY);
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.email) return parsed;
    } catch (_) {}
    return null;
  }

  function token() { return readStore(TOKEN_KEY) || ''; }
  function user() { return readUser(); }
  function isLoggedIn() { return !!token(); }

  function emit() {
    try {
      document.dispatchEvent(new CustomEvent('site-auth-change', { detail: { user: readUser() } }));
    } catch (_) {}
  }

  function setSession(nextToken, nextUser, remember) {
    writeStore(TOKEN_KEY, nextToken, remember);
    writeStore(USER_KEY, JSON.stringify({ email: nextUser.email, role: nextUser.role || 'user' }), remember);
  }

  function clearSession() {
    removeStore(TOKEN_KEY);
    removeStore(USER_KEY);
  }

  /* ---------- 网络层 ---------- */

  function apiBase() {
    return String((root.GamePlatformConfig && root.GamePlatformConfig.apiBase) || '').replace(/\/$/, '');
  }

  function identityBase() {
    return String((root.GamePlatformConfig && root.GamePlatformConfig.identityApiBase) || '').replace(/\/$/, '');
  }

  function serverMessage(data) {
    if (!data) return '';
    if (data.error && data.error.message) return String(data.error.message);
    if (data.message) return String(data.message);
    return '';
  }

  function errorMessage(status, data) {
    if (status === 401) return t('authErrInvalid');
    if (status === 409) return t('authErrExists');
    if (status === 400 || status === 422) return t('authErrInput');
    if (status === 429) return t('authErrRate');
    if (status >= 500) return t('authErrServer');
    return serverMessage(data) || ('HTTP ' + status);
  }

  function makeError(message, status, code) {
    var err = new Error(message);
    err.status = status || 0;
    if (code) err.code = code;
    return err;
  }

  function networkError() {
    return makeError(t('authErrNetwork'), 0, 'network');
  }

  function handleExpired() {
    clearSession();
    emit();
    return makeError(t('authErrExpired'), 401, 'expired');
  }

  function request(base, path, options, platform) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    var body = options.body;
    if (body && typeof body === 'string') headers['Content-Type'] = 'application/json';
    if (platform) {
      var current = token();
      if (current) headers.Authorization = 'Bearer ' + current;
    }
    var requestOptions = Object.assign({}, options);
    requestOptions.headers = headers;
    return fetch(base + path, requestOptions).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        if (!response.ok) {
          var code = data && data.error && data.error.code;
          if (platform && response.status === 401) throw handleExpired();
          throw makeError(errorMessage(response.status, data), response.status, code);
        }
        return data;
      }, function () { throw makeError('HTTP ' + response.status, response.status); });
    }, function () {
      throw networkError();
    });
  }

  function api(path, options) { return request(apiBase(), path, options, true); }
  function identity(path, options) { return request(identityBase(), path, options, false); }

  /* ---------- 会话 ---------- */

  function fetchPlatformUser() {
    return api('/api/auth/me').then(function (data) {
      if (!data || !data.user) throw makeError(t('authErrServer'), 500, 'no_user');
      return data.user;
    });
  }

  function storedInLocal() {
    try { return !!root.localStorage.getItem(TOKEN_KEY); } catch (_) { return false; }
  }

  function finishLogin(tokenValue, identityUser, remember) {
    var email = (identityUser && identityUser.email) || '';
    if (!tokenValue) return Promise.reject(makeError(t('authErrServer'), 500, 'no_token'));
    setSession(tokenValue, { email: email, role: (identityUser && identityUser.role) || 'user' }, remember);
    return fetchPlatformUser().then(function (platformUser) {
      var merged = {
        email: platformUser.email || email,
        role: platformUser.role || (identityUser && identityUser.role) || 'user'
      };
      setSession(tokenValue, merged, remember);
      emit();
      return merged;
    }).catch(function (err) {
      if (err && err.status === 401) throw err;
      var fallback = { email: email, role: (identityUser && identityUser.role) || 'user' };
      setSession(tokenValue, fallback, remember);
      emit();
      return fallback;
    });
  }

  function login(credentials) {
    credentials = credentials || {};
    var remember = credentials.remember !== false;
    return identity('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: credentials.email, password: credentials.password })
    }).then(function (data) {
      return finishLogin(data.token, data.user, remember);
    });
  }

  function register(payload) {
    payload = payload || {};
    var remember = payload.remember !== false;
    return identity('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email: payload.email, password: payload.password })
    }).then(function (data) {
      return finishLogin(data.token, data.user, remember);
    });
  }

  function recover(email) {
    return identity('/auth/recovery', { method: 'POST', body: JSON.stringify({ email: email }) });
  }

  function logout() {
    var current = token();
    var call = current
      ? identity('/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + current } }).catch(function () {})
      : Promise.resolve();
    return call.then(function () {
      clearSession();
      emit();
      return true;
    });
  }

  function verify() {
    if (!token()) return Promise.resolve(null);
    return fetchPlatformUser().then(function (platformUser) {
      var cached = readUser() || {};
      var merged = { email: platformUser.email || cached.email || '', role: platformUser.role || 'user' };
      setSession(token(), merged, storedInLocal());
      emit();
      return merged;
    }).catch(function (err) {
      if (err && err.status === 401) return null;
      // 网络抖动时沿用缓存身份；连缓存都没有就清掉孤立 token，避免受保护页卡在空白态。
      var cached = readUser();
      if (!cached) { clearSession(); emit(); }
      return cached;
    });
  }

  /* ---------- 回跳地址（静态托管可能丢弃 query，只能走 sessionStorage） ---------- */

  function currentRelative() {
    var path = root.location.pathname || '/';
    if (SITE_ROOT !== '/' && path.indexOf(SITE_ROOT) === 0) path = path.slice(SITE_ROOT.length - 1);
    if (path.charAt(0) === '/') path = path.slice(1);
    return path + (root.location.search || '') + (root.location.hash || '');
  }

  function saveReturn() {
    try { root.sessionStorage.setItem(RETURN_KEY, currentRelative()); } catch (_) {}
  }

  function resolveReturn(stored) {
    var fallback = SITE_ROOT + DEFAULT_RETURN;
    var value = String(stored || '').trim();
    if (!value) return fallback;
    if (/[\u0000-\u001f]/.test(value)) return fallback;
    if (value.charAt(0) === '/' || value.charAt(0) === '\\') return fallback;
    if (/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(value)) return fallback;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return fallback;
    var target;
    var base;
    try {
      base = new URL(SITE_ROOT);
      target = new URL(value, SITE_ROOT);
    } catch (_) { return fallback; }
    if (target.origin !== base.origin) return fallback;
    var decoded;
    try { decoded = decodeURIComponent(target.pathname); } catch (_) { return fallback; }
    if (/[\u0000-\u001f]/.test(decoded)) return fallback;
    if (/(^|[\\/])\.\.([\\/]|$)/.test(decoded)) return fallback;
    if (target.pathname.indexOf(base.pathname) !== 0) return fallback;
    var relative = target.pathname.slice(base.pathname.length);
    if (!relative || relative === 'login.html') return fallback;
    return target.href;
  }

  function consumeReturn() {
    var stored = '';
    try { stored = root.sessionStorage.getItem(RETURN_KEY) || ''; } catch (_) {}
    try { root.sessionStorage.removeItem(RETURN_KEY); } catch (_) {}
    return resolveReturn(stored);
  }

  function requireLogin() {
    if (token()) return true;
    saveReturn();
    root.location.replace(SITE_ROOT + 'login.html');
    return false;
  }

  /* ---------- 导航账号区 ---------- */

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function roleLabel(role) { return role === 'admin' ? t('roleAdmin') : t('roleCreator'); }

  function closeMenus() {
    var slots = document.querySelectorAll('[data-auth-slot]');
    Array.prototype.forEach.call(slots, function (slot) {
      var button = slot.querySelector('.account-btn');
      var menu = slot.querySelector('.account-menu');
      if (menu) menu.hidden = true;
      if (button) button.setAttribute('aria-expanded', 'false');
    });
  }

  function accountMenu(account) {
    var menu = el('div', 'account-menu');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    var head = el('div', 'account-menu-head');
    head.appendChild(el('strong', null, account.email));
    head.appendChild(el('span', null, roleLabel(account.role)));
    menu.appendChild(head);
    [['submit.html', t('menuSubmit')], ['author.html', t('menuAuthor')]].forEach(function (item) {
      var link = el('a', null, item[1]);
      link.href = SITE_ROOT + item[0];
      link.setAttribute('role', 'menuitem');
      menu.appendChild(link);
    });
    if (account.role === 'admin') {
      var adminLink = el('a', null, t('menuAdmin'));
      adminLink.href = SITE_ROOT + 'admin.html';
      adminLink.setAttribute('role', 'menuitem');
      menu.appendChild(adminLink);
    }
    menu.appendChild(el('hr'));
    var logoutButton = el('button', 'account-logout', t('menuLogout'));
    logoutButton.type = 'button';
    logoutButton.setAttribute('role', 'menuitem');
    menu.appendChild(logoutButton);
    return menu;
  }

  function renderSlot(slot) {
    slot.replaceChildren();
    var account = readUser();
    if (!token() || !account) {
      var link = el('a', 'nav-login', t('navLogin'));
      link.href = SITE_ROOT + 'login.html';
      link.addEventListener('click', function () {
        if ((root.location.pathname || '').indexOf('login.html') < 0) saveReturn();
      });
      slot.appendChild(link);
      return;
    }
    var local = String(account.email || '').split('@')[0];
    var button = el('button', 'account-btn');
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.appendChild(el('span', 'account-avatar', (String(account.email || '?').charAt(0) || '?').toUpperCase()));
    button.appendChild(el('span', 'account-name', local));
    var menu = accountMenu(account);
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      var open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
      button.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu.querySelector('.account-logout').addEventListener('click', function () {
      logout().then(function () {
        closeMenus();
        if (/submit\.html|admin\.html|author\.html/.test(root.location.pathname || '')) {
          root.location.assign(SITE_ROOT + 'index.html');
        }
      });
    });
    slot.appendChild(button);
    slot.appendChild(menu);
  }

  function renderNav() {
    var slots = document.querySelectorAll('[data-auth-slot]');
    Array.prototype.forEach.call(slots, renderSlot);
  }

  function bindNav() {
    document.addEventListener('click', function (event) {
      var node = event.target;
      while (node && node !== document) {
        if (node.classList && node.classList.contains('account-menu')) return;
        node = node.parentNode;
      }
      closeMenus();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeMenus();
    });
  }

  function init() {
    bindNav();
    renderNav();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  document.addEventListener('site-locale-change', renderNav);
  document.addEventListener('site-auth-change', renderNav);
  root.addEventListener('storage', function (event) {
    if (event.key === TOKEN_KEY || event.key === USER_KEY) renderNav();
  });

  root.SiteAuth = {
    siteRoot: SITE_ROOT,
    apiBase: apiBase,
    identityBase: identityBase,
    api: api,
    identity: identity,
    login: login,
    register: register,
    recover: recover,
    logout: logout,
    verify: verify,
    user: user,
    token: token,
    isLoggedIn: isLoggedIn,
    requireLogin: requireLogin,
    consumeReturn: consumeReturn,
    saveReturn: saveReturn,
    renderNav: renderNav,
    t: t
  };
})(window);
