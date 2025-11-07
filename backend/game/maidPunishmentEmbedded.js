// 女仆偷懒惩罚游戏（嵌入式 HTML + SSE）
// 依据 demoEmbeddedSse.js 的约定实现：title/description/requiredDevices/parameter + start/loop/end/updateParameters/onAction/getHtml

const game = {
  title: '女仆偷懒惩罚（QTZ+电击+TD01）',
  description: '保持踮脚站立；任意按钮按下时电击；长期未电击时启动TD01逐步增强；支持自动锁。',

  // 启动参数（简洁声明）
  parameter: [
    { key: 'duration', type: 'number', name: '游戏时长(分钟)', required: true, default: 10, min: 1, max: 360 },
    { key: 'shockIntensity', type: 'number', name: '电击强度(V)', required: true, default: 24, min: 1, max: 100 },
    { key: 'progressiveIntensity', type: 'boolean', name: '渐进强度', required: false, default: false },
    { key: 'maxIntensityIncrease', type: 'number', name: '最大增幅', required: false, default: 10, min: 0, max: 50 },
    { key: 'allowUnsafeIntensity', type: 'boolean', name: '允许超过30V', required: false, default: false },
    { key: 'td01DelaySeconds', type: 'number', name: 'TD01延时(秒)', required: false, default: 5, min: 1, max: 60 },
    { key: 'td01IntensityIncrease', type: 'number', name: 'TD01每5秒增幅', required: false, default: 50, min: 1, max: 100 },
    { key: 'manualStart', type: 'boolean', name: '手动开启(等待auto_lock按键)', required: false, default: false },
    { key: 'td01ShockProbability', type: 'number', name: 'TD01启动时电击概率(%)', required: false, default: 0, min: 0, max: 100 },
  ],

  requiredDevices: [
    { logicalId: 'auto_lock', name: '自动锁', type: 'ZIDONGSUO', required: false },
    { logicalId: 'shock_device', name: '电击设备', type: 'DIANJI', required: true },
    { logicalId: 'qtz_sensor', name: 'QTZ激光测距+脚踏', type: 'QTZ', required: true },
    { logicalId: 'td01_device', name: 'TD01设备', type: 'TD01', required: false },
  ],

  // 运行时状态
  _rt: {
    startTime: 0,
    isActive: false,
    paused: false,
    isLocked: false,
    waitingForManualStart: false,
    // 传感器/惩罚
    button0Pressed: false,
    button1Pressed: false,
    isShocking: false,
    shockCount: 0,
    lastNoShockTs: 0,
    // TD01
    td01Active: false,
    td01Intensity: 0,
    lastTd01IncreaseTs: 0,
    hasTd01: false,
  },

  // 参数缓存
  _cfg: {
    duration: 10,
    shockIntensity: 24,
    progressiveIntensity: false,
    maxIntensityIncrease: 10,
    allowUnsafeIntensity: false,
    td01DelaySeconds: 5,
    td01IntensityIncrease: 50,
    manualStart: false,
    td01ShockProbability: 0,
  },

  start(dm, parameters) {
    const p = parameters || {};
    for (const k of Object.keys(this._cfg)) {
      if (p[k] !== undefined) this._cfg[k] = p[k];
    }

    this._rt = {
      startTime: Date.now(),
      isActive: !this._cfg.manualStart,
      paused: false,
      isLocked: false,
      waitingForManualStart: !!this._cfg.manualStart,
      button0Pressed: false,
      button1Pressed: false,
      isShocking: false,
      shockCount: 0,
      lastNoShockTs: Date.now(),
      td01Active: false,
      td01Intensity: 0,
      lastTd01IncreaseTs: 0,
      hasTd01: !!dm.deviceMap['td01_device'],
    };

    dm.log('info', '女仆惩罚启动', { cfg: this._cfg });
    dm.emitState({ running: true, startTime: this._rt.startTime, waitingForManualStart: this._rt.waitingForManualStart });
    dm.emitUi({ fields: { statusText: this._rt.waitingForManualStart ? '等待手动开启' : '运行中', btnText: '暂停' } });

    // 监听 QTZ 按钮
    dm.listenDeviceProperty('qtz_sensor', 'button0', (nv) => { this._rt.button0Pressed = (nv === 1); this._onButtonsChanged(dm); });
    dm.listenDeviceProperty('qtz_sensor', 'button1', (nv) => { this._rt.button1Pressed = (nv === 1); this._onButtonsChanged(dm); });

    // 手动开启：监听 auto_lock 按键点击消息
    if (this._cfg.manualStart) {
      dm.listenDeviceMessages('auto_lock', (payload) => {
        if (payload?.method === 'action' && payload?.action === 'key_clicked') {
          this._forceStart(dm);
        }
      });
      // 解锁等待
      this._setLock(dm, true);
    } else {
      // 自动锁定
      this._setLock(dm, false);
    }
  },

  loop(dm) {
    if (this._rt.waitingForManualStart) return true;
    if (!this._rt.isActive) return false;
    if (this._rt.paused) { dm.emitState({ paused: true }); return true; }

    // 时间与结束判断
    const elapsed = Date.now() - this._rt.startTime;
    const total = Math.max(1, Math.floor(this._cfg.duration)) * 60 * 1000;
    const remainingSec = Math.max(0, Math.ceil((total - elapsed) / 1000));
    dm.emitState({ remainingSec });
    if (elapsed >= total) { this.end(dm); return false; }

    // TD01 延迟启动与递增
    if (this._rt.hasTd01 && !this._rt.isShocking) {
      const sinceNoShock = Date.now() - this._rt.lastNoShockTs;
      const needDelay = (this._cfg.td01DelaySeconds || 5) * 1000;
      if (!this._rt.td01Active && sinceNoShock >= needDelay) {
        this._startTd01(dm);
      }
      if (this._rt.td01Active) {
        const now = Date.now();
        if (now - (this._rt.lastTd01IncreaseTs || 0) >= 5000) {
          this._rt.td01Intensity = Math.min(this._rt.td01Intensity + (this._cfg.td01IntensityIncrease || 50), 255);
          dm.setDeviceProperty('td01_device', { power: this._rt.td01Intensity });
          this._rt.lastTd01IncreaseTs = now;
          dm.emitState({ td01Active: true, td01Intensity: this._rt.td01Intensity });
        }
      }
    }

    return true;
  },

  end(dm) {
    this._stopShock(dm);
    this._stopTd01(dm);
    this._setLock(dm, true);
    dm.emitState({ running: false });
    dm.log('info', '女仆惩罚结束', { shockCount: this._rt.shockCount });
  },

  updateParameters(parameters) {
    const p = parameters || {};
    for (const k of Object.keys(this._cfg)) { if (p[k] !== undefined) this._cfg[k] = p[k]; }
  },

  onAction(action, payload, dm) {
    switch (action) {
      case 'pause': {
        this._rt.paused = !this._rt.paused;
        dm.emitState({ paused: this._rt.paused });
        dm.emitUi({ fields: { statusText: this._rt.paused ? '已暂停' : '运行中', btnText: this._rt.paused ? '继续' : '暂停' } });
        return { paused: this._rt.paused };
      }
      case 'forceStart': { this._forceStart(dm); return { started: true }; }
      case 'unlock': { this._setLock(dm, true); return { unlocked: true }; }
      case 'ping': { const ts = Date.now(); dm.emitUi({ fields: { lastPing: new Date(ts).toLocaleTimeString() } }); return { ts }; }
      default:
        throw Object.assign(new Error(`Action not supported: ${action}`), { code: 'GAMEPLAY_ACTION_NOT_SUPPORTED' });
    }
  },

  // ===== 内部逻辑 =====
  _forceStart(dm) {
    if (this._rt.isActive) return;
    this._rt.waitingForManualStart = false;
    this._rt.isActive = true;
    this._rt.startTime = Date.now();
    this._rt.lastNoShockTs = Date.now();
    this._setLock(dm, false);
    dm.emitUi({ fields: { statusText: '运行中' } });
    dm.emitState({ waitingForManualStart: false, running: true });
  },

  _onButtonsChanged(dm) {
    const anyPressed = this._rt.button0Pressed || this._rt.button1Pressed;
    dm.emitState({ button0Pressed: this._rt.button0Pressed, button1Pressed: this._rt.button1Pressed });
    if (anyPressed && !this._rt.isShocking) {
      this._startShock(dm);
      this._resetTd01(dm);
    } else if (!anyPressed && this._rt.isShocking) {
      this._stopShock(dm);
      this._rt.lastNoShockTs = Date.now();
    }
  },

  _calcShockVoltage() {
    let v = this._cfg.shockIntensity || 24;
    if (this._cfg.progressiveIntensity) {
      const inc = Math.min(this._rt.shockCount * 5, this._cfg.maxIntensityIncrease || 0);
      v = Math.min(v + inc, 100);
    }
    if (!this._cfg.allowUnsafeIntensity) v = Math.min(v, 30);
    return v;
  },

  _startShock(dm) {
    if (this._rt.isShocking) return;
    const voltage = this._calcShockVoltage();
    this._rt.isShocking = true;
    this._rt.shockCount += 1;
    dm.setDeviceProperty('shock_device', { voltage, shock: 1 });
    dm.emitState({ isShocking: true, shockCount: this._rt.shockCount, voltage });
    dm.emitUi({ fields: { statusText: `电击中(${voltage}V)` } });
  },

  _stopShock(dm) {
    if (!this._rt.isShocking) return;
    dm.setDeviceProperty('shock_device', { shock: 0 });
    this._rt.isShocking = false;
    dm.emitState({ isShocking: false });
    dm.emitUi({ fields: { statusText: '运行中' } });
  },

  _startTd01(dm) {
    if (!this._rt.hasTd01 || this._rt.td01Active) return;
    this._rt.td01Active = true;
    this._rt.td01Intensity = 10;
    this._rt.lastTd01IncreaseTs = Date.now();
    dm.setDeviceProperty('td01_device', { power: this._rt.td01Intensity });
    dm.emitState({ td01Active: true, td01Intensity: this._rt.td01Intensity });
    // 可选：启动时电击概率
    const prob = Math.max(0, Math.min(100, Number(this._cfg.td01ShockProbability) || 0));
    if (prob > 0 && (Math.random() * 100) < prob) {
      const v = this._calcShockVoltage();
      dm.setDeviceProperty('shock_device', { voltage: v, shock: 1 });
      this._rt.isShocking = true;
      this._rt.shockCount += 1;
      dm.emitState({ isShocking: true, shockCount: this._rt.shockCount, voltage: v });
    }
  },

  _stopTd01(dm) {
    if (!this._rt.td01Active) return;
    dm.setDeviceProperty('td01_device', { power: 0 });
    this._rt.td01Active = false;
    this._rt.td01Intensity = 0;
    dm.emitState({ td01Active: false, td01Intensity: 0 });
  },

  _resetTd01(dm) { this._stopTd01(dm); this._rt.lastNoShockTs = Date.now(); },

  _setLock(dm, isOpen) {
    dm.setDeviceProperty('auto_lock', { open: isOpen ? 1 : 0 });
    this._rt.isLocked = !isOpen;
    dm.emitState({ isLocked: this._rt.isLocked });
    dm.emitUi({ fields: { lockedText: isOpen ? '已解锁' : '已加锁' } });
  },

  // ===== 页面 =====
  getHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>女仆偷懒惩罚</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, "Microsoft YaHei", sans-serif; margin: 0; padding: 16px; }
      header { display:flex; align-items:center; gap:8px; }
      .pill { display:inline-block; padding:2px 8px; border-radius:999px; background:#eee; color:#333; font-size:12px; }
      main { margin-top:16px; display:grid; grid-template-columns:1fr; gap:12px; }
      .card { border:1px solid #ddd; border-radius:8px; padding:12px; }
      .actions { display:flex; gap:8px; }
      button { padding:8px 12px; border-radius:6px; border:1px solid #ccc; background:#fafafa; cursor:pointer; }
      button.primary { background:#2563eb; color:#fff; border-color:#1d4ed8; }
      .ok { color:#16a34a; }
      .warn { color:#f59e0b; }
      .err { color:#dc2626; }
    </style>
  </head>
  <body>
    <header>
      <h2>女仆偷懒惩罚</h2>
      <span class="pill">运行中：<span data-bind="running">false</span></span>
      <span class="pill">开始时间：<span data-bind="startTime">-</span></span>
      <span class="pill">加锁状态：<span data-bind="isLocked">false</span> <span data-bind="lockedText"></span></span>
    </header>
    <main>
      <section class="card">
        <h3>进度</h3>
        <p>剩余秒数：<strong data-bind="remainingSec">-</strong></p>
        <p class="warn" data-bind="statusText">-</p>
        <div class="actions">
          <button class="primary" data-action="pause"><span data-bind="btnText">暂停</span></button>
          <button data-action="forceStart">强制开始</button>
          <button data-action="unlock">解锁</button>
          <button data-action="ping">Ping</button>
        </div>
      </section>
      <section class="card">
        <h3>传感器与惩罚</h3>
        <p>按钮1：<strong data-bind="button0Pressed">false</strong>；按钮2：<strong data-bind="button1Pressed">false</strong></p>
        <p>电击中：<strong data-bind="isShocking">false</strong>；累计电击：<strong data-bind="shockCount">0</strong></p>
        <p>TD01激活：<strong data-bind="td01Active">false</strong>；强度：<strong data-bind="td01Intensity">0</strong></p>
        <p>上次 Ping：<span data-bind="lastPing">-</span></p>
      </section>
      <section class="card">
        <h3>日志（最近10条）</h3>
        <ul id="logs" style="max-height:160px; overflow:auto; margin:0; padding-left:16px;"></ul>
      </section>
    </main>

    <script>
      (function(){
        const state = {};
        const ui = {};
        const $ = (s) => Array.from(document.querySelectorAll(s));
        function render(){
          $('[data-bind]').forEach(el => {
            const k = el.getAttribute('data-bind');
            const v = (k in state) ? state[k] : (k in ui ? ui[k] : el.textContent);
            el.textContent = (v === undefined || v === null) ? '' : String(v);
          });
        }
        function merge(o, p){ Object.assign(o, p || {}); }
        function addLog(item){
          const li = document.createElement('li');
          li.textContent = '[' + new Date(item.ts).toLocaleTimeString() + '] ' + item.level + ' — ' + item.message;
          const ul = document.getElementById('logs');
          ul.insertBefore(li, ul.firstChild);
          while (ul.children.length > 10) ul.removeChild(ul.lastChild);
        }
        function postAction(name, payload){
          return fetch('/api/games/current/actions', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ action:name, payload }) }).catch(()=>{});
        }
        $('[data-action]').forEach(el => {
          const name = el.getAttribute('data-action');
          const raw = el.getAttribute('data-payload');
          let payload = undefined; try { if (raw) payload = JSON.parse(raw); } catch(_){}
          el.addEventListener('click', () => postAction(name, payload));
        });
        const es = new EventSource('/api/games/current/stream');
        es.addEventListener('hello', (e)=>{ try{ const d = JSON.parse(e.data); merge(state, d.snapshot || {}); render(); } catch(_){} });
        es.addEventListener('state', (e)=>{ try{ merge(state, JSON.parse(e.data)); render(); } catch(_){} });
        es.addEventListener('ui', (e)=>{ try{ const d = JSON.parse(e.data); merge(ui, d.fields || {}); render(); } catch(_){} });
        es.addEventListener('log', (e)=>{ try{ addLog(JSON.parse(e.data)); } catch(_){} });
      })();
    </script>
  </body>
</html>`;
  },
};

module.exports = game;