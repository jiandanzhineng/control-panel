// 最小玩法示例：嵌入式 HTML + SSE + 页面动作
// 满足 PRD 的字段与方法约定，并演示 emitState/emitUi 与 onAction

const demo = {
  title: 'Demo — Embedded HTML + SSE',
  description: '最小玩法示例，内嵌页面，SSE 推送状态与 UI 增量，并支持页面动作。',
  // 启动前可配置参数的声明（供程序/前端读取生成配置界面）
  parameter: [
    { key: 'counterStart', type: 'number', name: '计数器起始值', required: false, default: 0, min: 0 }
  ],
  requiredDevices: [
    // 示例：非必需设备（无需映射即可运行）
    { logicalId: 'TD_DEVICE', name: '振动器', type: 'TD01', required: false },
    // 新增：QTZ 设备（测距及脚踏传感器），用于监听按钮属性变化
    { logicalId: 'QTZ_DEVICE', name: '测距及脚踏传感器', type: 'QTZ', required: true },
    { logicalId: 'STRENGTH_DEVICE', name: '强度接口设备', interface: 'strength', required: false },
  ],

  // 运行时内部状态（不持久化，由玩法自行维护）
  _runtime: {
    counter: 0,
    paused: false,
  },

  start(deviceManager, parameters) {
    const p = parameters || {};
    if (typeof p.counterStart === 'number') {
      this._runtime.counter = Math.max(0, Math.floor(p.counterStart));
    }
    deviceManager.log('info', 'Demo start', { parameters: p });
    deviceManager.emitState({ counter: this._runtime.counter, paused: this._runtime.paused });
    deviceManager.emitUi({ fields: { statusText: '准备就绪', btnText: '暂停' } });

    // 监听 QTZ 设备的 button0 / button1 属性变化
    try {
      deviceManager.listenDeviceProperty('QTZ_DEVICE', 'button0', (newVal, oldVal, ctx) => {
        deviceManager.log('info', 'QTZ button0 属性变化 从'+oldVal+'到'+newVal, { new: newVal, old: oldVal, logicalId: ctx?.logicalId, deviceId: ctx?.deviceId });
        deviceManager.setDeviceProperty('TD_DEVICE', {'power':50});
      });
      deviceManager.listenDeviceProperty('QTZ_DEVICE', 'button1', (newVal, oldVal, ctx) => {
        deviceManager.log('info', 'QTZ button1 属性变化 从'+oldVal+'到'+newVal, { new: newVal, old: oldVal, logicalId: ctx?.logicalId, deviceId: ctx?.deviceId });
        deviceManager.setDeviceProperty('TD_DEVICE', {'power':150});
      });
      deviceManager.log('debug', '已注册 QTZ 设备属性监听', { logicalId: 'QTZ_DEVICE', properties: ['button0', 'button1'] });
    } catch (e) {
      deviceManager.log('warn', '注册 QTZ 属性监听失败', { error: e?.message || String(e) });
    }

    // 监听所有来自 QTZ 的 MQTT 消息，并记录到日志
    try {
      deviceManager.listenDeviceMessages('QTZ_DEVICE', (payload, ctx) => {
        let brief = '';
        try { brief = JSON.stringify(payload); } catch (_) { brief = String(payload); }
        if (brief && brief.length > 200) brief = brief.slice(0, 200) + '…';
        deviceManager.log('info', `接收 QTZ 设备 MQTT 消息: ${brief}`, {
          method: payload?.method,
          logicalId: ctx?.logicalId,
          deviceId: ctx?.deviceId,
          topic: ctx?.topic,
        });
      });
    } catch (e) {
      deviceManager.log('warn', '注册 QTZ MQTT 消息监听失败', { error: e?.message || String(e) });
    }
  },

  loop(deviceManager) {
    // 每秒自增一次（除非暂停）
    if (!this._runtime.paused) {
      this._runtime.counter += 1;
      deviceManager.emitState({ counter: this._runtime.counter });
    }
    // 返回 true 保持运行；返回 false 将结束玩法
    return true;
  },

  end(deviceManager) {
    deviceManager.log('info', 'Demo end', { finalCounter: this._runtime.counter });
  },

  updateParameters(parameters) {
    if (parameters && typeof parameters.counterStart === 'number') {
      this._runtime.counter = Math.max(0, Math.floor(parameters.counterStart));
    }
  },

  onAction(action, payload, deviceManager) {
    switch (action) {
      case 'pause': {
        this._runtime.paused = !this._runtime.paused;
        deviceManager.emitState({ paused: this._runtime.paused });
        deviceManager.emitUi({ fields: { statusText: this._runtime.paused ? '已暂停' : '运行中', btnText: this._runtime.paused ? '继续' : '暂停' } });
        deviceManager.log('info', '切换暂停状态', { paused: this._runtime.paused });
        return { paused: this._runtime.paused };
      }
      case 'add': {
        const delta = typeof payload?.delta === 'number' ? payload.delta : 1;
        this._runtime.counter += delta;
        deviceManager.emitState({ counter: this._runtime.counter });
        deviceManager.log('info', '计数增加', { delta, counter: this._runtime.counter });
        return { counter: this._runtime.counter };
      }
      case 'ping': {
        const ts = Date.now();
        deviceManager.log('debug', 'UI ping', { ts, payload });
        deviceManager.emitUi({ fields: { lastPing: new Date(ts).toLocaleTimeString() } });
        return { ts };
      }
      default:
        // 按约定：未实现则由后端返回 400 + GAMEPLAY_ACTION_NOT_SUPPORTED
        throw Object.assign(new Error(`Action not supported: ${action}`), { code: 'GAMEPLAY_ACTION_NOT_SUPPORTED' });
    }
  },

  getHtml() {
    // 简易内嵌页面：包含基本绑定属性与最小的动作绑定逻辑
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Demo — Embedded HTML + SSE</title>
    <style>
      :root { color-scheme: light dark; }
      html, body { height: 100%; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; margin: 0; padding: 16px; box-sizing: border-box; }
      header { display: flex; align-items: center; gap: 8px; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eee; color: #333; font-size: 12px; }
      main { margin-top: 16px; display: grid; grid-template-columns: 1fr; gap: 12px; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; }
      .actions { display: flex; gap: 8px; }
      button { padding: 8px 12px; border-radius: 6px; border: 1px solid #ccc; background: #fafafa; cursor: pointer; }
      button.primary { background: #2563eb; color: white; border-color: #1d4ed8; }
      .hidden { display: none !important; }
      .ok { color: #16a34a; }
      .warn { color: #f59e0b; }
      @media (max-width: 768px) {
        body { padding: 0; }
        main { margin-top: 8px; }
        .card { border-radius: 0; }
      }
    </style>
  </head>
  <body>
    <header>
      <h2 data-bind="title">Demo — Embedded HTML + SSE</h2>
      <span class="pill">运行中：<span data-bind="running">false</span></span>
      <span class="pill">开始时间：<span data-bind="startTime">-</span></span>
    </header>
    <main>
      <section class="card">
        <h3>计数器</h3>
        <p>当前值：<strong data-bind="counter">0</strong></p>
        <p class="ok" data-show="paused">已暂停</p>
        <p class="warn" data-show="paused" style="font-size:12px;">暂停时不自动增长，可通过按钮 +1</p>
        <div class="actions">
          <button class="primary" data-action="pause"><span data-bind="btnText">暂停</span></button>
          <button data-action="add" data-payload='{"delta":1}'>+1</button>
          <button data-action="ping">Ping</button>
        </div>
      </section>
      <section class="card">
        <h3>UI 字段</h3>
        <p>状态文本：<span data-bind="statusText">-</span></p>
        <p>上次 ping：<span data-bind="lastPing">-</span></p>
      </section>
      <section class="card">
        <h3>日志（最近 10 条）</h3>
        <ul id="logs" style="max-height:160px; overflow:auto; margin:0; padding-left:16px;"></ul>
      </section>
    </main>

    <script>
      (function(){
        const state = {};
        const uiFields = {};
        const $ = (sel) => Array.from(document.querySelectorAll(sel));
        function render() {
          // data-bind
          $('[data-bind]').forEach(el => {
            const key = el.getAttribute('data-bind');
            const val = (key in state) ? state[key] : (key in uiFields ? uiFields[key] : el.textContent);
            el.textContent = (val === undefined || val === null) ? '' : String(val);
          });
          // data-show
          $('[data-show]').forEach(el => {
            const key = el.getAttribute('data-show');
            const val = !!state[key];
            el.classList.toggle('hidden', !val);
          });
          // data-class="key:className"
          $('[data-class]').forEach(el => {
            const raw = el.getAttribute('data-class') || '';
            const m = raw.match(/\s*([^:]+)\s*:\s*(.+)\s*/);
            if (!m) return;
            const key = m[1]; const cls = m[2];
            el.classList.toggle(cls, !!state[key]);
          });
        }
        function merge(obj, patch) { Object.assign(obj, patch || {}); }
        function addLog(item) {
          const li = document.createElement('li');
          li.textContent = '[' + new Date(item.ts).toLocaleTimeString() + '] ' + item.level + ' — ' + item.message;
          const ul = document.getElementById('logs');
          ul.insertBefore(li, ul.firstChild);
          while (ul.children.length > 10) ul.removeChild(ul.lastChild);
        }
        function postAction(name, payload) {
          return fetch('/api/games/current/actions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: name, payload })
          }).catch(() => {});
        }
        // 绑定按钮动作
        $('[data-action]').forEach(el => {
          const name = el.getAttribute('data-action');
          const raw = el.getAttribute('data-payload');
          let payload = undefined;
          try { if (raw) payload = JSON.parse(raw); } catch(_) {}
          el.addEventListener('click', () => postAction(name, payload));
        });

        // 订阅 SSE
        const es = new EventSource('/api/games/current/stream');
        es.addEventListener('hello', (e) => {
          try {
            const data = JSON.parse(e.data);
            merge(state, data.snapshot || {});
            render();
          } catch(_) {}
        });
        es.addEventListener('state', (e) => { try { merge(state, JSON.parse(e.data)); render(); } catch(_){} });
        es.addEventListener('ui', (e) => { try { const d = JSON.parse(e.data); merge(uiFields, d.fields || {}); render(); } catch(_){} });
        es.addEventListener('log', (e) => { try { addLog(JSON.parse(e.data)); } catch(_){} });
      })();
    </script>
  </body>
</html>`;
  },
};

module.exports = demo;
