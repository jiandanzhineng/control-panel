(function () {
  'use strict';

  var apiBase = String(window.GamePlatformConfig && window.GamePlatformConfig.apiBase || '').replace(/\/$/, '');
  var identityApiBase = String(window.GamePlatformConfig && window.GamePlatformConfig.identityApiBase || '').replace(/\/$/, '');
  var tokenKey = 'game-platform-mobile-token';
  var user = null;
  var authView = document.getElementById('auth-view');
  var dashboard = document.getElementById('dashboard');
  var message = document.getElementById('platform-message');
  var submissionForm = document.getElementById('submission-form');
  var gitField = document.getElementById('git-field');
  var zipField = document.getElementById('zip-field');

  function api(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    var token = sessionStorage.getItem(tokenKey);
    if (token) headers.Authorization = 'Bearer ' + token;
    var request = Object.assign({}, options);
    request.headers = headers;
    return fetch(apiBase + path, request).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        if (!response.ok) {
          var err = new Error((data.error && data.error.message) || ('HTTP ' + response.status));
          err.status = response.status;
          throw err;
        }
        return data;
      });
    });
  }

  function identityApi(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    var request = Object.assign({}, options);
    request.headers = headers;
    return fetch(identityApiBase + path, request).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        if (!response.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = 'platform-message ' + (type || '');
  }

  function setBusy(form, busy) {
    form.querySelectorAll('button').forEach(function (button) { button.disabled = busy; });
  }

  function switchAuth(mode) {
    document.querySelectorAll('[data-auth-mode]').forEach(function (button) {
      button.classList.toggle('active', button.getAttribute('data-auth-mode') === mode);
    });
    document.getElementById('register-form').hidden = mode !== 'register';
    document.getElementById('login-form').hidden = mode !== 'login';
  }

  function showDashboard() {
    authView.hidden = true;
    dashboard.hidden = false;
    document.getElementById('account-name').textContent = user.email;
    document.getElementById('admin-link').hidden = user.role !== 'admin';
  }

  function startMobileSession(data) {
    if (!data.token) throw new Error('mobile 账号服务没有返回登录凭证');
    sessionStorage.setItem(tokenKey, data.token);
    return api('/api/auth/me').then(function (result) {
      user = result.user;
      showDashboard();
      return loadDashboard();
    });
  }

  function setSubmissionKind() {
    var kind = submissionForm.querySelector('input[name="kind"]:checked').value;
    gitField.hidden = kind !== 'git';
    zipField.hidden = kind !== 'zip';
    document.getElementById('git-url').required = kind === 'git';
    document.getElementById('zip-file').required = kind === 'zip';
  }

  function statusName(value) {
    return {
      draft: '等待上传', pending: '待审核', changes_requested: '需修改',
      rejected: '未通过', published: '已发布'
    }[value] || value;
  }

  function renderSubmissions(items) {
    var list = document.getElementById('submission-list');
    list.replaceChildren();
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'platform-empty';
      empty.textContent = '尚未提交游戏。';
      list.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('article');
      row.className = 'submission-row';
      var title = document.createElement('strong');
      title.textContent = item.title;
      var detail = document.createElement('span');
      detail.className = 'submission-detail';
      detail.textContent = (item.kind === 'zip' ? 'ZIP 投稿' : '公开 Git 投稿') + ' · ' + new Date(item.updatedAt * 1000).toLocaleString();
      var status = document.createElement('span');
      status.className = 'submission-status status-' + item.status;
      status.textContent = statusName(item.status);
      row.append(title, detail, status);
      if (item.reviewNote) {
        var note = document.createElement('p');
        note.className = 'submission-note';
        note.textContent = '审核意见：' + item.reviewNote;
        row.appendChild(note);
      }
      list.appendChild(row);
    });
  }

  function loadDashboard() {
    return api('/api/submissions').then(function (data) { renderSubmissions(data.submissions || []); });
  }

  function uploadArchive(instruction, file, submissionID) {
    if (instruction.mode === 'oss-form') {
      var form = new FormData();
      Object.keys(instruction.fields || {}).forEach(function (key) { form.append(key, instruction.fields[key]); });
      form.append('file', file);
      return fetch(instruction.action, { method: 'POST', body: form }).then(function (response) {
        if (!response.ok) throw new Error('OSS 上传失败：HTTP ' + response.status);
      });
    }
    if (instruction.mode === 'local') {
      var localForm = new FormData();
      localForm.append('file', file);
      return api('/api/submissions/' + encodeURIComponent(submissionID) + '/local-upload', { method: 'POST', body: localForm });
    }
    return Promise.reject(new Error('未知上传方式'));
  }

  document.querySelectorAll('[data-auth-mode]').forEach(function (button) {
    button.addEventListener('click', function () { switchAuth(button.getAttribute('data-auth-mode')); });
  });

  document.getElementById('register-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    setBusy(form, true);
    identityApi('/auth/register', { method: 'POST', body: JSON.stringify({
      email: form.email.value, password: form.password.value
    }) }).then(function (data) {
      setMessage('账号已创建。', 'success');
      return startMobileSession(data);
    }).catch(function (err) { setMessage(err.message, 'error'); }).finally(function () { setBusy(form, false); });
  });

  document.getElementById('login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    setBusy(form, true);
    identityApi('/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email.value, password: form.password.value }) })
      .then(function (data) { setMessage('已登录。', 'success'); return startMobileSession(data); })
      .catch(function (err) { setMessage(err.message, 'error'); })
      .finally(function () { setBusy(form, false); });
  });

  document.getElementById('logout').addEventListener('click', function () {
    var token = sessionStorage.getItem(tokenKey);
    var options = { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {} };
    identityApi('/auth/logout', options).finally(function () {
      sessionStorage.removeItem(tokenKey);
      user = null;
      dashboard.hidden = true;
      authView.hidden = false;
      setMessage('已退出登录。', '');
    });
  });

  submissionForm.querySelectorAll('input[name="kind"]').forEach(function (input) { input.addEventListener('change', setSubmissionKind); });
  setSubmissionKind();

  submissionForm.addEventListener('submit', function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    var kind = form.querySelector('input[name="kind"]:checked').value;
    var file = document.getElementById('zip-file').files[0];
    if (kind === 'zip' && !file) return;
    setBusy(form, true);
    setMessage('正在提交…', '');
    api('/api/submissions', { method: 'POST', body: JSON.stringify({
      authorName: form.authorName.value, title: form.title.value, description: form.description.value, kind: kind, gitUrl: form.gitUrl.value
    }) }).then(function (data) {
      if (kind !== 'zip') return data;
      return uploadArchive(data.upload, file, data.submission.id).then(function () {
        return api('/api/submissions/' + encodeURIComponent(data.submission.id) + '/complete', { method: 'POST', body: '{}' });
      });
    }).then(function () {
      form.reset();
      setSubmissionKind();
      setMessage('投稿已进入审核队列。', 'success');
      return loadDashboard();
    }).catch(function (err) { setMessage(err.message, 'error'); }).finally(function () { setBusy(form, false); });
  });

  api('/api/auth/me').then(function (data) {
    user = data.user;
    showDashboard();
    return loadDashboard();
  }).catch(function () { switchAuth('login'); });
})();
