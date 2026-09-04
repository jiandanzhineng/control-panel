(function () {
  'use strict';
  var apiBase = String(window.GamePlatformConfig && window.GamePlatformConfig.apiBase || '').replace(/\/$/, '');
  var message = document.getElementById('admin-message');

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    return fetch(apiBase + path, Object.assign({ credentials: 'include', headers: headers }, options)).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        if (!response.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function setMessage(text, type) { message.textContent = text || ''; message.className = 'platform-message ' + (type || ''); }
  function button(text, handler, style) {
    var element = document.createElement('button');
    element.type = 'button'; element.className = 'btn ' + (style || 'btn-ghost'); element.textContent = text;
    element.addEventListener('click', handler); return element;
  }

  function action(id, action, body) {
    return api('/api/admin/submissions/' + encodeURIComponent(id) + '/' + action, { method: 'POST', body: JSON.stringify(body || {}) })
      .then(function () { setMessage('操作已完成。', 'success'); return load(); })
      .catch(function (err) { setMessage(err.message, 'error'); });
  }

  function releaseAction(gameID) {
    return api('/api/admin/releases/' + encodeURIComponent(gameID) + '/revoke', { method: 'POST', body: '{}' })
      .then(function () { setMessage('游戏已下架。', 'success'); return load(); })
      .catch(function (err) { setMessage(err.message, 'error'); });
  }

  function render(items) {
    var list = document.getElementById('review-list');
    list.replaceChildren();
    if (!items.length) { list.textContent = '当前没有待审核投稿。'; return; }
    items.forEach(function (item) {
      var card = document.createElement('article'); card.className = 'review-row';
      var heading = document.createElement('h2'); heading.textContent = item.title;
      var meta = document.createElement('p'); meta.className = 'review-meta'; meta.textContent = item.authorName + ' · ' + (item.kind === 'zip' ? 'ZIP 投稿' : '公开 Git 投稿');
      var description = document.createElement('p'); description.textContent = item.description || '（未填写说明）';
      var source = document.createElement('a'); source.target = '_blank'; source.rel = 'noopener';
      source.textContent = item.kind === 'zip' ? '下载 ZIP 源包' : '打开公开 Git 地址';
      source.href = item.kind === 'zip'
        ? apiBase + '/api/admin/submissions/' + encodeURIComponent(item.id) + '/source'
        : item.gitUrl;
      var note = document.createElement('textarea'); note.placeholder = '退回或拒绝时填写审核意见'; note.rows = 3;
      var actions = document.createElement('div'); actions.className = 'platform-actions';
      actions.append(
        button('批准发布', function () {
          if (window.confirm('确认发布？平台会同步生成游戏资源、ZIP 和 registry。')) action(item.id, 'publish');
        }, 'btn-primary'),
        button('退回修改', function () { action(item.id, 'review', { status: 'changes_requested', note: note.value }); }),
        button('拒绝', function () { action(item.id, 'review', { status: 'rejected', note: note.value }); })
      );
      card.append(heading, meta, description, source, note, actions); list.appendChild(card);
    });
  }

  function renderReleases(items) {
    var list = document.getElementById('release-list');
    list.replaceChildren();
    if (!items.length) { list.textContent = '当前没有已发布游戏。'; return; }
    items.forEach(function (item) {
      var card = document.createElement('article'); card.className = 'review-row';
      var heading = document.createElement('h2'); heading.textContent = item.gameId + ' · v' + item.version;
      var meta = document.createElement('p'); meta.className = 'review-meta'; meta.textContent = '发布时间：' + new Date(item.createdAt * 1000).toLocaleString();
      card.append(heading, meta, button('下架', function () {
        if (window.confirm('确认从玩法库下架「' + item.gameId + '」？已发布文件将保留。')) releaseAction(item.gameId);
      }, 'btn-ghost'));
      list.appendChild(card);
    });
  }

  function load() {
    return Promise.all([
      api('/api/admin/submissions?status=pending'),
      api('/api/admin/releases')
    ]).then(function (results) {
      render(results[0].submissions || []);
      renderReleases(results[1].releases || []);
    });
  }

  document.getElementById('registry-rebuild').addEventListener('click', function () {
    if (!window.confirm('确认按当前已发布游戏重建 registry？')) return;
    api('/api/admin/registry/rebuild', { method: 'POST', body: '{}' })
      .then(function () { setMessage('registry 已重建。', 'success'); })
      .catch(function (err) { setMessage(err.message, 'error'); });
  });

  document.getElementById('registry-import').addEventListener('click', function () {
    if (!window.confirm('仅首次从旧站切换时使用。确认导入旧 registry？')) return;
    api('/api/admin/registry/import', { method: 'POST', body: '{}' })
      .then(function (data) { setMessage('已导入 ' + data.imported + ' 个版本。', 'success'); return load(); })
      .catch(function (err) { setMessage(err.message, 'error'); });
  });

  api('/api/auth/me').then(function (data) {
    if (data.user.role !== 'admin') throw new Error('当前账号不是审核管理员');
    document.getElementById('admin-user').textContent = data.user.displayName;
    return load();
  }).catch(function (err) {
    document.getElementById('review-list').textContent = err.message;
  });
})();
