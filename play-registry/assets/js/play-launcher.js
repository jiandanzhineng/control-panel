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
  var backendForbidden = false; // 探测到后端在跑但拒绝本网站（403，未授权）
  var busy = false; // 同一时刻只处理一个 GameHost 请求（cache/launch）

  // ---------- 工具 ----------
  function t(key, vars) {
    try {
      if (typeof window !== 'undefined' && window.SiteI18n && window.SiteI18n.t) return window.SiteI18n.t(key, vars);
    } catch (_) {}
    var text = key;
    if (vars) {
      text = String(text).replace(/\{(\w+)\}/g, function (_, k) {
        return vars[k] == null ? '' : String(vars[k]);
      });
    }
    return text;
  }

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 轻量 toast（复用页面 #toast，若无则降级到 modal-status）
  function toast(msg) {
    var t = el('toast');
    if (t) {
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(function () { t.classList.remove('show'); }, 2200);
      return;
    }
    var s = el('modal-status');
    if (s) { s.textContent = msg; }
  }

  // 宿主（PC Electron / 手机 App）注入的统一游戏启动桥
  function gameHost() { return window.GameHost || null; }

  function deviceApi() { return window.DeviceAPI || null; }

  // 探测本机后端：
  //   命中(200) → 返回 base
  //   后端在跑但拒绝本网站(403) → 返回 { forbidden: true }
  //   连不上/超时 → 返回 null
  function probePort(port) {
    var base = 'http://127.0.0.1:' + port;
    return new Promise(function (resolve) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 800);
      fetch(base + '/api/devices', { signal: ctrl.signal, mode: 'cors' })
        .then(function (r) {
          clearTimeout(t);
          if (r.ok) resolve(base);
          else if (r.status === 403) resolve({ forbidden: true, base: base });
          else resolve(null);
        })
        .catch(function () { clearTimeout(t); resolve(null); });
    });
  }

  function detectBackend(force) {
    if (backendBase && !force) return Promise.resolve(backendBase);
    backendForbidden = false;
    return BACKEND_PORTS.reduce(function (chain, port) {
      return chain.then(function (found) {
        if (found) return found;
        return probePort(port).then(function (b) {
          if (b === null) return null;
          if (b && b.forbidden) { backendForbidden = true; return null; }
          backendBase = b;
          return b;
        });
      });
    }, Promise.resolve(null)).then(function (b) { return b; });
  }

  function fetchJson(base, path) {
    return fetch(base + path, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function apiJson(base, path, options) {
    return fetch(base + path, Object.assign({ mode: 'cors' }, options || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) {
          var msg = (data && data.error && data.error.message) || data.message || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return data;
      });
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
      if (!m) throw new Error(t('noManifest'));
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

  function mappingHasSelection(logicalId) {
    return Array.isArray(mapping[logicalId]) && mapping[logicalId].length > 0;
  }

  function setDefaultMapping(logicalDevice, candidates) {
    if (!logicalDevice || !logicalDevice.id || mappingHasSelection(logicalDevice.id)) return;
    mapping[logicalDevice.id] = candidates.length ? [candidates[0].id] : [];
  }

  // ---------- modal 渲染 ----------
  function openModal(game, triggerButton) {
    // feature detection：宿主存在时，委托宿主打开原生配置页并运行，
    // 不再探测 127.0.0.1、不弹设备 modal，也不回退到网页直接运行。
    var host = gameHost();
    if (host && typeof host.launch === 'function') {
      launchViaHost(game, triggerButton);
      return;
    }

    currentGame = game;
    mapping = {};
    params = {};

    el('modal-game-title').textContent = game.title || game.id;

    // 状态条
    var status = el('modal-status');
    status.innerHTML = '<span class="dot pulse"></span> ' + t('probing');
    status.className = 'modal-status searching';

    el('modal-body').innerHTML = '<div class="loader">' + t('connecting') + '</div>';
    el('modal-start').disabled = true;
    el('modal').classList.add('show');

    detectBackend().then(function (base) {
      if (base) { loadBackendData(base); return; }
      // 后端在跑但拒绝本网站：尝试走 DeviceAPI 授权
      if (backendForbidden) { handleForbidden(); return; }
      showNoBackend();
    });
  }

  // 后端返回 403：面板在运行，但没授权本网站。
  //   - electron 内置浏览器（有 DeviceAPI）→ 引导申请授权，允许后重探测
  //   - 普通浏览器（无 DeviceAPI）→ 提示在面板内打开 / 开开发者模式
  function handleForbidden() {
    var api = deviceApi();
    if (!api || !api.requestAccess) { showMissingApi(); return; }
    var status = el('modal-status');
    status.innerHTML = '<span class="dot warn"></span> ' + t('panelRunningUnauthorized');
    status.className = 'modal-status warn';
    el('modal-body').innerHTML =
      '<div class="empty-block">'
      + '<p style="font-size:16px;margin-bottom:10px;">' + t('needGrant') + '</p>'
      + '<p style="color:var(--text-soft);font-size:14px;margin-bottom:16px;">' + t('grantHint') + '</p>'
      + '<button class="btn btn-primary" id="request-grant">' + t('requestGrant') + '</button>'
      + '</div>';
    var btn = el('request-grant');
    if (btn) btn.onclick = function () {
      btn.disabled = true;
      btn.textContent = t('waitingGrant');
      api.requestAccess().then(function () {
        backendBase = null;
        backendForbidden = false;
        openModal(currentGame); // 重新探测，此时后端已放行
      }).catch(function (err) {
        btn.disabled = false;
        btn.textContent = t('requestGrant');
        status.innerHTML = '<span class="dot err"></span> ' + t('grantFail', { msg: esc(err && err.message ? err.message : err) });
        status.className = 'modal-status error';
      });
    };
  }

  function showMissingApi() {
    var status = el('modal-status');
    status.innerHTML = '<span class="dot err"></span> ' + t('envNoGrant');
    status.className = 'modal-status error';
    el('modal-body').innerHTML =
      '<div class="empty-block">'
      + '<p style="font-size:16px;margin-bottom:10px;">' + t('cannotGrant') + '</p>'
      + '<p style="color:var(--text-soft);font-size:14px;margin-bottom:16px;">' + t('cannotGrantHint') + '</p>'
      + '<button class="btn btn-ghost" id="retry-detect">' + t('retryDetect') + '</button>'
      + '</div>';
    var retry = el('retry-detect');
    if (retry) retry.onclick = function () { backendBase = null; backendForbidden = false; openModal(currentGame); };
  }

  function showNoBackend() {
    var status = el('modal-status');
    status.innerHTML = '<span class="dot err"></span> ' + t('noPanel');
    status.className = 'modal-status error';
    el('modal-body').innerHTML =
      '<div class="empty-block">'
      + '<p style="font-size:16px;margin-bottom:10px;">' + t('noPanelHint') + '</p>'
      + '<p style="color:var(--text-soft);font-size:14px;margin-bottom:16px;">' + t('noPanelHint2') + '</p>'
      + '<button class="btn btn-ghost" id="retry-detect">重新探测</button>'
      + '</div>';
    var retry = el('retry-detect');
    if (retry) retry.onclick = function () { backendBase = null; backendForbidden = false; openModal(currentGame); };
  }

  function loadBackendData(base) {
    var status = el('modal-status');
    status.innerHTML = '<span class="dot ok"></span> ' + t('connectedLoading', { base: base });
    status.className = 'modal-status ok';

    Promise.all([fetchJson(base, '/api/devices'), fetchJson(base, '/api/device-capabilities')])
      .then(function (results) {
        devices = results[0] || [];
        typeCaps = (results[1] && results[1].typeCapabilityMap) || {};
        renderDevicePicker(base);
      })
      .catch(function (err) {
        var s = el('modal-status');
        s.innerHTML = '<span class="dot err"></span> ' + t('loadDevicesFail', { msg: esc(err.message || err) });
        s.className = 'modal-status error';
        el('modal-body').innerHTML = '<div class="empty-block"><p>' + t('cannotReadDevices') + '</p></div>';
      });
  }

  function renderDevicePicker(base) {
    var online = onlineDevices();
    var status = el('modal-status');
    if (!online.length) {
      status.innerHTML = '<span class="dot warn"></span> ' + t('noOnline', { base: base });
      status.className = 'modal-status warn';
    } else {
      status.innerHTML = '<span class="dot ok"></span> ' + t('onlineCount', { base: base, n: online.length });
      status.className = 'modal-status ok';
    }

    getManifest(currentGame).then ? getManifest(currentGame).then(renderForm) : renderForm(getManifest(currentGame));

    function renderForm(manifest) {
      var html = '';
      var devs = manifest.devices || [];

      // 设备映射区
      if (devs.length) {
        html += '<div class="form-section"><h4>' + t('deviceMap') + '</h4>';
        devs.forEach(function (d) {
          var req = d.required ? '<span class="req">' + t('required') + '</span>' : '<span class="opt">' + t('optional') + '</span>';
          var caps = (d.capabilities || []).join(', ');
          var candidates = online.filter(function (p) { return canMap(d, p); });
          setDefaultMapping(d, candidates);
          html += '<div class="map-row" data-logical="' + esc(d.id) + '">'
            + '<div class="map-meta">'
            + '<span class="map-lid">' + esc(d.id) + '</span> ' + req
            + '<span class="map-caps">' + t('caps', { caps: esc(caps || t('none')) }) + '</span>'
            + '</div>'
            + '<div class="map-options" role="group" aria-label="' + esc(d.id) + ' 设备映射">'
            + candidates.map(function (p) {
              var checked = (mapping[d.id] || []).indexOf(p.id) >= 0 ? ' checked' : '';
              return '<label class="map-option">'
                + '<input class="map-checkbox" type="checkbox" data-lid="' + esc(d.id) + '" value="' + esc(p.id) + '"' + checked + '>'
                + '<span class="map-device-id">' + esc(p.id) + '</span>'
                + '<span class="map-device-type">' + esc(p.type) + '</span>'
                + '</label>';
            }).join('')
            + '</div>'
            + (candidates.length === 0 ? '<span class="map-none">' + t('noMatchDevice') + '</span>' : '')
            + '</div>';
        });
        html += '</div>';
      } else {
        html += '<div class="form-section"><p>' + t('noMapNeeded') + '</p></div>';
      }

      // 参数区
      var ps = manifest.params || [];
      if (ps.length) {
        html += '<div class="form-section"><h4>' + t('params') + '</h4>';
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

      html += '<div class="form-section"><p class="hint">' + t('mapHint') + '</p></div>';

      el('modal-body').innerHTML = html;

      // 校验初始 start 按钮
      validateStart(devs);

      // 绑定 change
      el('modal-body').querySelectorAll('.map-checkbox').forEach(function (box) {
        box.addEventListener('change', function () {
          var lid = box.getAttribute('data-lid');
          var selected = [];
          el('modal-body').querySelectorAll('.map-checkbox').forEach(function (checkedBox) {
            if (checkedBox.getAttribute('data-lid') === lid && checkedBox.checked) {
              selected.push(checkedBox.value);
            }
          });
          mapping[lid] = selected;
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
    var missing = devs.filter(function (d) { return d.required && !mappingHasSelection(d.id); });
    var btn = el('modal-start');
    if (missing.length) {
      btn.disabled = true;
      btn.textContent = t('needMap', { ids: missing.map(function (d) { return d.id; }).join(', ') });
    } else {
      btn.disabled = false;
      btn.textContent = t('startPlay');
    }
  }

  // ---------- 启动 ----------
  function installGamePackage(game) {
    if (!backendBase || !game || !game.cacheable || !game.packageUrl || !game.packageSha256) {
      return Promise.resolve(null);
    }
    var status = el('modal-status');
    if (status) {
      status.innerHTML = '<span class="dot pulse"></span> ' + t('caching');
      status.className = 'modal-status searching';
    }
    return apiJson(backendBase, '/api/game-cache/install/' + encodeURIComponent(game.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(function (installed) {
      if (status) {
        status.innerHTML = '<span class="dot ok"></span> ' + t('cachedLaunch');
        status.className = 'modal-status ok';
      }
      return installed;
    }).catch(function (err) {
      if (status) {
        status.innerHTML = '<span class="dot warn"></span> ' + t('cacheFallback', { msg: esc(err.message || err) });
        status.className = 'modal-status warn';
      }
      return null;
    });
  }

  function savePlayedGame(game, gameUrl, gamePath, cacheInfo) {
    if (!backendBase || !game) return Promise.resolve();
    var cached = !!(cacheInfo && cacheInfo.localGamePath);
    var payload = {
      id: game.id,
      title: game.title || game.id,
      description: game.description || '',
      version: game.version || '1.0.0',
      devices: game.devices || [],
      params: game.params || [],
      gamePath: gamePath,
      externalUrl: gameUrl,
      origin: 'website',
      cached: cached,
      localGamePath: cached ? cacheInfo.localGamePath : '',
      packageSha256: cached ? (cacheInfo.packageSha256 || game.packageSha256 || '') : '',
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
    el('modal-start').disabled = true;
    el('modal-start').textContent = t('starting');
    installGamePackage(currentGame).then(function (cacheInfo) {
      var selectedPath = (cacheInfo && cacheInfo.localGamePath) ? cacheInfo.localGamePath : proxyPathOnly;
      var launchBase = backendBase + selectedPath;
      var q = new URLSearchParams();
      q.set('deviceMap', JSON.stringify(mapping));
      q.set('params', JSON.stringify(params));
      var launchUrl = launchBase + '?' + q.toString();

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
      savePlayedGame(currentGame, gameUrl, selectedPath, cacheInfo).finally(function () {
        location.href = 'play.html';
      });
    });
  }

  function closeModal() {
    el('modal').classList.remove('show');
  }

  // ---------- GameHost 桥接（PC Electron / 手机 App）----------
  // 请求体严格只含 v 和 gameId 两个字段。
  function setActionBusy(triggerButton, active) {
    busy = active;
    var buttons = document.querySelectorAll('[data-cache], [data-launch]');
    Array.prototype.forEach.call(buttons, function (button) {
      button.disabled = active;
    });
    if (!triggerButton) return;
    triggerButton.disabled = active;
    triggerButton.setAttribute('aria-busy', active ? 'true' : 'false');
    if (active) triggerButton.classList.add('is-loading');
    else triggerButton.classList.remove('is-loading');
  }

  function runHostRequest(triggerButton, invoke, onSuccess, onError) {
    setActionBusy(triggerButton, true);
    Promise.resolve()
      .then(invoke)
      .then(onSuccess, onError)
      .then(
        function () { setActionBusy(triggerButton, false); },
        function () { setActionBusy(triggerButton, false); },
      );
  }

  function launchViaHost(game, triggerButton) {
    if (busy) return; // 同一时刻只处理一个请求，重复点击忽略
    var host = gameHost();
    if (!host || typeof host.launch !== 'function') { toast(t('envNoLaunch')); return; }
    toast(t('launchingNamed', { title: game.title || game.id }));
    runHostRequest(
      triggerButton,
      function () { return host.launch({ v: 1, gameId: game.id }); },
      function () {
        toast(t('launchAccepted'));
      },
      function (err) {
        toast(t('launchFail', { msg: err && err.message ? err.message : err }));
      },
    );
  }

  function cacheGame(game, triggerButton) {
    if (busy) return; // 同一时刻只处理一个请求，重复点击忽略
    var host = gameHost();
    if (!host || typeof host.cache !== 'function') {
      toast(t('cacheInApp'));
      return;
    }
    toast(t('cachingNamed', { title: game.title || game.id }));
    runHostRequest(
      triggerButton,
      function () { return host.cache({ v: 1, gameId: game.id }); },
      function () {
        toast(t('cachedNamed', { title: game.title || game.id }));
      },
      function (err) {
        toast(t('cacheFail', { msg: err && err.message ? err.message : err }));
      },
    );
  }

  // ---------- 暴露 ----------
  window.PlayLauncher = {
    open: openModal,
    cache: cacheGame,
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
