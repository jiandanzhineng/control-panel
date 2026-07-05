/* play-launcher.js — 让玩法网站直接运行游戏。
 *
 * 核心思路：游戏页面引用的 /bridge-api/device-api-bridge.js 和 ws://location.host/bridge
 * 都来自「页面所在 host」。网站本身没有这些资源，所以玩法页在网站 origin 下跑不起来。
 *
 * 解法（复用已验证的面板 gameProxy 链路，零新协议、零跨域）：
 *   1. 探测本机控制面板后端（127.0.0.1:5278，可扫描常见端口）
 *   2. fetch 本机后端 /api/devices（在线设备）+ /api/device-capabilities（type→能力集）
 *   3. 弹设备选择 modal：按游戏 manifest 的 devices[] 逐个逻辑设备选物理设备
 *   4. 拼 deviceMap + params，用 127.0.0.1:<port>/games/proxy/<游戏绝对URL> 加载进
 *      play.html 的 iframe（带 ?deviceMap=&params= query）
 *   5. iframe 内 bridge 脚本自动连本机 /bridge（同源），从 location.search 读 deviceMap/params
 *
 * 不改后端任何代码：CORS 已全局开、gameProxy 已挂、bridge 已支持 query 注入。
 */
(function () {
  'use strict';

  var BACKEND_PORTS = [5278, 5277, 3000, 3010];
  var backendBase = null; // 缓存探测到的本机后端，如 http://127.0.0.1:5278

  // ---------- 工具 ----------
  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 探测本机后端：用 fetch HEAD/GET，超时短，命中即缓存
  function probePort(port) {
    var url = 'http://127.0.0.1:' + port + '/api/devices';
    return new Promise(function (resolve) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 800);
      fetch(url, { signal: ctrl.signal, mode: 'cors' })
        .then(function (r) { clearTimeout(t); if (r.ok) resolve('http://127.0.0.1:' + port); else resolve(null); })
        .catch(function () { clearTimeout(t); resolve(null); });
    });
  }

  function detectBackend(force) {
    if (backendBase && !force) return Promise.resolve(backendBase);
    return BACKEND_PORTS.reduce(function (chain, port) {
      return chain.then(function (found) {
        if (found) return found;
        return probePort(port).then(function (b) { if (b) backendBase = b; return b; });
      });
    }, Promise.resolve(null)).then(function (b) { return b; });
  }

  function fetchJson(base, path) {
    return fetch(base + path, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---------- 状态 ----------
  var currentGame = null;      // 当前选中的游戏 entry（含 manifest 解析结果）
  var devices = [];            // 在线物理设备 [{id, type, connected, ...}]
  var typeCaps = {};           // type → [capability]
  var mapping = {};            // logicalId → physicalId[]（用户选的）
  var params = {};             // 用户填的参数

  // ---------- manifest 解析 ----------
  // 游戏 entry 来自 registry.json，但 devices/params 详细定义在游戏页内联 manifest。
  // registry 已含 devices/params（build-registry 抽取），直接用；缺则回退抓游戏页。
  function getManifest(game) {
    if (game.devices && game.devices.length) {
      return { devices: game.devices, params: game.params || [] };
    }
    // 回退：抓游戏 index.html 解析内联 manifest
    var gameUrl = new URL(game._path || ('games/' + game.id + '/index.html'), location.href).href;
    return fetch(gameUrl).then(function (r) { return r.text(); }).then(function (html) {
      var m = html.match(/<script[^>]*\bid=["']?game-manifest["']?[^>]*>([\s\S]*?)<\/script>/i);
      if (!m) throw new Error('游戏页无 game-manifest');
      var obj = JSON.parse(m[1]);
      return { devices: obj.devices || [], params: obj.params || [] };
    });
  }

  // ---------- 设备匹配 ----------
  // 一个物理设备能映射到某逻辑设备，当且仅当它的类型覆盖逻辑设备要求的所有能力
  function canMap(logicalDevice, physicalDevice) {
    var required = logicalDevice.capabilities || [];
    var have = typeCaps[physicalDevice.type] || [];
    if (!required.length) return true;
    return required.every(function (c) { return have.indexOf(c) >= 0; });
  }

  function onlineDevices() {
    return devices.filter(function (d) { return d.connected; });
  }

  // ---------- modal 渲染 ----------
  function openModal(game) {
    currentGame = game;
    mapping = {};
    params = {};

    el('modal-game-title').textContent = game.title || game.id;

    // 状态条
    var status = el('modal-status');
    status.innerHTML = '<span class="dot pulse"></span> 正在探测本机控制面板…';
    status.className = 'modal-status searching';

    el('modal-body').innerHTML = '<div class="loader">连接中…</div>';
    el('modal-start').disabled = true;
    el('modal').classList.add('show');

    detectBackend().then(function (base) {
      if (!base) {
        showNoBackend();
        return;
      }
      loadBackendData(base);
    });
  }

  function showNoBackend() {
    var status = el('modal-status');
    status.innerHTML = '<span class="dot err"></span> 未找到本机控制面板';
    status.className = 'modal-status error';
    el('modal-body').innerHTML =
      '<div class="empty-block">'
      + '<p style="font-size:16px;margin-bottom:10px;">未在 127.0.0.1 探测到控制面板后端</p>'
      + '<p style="color:var(--text-soft);font-size:14px;margin-bottom:16px;">请先启动控制面板（Electron 桌面端或后端服务），让本机 5278 端口可用后重试。</p>'
      + '<button class="btn btn-ghost" id="retry-detect">重新探测</button>'
      + '</div>';
    var retry = el('retry-detect');
    if (retry) retry.onclick = function () { backendBase = null; openModal(currentGame); };
  }

  function loadBackendData(base) {
    var status = el('modal-status');
    status.innerHTML = '<span class="dot ok"></span> 已连接 ' + base + ' · 加载设备中…';
    status.className = 'modal-status ok';

    Promise.all([fetchJson(base, '/api/devices'), fetchJson(base, '/api/device-capabilities')])
      .then(function (results) {
        devices = results[0] || [];
        typeCaps = (results[1] && results[1].typeCapabilityMap) || {};
        renderDevicePicker(base);
      })
      .catch(function (err) {
        var s = el('modal-status');
        s.innerHTML = '<span class="dot err"></span> 加载设备失败: ' + esc(err.message || err);
        s.className = 'modal-status error';
        el('modal-body').innerHTML = '<div class="empty-block"><p>无法从控制面板读取设备列表。</p></div>';
      });
  }

  function renderDevicePicker(base) {
    var online = onlineDevices();
    var status = el('modal-status');
    if (!online.length) {
      status.innerHTML = '<span class="dot warn"></span> ' + base + ' · 当前无在线设备';
      status.className = 'modal-status warn';
    } else {
      status.innerHTML = '<span class="dot ok"></span> ' + base + ' · ' + online.length + ' 个在线设备';
      status.className = 'modal-status ok';
    }

    getManifest(currentGame).then ? getManifest(currentGame).then(renderForm) : renderForm(getManifest(currentGame));

    function renderForm(manifest) {
      var html = '';
      var devs = manifest.devices || [];

      // 设备映射区
      if (devs.length) {
        html += '<div class="form-section"><h4>设备映射</h4>';
        devs.forEach(function (d) {
          var req = d.required ? '<span class="req">必需</span>' : '<span class="opt">可选</span>';
          var caps = (d.capabilities || []).join(', ');
          var candidates = online.filter(function (p) { return canMap(d, p); });
          html += '<div class="map-row" data-logical="' + esc(d.id) + '">'
            + '<div class="map-meta">'
            + '<span class="map-lid">' + esc(d.id) + '</span> ' + req
            + '<span class="map-caps">能力: ' + esc(caps || '（无）') + '</span>'
            + '</div>'
            + '<select class="map-select" data-lid="' + esc(d.id) + '">'
            + '<option value="">— 未映射 —</option>'
            + candidates.map(function (p) {
              return '<option value="' + esc(p.id) + '">' + esc(p.id) + ' · ' + esc(p.type) + '</option>';
            }).join('')
            + '</select>'
            + (candidates.length === 0 ? '<span class="map-none">无匹配设备</span>' : '')
            + '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="form-section"><p>此玩法不需要设备映射。</p></div>';
      }

      // 参数区
      var ps = manifest.params || [];
      if (ps.length) {
        html += '<div class="form-section"><h4>参数</h4>';
        ps.forEach(function (p) {
          var def = (p.default !== undefined ? p.default : '');
          var label = esc(p.label || p.key);
          var input;
          if (p.type === 'boolean') {
            input = '<label class="bool"><input type="checkbox" data-pkey="' + esc(p.key) + '" data-ptype="boolean"' + (def ? ' checked' : '') + '> ' + label + '</label>';
          } else if (p.type === 'enum' && p.options) {
            input = '<label>' + label + '</label><select data-pkey="' + esc(p.key) + '" data-ptype="enum">'
              + p.options.map(function (o) {
                var v = typeof o === 'object' ? o.value : o;
                var t = typeof o === 'object' ? o.label : o;
                return '<option value="' + esc(v) + '"' + (v === def ? ' selected' : '') + '>' + esc(t) + '</option>';
              }).join('') + '</select>';
          } else {
            input = '<label>' + label + '</label><input type="' + (p.type === 'number' ? 'number' : 'text') + '" data-pkey="' + esc(p.key) + '" data-ptype="' + esc(p.type || 'string') + '" value="' + esc(def) + '">';
          }
          html += '<div class="param-row">' + input + '</div>';
        });
        html += '</div>';
      }

      html += '<div class="form-section"><p class="hint">提示：可选设备不映射也能运行；必需设备必须选择。运行中可在控制栏「重选设备」。</p></div>';

      el('modal-body').innerHTML = html;

      // 校验初始 start 按钮
      validateStart(devs);

      // 绑定 change
      el('modal-body').querySelectorAll('.map-select').forEach(function (sel) {
        sel.addEventListener('change', function () {
          var lid = sel.getAttribute('data-lid');
          var v = sel.value;
          if (v) mapping[lid] = [v]; else delete mapping[lid];
          validateStart(devs);
        });
      });
      el('modal-body').querySelectorAll('[data-pkey]').forEach(function (inp) {
        var handler = function () {
          var key = inp.getAttribute('data-pkey');
          var pt = inp.getAttribute('data-ptype');
          var val;
          if (pt === 'boolean') val = inp.checked;
          else if (pt === 'number') val = inp.value === '' ? null : Number(inp.value);
          else val = inp.value;
          if (val === null) delete params[key]; else params[key] = val;
        };
        inp.addEventListener('change', handler);
        inp.addEventListener('input', handler);
        handler(); // 初始化默认值进 params
      });
    }
  }

  function validateStart(devs) {
    var missing = devs.filter(function (d) { return d.required && !mapping[d.id]; });
    var btn = el('modal-start');
    if (missing.length) {
      btn.disabled = true;
      btn.textContent = '需映射: ' + missing.map(function (d) { return d.id; }).join(', ');
    } else {
      btn.disabled = false;
      btn.textContent = '启动玩法 →';
    }
  }

  // ---------- 启动 ----------
  function savePlayedGame(game, gameUrl, proxyPath) {
    if (!backendBase || !game) return Promise.resolve();
    var payload = {
      id: game.id,
      title: game.title || game.id,
      description: game.description || '',
      version: game.version || '1.0.0',
      devices: game.devices || [],
      params: game.params || [],
      gamePath: proxyPath,
      externalUrl: gameUrl,
      origin: 'website',
      deviceMap: mapping,
      parameters: params,
    };
    return fetch(backendBase + '/api/games/played', {
      method: 'POST',
      mode: 'cors',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(function () {});
  }

  function startGame() {
    if (!currentGame || !backendBase) return;
    var gameUrl = new URL(currentGame._path || ('games/' + currentGame.id + '/index.html'), location.href).href;
    // 经本机后端 gameProxy 同源化：/games/proxy/<proto>/<host>/<path>
    var u = new URL(gameUrl);
    var proxyPathOnly = '/games/proxy/' + u.protocol.replace(':', '') + '/' + u.host + u.pathname;
    var proxyPath = backendBase + proxyPathOnly;
    var q = new URLSearchParams();
    q.set('deviceMap', JSON.stringify(mapping));
    q.set('params', JSON.stringify(params));
    var launchUrl = proxyPath + '?' + q.toString();

    // 用 sessionStorage 传参给 play.html（避免静态站 cleanURL 重写丢 query）
    try {
      sessionStorage.setItem('play-launch', JSON.stringify({
        id: currentGame.id,
        title: currentGame.title || currentGame.id,
        backend: backendBase,
        launch: launchUrl,
      }));
    } catch (_) {}
    closeModal();
    savePlayedGame(currentGame, gameUrl, proxyPathOnly).finally(function () {
      location.href = 'play.html';
    });
  }

  function closeModal() {
    el('modal').classList.remove('show');
  }

  // ---------- 暴露 ----------
  window.PlayLauncher = {
    open: openModal,
    detectBackend: detectBackend,
    startGame: startGame,
    closeModal: closeModal,
  };

  // modal 关闭按钮
  document.addEventListener('DOMContentLoaded', function () {
    var modal = el('modal');
    if (!modal) return;
    modal.addEventListener('click', function (e) {
      if (e.target === modal || e.target.classList.contains('modal-close')) closeModal();
    });
    var startBtn = el('modal-start');
    if (startBtn) startBtn.addEventListener('click', startGame);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('show')) closeModal();
    });
  });
})();
