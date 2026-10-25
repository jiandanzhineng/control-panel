/* play-registry 投稿工作台：登录校验、投稿（ZIP / 公开 Git）、我的投稿与分成。 */
(function () {
  'use strict';

  var auth = window.SiteAuth;
  if (!auth) return;

  var message = document.getElementById('platform-message');
  var dashboard = document.getElementById('dashboard');
  var submissionForm = document.getElementById('submission-form');
  var gitField = document.getElementById('git-field');
  var zipField = document.getElementById('zip-field');
  var emailSlot = document.getElementById('dash-email');
  var authorLink = document.getElementById('author-link');
  var adminLink = document.getElementById('admin-link');

  function t(key, vars) { return auth.t(key, vars); }

  function setMessage(text, type) {
    if (!message) return;
    message.textContent = text || '';
    message.className = 'platform-message ' + (type || '');
  }

  function setBusy(form, busy) {
    Array.prototype.forEach.call(form.querySelectorAll('button'), function (button) { button.disabled = busy; });
  }

  function statusName(value) {
    var labels = {
      draft: t('statusDraft'),
      pending: t('statusPending'),
      changes_requested: t('statusChanges'),
      rejected: t('statusRejected'),
      published: t('statusPublished')
    };
    return labels[value] || value;
  }

  function showDashboard(user) {
    if (dashboard) dashboard.hidden = false;
    if (emailSlot) emailSlot.textContent = t('dashSignedIn', { email: user.email });
    if (adminLink) adminLink.hidden = user.role !== 'admin';
    if (authorLink) authorLink.hidden = false;
  }

  function setSubmissionKind() {
    var checked = submissionForm.querySelector('input[name="kind"]:checked');
    var kind = checked ? checked.value : 'zip';
    gitField.hidden = kind !== 'git';
    zipField.hidden = kind !== 'zip';
    document.getElementById('git-url').required = kind === 'git';
    document.getElementById('zip-file').required = kind === 'zip';
  }

  function renderSubmissions(items) {
    var list = document.getElementById('submission-list');
    list.replaceChildren();
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'platform-empty';
      empty.textContent = t('mineEmpty');
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
      detail.textContent = (item.kind === 'zip' ? t('kindZip') : t('kindGit'))
        + ' · ' + new Date(item.updatedAt * 1000).toLocaleString();
      var status = document.createElement('span');
      status.className = 'submission-status status-' + item.status;
      status.textContent = statusName(item.status);
      row.append(title, detail, status);
      if (item.reviewNote) {
        var note = document.createElement('p');
        note.className = 'submission-note';
        note.textContent = t('mineReviewNote', { note: item.reviewNote });
        row.appendChild(note);
      }
      list.appendChild(row);
    });
  }

  function renderPayouts(items) {
    var list = document.getElementById('payout-list');
    list.replaceChildren();
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'platform-empty';
      empty.textContent = t('payoutEmpty');
      list.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var row = document.createElement('article');
      row.className = 'submission-row';
      var title = document.createElement('strong');
      title.textContent = item.gameId + ' · ' + item.month;
      var detail = document.createElement('span');
      detail.className = 'submission-detail';
      var parts = [];
      if (item.validPlays != null) parts.push(t('payoutPlays', { n: item.validPlays }));
      parts.push(t('payoutAmount', { n: item.amountCny }));
      if (item.paidAt) parts.push(t('payoutPaidAt', { date: new Date(item.paidAt * 1000).toLocaleDateString() }));
      detail.textContent = parts.join(' · ');
      row.append(title, detail);
      if (item.note) {
        var note = document.createElement('p');
        note.className = 'submission-note';
        note.textContent = t('payoutNote', { note: item.note });
        row.appendChild(note);
      }
      list.appendChild(row);
    });
  }

  function loadPayouts() {
    return auth.api('/api/payouts/mine').then(function (data) { renderPayouts(data.records || []); });
  }

  function loadDashboard() {
    return Promise.all([
      auth.api('/api/submissions').then(function (data) { renderSubmissions(data.submissions || []); }),
      loadPayouts()
    ]);
  }

  function uploadArchive(instruction, file, submissionID) {
    if (instruction.mode === 'oss-form') {
      var form = new FormData();
      Object.keys(instruction.fields || {}).forEach(function (key) { form.append(key, instruction.fields[key]); });
      form.append('file', file);
      return fetch(instruction.action, { method: 'POST', body: form }).then(function (response) {
        if (!response.ok) throw new Error(t('uploadFail', { status: response.status }));
      });
    }
    if (instruction.mode === 'local') {
      var localForm = new FormData();
      localForm.append('file', file);
      return auth.api('/api/submissions/' + encodeURIComponent(submissionID) + '/local-upload', { method: 'POST', body: localForm });
    }
    return Promise.reject(new Error(t('uploadUnknown')));
  }

  function bindForm() {
    Array.prototype.forEach.call(submissionForm.querySelectorAll('input[name="kind"]'), function (input) {
      input.addEventListener('change', setSubmissionKind);
    });
    setSubmissionKind();

    submissionForm.addEventListener('submit', function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var kind = form.querySelector('input[name="kind"]:checked').value;
      var file = document.getElementById('zip-file').files[0];
      if (kind === 'zip' && !file) return;
      setBusy(form, true);
      setMessage(t('submittingMsg'), '');
      auth.api('/api/submissions', { method: 'POST', body: JSON.stringify({
        authorName: form.authorName.value,
        title: form.title.value,
        description: form.description.value,
        kind: kind,
        gitUrl: form.gitUrl.value
      }) }).then(function (data) {
        if (kind !== 'zip') return data;
        return uploadArchive(data.upload, file, data.submission.id).then(function () {
          return auth.api('/api/submissions/' + encodeURIComponent(data.submission.id) + '/complete', { method: 'POST', body: '{}' });
        });
      }).then(function () {
        form.reset();
        setSubmissionKind();
        setMessage(t('submittedMsg'), 'success');
        return loadDashboard();
      }).catch(function (err) {
        setMessage(err && err.message ? err.message : t('authErrServer'), 'error');
      }).finally(function () { setBusy(form, false); });
    });
  }

  /* 未登录先跳登录页，回来后用 /api/auth/me 校验；校验失败再跳一次。 */
  if (!auth.requireLogin()) return;

  auth.verify().then(function (user) {
    if (!user) { auth.requireLogin(); return; }
    showDashboard(user);
    bindForm();
    return loadDashboard();
  }).catch(function (err) {
    setMessage(err && err.message ? err.message : t('authErrServer'), 'error');
  });
})();
