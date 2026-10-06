(function () {
  'use strict';
  var apiBase = String(window.GamePlatformConfig && window.GamePlatformConfig.apiBase || '').replace(/\/$/, '');
  var tokenKey = 'game-platform-mobile-token';
  var message = document.getElementById('admin-message');

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
        if (!response.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function downloadArchive(id) {
    var token = sessionStorage.getItem(tokenKey);
    if (!token) return Promise.reject(new Error('请先在投稿工作台登录 mobile 账号'));
    return fetch(apiBase + '/api/admin/submissions/' + encodeURIComponent(id) + '/source', {
      headers: { Authorization: 'Bearer ' + token }
    }).then(function (response) {
      if (!response.ok) throw new Error('下载 ZIP 源包失败：HTTP ' + response.status);
      return response.blob();
    }).then(function (blob) {
      var link = document.createElement('a');
      var url = URL.createObjectURL(blob);
      link.href = url;
      link.download = id + '-source.zip';
      link.click();
      URL.revokeObjectURL(url);
    });
  }

  function setMessage(text, type) { message.textContent = text || ''; message.className = 'platform-message ' + (type || ''); }
  function button(text, handler, style) {
    var element = document.createElement('button');
    element.type = 'button'; element.className = 'btn ' + (style || 'btn-ghost'); element.textContent = text;
    element.addEventListener('click', handler); return element;
  }

  var idStatusLabels = {
    new: '新游戏',
    own: '更新（原作者）',
    official: '官方 ID',
    conflict: 'ID 冲突',
    admin: '管理员更新'
  };

  function idBadge(item) {
    if (!item.gameId || !idStatusLabels[item.gameIdStatus]) return null;
    var badge = document.createElement('span');
    badge.className = 'badge id-status id-status-' + item.gameIdStatus;
    badge.textContent = idStatusLabels[item.gameIdStatus] + ' · ' + item.gameId;
    return badge;
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
      var source = item.kind === 'zip' ? button('下载 ZIP 源包', function () {
        downloadArchive(item.id).catch(function (err) { setMessage(err.message, 'error'); });
      }) : document.createElement('a');
      if (item.kind !== 'zip') {
        source.target = '_blank'; source.rel = 'noopener'; source.textContent = '打开公开 Git 地址'; source.href = item.gitUrl;
      }
      var note = document.createElement('textarea'); note.placeholder = '退回或拒绝时填写审核意见'; note.rows = 3;
      var actions = document.createElement('div'); actions.className = 'platform-actions';
      var badge = idBadge(item);
      if (badge) meta.appendChild(badge);
      actions.append(
        button('批准发布', function () {
          if (item.gameIdStatus === 'conflict') { setMessage('该投稿不能直接发布：游戏 ID 属于其他作者，或版本号没有提高。请先退回或拒绝。', 'error'); return; }
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
    document.getElementById('admin-user').textContent = data.user.email;
    return load();
  }).catch(function (err) {
    document.getElementById('review-list').textContent = err.message;
  });
})();


/* 月度分成 tab：手工录入发放记录、看社区游戏与作者、指定归属。 */
(function () {
  'use strict';
  var apiBase = String(window.GamePlatformConfig && window.GamePlatformConfig.apiBase || '').replace(/\/$/, '');
  var tokenKey = 'game-platform-mobile-token';
  var list = document.getElementById('payout-list');
  var message = document.getElementById('admin-message');
  if (!list || !message) return;

  var monthInput = document.getElementById('payout-month');
  var gameSelect = document.getElementById('payout-game');
  var playsInput = document.getElementById('payout-plays');
  var amountInput = document.getElementById('payout-amount');
  var noteInput = document.getElementById('payout-note');
  var gamesBox = document.getElementById('payout-games');
  var ownerList = document.getElementById('owner-list');
  var ownerGameInput = document.getElementById('owner-game');
  var ownerEmailInput = document.getElementById('owner-email');
  var ownerNameInput = document.getElementById('owner-name');
  if (!monthInput.value) monthInput.value = lastMonth();

  function lastMonth() {
    var now = new Date();
    var month = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return month.getFullYear() + '-' + String(month.getMonth() + 1).padStart(2, '0');
  }

  function token() { return sessionStorage.getItem(tokenKey); }

  function request(path, options) {
    options = options || {};
    var headers = Object.assign({}, options.headers || {});
    if (options.body && typeof options.body === 'string') headers['Content-Type'] = 'application/json';
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(apiBase + path, Object.assign({}, options, { headers: headers })).then(function (response) {
      return response.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        if (!response.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + response.status));
        return data;
      });
    });
  }

  function setMessage(text, type) { message.textContent = text || ''; message.className = 'platform-message ' + (type || ''); }

  function formatTime(unix) {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString();
  }

  function cell(row, text) {
    var td = document.createElement('td');
    td.textContent = text;
    row.appendChild(td);
  }

  function table(headers) {
    var element = document.createElement('table');
    element.className = 'payout-table';
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    headers.forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    var body = document.createElement('tbody');
    element.append(head, body);
    return { element: element, body: body };
  }

  function renderGames(games) {
    gamesBox.replaceChildren();
    if (!games.length) {
      gamesBox.textContent = '还没有社区游戏。先有作者投稿上架，或在下面「归属指定」里认领导入的游戏。';
      return;
    }
    var built = table(['游戏 ID', '标题', '当前版本', '作者', '作者邮箱', '账号中心 ID', '状态']);
    games.forEach(function (game) {
      var row = document.createElement('tr');
      cell(row, game.gameId);
      cell(row, game.title || game.gameId);
      cell(row, 'v' + (game.version || '?'));
      cell(row, game.authorName || '—');
      cell(row, game.email || '（该邮箱还没在投稿平台登录过）');
      cell(row, game.authorId || '—');
      cell(row, game.status === 'active' ? '已上线' : '已下架');
      built.body.appendChild(row);
    });
    gamesBox.appendChild(built.element);
    // 下拉只放还在线上的游戏，已下架的一般不需要再发钱。
    var previous = gameSelect.value;
    gameSelect.replaceChildren();
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = games.length ? '请选择游戏' : '没有可选的社区游戏';
    gameSelect.appendChild(placeholder);
    games.forEach(function (game) {
      if (game.status !== 'active') return;
      var option = document.createElement('option');
      option.value = game.gameId;
      option.textContent = game.gameId + ' · ' + (game.title || '') + ' · ' + (game.authorName || '');
      gameSelect.appendChild(option);
    });
    if (previous) gameSelect.value = previous;
  }

  function renderOwners(owners) {
    ownerList.replaceChildren();
    if (!owners.length) {
      ownerList.textContent = '还没有手工指定的归属。';
      return;
    }
    var built = table(['游戏 ID', '作者', '作者邮箱', '操作人', '指定时间']);
    owners.forEach(function (owner) {
      var row = document.createElement('tr');
      cell(row, owner.gameId);
      cell(row, owner.authorName || '—');
      cell(row, owner.email || '—');
      cell(row, owner.setBy || '—');
      cell(row, formatTime(owner.setAt));
      built.body.appendChild(row);
    });
    ownerList.appendChild(built.element);
  }

  function renderRecords(records) {
    list.replaceChildren();
    if (!records.length) {
      list.textContent = '还没有发放记录。统计完在商城后台发钱，再回到上面的表单录入。';
      return;
    }
    var built = table(['月份', '游戏 ID', '作者', '作者邮箱', '有效游玩', '金额(元)', '发放时间', '操作人', '备注', '操作']);
    records.forEach(function (record) {
      var row = document.createElement('tr');
      cell(row, record.month);
      cell(row, record.gameId);
      cell(row, record.authorName || '—');
      cell(row, record.authorEmail || record.authorId || '—');
      cell(row, record.validPlays == null ? '—' : String(record.validPlays));
      cell(row, String(record.amountCny));
      cell(row, formatTime(record.paidAt));
      cell(row, record.paidBy || '—');
      cell(row, record.note || '');
      var actions = document.createElement('td');
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost';
      remove.textContent = '删除';
      remove.addEventListener('click', function () {
        if (!window.confirm('确认删除「' + record.month + ' ' + record.gameId + '」这条发放记录？删掉后可以重新录入。')) return;
        request('/api/admin/payouts/' + encodeURIComponent(record.id) + '/delete', { method: 'POST', body: '{}' })
          .then(function () { setMessage('已删除，可以重新录入。', 'success'); return loadRecords(monthInput.value); })
          .catch(function (err) { setMessage(err.message, 'error'); });
      });
      actions.appendChild(remove);
      row.appendChild(actions);
      built.body.appendChild(row);
    });
    list.appendChild(built.element);
  }

  function loadGames() {
    return request('/api/admin/community-games').then(function (data) {
      renderGames(data.games || []);
    }).catch(function (err) { setMessage(err.message, 'error'); });
  }

  function loadOwners() {
    return request('/api/admin/game-owners').then(function (data) {
      renderOwners(data.owners || []);
    }).catch(function (err) { setMessage(err.message, 'error'); });
  }

  function loadRecords(month) {
    var path = month ? '/api/admin/payouts?month=' + encodeURIComponent(month) : '/api/admin/payouts';
    return request(path).then(function (data) {
      renderRecords(data.records || []);
    }).catch(function (err) { setMessage(err.message, 'error'); });
  }

  document.getElementById('payout-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var month = String(monthInput.value || '').trim();
    var gameId = String(gameSelect.value || '').trim();
    var amount = Number(String(amountInput.value || '').trim());
    if (!month || !gameId) { setMessage('请先选择月份和游戏。', 'error'); return; }
    if (!Number.isFinite(amount) || amount <= 0) { setMessage('金额必须大于 0 元。', 'error'); return; }
    var payload = { month: month, gameId: gameId, amountCny: Math.round(amount) };
    var plays = String(playsInput.value || '').trim();
    if (plays) payload.validPlays = Number(plays);
    var note = String(noteInput.value || '').trim();
    if (note) payload.note = note;
    setMessage('正在录入…', '');
    request('/api/admin/payouts', { method: 'POST', body: JSON.stringify(payload) })
      .then(function () {
        amountInput.value = '';
        playsInput.value = '';
        noteInput.value = '';
        setMessage('已录入。作者现在可以在「我的分成」里看到这条记录。', 'success');
        return loadRecords(month);
      })
      .catch(function (err) { setMessage(err.message, 'error'); });
  });

  document.getElementById('owner-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var payload = {
      gameId: String(ownerGameInput.value || '').trim(),
      email: String(ownerEmailInput.value || '').trim(),
      authorName: String(ownerNameInput.value || '').trim()
    };
    if (!payload.gameId || !payload.email || !payload.authorName) { setMessage('请把游戏 ID、作者邮箱和署名都填上。', 'error'); return; }
    request('/api/admin/game-owners', { method: 'POST', body: JSON.stringify(payload) })
      .then(function () {
        ownerGameInput.value = '';
        ownerEmailInput.value = '';
        ownerNameInput.value = '';
        setMessage('归属已指定。该游戏现在按社区游戏结算。', 'success');
        return Promise.all([loadOwners(), loadGames()]);
      })
      .catch(function (err) { setMessage(err.message, 'error'); });
  });

  document.getElementById('payout-load').addEventListener('click', function () { loadRecords(String(monthInput.value || '').trim()); });
  document.getElementById('payout-load-all').addEventListener('click', function () { loadRecords(''); });

  document.querySelectorAll('[data-admin-tab]').forEach(function (button) {
    button.addEventListener('click', function () {
      var tab = button.getAttribute('data-admin-tab');
      document.querySelectorAll('[data-admin-tab]').forEach(function (other) {
        other.classList.toggle('active', other === button);
      });
      document.getElementById('tab-review').hidden = tab !== 'review';
      document.getElementById('tab-payout').hidden = tab !== 'payout';
      if (tab === 'payout') { loadGames(); loadOwners(); loadRecords(String(monthInput.value || '').trim()); }
    });
  });
})();
