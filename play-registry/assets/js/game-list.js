// 玩法列表渲染 + 搜索 + 能力筛选 + 启动 modal 绑定。
// 依赖 window.PlayLauncher（play-launcher.js）与页面上的 #grid #search #filters #toast。
(function () {
  "use strict";
  var grid = document.getElementById('grid');
  var search = document.getElementById('search');
  var filters = document.getElementById('filters');
  var toastEl = document.getElementById('toast');
  var allGames = [];
  var activeFilter = 'all';
  function t(key, vars) {
    try { if (typeof window !== 'undefined' && window.SiteI18n && window.SiteI18n.t) return window.SiteI18n.t(key, vars); } catch (_) {}
    var text = key;
    if (vars) text = String(text).replace(/\{(\w+)\}/g, function (_, k) { return vars[k] == null ? '' : String(vars[k]); });
    return text;
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  // 游戏图标按 id 哈希选 emoji（确定性，无随机）
  var ICONS = ['⚡', '🎯', '🔥', '💧', '🚪', '⚖️', '📏', '🦶', '💫', '🎮', '🧩', '⏳'];
  function iconFor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return ICONS[h % ICONS.length];
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(2) + ' MB';
  }

  function uniq(arr) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && !seen[arr[i]]) { seen[arr[i]] = 1; out.push(arr[i]); }
    }
    return out;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function capabilityChips(g) {
    var caps = [];
    (g.devices || []).forEach(function (d) {
      (d.capabilities || []).forEach(function (c) { caps.push(c); });
    });
    return uniq(caps);
  }

  function buildFilters(games) {
    var set = Object.create(null);
    games.forEach(function (g) {
      capabilityChips(g).forEach(function (c) { set[c] = (set[c] || 0) + 1; });
    });
    var keys = Object.keys(set).sort();
    var html = '<span class="chip ' + (activeFilter === 'all' ? 'active' : '') + '" data-filter="all">' + t('filterAll') + '</span>';
    keys.forEach(function (k) {
      html += '<span class="chip" data-filter="' + esc(k) + '">' + esc(k) + ' <span style="opacity:.6">' + set[k] + '</span></span>';
    });
    filters.innerHTML = html;
    filters.querySelectorAll('.chip').forEach(function (el) {
      el.addEventListener('click', function () {
        activeFilter = el.getAttribute('data-filter');
        filters.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('active'); });
        el.classList.add('active');
        render();
      });
    });
  }

  function matches(g, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (g.title || '').toLowerCase().indexOf(q) >= 0
      || (g.id || '').toLowerCase().indexOf(q) >= 0
      || (g.description || '').toLowerCase().indexOf(q) >= 0;
  }

  function cardHtml(g) {
    var caps = capabilityChips(g);
    var reqDevices = (g.devices || []).filter(function (d) { return d.required; }).map(function (d) { return d.id; });
    var badges = caps.map(function (c) { return '<span class="badge">' + esc(c) + '</span>'; }).join('');
    if (reqDevices.length) {
      badges += '<span class="badge required">' + t('required') + ': ' + esc(reqDevices.join(', ')) + '</span>';
    }
    return '<article class="game-card">'
      + '<div class="game-card-head">'
        + '<div class="game-icon">' + iconFor(g.id) + '</div>'
        + '<div style="flex:1;min-width:0;">'
          + '<div class="game-title">' + esc(g.title || g.id) + '</div>'
          + '<div class="game-id">' + esc(g.id) + '</div>'
        + '</div>'
        + '<span class="badge ver">v' + esc(g.version || '0.0.0') + '</span>'
      + '</div>'
      + '<p class="game-desc">' + esc(g.description || t('noDesc')) + '</p>'
      + '<div class="game-meta">' + badges + '</div>'
      + '<div class="game-card-foot">'
        + '<span class="game-size">' + (g.sha256 ? ('sha ' + g.sha256.slice(0, 8)) : '') + (g.size ? ' · ' + fmtSize(g.size) : '') + '</span>'
        + '<span class="game-actions">'
          + '<button class="play-link ghost" type="button" data-cache="' + esc(g.id) + '">' + t('cache') + '</button>'
          + '<button class="play-link" type="button" data-launch="' + esc(g.id) + '">' + t('launch') + '</button>'
        + '</span>'
      + '</div>'
    + '</article>';
  }

  function render() {
    var q = search.value.trim();
    var list = allGames.filter(function (g) {
      if (!matches(g, q)) return false;
      if (activeFilter !== 'all' && capabilityChips(g).indexOf(activeFilter) < 0) return false;
      return true;
    });
    if (!list.length) {
      grid.innerHTML = '<div class="empty-state"><p style="font-size:16px;margin-bottom:6px;">' + t('noMatch') + '</p><p>' + t('tryOther') + '</p></div>';
      return;
    }
    grid.innerHTML = list.map(cardHtml).join('');
  }

  function updateStats(games) {
    document.getElementById('stat-games').textContent = games.length;
    var capSet = Object.create(null), devSet = Object.create(null);
    games.forEach(function (g) {
      (g.devices || []).forEach(function (d) {
        devSet[d.id] = 1;
        (d.capabilities || []).forEach(function (c) { capSet[c] = 1; });
      });
    });
    document.getElementById('stat-devices').textContent = Object.keys(devSet).length;
    document.getElementById('stat-caps').textContent = Object.keys(capSet).length;
  }

  function loadFrom(path) {
    return fetch(path).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function applyRegistry(data) {
    var games = data.games || [];
    games.forEach(function (g) {
      g._path = g.path || ('games/' + g.id + '/index.html');
      var abs = new URL(g._path, location.href).href;
      g._launchUrl = 'undersilicon://play/' + encodeURIComponent(abs);
    });
    allGames = games;
    updateStats(games);
    buildFilters(games);
    render();
  }

  loadFrom('registry.json')
    .then(applyRegistry)
    .catch(function (err) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">'
        + '<p style="font-size:16px;margin-bottom:6px;color:var(--warn);">' + t('registryFail') + '</p>'
        + '<p>' + esc(err.message || err) + '</p>'
        + '<p>' + t('registryHint') + '</p>'
        + '</div>';
    });

  search.addEventListener('input', render);
  document.addEventListener('site-locale-change', function () { buildFilters(allGames); render(); });

  // 点击"启动" → 打开设备选择 modal（或委托宿主）；点击"缓存" → 委托宿主缓存
  grid.addEventListener('click', function (e) {
    var cacheBtn = e.target.closest('[data-cache]');
    if (cacheBtn) {
      var cacheId = cacheBtn.getAttribute('data-cache');
      var cg = allGames.find(function (x) { return x.id === cacheId; });
      if (cg && window.PlayLauncher && window.PlayLauncher.cache) window.PlayLauncher.cache(cg, cacheBtn);
      return;
    }
    var btn = e.target.closest('[data-launch]');
    if (!btn) return;
    var id = btn.getAttribute('data-launch');
    var g = allGames.find(function (x) { return x.id === id; });
    if (g && window.PlayLauncher) window.PlayLauncher.open(g, btn);
  });

  // 绑定 modal 取消按钮
  var cancelBtn = document.getElementById('modal-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function () { window.PlayLauncher.closeModal(); });

  // 从 play.html「重选设备」跳回时带 ?open=<id>，自动打开 modal
  var openId = new URLSearchParams(location.search).get('open');
  if (openId) {
    var tryOpen = function () {
      var g = allGames.find(function (x) { return x.id === openId; });
      if (g && window.PlayLauncher) { window.PlayLauncher.open(g); }
      else setTimeout(tryOpen, 200);
    };
    setTimeout(tryOpen, 300);
  }
})();
