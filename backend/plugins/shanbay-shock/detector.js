(function () {
  'use strict';

  let fs;
  let path;
  let WebSocket;
  try {
    fs = require('fs');
    path = require('path');
    WebSocket = loadWebSocketModule();
  } catch (_) {
    return;
  }

  const DEFAULT_PARAMS = {
    shockVoltage: 15,
    shockDuration: 2,
    cooldownMs: 3000,
    maxShocks: 50,
  };

  function loadWebSocketModule() {
    try {
      return require('ws');
    } catch (_) {
      const resourcesPath = process.resourcesPath || '';
      const candidates = [
        resourcesPath ? path.join(resourcesPath, 'app.asar', 'backend', 'node_modules', 'ws') : '',
        resourcesPath ? path.join(resourcesPath, 'app', 'backend', 'node_modules', 'ws') : '',
        process.cwd ? path.join(process.cwd(), 'backend', 'node_modules', 'ws') : '',
      ].filter(Boolean);
      for (const candidate of candidates) {
        try {
          return require(candidate);
        } catch (_) {}
      }
      throw new Error('ws module not found');
    }
  }

  const state = {
    enabled: false,
    ready: false,
    shockCount: 0,
    rightCount: 0,
    wrongCount: 0,
    lastSignalAt: 0,
    lastShockAt: 0,
    status: '等待扇贝答题',
    floating: null,
    processed: [],
  };

  function safeReadActiveConfig() {
    const activePath = process.env.ACTIVE_PLUGIN_PATH;
    if (!activePath) return null;
    try {
      const active = JSON.parse(fs.readFileSync(activePath, 'utf-8'));
      if (active.pluginId !== 'shanbay-shock') return null;
      return {
        ...active,
        params: { ...DEFAULT_PARAMS, ...(active.params || {}) },
      };
    } catch (_) {
      return null;
    }
  }

  const active = safeReadActiveConfig();
  if (!active || !matchesAny(location.href, active.matchUrls || [])) return;

  state.enabled = true;
  const DeviceAPI = buildDeviceAPI(active.bridgeUrl || 'ws://127.0.0.1:5277/bridge', active.deviceMap || {}, active.params || {});
  try {
    Object.defineProperty(window, 'DeviceAPI', {
      value: DeviceAPI,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch (_) {}

  DeviceAPI.ready.then(() => {
    state.ready = true;
    state.status = '已连接设备';
    updateFloatingUI();
  }).catch(() => {});

  // 判定完全依赖点击委托（用户点了哪个选项按钮），这是唯一权威来源。
  // 已移除 fetch/XHR/DOM 文本扫描：它们对整段响应/DOM 做子串匹配，
  // 会把"下一题数据/释义文本"里的关键词误判成答错，导致答对也电击。
  onDomReady(() => {
    injectFloatingUI();
    installClickObserver();
    updateFloatingUI();
  });

  function buildDeviceAPI(bridgeUrl, deviceMap, params) {
    let ws = null;
    let idCounter = 0;
    const pending = new Map();
    const readyWaiters = [];
    let ready = false;

    function genId() {
      idCounter += 1;
      return `plugin_${idCounter}_${Date.now()}`;
    }

    function resolveReady() {
      ready = true;
      while (readyWaiters.length) {
        const fn = readyWaiters.shift();
        try { fn(); } catch (_) {}
      }
    }

    function connect() {
      try {
        ws = new WebSocket(bridgeUrl);
      } catch (_) {
        setTimeout(connect, 2000);
        return;
      }

      ws.on('open', () => {
        const id = genId();
        pending.set(id, { resolve: resolveReady, reject: function () {} });
        ws.send(JSON.stringify({
          id,
          action: 'init',
          deviceMap,
          params,
        }));
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
        if (msg.id && pending.has(msg.id)) {
          const item = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) item.reject(new Error(msg.error));
          else item.resolve(msg.result);
        }
      });

      ws.on('close', () => {
        ready = false;
        state.ready = false;
        state.status = '设备连接断开，正在重连';
        updateFloatingUI();
        setTimeout(connect, 2000);
      });

      ws.on('error', () => {});
    }

    function sendRequest(data) {
      return new Promise((resolve, reject) => {
        const id = genId();
        data.id = id;
        pending.set(id, { resolve, reject });
        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify(data));
          } catch (error) {
            pending.delete(id);
            reject(error);
          }
        } else {
          pending.delete(id);
          reject(new Error('Bridge not connected'));
        }
      });
    }

    connect();

    return {
      ready: new Promise((resolve) => {
        if (ready) resolve();
        else readyWaiters.push(resolve);
      }),
      params,
      deviceMap,
      device: (logicalId) => ({
        invoke: (capability, actionName, input) => sendRequest({
          action: 'invoke',
          deviceId: logicalId,
          capability,
          actionName,
          params: input || {},
        }),
        isMapped: () => {
          const ids = deviceMap[logicalId];
          return Array.isArray(ids) ? ids.length > 0 : !!ids;
        },
      }),
      log: (level, message, meta) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({
            id: genId(),
            action: 'log',
            level,
            message,
            meta: meta || {},
          }));
        } catch (_) {}
      },
    };
  }

  function installClickObserver() {
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      // 扇贝答题选项按钮 class 为 index_option__*；优先命中它，兜底才用通用 button。
      const option = target.closest('[class*="index_option"]');
      const button = option || target.closest('button, [role="button"]');
      if (!button) return;
      const text = ((button.innerText || button.getAttribute('aria-label') || '') + '').trim().replace(/\s+/g, ' ');
      if (!text) return;
      const signal = classifyChoice(text);
      if (signal) onSignal(signal, 'click', text);
    }, true);
  }

  // 把选项按钮文案映射为答题结果。语义（基于扇贝网页版真实按钮）：
  //   第一阶段：「认识」=答对，「不认识」=答错。
  //   答错后二次确认：「想起来了」/「没想起来」——已在"不认识"时判过错，
  //   这里一律不再算错（归 right/中性），避免对同一词重复电击。
  // 顺序要点：先判「不认识」再判「认识」，因为"不认识"包含"认识"子串。
  function classifyChoice(text) {
    if (/不认识/.test(text)) return 'wrong';
    if (/认识/.test(text)) return 'right';
    // 二次确认阶段：想起来了 / 没想起来，都不再触发电击
    if (/想起来了|没想起来|想起来|记得|太简单/.test(text)) return 'right';
    return null;
  }

  function onSignal(signal, source, detail) {
    const now = Date.now();
    const word = currentWord();
    // 每个单词的一次答题周期内只认第一个信号，right/wrong 互斥：
    // key 不含 signal，故答对后即使再冒出别的信号也会被同一周期去重挡掉，
    // 不会出现同一次答题既记答对又记答错、进而误电击。
    const key = `${word}:${Math.floor(now / 1200)}`;
    if (state.processed.includes(key)) return;
    state.processed.push(key);
    if (state.processed.length > 20) state.processed.shift();

    if (signal === 'right') {
      state.rightCount += 1;
      state.status = '答对';
      updateFloatingUI();
      return;
    }

    state.wrongCount += 1;
    state.status = '答错';
    updateFloatingUI();
    triggerShock(source, detail);
  }

  function triggerShock(source, detail) {
    const now = Date.now();
    const params = active.params || DEFAULT_PARAMS;
    const cooldownMs = Math.max(500, Number(params.cooldownMs) || DEFAULT_PARAMS.cooldownMs);
    const maxShocks = Math.max(1, Number(params.maxShocks) || DEFAULT_PARAMS.maxShocks);
    if (state.shockCount >= maxShocks) {
      state.status = '已达到触发上限';
      updateFloatingUI();
      return;
    }
    if (now - state.lastShockAt < cooldownMs) {
      state.status = '冷却中，跳过触发';
      updateFloatingUI();
      return;
    }
    if (!DeviceAPI.device('shock').isMapped()) {
      state.status = '未映射电击设备';
      updateFloatingUI();
      return;
    }

    state.lastShockAt = now;
    state.shockCount += 1;
    const voltage = Math.min(100, Math.max(0, Number(params.shockVoltage) || DEFAULT_PARAMS.shockVoltage));
    const durationSeconds = Math.min(10, Math.max(1, Number(params.shockDuration) || DEFAULT_PARAMS.shockDuration));

    DeviceAPI.log('info', 'shanbay wrong answer detected', { source, detail, voltage, durationSeconds });
    DeviceAPI.device('shock').invoke('shock', 'start', { voltage }).catch(() => {});
    setTimeout(() => {
      DeviceAPI.device('shock').invoke('shock', 'stop', {}).catch(() => {});
    }, durationSeconds * 1000);
    state.status = `已触发 ${durationSeconds}s`;
    updateFloatingUI();
  }

  function injectFloatingUI() {
    if (state.floating || !document.body) return;
    const el = document.createElement('div');
    el.id = 'undersilicon-shanbay-status';
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'padding:9px 12px',
      'border-radius:8px',
      'background:rgba(17,24,39,.92)',
      'color:#fff',
      'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 6px 18px rgba(0,0,0,.24)',
      'pointer-events:none',
      'white-space:nowrap',
    ].join(';');
    document.body.appendChild(el);
    state.floating = el;
  }

  function updateFloatingUI() {
    if (!state.floating) return;
    state.floating.textContent = `⚡${state.shockCount} ✓${state.rightCount} ✗${state.wrongCount} · ${state.status}`;
  }

  function currentWord() {
    try {
      const el = document.querySelector('h1,[class*="word"],[class*="Word"]');
      return ((el && el.innerText) || '').split('\n')[0].trim().slice(0, 80) || 'unknown';
    } catch (_) {
      return 'unknown';
    }
  }

  function matchesAny(url, patterns) {
    return (patterns || []).some((pattern) => {
      const escaped = String(pattern)
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`, 'i').test(url);
    });
  }

  function onDomReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }
})();
