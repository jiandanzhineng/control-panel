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
    punishForgotten: false,
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
    status: '',
    floating: null,
    processed: [],
    shockStopTimer: null,
    shocking: false,
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

  function isEn() {
    return active.locale === 'en';
  }
  function t(zh, en) {
    return isEn() ? (en || zh) : zh;
  }

  state.status = t('等待扇贝答题', 'Waiting for Shanbay');
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
    state.status = t('已连接设备', 'Device connected');
    updateFloatingUI();
  }).catch(() => {});

  // 判定完全依赖用户选择的当前选项按钮（点击或数字键快捷键），这是唯一权威来源。
  // 已移除 fetch/XHR/DOM 文本扫描：它们对整段响应/DOM 做子串匹配，
  // 会把"下一题数据/释义文本"里的关键词误判成答错，导致答对也电击。
  onDomReady(() => {
    injectFloatingUI();
    installChoiceObservers();
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
        state.status = t('设备连接断开，正在重连', 'Disconnected, reconnecting');
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
      locale: active.locale === 'en' ? 'en' : 'zh',
      localeTag: active.localeTag || (active.locale === 'en' ? 'en-US' : 'zh-CN'),
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

  function installChoiceObservers() {
    installClickObserver();
    installKeyboardObserver();
  }

  function installClickObserver() {
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      // 扇贝答题选项按钮 class 为 index_option__*；优先命中它，兜底才用通用 button。
      const option = target.closest('[class*="index_option"]');
      const button = option || target.closest('button, [role="button"]');
      if (!button) return;
      const text = choiceText(button);
      if (!text) return;
      const signal = classifyChoice(text);
      if (signal) onSignal(signal, 'click', text);
    }, true);
  }

  function installKeyboardObserver() {
    document.addEventListener('keydown', (event) => {
      if (!event || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.defaultPrevented || isEditableTarget(event.target)) return;

      const index = choiceIndexFromKeyboardEvent(event);
      if (index < 0) return;

      const choices = getCurrentChoiceOptions();
      const choice = choices[index];
      if (!choice) return;

      const text = choiceText(choice);
      const signal = classifyChoice(text);
      if (signal) onSignal(signal, 'keyboard', text);
    }, true);
  }

  function choiceIndexFromKeyboardEvent(event) {
    const key = String(event.key || '');
    if (/^[1-9]$/.test(key)) return Number(key) - 1;
    const code = String(event.code || '');
    const match = code.match(/^(?:Digit|Numpad)([1-9])$/);
    return match ? Number(match[1]) - 1 : -1;
  }

  function getCurrentChoiceOptions() {
    const primary = queryAll('[class*="index_option"]');
    const candidates = primary.length ? primary : queryAll('button, [role="button"]');
    const choices = [];
    for (const candidate of candidates) {
      if (!candidate || choices.includes(candidate)) continue;
      if (!isVisibleElement(candidate)) continue;
      const text = choiceText(candidate);
      if (!text || !classifyChoice(text)) continue;
      choices.push(candidate);
    }
    return choices;
  }

  function queryAll(selector) {
    try {
      return Array.prototype.slice.call(document.querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  function choiceText(element) {
    if (!element) return '';
    const text = element.innerText || element.textContent || (element.getAttribute && element.getAttribute('aria-label')) || '';
    return String(text).trim().replace(/\s+/g, ' ');
  }

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = String(target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function isVisibleElement(element) {
    if (!element) return false;
    if (element.hidden) return false;
    if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return false;
    if (typeof window.getComputedStyle === 'function') {
      const style = window.getComputedStyle(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
        return false;
      }
    }
    return true;
  }

  // 把选项按钮文案映射为答题结果。语义（基于扇贝网页版真实按钮）：
  //   第一阶段：「认识」=right，「不认识」=wrong（必罚）。
  //   点「不认识」后的二次确认：「想起来了」=right，「没想起来」=forgotten。
  //   forgotten 单独成信号：默认不罚（也不计答对，因为它是"不认识"的后续，
  //   本就没记住），仅当配置 punishForgotten 时才当作答错电击。
  // 顺序要点：
  //   1) 先判「没想起来」再判「想起来了」，因二者都含"想起来"子串。
  //   2) 先判「不认识」再判「认识」，因"不认识"含"认识"子串。
  function classifyChoice(text) {
    if (/没想起来|没想起/.test(text)) return 'forgotten';
    if (/想起来了|想起来|记得|太简单/.test(text)) return 'right';
    if (/不认识/.test(text)) return 'wrong';
    if (/认识/.test(text)) return 'right';
    return null;
  }

  function onSignal(signal, source, detail) {
    const now = Date.now();
    const word = currentWord();

    // 「没想起来」是点「不认识」后的二次确认：本就是没记住的词。
    // 默认既不算答对也不电击（视为"不认识"的后续，中性略过）；
    // 仅当开启 punishForgotten 时，才把它当作一次答错来处理。
    if (signal === 'forgotten') {
      const punish = !!(active.params || DEFAULT_PARAMS).punishForgotten;
      if (!punish) {
        state.status = t('没想起来（未惩罚）', 'Forgotten (no punish)');
        updateFloatingUI();
        return;
      }
      signal = 'wrong';
    }

    // 每个单词的一次答题周期内只认第一个信号，right/wrong 互斥：
    // key 不含 signal，故答对后即使再冒出别的信号也会被同一周期去重挡掉，
    // 不会出现同一次答题既记答对又记答错、进而误电击。
    const key = `${word}:${Math.floor(now / 1200)}`;
    if (state.processed.includes(key)) return;
    state.processed.push(key);
    if (state.processed.length > 20) state.processed.shift();

    if (signal === 'right') {
      state.rightCount += 1;
      state.status = t('答对', 'Correct');
      updateFloatingUI();
      return;
    }

    state.wrongCount += 1;
    state.status = t('答错', 'Wrong');
    updateFloatingUI();
    triggerShock(source, detail);
  }

  function triggerShock(source, detail) {
    const params = active.params || DEFAULT_PARAMS;
    if (!DeviceAPI.device('shock').isMapped()) {
      state.status = t('未映射电击设备', 'Shock device unmapped');
      updateFloatingUI();
      return;
    }

    // 无次数上限、无冷却延时：每次答错都触发。
    // 连续触发时按“最新一次触发”重算结束时间——取消上一个 stop 定时器，
    // 重新计时，因此结束时间 = 最后一次触发 + 时长。
    state.lastShockAt = Date.now();
    state.shockCount += 1;
    const voltage = Math.min(100, Math.max(0, Number(params.shockVoltage) || DEFAULT_PARAMS.shockVoltage));
    const durationSeconds = Math.min(10, Math.max(1, Number(params.shockDuration) || DEFAULT_PARAMS.shockDuration));

    DeviceAPI.log('info', 'shanbay wrong answer detected', { source, detail, voltage, durationSeconds });
    DeviceAPI.device('shock').invoke('shock', 'start', { voltage }).catch(() => {});
    if (state.shockStopTimer) clearTimeout(state.shockStopTimer);
    state.shockStopTimer = setTimeout(() => {
      state.shockStopTimer = null;
      state.shocking = false;
      DeviceAPI.device('shock').invoke('shock', 'stop', {}).catch(() => {});
      state.status = t('答错', 'Wrong');
      updateFloatingUI();
    }, durationSeconds * 1000);

    state.shocking = true;
    state.status = t('电击中 {n}s', 'Shocking {n}s').replace('{n}', durationSeconds);
    flashLightning();
    updateFloatingUI();
  }

  function injectFloatingUI() {
    if (state.floating || !document.body) return;
    injectStyles();

    const el = document.createElement('div');
    el.id = 'undersilicon-shanbay-status';
    el.style.cssText = [
      'position:fixed',
      'right:20px',
      'bottom:20px',
      'z-index:2147483646',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:12px 16px',
      'border-radius:14px',
      'background:linear-gradient(135deg,rgba(17,24,39,.96),rgba(30,41,59,.96))',
      'color:#fff',
      'font:600 15px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      'box-shadow:0 10px 30px rgba(0,0,0,.35)',
      'border:1px solid rgba(250,204,21,.35)',
      'pointer-events:none',
      'white-space:nowrap',
      'transition:transform .12s ease, box-shadow .12s ease',
    ].join(';');

    const bolt = document.createElement('span');
    bolt.className = 'us-bolt';
    bolt.textContent = '⚡';
    bolt.style.cssText = 'font-size:26px;line-height:1;filter:drop-shadow(0 0 4px rgba(250,204,21,.6));';

    const info = document.createElement('span');
    info.className = 'us-info';

    el.appendChild(bolt);
    el.appendChild(info);
    document.body.appendChild(el);
    state.floating = el;
    state.floatingBolt = bolt;
    state.floatingInfo = info;

    // 全屏闪电覆盖层：电击时整屏闪一下并叠加大号闪电。
    const overlay = document.createElement('div');
    overlay.id = 'undersilicon-shanbay-flash';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483645',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'pointer-events:none',
      'opacity:0',
      'background:radial-gradient(circle at center,rgba(250,204,21,.28),rgba(0,0,0,.35))',
    ].join(';');
    const bigBolt = document.createElement('div');
    bigBolt.textContent = '⚡';
    bigBolt.style.cssText = 'font-size:40vh;line-height:1;filter:drop-shadow(0 0 30px rgba(250,204,21,.9));';
    overlay.appendChild(bigBolt);
    document.body.appendChild(overlay);
    state.flashOverlay = overlay;
  }

  function injectStyles() {
    if (document.getElementById('undersilicon-shanbay-style')) return;
    const style = document.createElement('style');
    style.id = 'undersilicon-shanbay-style';
    style.textContent = [
      '@keyframes us-flash{0%{opacity:0}8%{opacity:1}22%{opacity:.15}36%{opacity:.9}100%{opacity:0}}',
      '@keyframes us-bolt-buzz{0%,100%{transform:scale(1) rotate(0)}25%{transform:scale(1.35) rotate(-8deg)}50%{transform:scale(1.15) rotate(6deg)}75%{transform:scale(1.4) rotate(-4deg)}}',
      '#undersilicon-shanbay-flash.us-on{animation:us-flash .55s ease-out}',
      '#undersilicon-shanbay-status.us-shocking{transform:scale(1.06);box-shadow:0 0 0 3px rgba(250,204,21,.5),0 10px 30px rgba(0,0,0,.4)}',
      '#undersilicon-shanbay-status.us-shocking .us-bolt{animation:us-bolt-buzz .4s linear infinite;color:#fde047}',
    ].join('\n');
    document.head.appendChild(style);
  }

  function flashLightning() {
    const overlay = state.flashOverlay;
    if (overlay) {
      overlay.classList.remove('us-on');
      // 强制重排以便重复触发动画
      void overlay.offsetWidth;
      overlay.classList.add('us-on');
      const dur = Math.min(10, Math.max(1, Number((active.params || DEFAULT_PARAMS).shockDuration) || DEFAULT_PARAMS.shockDuration));
      clearTimeout(state.flashTimer);
      state.flashTimer = setTimeout(() => {
        overlay.classList.remove('us-on');
      }, dur * 1000);
    }
    if (state.floating) state.floating.classList.add('us-shocking');
  }

  function updateFloatingUI() {
    if (!state.floating) return;
    if (!state.shocking && state.floating.classList.contains('us-shocking')) {
      state.floating.classList.remove('us-shocking');
    }
    if (state.floatingInfo) {
      state.floatingInfo.textContent = t('{n}次 · ✓{r} ✗{w} · {s}', '{n}x · ✓{r} ✗{w} · {s}')
        .replace('{n}', state.shockCount)
        .replace('{r}', state.rightCount)
        .replace('{w}', state.wrongCount)
        .replace('{s}', state.status);
    }
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
