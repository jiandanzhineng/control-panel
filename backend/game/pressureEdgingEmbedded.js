// 气压寸止玩法：基于气压传感器的寸止训练（嵌入式 HTML + SSE）
// 参考：demoEmbeddedSse.js 的接口与事件模型；结合 pressure-edging-game.js 的业务逻辑

const pressureEdging = {
  title: '气压寸止玩法',
  description: '基于气压传感器(QIYA)的寸止训练，根据压力与时间窗智能调节 TD01 强度，并在超阈值时触发电击。',

  // 启动前可配置参数（供前端生成配置界面）
  parameter: [
    { key: 'duration', type: 'number', name: '游戏时长(分钟)', required: true, default: 20, min: 1, max: 120 },
    { key: 'criticalPressure', type: 'number', name: '临界气压(kPa)', required: true, default: 20, min: 0, max: 60, step: 0.5 },
    { key: 'maxMotorIntensity', type: 'number', name: 'TD01最大强度', required: true, default: 255, min: 1, max: 255 },
    { key: 'lowPressureDelay', type: 'number', name: '低压延迟(秒)', required: true, default: 5, min: 0, max: 120 },
    { key: 'stimulationRampRateLimit', type: 'number', name: '强度递增速率上限(每秒)', required: true, default: 2, min: 1, max: 50 },
    { key: 'pressureSensitivity', type: 'number', name: '压力敏感度系数', required: true, default: 1.0, min: 0.1, max: 5.0, step: 0.1 },
    { key: 'stimulationRampRandomPercent', type: 'number', name: '强度随机扰动(%)', required: false, default: 0, min: 0, max: 100 },
    { key: 'intensityGradualIncrease', type: 'number', name: '延迟后逐步提升(每秒)', required: false, default: 2, min: 0, max: 20, step: 0.5 },
    { key: 'shockIntensity', type: 'number', name: '电击强度(V)', required: false, default: 20, min: 10, max: 100 },
    { key: 'shockDuration', type: 'number', name: '电击持续(秒)', required: false, default: 3, min: 0.5, max: 50, step: 0.1 },
  ],

  requiredDevices: [
    { logicalId: 'QIYA_DEVICE', name: '气压传感器', type: 'QIYA', required: true },
    { logicalId: 'TD_DEVICE', name: '偏轴电机控制器', type: 'TD01', required: true },
    { logicalId: 'DIANJI_DEVICE', name: '电击设备', type: 'DIANJI', required: false },
    { logicalId: 'ZIDONGSUO_DEVICE', name: '自动锁', type: 'ZIDONGSUO', required: false },
  ],

  // 玩法运行态（非持久）
  _runtime: {
    // 配置值会在 start 时覆盖
    config: {
      duration: 20,
      criticalPressure: 20,
      maxMotorIntensity: 200,
      lowPressureDelay: 5,
      stimulationRampRateLimit: 10,
      pressureSensitivity: 1.0,
      stimulationRampRandomPercent: 0,
      intensityGradualIncrease: 2,
      shockIntensity: 20,
      shockDuration: 1,
    },

    // 过程状态
    running: false,
    paused: false,
    startTime: 0,
    endTime: 0,

    // 传感与强度
    currentPressure: 0,
    maxPressure: 0,
    minPressure: 999,
    averagePressure: 0,
    pressureHistory: [],

    targetIntensity: 0,
    currentIntensity: 0,
    lastUpdateTs: 0,

    // 延迟与提升
    isInDelayPeriod: false,
    delayStartTime: 0,
    baseIntensity: 0,
    intensityIncreaseStartTime: 0,

    // 电击
    isShocking: false,
    lastShockTime: 0,
    shockCount: 0,
    shockTimer: null,

    // 统计
    totalStimulationTime: 0,
  },

  start(deviceManager, parameters) {
    // 合并参数
    this.updateParameters(parameters);

    const now = Date.now();
    this._runtime.running = true;
    this._runtime.paused = false;
    this._runtime.startTime = now;
    this._runtime.endTime = now + (this._runtime.config.duration * 60 * 1000);
    this._runtime.lastUpdateTs = now;

    // 初始化设备状态
    try {
      // 加快气压上报以提升响应
      deviceManager.setDeviceProperty('QIYA_DEVICE', { report_delay_ms: 100 });
      // 电机归零
      deviceManager.setDeviceProperty('TD_DEVICE', { power: 0 });
      // 自动锁（若存在）上锁
      deviceManager.setDeviceProperty('ZIDONGSUO_DEVICE', { open: 0 });
      // 电击设备预设电压
      deviceManager.setDeviceProperty('DIANJI_DEVICE', { voltage: this._runtime.config.shockIntensity, shock: 0 });
    } catch (e) {
      deviceManager.log('warn', '初始化设备状态失败', { error: e?.message || String(e) });
    }

    // 监听气压传感属性
    try {
      deviceManager.listenDeviceProperty('QIYA_DEVICE', 'pressure', (newVal, oldVal, ctx) => {
        const p = Number(newVal) || 0;
        this._runtime.currentPressure = p;
        // 压力统计
        this._runtime.maxPressure = Math.max(this._runtime.maxPressure, p);
        this._runtime.minPressure = Math.min(this._runtime.minPressure, p);
        // 历史与均值（最近 60 点）
        const nowTs = Date.now();
        this._runtime.pressureHistory.push({ ts: nowTs, pressure: p });
        const recent = this._runtime.pressureHistory.slice(-60);
        const sum = recent.reduce((acc, it) => acc + (Number(it.pressure) || 0), 0);
        this._runtime.averagePressure = recent.length ? (sum / recent.length) : p;
        // 将最新压力发给 UI
        deviceManager.emitState({ currentPressure: p, averagePressure: this._runtime.averagePressure });
      });
      deviceManager.log('debug', '已注册 QIYA 压力属性监听', { logicalId: 'QIYA_DEVICE', prop: 'pressure' });
    } catch (e) {
      deviceManager.log('warn', '注册 QIYA 压力属性监听失败', { error: e?.message || String(e) });
    }

    // 监听气压设备的所有 MQTT 消息（调试日志）
    try {
      deviceManager.listenDeviceMessages('QIYA_DEVICE', (payload, ctx) => {
        // 兼容部分设备直接在 report.data 中给出 pressure 的情况
        const pRaw = payload && payload.data && payload.data.pressure;
        const p = Number(pRaw);
        if (!Number.isNaN(p)) {
          this._runtime.currentPressure = p;
          // 同步统计与历史
          this._runtime.maxPressure = Math.max(this._runtime.maxPressure, p);
          this._runtime.minPressure = Math.min(this._runtime.minPressure, p);
          const nowTs = Date.now();
          this._runtime.pressureHistory.push({ ts: nowTs, pressure: p });
          const recent = this._runtime.pressureHistory.slice(-60);
          const sum = recent.reduce((acc, it) => acc + (Number(it.pressure) || 0), 0);
          this._runtime.averagePressure = recent.length ? (sum / recent.length) : p;
          deviceManager.emitState({ currentPressure: p, averagePressure: this._runtime.averagePressure });
        }
        // let brief = '';
        // try { brief = JSON.stringify(payload); } catch (_) { brief = String(payload); }
        // if (brief && brief.length > 200) brief = brief.slice(0, 200) + '…';
        // deviceManager.log('info', `接收 QIYA 设备 MQTT: ${brief}`, { logicalId: ctx?.logicalId, deviceId: ctx?.deviceId, topic: ctx?.topic });
      });
    } catch (e) {
      deviceManager.log('warn', '注册 QIYA MQTT 监听失败', { error: e?.message || String(e) });
    }

    // 向 UI 发送初始快照
    deviceManager.emitState({
      running: true,
      paused: false,
      startTime: new Date(this._runtime.startTime).toLocaleString(),
      currentPressure: this._runtime.currentPressure,
      currentIntensity: this._runtime.currentIntensity,
      targetIntensity: this._runtime.targetIntensity,
      shockCount: this._runtime.shockCount,
    });
    deviceManager.emitUi({ fields: { statusText: '准备就绪', btnText: '暂停' } });
  },

  // 主循环：计算目标强度、应用速率限制并下发到 TD01；超压触发电击
  loop(deviceManager) {
    if (!this._runtime.running) return false;
    if (this._runtime.paused) return true;

    const now = Date.now();
    const dtSec = Math.max(0, (now - this._runtime.lastUpdateTs) / 1000);
    this._runtime.lastUpdateTs = now;

    // 到时结束
    if (now >= this._runtime.endTime) {
      this.end(deviceManager);
      return false;
    }

    const cfg = this._runtime.config;
    const pressure = this._runtime.currentPressure;

    if (pressure >= cfg.criticalPressure) {
      // 超压：停止刺激并触发电击
      this._runtime.targetIntensity = 0;
      this._runtime.isInDelayPeriod = false;
      this._runtime.baseIntensity = 0;
      this._runtime.intensityIncreaseStartTime = 0;
      this._triggerShock(deviceManager);
    } else {
      // 低压：延迟期 + 逐步提升
      const pressureDiff = cfg.criticalPressure - pressure;
      const normalizedDiff = pressureDiff / Math.max(1e-6, cfg.criticalPressure);

      if (!this._runtime.isInDelayPeriod) {
        this._runtime.isInDelayPeriod = true;
        this._runtime.delayStartTime = now;
        this._runtime.targetIntensity = 0;
        this._runtime.baseIntensity = 0;
        this._runtime.intensityIncreaseStartTime = 0;
        deviceManager.log('info', `压力低于临界值，开始延迟 ${cfg.lowPressureDelay}s`);
        deviceManager.emitUi({ fields: { statusText: `延迟期中(${cfg.lowPressureDelay}s)…` } });
      } else {
        const delayElapsed = (now - this._runtime.delayStartTime) / 1000;
        if (delayElapsed >= cfg.lowPressureDelay) {
          const baseTarget = normalizedDiff * cfg.maxMotorIntensity * cfg.pressureSensitivity;
          if (this._runtime.intensityIncreaseStartTime === 0) {
            this._runtime.baseIntensity = baseTarget;
            this._runtime.intensityIncreaseStartTime = now;
            deviceManager.log('info', `延迟结束，基础强度: ${baseTarget.toFixed(1)}，开始逐步提升`);
            deviceManager.emitUi({ fields: { statusText: '强度逐步提升中…' } });
          }
          const incElapsed = (now - this._runtime.intensityIncreaseStartTime) / 1000;
          let target = (this._runtime.baseIntensity || 0) + incElapsed * (cfg.intensityGradualIncrease || 0);
          // 随机扰动
          if (cfg.stimulationRampRandomPercent > 0) {
            const rnd = 1 + (Math.random() - 0.5) * 2 * (cfg.stimulationRampRandomPercent / 100);
            target *= rnd;
          }
          this._runtime.targetIntensity = Math.min(Math.max(target, 0), cfg.maxMotorIntensity);
        }
      }
    }

    // 应用速率限制并下发到 TD01
    const maxChange = Math.max(0, cfg.stimulationRampRateLimit) * dtSec;
    const cur = this._runtime.currentIntensity;
    const tgt = this._runtime.targetIntensity;
    let next = cur;
    if (tgt > cur) next = Math.min(cur + maxChange, tgt);
    else next = tgt; // 下降不限制

    // 下发到设备
    try {
      const rounded = Math.round(next);
      if (!Number.isNaN(rounded)) {
        deviceManager.setDeviceProperty('TD_DEVICE', { power: rounded });
        this._runtime.currentIntensity = rounded;
      }
    } catch (e) {
      deviceManager.log('warn', '设置 TD_DEVICE power 失败', { error: e?.message || String(e) });
    }

    // 统计刺激时间
    if (this._runtime.currentIntensity > 0) {
      this._runtime.totalStimulationTime += dtSec;
    }

    // 推送状态
    deviceManager.emitState({
      currentPressure: this._runtime.currentPressure,
      currentIntensity: this._runtime.currentIntensity,
      targetIntensity: this._runtime.targetIntensity,
      shockCount: this._runtime.shockCount,
      totalStimulationTime: Number(this._runtime.totalStimulationTime.toFixed(1)),
    });

    return true;
  },

  end(deviceManager) {
    // 结束前复位设备
    try { deviceManager.setDeviceProperty('TD_DEVICE', { power: 0 }); } catch(_) {}
    try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0 }); } catch(_) {}
    try { deviceManager.setDeviceProperty('ZIDONGSUO_DEVICE', { open: 1 }); } catch(_) {}
    // 恢复气压上报速率
    try { deviceManager.setDeviceProperty('QIYA_DEVICE', { report_delay_ms: 5000 }); } catch(_) {}

    // 关闭内部状态
    this._runtime.running = false;
    this._runtime.paused = false;
    if (this._runtime.shockTimer) {
      clearTimeout(this._runtime.shockTimer);
      this._runtime.shockTimer = null;
    }

    deviceManager.emitUi({ fields: { statusText: '已结束', btnText: '暂停' } });
    deviceManager.log('info', '气压寸止玩法结束', { finalIntensity: this._runtime.currentIntensity, shocks: this._runtime.shockCount });
  },

  updateParameters(parameters) {
    const p = parameters || {};
    const cfg = this._runtime.config;
    Object.keys(cfg).forEach((k) => {
      if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k];
    });
  },

  onAction(action, payload, deviceManager) {
    switch (action) {
      case 'pause': {
        this._runtime.paused = !this._runtime.paused;
        deviceManager.emitState({ paused: this._runtime.paused });
        deviceManager.emitUi({ fields: { statusText: this._runtime.paused ? '已暂停' : '运行中', btnText: this._runtime.paused ? '继续' : '暂停' } });
        deviceManager.log('info', '切换暂停', { paused: this._runtime.paused });
        return { paused: this._runtime.paused };
      }
      case 'addIntensity': {
        const delta = typeof payload?.delta === 'number' ? payload.delta : 10;
        this._runtime.targetIntensity = Math.min(this._runtime._maxMotorIntensity || this._runtime.config.maxMotorIntensity, Math.max(0, this._runtime.targetIntensity + delta));
        deviceManager.emitState({ targetIntensity: this._runtime.targetIntensity });
        deviceManager.log('info', '手动调整目标强度', { delta, target: this._runtime.targetIntensity });
        return { targetIntensity: this._runtime.targetIntensity };
      }
      case 'shockOnce': {
        this._triggerShock(deviceManager, /*force*/true);
        return { shocked: true };
      }
      case 'ping': {
        const ts = Date.now();
        deviceManager.log('debug', 'UI ping', { ts, payload });
        deviceManager.emitUi({ fields: { lastPing: new Date(ts).toLocaleTimeString() } });
        return { ts };
      }
      default:
        throw Object.assign(new Error(`Action not supported: ${action}`), { code: 'GAMEPLAY_ACTION_NOT_SUPPORTED' });
    }
  },

  // 触发电击（内部）
  _triggerShock(deviceManager, force = false) {
    const cfg = this._runtime.config;
    if (!force && this._runtime.isShocking) return;
    try {
      this._runtime.isShocking = true;
      this._runtime.lastShockTime = Date.now();
      this._runtime.shockCount += 1;
      deviceManager.log('warn', `触发电击 — ${cfg.shockIntensity}V / ${cfg.shockDuration}s`);
      deviceManager.setDeviceProperty('DIANJI_DEVICE', { voltage: cfg.shockIntensity, shock: 1 });
      if (this._runtime.shockTimer) clearTimeout(this._runtime.shockTimer);
      this._runtime.shockTimer = setTimeout(() => {
        try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0 }); } catch(_) {}
        this._runtime.isShocking = false;
        deviceManager.log('info', '电击结束');
      }, Math.max(100, cfg.shockDuration * 1000));
    } catch (e) {
      this._runtime.isShocking = false;
      deviceManager.log('error', '触发电击失败', { error: e?.message || String(e) });
    }
  },

  getHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>气压寸止玩法</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial, "Noto Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; margin: 0; padding: 8px; }
      header { display: flex; align-items: center; gap: 6px; }
      .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #eee; color: #333; font-size: 12px; }
      main { margin-top: 8px; display: grid; grid-template-columns: 1fr; gap: 8px; }
      .card { border: 1px solid #ddd; border-radius: 8px; padding: 8px; }
      .actions { display: flex; gap: 6px; }
      button { padding: 6px 10px; border-radius: 6px; border: 1px solid #ccc; background: #fafafa; cursor: pointer; }
      button.primary { background: #2563eb; color: white; border-color: #1d4ed8; }
      .hidden { display: none !important; }
      .ok { color: #16a34a; }
      .warn { color: #f59e0b; }
    </style>
  </head>
  <body>
    <header>
      <h2 data-bind="title">气压寸止玩法</h2>
      <span class="pill">运行中：<span data-bind="running">false</span></span>
      <span class="pill">开始时间：<span data-bind="startTime">-</span></span>
    </header>
    <main>
      <section class="card">
        <h3>压力与强度</h3>
        <p>当前压力：<strong data-bind="currentPressure">0</strong> kPa</p>
        <p>平均压力(近60点)：<strong data-bind="averagePressure">0</strong> kPa</p>
        <p>当前强度：<strong data-bind="currentIntensity">0</strong></p>
        <p>目标强度：<strong data-bind="targetIntensity">0</strong></p>
        <p class="warn" data-show="paused">已暂停</p>
        <div class="actions">
          <button class="primary" data-action="pause"><span data-bind="btnText">暂停</span></button>
          <button data-action="addIntensity" data-payload='{"delta":10}'>目标强度 +10</button>
          <button data-action="shockOnce">手动电击</button>
          <button data-action="ping">Ping</button>
        </div>
      </section>
      <section class="card">
        <h3>状态</h3>
        <p>状态文本：<span data-bind="statusText">-</span></p>
        <p>电击次数：<strong data-bind="shockCount">0</strong></p>
        <p>累计刺激时长：<strong data-bind="totalStimulationTime">0</strong> 秒</p>
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
          $('[data-bind]').forEach(el => {
            const key = el.getAttribute('data-bind');
            let val = (key in state) ? state[key] : (key in uiFields ? uiFields[key] : el.textContent);
            if (key === 'startTime') {
              const num = Number(val);
              if (!Number.isNaN(num) && num > 0) {
                val = new Date(num).toLocaleString();
              }
            }
            if (el.tagName === 'STRONG') {
              const num = Number(val);
              if (!Number.isNaN(num)) {
                val = num.toFixed(2);
              }
            }
            el.textContent = (val === undefined || val === null) ? '' : String(val);
          });
          $('[data-show]').forEach(el => {
            const key = el.getAttribute('data-show');
            const val = !!state[key];
            el.classList.toggle('hidden', !val);
          });
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

module.exports = pressureEdging;