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
    document.getElementById('admin-user').textContent = data.user.email;
    return load();
  }).catch(function (err) {
    document.getElementById('review-list').textContent = err.message;
  });
})();

/* 月度分成 tab：生成、查看、导出、逐行标记。 */
(function () {
  'use strict';
  var apiBase = String(window.GamePlatformConfig && window.GamePlatformConfig.apiBase || '').replace(/\/$/, '');
  var tokenKey = 'game-platform-mobile-token';
  var list = document.getElementById('payout-list');
  var message = document.getElementById('admin-message');
  if (!list || !message) return;

  var monthInput = document.getElementById('payout-month');
  var poolInput = document.getElementById('payout-pool');
  var durationInput = document.getElementById('payout-min-duration');
  var devicesInput = document.getElementById('payout-min-devices');
  var playsInput = document.getElementById('payout-min-plays');
  var statusNames = { draft: '待发放', paid: '已发放', skipped: '已跳过' };
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

  function numberOrNull(input) {
    var raw = String(input.value || '').trim();
    if (!raw) return null;
    var value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  function monthValue() { return String(monthInput.value || '').trim(); }

  function markRow(month, gameID, status, note) {
    return request('/api/admin/payouts/' + encodeURIComponent(month) + '/' + encodeURIComponent(gameID) + '/mark', {
      method: 'POST', body: JSON.stringify({ status: status, note: note })
    }).then(function () { setMessage('已标记为' + statusNames[status] + '。', 'success'); return load(month); })
      .catch(function (err) { setMessage(err.message, 'error'); });
  }

  function render(reports) {
    list.replaceChildren();
    if (!reports.length) { list.textContent = '该月份还没有报表行。'; return; }
    var table = document.createElement('table');
    table.className = 'payout-table';
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['游戏 ID', '作者', '作者邮箱', '有效游玩', '独立设备', '时长(分钟)', '金额(元)', '状态', '备注', '操作'].forEach(function (label) {
      var cell = document.createElement('th'); cell.textContent = label; headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    var body = document.createElement('tbody');
    reports.forEach(function (report) {
      var row = document.createElement('tr');
      [report.gameId, report.authorName, report.authorEmail || report.authorId, String(report.validPlays),
        String(report.uniqueDevices), Number(report.totalMinutes || 0).toFixed(1), String(report.amountCny),
        statusNames[report.status] || report.status, report.note || ''
      ].forEach(function (value) {
        var cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
      });
      var note = document.createElement('input');
      note.type = 'text'; note.placeholder = '备注（如商城账号）'; note.value = report.note || ''; note.maxLength = 500;
      var noteCell = document.createElement('td'); noteCell.appendChild(note); row.appendChild(noteCell);
      var actions = document.createElement('td');
      var paid = document.createElement('button');
      paid.type = 'button'; paid.className = 'btn btn-primary'; paid.textContent = '标记已发';
      paid.addEventListener('click', function () { markRow(report.month, report.gameId, 'paid', note.value); });
      var skipped = document.createElement('button');
      skipped.type = 'button'; skipped.className = 'btn btn-ghost'; skipped.textContent = '跳过';
      skipped.addEventListener('click', function () { markRow(report.month, report.gameId, 'skipped', note.value); });
      actions.append(paid, skipped);
      row.appendChild(actions);
      body.appendChild(row);
    });
    table.append(head, body);
    list.appendChild(table);
  }

  function load(month) {
    if (!month) { setMessage('请先选择月份。', 'error'); return Promise.resolve(); }
    return request('/api/admin/payouts/' + encodeURIComponent(month)).then(function (data) {
      render(data.reports || []);
      if (data.openpanelConfigured === false) setMessage('服务器还没配置 OpenPanel read client，生成报表会失败。', 'error');
    }).catch(function (err) { setMessage(err.message, 'error'); });
  }

  document.getElementById('payout-form').addEventListener('submit', function (event) {
    event.preventDefault();
    var month = monthValue();
    var payload = { bonusPoolCny: numberOrNull(poolInput) || 0 };
    if (numberOrNull(durationInput) !== null) payload.minDurationMs = numberOrNull(durationInput) * 60000;
    if (numberOrNull(devicesInput) !== null) payload.minDeviceCount = numberOrNull(devicesInput);
    if (numberOrNull(playsInput) !== null) payload.minValidPlays = numberOrNull(playsInput);
    setMessage('正在生成…', '');
    request('/api/admin/payouts/' + encodeURIComponent(month) + '/generate', { method: 'POST', body: JSON.stringify(payload) })
      .then(function (data) { render(data.reports || []); setMessage('报表已生成。', 'success'); })
      .catch(function (err) { setMessage(err.message, 'error'); });
  });

  document.getElementById('payout-load').addEventListener('click', function () { load(monthValue()); });

  document.getElementById('payout-export').addEventListener('click', function () {
    var month = monthValue();
    if (!month || !token()) { setMessage('请先选择月份并登录。', 'error'); return; }
    fetch(apiBase + '/api/admin/payouts/' + encodeURIComponent(month) + '.csv', { headers: { Authorization: 'Bearer ' + token() } })
      .then(function (response) {
        if (!response.ok) throw new Error('导出失败：HTTP ' + response.status);
        return response.blob();
      })
      .then(function (blob) {
        var link = document.createElement('a');
        var url = URL.createObjectURL(blob);
        link.href = url; link.download = 'payouts-' + month + '.csv'; link.click();
        URL.revokeObjectURL(url);
      })
      .catch(function (err) { setMessage(err.message, 'error'); });
  });

  document.querySelectorAll('[data-admin-tab]').forEach(function (button) {
    button.addEventListener('click', function () {
      var tab = button.getAttribute('data-admin-tab');
      document.querySelectorAll('[data-admin-tab]').forEach(function (other) {
        other.classList.toggle('active', other === button);
      });
      document.getElementById('tab-review').hidden = tab !== 'review';
      document.getElementById('tab-payout').hidden = tab !== 'payout';
      if (tab === 'payout') load(monthValue());
    });
  });
})();
