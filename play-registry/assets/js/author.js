/* play-registry 作者管理：列出本人可管理的社区游戏，修改署名 / 名称 / 说明后提交审核。 */
(function () {
  'use strict';

  var auth = window.SiteAuth;
  var box = document.getElementById('author-list');
  var message = document.getElementById('author-message');
  var emailSlot = document.getElementById('author-email');
  if (!auth || !box) return;

  function t(key, vars) { return auth.t(key, vars); }

  function setMessage(text, type) {
    message.textContent = text || '';
    message.className = 'platform-message ' + (type || '');
  }

  function field(labelText, name, value, multiline) {
    var label = document.createElement('label');
    var caption = document.createElement('span');
    caption.textContent = labelText;
    var input = document.createElement(multiline ? 'textarea' : 'input');
    input.name = name;
    input.value = value == null ? '' : String(value);
    if (multiline) input.rows = 4;
    else input.type = 'text';
    input.required = true;
    label.append(caption, input);
    return { label: label, input: input };
  }

  function statusLabel(value) {
    var labels = {
      draft: t('statusDraft'),
      pending: t('statusPending'),
      changes_requested: t('statusChanges'),
      rejected: t('statusRejected'),
      published: t('statusPublished')
    };
    return labels[value] || value;
  }

  function buildForm(item) {
    var form = document.createElement('form');
    form.className = 'platform-form';
    var heading = document.createElement('h2');
    heading.textContent = item.title || item.gameId || '';
    var author = field(t('authorNameNote'), 'authorName', item.authorName);
    var title = field(t('authorTitleNote'), 'title', item.title);
    var description = field(t('authorDescNote'), 'description', item.description, true);
    var status = document.createElement('span');
    status.className = 'submission-status status-' + item.status;
    status.textContent = statusLabel(item.status);
    var submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'btn btn-primary';
    submit.textContent = t('authorSubmit');

    form.append(heading, author.label, title.label, description.label, status, submit);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      submit.disabled = true;
      auth.api('/api/submissions/' + encodeURIComponent(item.id) + '/update', {
        method: 'POST',
        body: JSON.stringify({
          authorName: author.input.value,
          title: title.input.value,
          description: description.input.value
        })
      }).then(function () {
        setMessage(t('authorSubmitted'), 'success');
      }).catch(function (err) {
        setMessage(err && err.message ? err.message : t('authErrServer'), 'error');
      }).finally(function () { submit.disabled = false; });
    });
    return form;
  }

  function render(items) {
    box.replaceChildren();
    if (!items.length) {
      var empty = document.createElement('p');
      empty.className = 'platform-empty';
      empty.textContent = t('authorEmpty');
      box.appendChild(empty);
      return;
    }
    items.forEach(function (item) {
      var card = document.createElement('section');
      card.className = 'platform-panel';
      card.appendChild(buildForm(item));
      box.appendChild(card);
    });
  }

  if (!auth.requireLogin()) return;

  auth.verify().then(function (user) {
    if (!user) { auth.requireLogin(); return; }
    if (emailSlot) emailSlot.textContent = user.email;
    return auth.api('/api/submissions').then(function (data) { render(data.submissions || []); });
  }).catch(function (err) {
    setMessage(err && err.message ? err.message : t('authErrServer'), 'error');
  });
})();
