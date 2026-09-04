(function (root) {
  'use strict';

  var catalogs = {};

  function normalizeLocale(value) {
    if (!value) return '';
    var raw = String(value).trim();
    if (!raw || raw === 'zh' || raw === 'zh-CN' || raw === 'system') return '';
    return raw.split(/[-_]/)[0];
  }

  function locale() {
    try {
      var fromApi = normalizeLocale(root.DeviceAPI && root.DeviceAPI.locale);
      if (fromApi) return fromApi;
    } catch (_) {}
    try {
      var fromQuery = normalizeLocale(new URLSearchParams(location.search).get('locale'));
      if (fromQuery) return fromQuery;
    } catch (_) {}
    return 'zh';
  }

  function isEn() {
    return locale() === 'en';
  }

  function interpolate(text, vars) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return text;
    return String(text).replace(/\{(\w+)\}/g, function (match, key) {
      return vars[key] == null ? match : String(vars[key]);
    });
  }

  function t(zh, vars) {
    zh = zh == null ? '' : String(zh);
    var lang = locale();
    var table = catalogs[lang];
    var out = zh;
    if (lang !== 'zh') {
      if (table && Object.prototype.hasOwnProperty.call(table, zh)) out = table[zh];
      else if (typeof vars === 'string') out = vars;
    }
    return interpolate(out, vars);
  }

  function register(messages) {
    if (!messages || typeof messages !== 'object') return;
    Object.keys(messages).forEach(function (lang) {
      var table = messages[lang];
      if (!table || typeof table !== 'object') return;
      catalogs[lang] = catalogs[lang] || {};
      Object.keys(table).forEach(function (key) {
        catalogs[lang][key] = table[key];
      });
    });
  }

  function apply(rootEl) {
    var en = isEn();
    var scope = rootEl || document;
    if (document.documentElement) document.documentElement.lang = en ? 'en' : 'zh-CN';
    var title = document.querySelector('title');
    if (title && title.getAttribute('data-en') && en) document.title = title.getAttribute('data-en');
    if (!en) return;
    Array.prototype.forEach.call(scope.querySelectorAll('[data-en]'), function (el) {
      if (el.tagName === 'TITLE') return;
      if (el.hasAttribute('data-bind')) return;
      el.textContent = el.getAttribute('data-en') || '';
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-en-html]'), function (el) {
      el.innerHTML = el.getAttribute('data-en-html') || '';
    });
    Array.prototype.forEach.call(scope.querySelectorAll('[data-en-title]'), function (el) {
      el.setAttribute('title', el.getAttribute('data-en-title') || '');
    });
  }

  root.GameI18n = { locale: locale, isEn: isEn, t: t, register: register, apply: apply };
})(typeof window !== 'undefined' ? window : this);
