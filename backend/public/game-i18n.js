(function (root) {
  'use strict';

  function locale() {
    try {
      if (root.DeviceAPI && root.DeviceAPI.locale === 'en') return 'en';
    } catch (_) {}
    try {
      var q = new URLSearchParams(location.search).get('locale');
      if (q === 'en') return 'en';
    } catch (_) {}
    return 'zh';
  }

  function isEn() {
    return locale() === 'en';
  }

  function t(zh, en) {
    if (zh && typeof zh === 'object') {
      return isEn() ? (zh.en || zh.zh || '') : (zh.zh || zh.en || '');
    }
    return isEn() ? (en || zh || '') : (zh || '');
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

  root.GameI18n = { locale: locale, isEn: isEn, t: t, apply: apply };
})(typeof window !== 'undefined' ? window : this);
