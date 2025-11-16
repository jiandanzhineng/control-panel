// 俯卧撑检测训练（嵌入式 HTML + SSE）
// 参考 demoEmbeddedSse.js 接口：title/description/requiredDevices/parameter + start/loop/end/updateParameters/onAction/getHtml

const game = {
  title: '俯卧撑检测训练游戏',
  description: '基于 QTZ 距离阈值检测俯卧撑动作，支持自动锁、电击与跳蛋奖励，嵌入式页面 + SSE。',

  // 启动参数（简洁声明）
  parameter: [
    { key: 'duration', type: 'number', name: '游戏时长(分钟)', required: true, default: 15, min: 1, max: 240 },
    { key: 'targetCount', type: 'number', name: '目标数量(个)', required: true, default: 30, min: 1, max: 2000 },
    { key: 'downThreshold', type: 'number', name: '下降阈值(cm)', required: true, default: 15, min: 1, max: 30 },
    { key: 'upThreshold', type: 'number', name: '上升阈值(cm)', required: true, default: 35, min: 10, max: 50 },
    { key: 'idleTimeLimit', type: 'number', name: '无动作触发惩罚(秒)', required: true, default: 30, min: 5, max: 120 },
    { key: 'shockIntensity', type: 'number', name: '电击强度(V)', required: true, default: 15, min: 10, max: 100 },
    { key: 'shockDuration', type: 'number', name: '电击时长(秒)', required: true, default: 3, min: 1, max: 10 },
    { key: 'randomIntensityRange', type: 'number', name: '强度随机幅度(±)', required: false, default: 10, min: 0, max: 50 },
    { key: 'randomDurationRange', type: 'number', name: '时长随机幅度(±秒)', required: false, default: 1, min: 0, max: 5 },
    { key: 'rewardTriggerCount', type: 'number', name: '奖励触发连击数', required: false, default: 5, min: 1, max: 20 },
    { key: 'rewardTriggerProbability', type: 'number', name: '奖励触发概率(%)', required: false, default: 30, min: 0, max: 100 },
    { key: 'vibratorIntensity', type: 'number', name: '跳蛋强度', required: false, default: 100, min: 0, max: 255 },
    { key: 'vibratorDuration', type: 'number', name: '跳蛋时长(秒)', required: false, default: 15, min: 5, max: 60 },
    { key: 'enableVoice', type: 'boolean', name: '启用语音提示', required: false, default: true },
  ],

  requiredDevices: [
    { logicalId: 'distance_sensor', name: 'QTZ距离传感器', type: 'QTZ', required: true },
    { logicalId: 'auto_lock', name: '自动锁', type: 'ZIDONGSUO', required: false },
    { logicalId: 'shock_device', name: '电击设备', type: 'DIANJI', required: false },
    { logicalId: 'vibrator_device', name: '跳蛋设备', type: 'TD01', required: false },
  ],

  // 运行时状态
  _runtime: {
    startTime: 0,
    running: false,
    paused: false,
    isLocked: false,
    completedCount: 0,
    consecutiveCount: 0,
    currentDistance: 0,
    phase: 'up',
    lastActionTs: 0,
    lastIdleWarnTs: 0,
    shocking: false,
    vibratorOn: false,
    punishmentCount: 0,
    rewardCount: 0,
    targetCount: 30,
    durationMin: 15,
    downThresholdCm: 15,
    upThresholdCm: 35,
    idleLimitSec: 30,
    shockIntensityV: 15,
    shockDurationSec: 3,
    rewardTriggerCount: 5,
    rewardTriggerProbability: 30,
    vibratorIntensity: 100,
    vibratorDurationSec: 15,
    randomIntensityRange: 10,
    randomDurationRange: 1,
  },

  // 计时器句柄
  _timers: {
    shockTimer: null,
    vibratorTimer: null,
  },

  updateParameters(parameters) {
    const p = parameters || {};
    const r = this._runtime;
    if (typeof p.duration === 'number') r.durationMin = p.duration;
    if (typeof p.targetCount === 'number') r.targetCount = p.targetCount;
    if (typeof p.downThreshold === 'number') r.downThresholdCm = p.downThreshold;
    if (typeof p.upThreshold === 'number') r.upThresholdCm = p.upThreshold;
    if (typeof p.idleTimeLimit === 'number') r.idleLimitSec = p.idleTimeLimit;
    if (typeof p.shockIntensity === 'number') r.shockIntensityV = p.shockIntensity;
    if (typeof p.shockDuration === 'number') r.shockDurationSec = p.shockDuration;
    if (typeof p.randomIntensityRange === 'number') r.randomIntensityRange = p.randomIntensityRange;
    if (typeof p.randomDurationRange === 'number') r.randomDurationRange = p.randomDurationRange;
    if (typeof p.rewardTriggerCount === 'number') r.rewardTriggerCount = p.rewardTriggerCount;
    if (typeof p.rewardTriggerProbability === 'number') r.rewardTriggerProbability = p.rewardTriggerProbability;
    if (typeof p.vibratorIntensity === 'number') r.vibratorIntensity = p.vibratorIntensity;
    if (typeof p.vibratorDuration === 'number') r.vibratorDurationSec = p.vibratorDuration;
  },

  start(deviceManager, parameters) {
    this.updateParameters(parameters);
    const r = this._runtime;
    r.startTime = Date.now();
    r.running = true;
    r.paused = false;
    r.completedCount = 0;
    r.consecutiveCount = 0;
    r.phase = 'up';
    r.lastActionTs = Date.now();
    r.lastIdleWarnTs = 0;
    r.shocking = false;
    r.vibratorOn = false;
    r.punishmentCount = 0;
    r.rewardCount = 0;

    deviceManager.log('info', '俯卧撑检测启动', { target: r.targetCount, durationMin: r.durationMin });
    deviceManager.emitState({ running: true, startTime: r.startTime, completedCount: 0, targetCount: r.targetCount });
    deviceManager.emitUi({ fields: { statusText: '准备就绪', btnText: '暂停' } });

    // 设置 QTZ 阈值与上报延迟（cm->mm）
    deviceManager.setDeviceProperty('distance_sensor', {
      low_band: Math.round(r.downThresholdCm * 10),
      high_band: Math.round(r.upThresholdCm * 10),
      report_delay_ms: 500,
    });

    // 监听 QTZ 事件（低/高阈值触发）
    deviceManager.listenDeviceMessages('distance_sensor', (payload) => {
      if (!r.running || r.paused) return;
      const now = Date.now();
      if (payload && payload.method === 'low') {
        if (r.phase === 'up') {
          r.phase = 'down';
          r.lastActionTs = now;
          deviceManager.log('info', '下降阶段');
          deviceManager.emitState({ phase: r.phase, lastActionTs: r.lastActionTs });
        }
      } else if (payload && payload.method === 'high') {
        if (r.phase === 'down') {
          r.phase = 'up';
          r.lastActionTs = now;
          this._onComplete(deviceManager);
        }
      }
    });

    // 距离属性用于 UI 显示（mm->cm）
    deviceManager.listenDeviceProperty('distance_sensor', 'distance', (val) => {
      r.currentDistance = Number(val) ? (Number(val) / 10).toFixed(1) : 0;
      deviceManager.emitState({ currentDistance: r.currentDistance });
    });

    // 可选：锁定
    this._setLock(deviceManager, false);
  },

  loop(deviceManager) {
    const r = this._runtime;
    if (!r.running) return false;

    // 时间与进度
    const elapsedMs = Date.now() - r.startTime;
    const totalMs = r.durationMin * 60 * 1000;
    const remainMs = Math.max(0, totalMs - elapsedMs);
    if (remainMs <= 0) { this.end(deviceManager); return false; }

    const mm = Math.floor(remainMs / 60000);
    const ss = Math.floor((remainMs % 60000) / 1000);
    const idleSec = Math.floor((Date.now() - r.lastActionTs) / 1000);
    const completionRate = r.targetCount > 0 ? Number(((r.completedCount / r.targetCount) * 100).toFixed(1)) : 0;

    deviceManager.emitState({
      remainText: `${mm}:${String(ss).padStart(2, '0')}`,
      idleSec,
      completedCount: r.completedCount,
      targetCount: r.targetCount,
      completionRate,
      shocking: r.shocking,
      vibratorOn: r.vibratorOn,
    });

    // 无动作惩罚检测
    if (!r.paused && !r.shocking && idleSec >= r.idleLimitSec) {
      this._triggerPunishment(deviceManager);
    } else if (!r.shocking && idleSec >= r.idleLimitSec - 5) {
      const now = Date.now();
      if (now - r.lastIdleWarnTs > 5000) {
        r.lastIdleWarnTs = now;
        deviceManager.log('warn', `还有 ${Math.max(0, r.idleLimitSec - idleSec)} 秒将触发惩罚`);
        deviceManager.emitUi({ fields: { statusText: '警告：快动起来！' } });
      }
    }

    return true;
  },

  end(deviceManager) {
    const r = this._runtime;
    if (!r.running) return;
    r.running = false;

    // 清理计时器
    try { if (this._timers.shockTimer) clearTimeout(this._timers.shockTimer); } catch (_) {}
    try { if (this._timers.vibratorTimer) clearTimeout(this._timers.vibratorTimer); } catch (_) {}
    this._timers.shockTimer = null;
    this._timers.vibratorTimer = null;

    // 设备复位
    deviceManager.setDeviceProperty('shock_device', { shock: 0 });
    deviceManager.setDeviceProperty('vibrator_device', { power: 0 });
    deviceManager.setDeviceProperty('distance_sensor', { report_delay_ms: 10000 });
    this._setLock(deviceManager, true);

    deviceManager.emitUi({ fields: { statusText: '训练结束', btnText: '暂停' } });
    deviceManager.log('info', `完成 ${r.completedCount}/${r.targetCount} 个，惩罚 ${r.punishmentCount} 次，奖励 ${r.rewardCount} 次`);
  },

  onAction(action, payload, deviceManager) {
    const r = this._runtime;
    switch (action) {
      case 'pause': {
        r.paused = !r.paused;
        deviceManager.emitState({ paused: r.paused });
        deviceManager.emitUi({ fields: { statusText: r.paused ? '已暂停' : '运行中', btnText: r.paused ? '继续' : '暂停' } });
        return { paused: r.paused };
      }
      default:
        throw Object.assign(new Error(`Action not supported: ${action}`), { code: 'GAMEPLAY_ACTION_NOT_SUPPORTED' });
    }
  },

  // 完成一次俯卧撑
  _onComplete(deviceManager) {
    const r = this._runtime;
    r.completedCount += 1;
    r.consecutiveCount += 1;
    deviceManager.emitState({ completedCount: r.completedCount, phase: r.phase, lastActionTs: r.lastActionTs });
    deviceManager.log('info', `完成 ${r.completedCount}/${r.targetCount}`);

    // 达成目标
    if (r.completedCount >= r.targetCount) {
      this.end(deviceManager);
      deviceManager.log('success', '目标完成，训练结束');
      return;
    }

    // 奖励触发
    if (r.consecutiveCount >= r.rewardTriggerCount) {
      const rand = Math.random() * 100;
      if (rand < r.rewardTriggerProbability) {
        this._triggerReward(deviceManager);
      }
    }
  },

  _triggerReward(deviceManager) {
    const r = this._runtime;
    if (r.vibratorOn) return;
    r.vibratorOn = true;
    r.rewardCount += 1;
    deviceManager.log('warn', `奖励干扰 开始 强度=${r.vibratorIntensity} 时长=${r.vibratorDurationSec}s`);
    deviceManager.setDeviceProperty('vibrator_device', { power: r.vibratorIntensity });
    this._timers.vibratorTimer = setTimeout(() => {
      this._stopVibrator(deviceManager);
    }, Math.max(1, r.vibratorDurationSec) * 1000);
  },

  _stopVibrator(deviceManager) {
    const r = this._runtime;
    if (!r.vibratorOn) return;
    r.vibratorOn = false;
    deviceManager.setDeviceProperty('vibrator_device', { power: 0 });
    try { if (this._timers.vibratorTimer) clearTimeout(this._timers.vibratorTimer); } catch (_) {}
    this._timers.vibratorTimer = null;
    deviceManager.log('info', '奖励干扰停止');
  },

  _triggerPunishment(deviceManager) {
    const r = this._runtime;
    if (r.shocking) return;
    r.consecutiveCount = 0;
    r.punishmentCount += 1;

    // 随机强度/时长
    const iv = (Math.random() - 0.5) * 2 * r.randomIntensityRange;
    const dv = (Math.random() - 0.5) * 2 * r.randomDurationRange;
    const intensity = Math.max(10, Math.min(100, r.shockIntensityV + iv));
    const duration = Math.max(1, Math.min(10, r.shockDurationSec + dv));

    r.shocking = true;
    r.lastActionTs = Date.now();
    deviceManager.log('error', `惩罚 电压=${intensity.toFixed(1)}V 时长=${duration.toFixed(1)}s`);
    deviceManager.setDeviceProperty('shock_device', { voltage: Math.round(intensity), shock: 1 });
    this._timers.shockTimer = setTimeout(() => { this._stopShock(deviceManager); }, Math.round(duration * 1000));
  },

  _stopShock(deviceManager) {
    const r = this._runtime;
    if (!r.shocking) return;
    r.shocking = false;
    deviceManager.setDeviceProperty('shock_device', { shock: 0 });
    try { if (this._timers.shockTimer) clearTimeout(this._timers.shockTimer); } catch (_) {}
    this._timers.shockTimer = null;
    deviceManager.log('info', '惩罚停止');
  },

  _setLock(deviceManager, open) {
    // open=true 解锁；false 锁定
    deviceManager.setDeviceProperty('auto_lock', { open: open ? 1 : 0 });
    this._runtime.isLocked = !open;
    deviceManager.emitState({ isLocked: this._runtime.isLocked });
  },

  getHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>俯卧撑检测训练</title>
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
      .err { color: #ef4444; }
      @media (max-width: 768px) {
        body { padding: 0; }
        main { margin-top: 8px; }
        .card { border-radius: 0; }
      }
    </style>
  </head>
  <body>
    <header>
      <h2>俯卧撑检测训练</h2>
      <span class="pill">运行中：<span data-bind="running">false</span></span>
      <span class="pill">开始时间：<span data-bind="startTime">-</span></span>
      <span class="pill">剩余：<span data-bind="remainText">-</span></span>
    </header>
    <main>
      <section class="card">
        <h3>进度</h3>
        <p>已完成：<strong data-bind="completedCount">0</strong> / <span data-bind="targetCount">0</span>（<span data-bind="completionRate">0</span>%）</p>
        <p>当前阶段：<span data-bind="phase">-</span></p>
        <p>当前距离：<span data-bind="currentDistance">0</span> cm</p>
        <p class="warn">无动作：<span data-bind="idleSec">0</span> 秒</p>
        <div class="actions">
          <button class="primary" data-action="pause"><span data-bind="btnText">暂停</span></button>
        </div>
      </section>
      <section class="card">
        <h3>设备状态</h3>
        <p>自动锁：<span data-bind="isLocked">false</span></p>
        <p class="err" data-class="shocking:err">电击中：<span data-bind="shocking">false</span></p>
        <p class="warn" data-class="vibratorOn:warn">跳蛋工作：<span data-bind="vibratorOn">false</span></p>
        <p>惩罚次数：<span data-bind="punishmentCount">0</span>，奖励次数：<span data-bind="rewardCount">0</span></p>
      </section>
      <section class="card">
        <h3>日志（最近 10 条）</h3>
        <ul id="logs" style="max-height:160px; overflow:auto; margin:0; padding-left:16px;"></ul>
      </section>
      <section class="card">
        <h3>提示</h3>
        <p><span data-bind="statusText">-</span></p>
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
            const val = (key in state) ? state[key] : (key in uiFields ? uiFields[key] : el.textContent);
            el.textContent = (val === undefined || val === null) ? '' : String(val);
          });
          $('[data-class]').forEach(el => {
            const raw = el.getAttribute('data-class') || '';
            const m = raw.match(/\s*([^:]+)\s*:\s*(.+)\s*/);
            if (!m) return;
            const key = m[1]; const cls = m[2];
            el.classList.toggle(cls, !!state[key]);
          });
        }
        function merge(obj, patch){ Object.assign(obj, patch || {}); }
        function addLog(item){
          const li = document.createElement('li');
          li.textContent = '[' + new Date(item.ts).toLocaleTimeString() + '] ' + item.level + ' — ' + item.message;
          const ul = document.getElementById('logs');
          ul.insertBefore(li, ul.firstChild);
          while (ul.children.length > 10) ul.removeChild(ul.lastChild);
        }
        function postAction(name, payload){
          return fetch('/api/games/current/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: name, payload }) }).catch(()=>{});
        }
        $('[data-action]').forEach(el => {
          const name = el.getAttribute('data-action');
          const raw = el.getAttribute('data-payload');
          let payload = undefined; try { if (raw) payload = JSON.parse(raw); } catch(_) {}
          el.addEventListener('click', () => postAction(name, payload));
        });
        const es = new EventSource('/api/games/current/stream');
        es.addEventListener('hello', (e) => { try { const d = JSON.parse(e.data); merge(state, d.snapshot || {}); render(); } catch(_){} });
        es.addEventListener('state', (e) => { try { merge(state, JSON.parse(e.data)); render(); } catch(_){} });
        es.addEventListener('ui', (e) => { try { const d = JSON.parse(e.data); merge(uiFields, d.fields || {}); render(); } catch(_){} });
        es.addEventListener('log', (e) => { try { addLog(JSON.parse(e.data)); } catch(_){} });
      })();
    </script>
  </body>
</html>`;
  },
};

module.exports = game;
