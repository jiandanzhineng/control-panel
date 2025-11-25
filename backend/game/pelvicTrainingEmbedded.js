const pelvicTraining = {
  title: '提肛训练玩法',
  description: '基于气压传感器的提肛训练，放松与提肛阶段交替，未在设定时长内达到气压变化度则电击，否则成功次数+1。',

  parameter: [
    { key: 'duration', type: 'number', name: '游戏时长(分钟)', required: true, default: 20, min: 1, max: 120 },
    { key: 'targetCount', type: 'number', name: '提肛次数目标', required: false, default: 50, min: 1, max: 10000 },
    { key: 'pressureDelta', type: 'number', name: '气压变化度(kPa)', required: true, default: 0.3, min: 0.1, max: 60, step: 0.1 },
    { key: 'shockIntensity', type: 'number', name: '电击强度(V)', required: false, default: 20, min: 10, max: 100 },
    { key: 'shockDuration', type: 'number', name: '电击持续(秒)', required: false, default: 3, min: 0.5, max: 50, step: 0.1 },
    { key: 'cycleTime', type: 'number', name: '单个循环时间(秒)', required: true, default: 10, min: 3, max: 120 }
  ],

  requiredDevices: [
    { logicalId: 'QIYA_DEVICE', name: '气压传感器', type: 'QIYA', required: true },
    { logicalId: 'DIANJI_DEVICE', name: '电击设备', type: 'DIANJI', required: false },
    { logicalId: 'ZIDONGSUO_DEVICE', name: '自动锁', type: 'ZIDONGSUO', required: false },
  ],

  _runtime: {
    config: {
      duration: 20,
      targetCount: 50,
      pressureDelta: 5,
      shockIntensity: 20,
      shockDuration: 3,
      cycleTime: 10,
    },
    running: false,
    paused: false,
    startTime: 0,
    endTime: 0,
    currentPressure: 0,
    phase: 'relax',
    phaseStartTs: 0,
    relaxMinPressure: 0,
    clenchTargetPressure: 0,
    clenchSuccess: false,
    clenchFailed: false,
    successCount: 0,
    shockCount: 0,
    isShocking: false,
    lastUpdateTs: 0,
    shockTimer: null,
  },

  start(deviceManager, parameters) {
    this.updateParameters(parameters);
    const now = Date.now();
    this._runtime.running = true;
    this._runtime.paused = false;
    this._runtime.startTime = now;
    this._runtime.endTime = now + (this._runtime.config.duration * 60 * 1000);
    this._runtime.lastUpdateTs = now;
    this._runtime.phase = 'relax';
    this._runtime.phaseStartTs = now;
    this._runtime.successCount = 0;
    this._runtime.shockCount = 0;
    try { deviceManager.setDeviceProperty('QIYA_DEVICE', { report_delay_ms: 100 }); } catch(_) {}
    try { deviceManager.setDeviceProperty('ZIDONGSUO_DEVICE', { open: 0 }); } catch(_) {}
    try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { voltage: this._runtime.config.shockIntensity, shock: 0 }); } catch(_) {}
    try {
      deviceManager.listenDeviceProperty('QIYA_DEVICE', 'pressure', (newVal) => {
        const p = Number(newVal) || 0;
        this._runtime.currentPressure = p;
        if (this._runtime.phase === 'relax') {
          if (this._runtime.relaxMinPressure === 0) this._runtime.relaxMinPressure = p;
          this._runtime.relaxMinPressure = Math.min(this._runtime.relaxMinPressure, p);
        }
        deviceManager.emitState({ currentPressure: p });
      });
    } catch(_) {}
    try {
      deviceManager.listenDeviceMessages('QIYA_DEVICE', (payload) => {
        const pRaw = payload && payload.data && payload.data.pressure;
        const p = Number(pRaw);
        if (!Number.isNaN(p)) {
          this._runtime.currentPressure = p;
          if (this._runtime.phase === 'relax') {
            if (this._runtime.relaxMinPressure === 0) this._runtime.relaxMinPressure = p;
            this._runtime.relaxMinPressure = Math.min(this._runtime.relaxMinPressure, p);
          }
          deviceManager.emitState({ currentPressure: p });
        }
      });
    } catch(_) {}
    deviceManager.emitState({
      running: true,
      paused: false,
      startTime: this._runtime.startTime,
      currentPressure: this._runtime.currentPressure,
      phase: this._runtime.phase,
      successCount: this._runtime.successCount,
      shockCount: this._runtime.shockCount,
      pressureDelta: this._runtime.config.pressureDelta,
      cycleTime: this._runtime.config.cycleTime,
    });
    deviceManager.emitUi({ fields: { statusText: '准备就绪', btnText: '暂停' } });
  },

  loop(deviceManager) {
    if (!this._runtime.running) return false;
    if (this._runtime.paused) return true;
    const now = Date.now();
    const dtSec = Math.max(0, (now - this._runtime.lastUpdateTs) / 1000);
    this._runtime.lastUpdateTs = now;
    if (now >= this._runtime.endTime) { this.end(deviceManager); return false; }
    const cfg = this._runtime.config;
    const p = this._runtime.currentPressure;
    const elapsed = (now - this._runtime.phaseStartTs) / 1000;
    if (this._runtime.phase === 'relax') {
      if (elapsed >= cfg.cycleTime) {
        this._runtime.phase = 'clench';
        this._runtime.phaseStartTs = now;
        const base = this._runtime.relaxMinPressure || p;
        this._runtime.clenchTargetPressure = base + cfg.pressureDelta;
        this._runtime.clenchSuccess = false;
        this._runtime.clenchFailed = false;
        deviceManager.emitUi({ fields: { statusText: '提肛阶段…' } });
      }
    } else {
      if (!this._runtime.clenchSuccess && p >= this._runtime.clenchTargetPressure) {
        this._runtime.clenchSuccess = true;
      }
      if (elapsed >= cfg.cycleTime) {
        if (this._runtime.clenchSuccess) {
          this._runtime.successCount += 1;
        } else {
          this._runtime.clenchFailed = true;
          this._triggerShock(deviceManager);
        }
        this._runtime.phase = 'relax';
        this._runtime.phaseStartTs = now;
        this._runtime.relaxMinPressure = p;
        this._runtime.clenchSuccess = false;
        deviceManager.emitUi({ fields: { statusText: '放松阶段…' } });
      }
    }
    if (this._runtime.successCount >= (cfg.targetCount || 0)) { this.end(deviceManager); return false; }
    const totalDur = Math.max(1, (this._runtime.endTime - this._runtime.startTime) / 1000);
    const elapsedTotal = Math.max(0, (now - this._runtime.startTime) / 1000);
    const countPct = Math.max(0, Math.min(100, (this._runtime.successCount / Math.max(1, cfg.targetCount)) * 100));
    const timePct = Math.max(0, Math.min(100, (elapsedTotal / totalDur) * 100));
    deviceManager.emitState({
      currentPressure: this._runtime.currentPressure,
      phase: this._runtime.phase,
      successCount: this._runtime.successCount,
      shockCount: this._runtime.shockCount,
      relaxMinPressure: Number((this._runtime.relaxMinPressure || 0).toFixed(2)),
      clenchTargetPressure: Number((this._runtime.clenchTargetPressure || 0).toFixed(2)),
      phaseRemaining: Math.max(0, Number((cfg.cycleTime - elapsed).toFixed(1))),
      clenchSuccess: !!this._runtime.clenchSuccess,
      clenchFailed: !!this._runtime.clenchFailed,
      countProgressPercent: Number(countPct.toFixed(1)),
      timeProgressPercent: Number(timePct.toFixed(1))
    });
    return true;
  },

  end(deviceManager) {
    try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0 }); } catch(_) {}
    try { deviceManager.setDeviceProperty('ZIDONGSUO_DEVICE', { open: 1 }); } catch(_) {}
    try { deviceManager.setDeviceProperty('QIYA_DEVICE', { report_delay_ms: 5000 }); } catch(_) {}
    this._runtime.running = false;
    this._runtime.paused = false;
    if (this._runtime.shockTimer) { clearTimeout(this._runtime.shockTimer); this._runtime.shockTimer = null; }
    deviceManager.emitUi({ fields: { statusText: '已结束', btnText: '暂停' } });
    deviceManager.log('info', '提肛训练结束', { successCount: this._runtime.successCount, shocks: this._runtime.shockCount });
  },

  updateParameters(parameters) {
    const p = parameters || {};
    const cfg = this._runtime.config;
    Object.keys(cfg).forEach((k) => { if (p[k] !== undefined && p[k] !== null) cfg[k] = p[k]; });
  },

  onAction(action, payload, deviceManager) {
    switch (action) {
      case 'pause': {
        this._runtime.paused = !this._runtime.paused;
        deviceManager.emitState({ paused: this._runtime.paused });
        deviceManager.emitUi({ fields: { statusText: this._runtime.paused ? '已暂停' : (this._runtime.phase === 'relax' ? '放松阶段…' : '提肛阶段…'), btnText: this._runtime.paused ? '继续' : '暂停' } });
        deviceManager.log('info', '切换暂停', { paused: this._runtime.paused });
        return { paused: this._runtime.paused };
      }
      case 'shockOnce': {
        this._triggerShock(deviceManager, true);
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

  _triggerShock(deviceManager, force = false) {
    if (!force && this._runtime.isShocking) return;
    const cfg = this._runtime.config;
    try {
      this._runtime.isShocking = true;
      this._runtime.shockCount += 1;
      deviceManager.setDeviceProperty('DIANJI_DEVICE', { voltage: cfg.shockIntensity, shock: 1 });
      if (this._runtime.shockTimer) clearTimeout(this._runtime.shockTimer);
      this._runtime.shockTimer = setTimeout(() => {
        try { deviceManager.setDeviceProperty('DIANJI_DEVICE', { shock: 0 }); } catch(_) {}
        this._runtime.isShocking = false;
      }, Math.max(100, cfg.shockDuration * 1000));
    } catch(_) {
      this._runtime.isShocking = false;
    }
  },

  getHtml() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>提肛训练玩法</title>
    <style>
      :root { --bg:#f6f7fb; --card:#ffffff; --text:#0f172a; --muted:#64748b; --border:#e5e7eb; --primary:#3b82f6; --accent:#22d3ee; --ok:#16a34a; --warn:#d97706; --danger:#dc2626; --deep:#0ea5e9; }
      * { box-sizing:border-box; }
      body { margin:0; padding:16px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif; color:var(--text); background:var(--bg); }
      header { display:flex; align-items:center; gap:12px; }
      .title { font-size:20px; margin:0; color:#0f172a; }
      .pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; background:#f8fafc; color:var(--muted); border:1px solid var(--border); font-size:12px; }
      main { margin-top:12px; display:grid; grid-template-columns:1fr; gap:12px; }
      .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px; box-shadow:0 6px 18px rgba(0,0,0,0.06); }
      .section-title { margin:0 0 8px; font-size:16px; color:#0f172a; }
      .stats { display:grid; grid-template-columns:1fr; gap:12px; }
      @media (min-width: 760px) { .stats { grid-template-columns:1fr 1fr; } }
      .stat { background:#f9fafb; border:1px solid var(--border); border-radius:12px; padding:12px; }
      .label { color:var(--muted); font-size:12px; }
      .value { font-weight:700; font-size:22px; color:#0f172a; display:flex; align-items:center; gap:8px; }
      .achieved { display:inline-block; padding:2px 10px; border-radius:999px; background: linear-gradient(180deg, #22c55e, #16a34a); color:#fff; font-size:22px; font-weight:800; box-shadow:0 4px 12px rgba(22,163,74,0.25); }
      .failed { display:inline-block; padding:2px 10px; border-radius:999px; background: linear-gradient(180deg, #f87171, #dc2626); color:#fff; font-size:22px; font-weight:800; box-shadow:0 4px 12px rgba(220,38,38,0.25); }
      .hero { display:flex; flex-direction:column; gap:6px; padding:16px; border-radius:14px; background:linear-gradient(180deg, #e0f2fe, #bfdbfe); border:1px solid #93c5fd; }
      .hero .stage { font-size:28px; font-weight:800; color:#0c4a6e; }
      .hero .remain { font-size:22px; font-weight:700; color:#0c4a6e; }
      .progress { height:14px; background:#eef2ff; border:1px solid #c7d2fe; border-radius:10px; overflow:hidden; margin-top:6px; }
      .bar { height:100%; width:0%; background: linear-gradient(90deg, var(--primary), var(--deep)); transition: width .25s ease; }
      .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
      button { padding:10px 14px; border-radius:12px; border:1px solid var(--border); background:#f8fafc; color:#0f172a; cursor:pointer; }
      button.primary { background: linear-gradient(180deg, #60a5fa, #3b82f6); border-color:#3b82f6; color:#fff; }
      button.danger { background: linear-gradient(180deg, #f87171, #dc2626); border-color:#dc2626; color:#fff; }
      .muted { color:var(--muted); }
      #logs { list-style:none; margin:0; padding:0; max-height:180px; overflow:auto; font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; }
      #logs li { padding:6px 8px; border-bottom:1px solid var(--border); color:#334155; }
      #logs li.warn { color:var(--warn); }
      #logs li.error { color:#ef4444; }
    </style>
  </head>
  <body>
    <header>
      <h2 class="title" data-bind="title">提肛训练玩法</h2>
      <span class="pill"><span class="muted">开始</span> <span data-bind="startTime">-</span></span>
      <span class="pill"><span class="muted">状态</span> <span data-bind="running">false</span></span>
    </header>
    <main>
      <section class="card hero">
        <div class="stage" id="stageText">当前阶段：-</div>
        <div class="remain">本阶段剩余：<span id="remainText">0</span> 秒</div>
      </section>
      <section class="card">
        <h3 class="section-title">总体进度</h3>
        <div class="label">按次数计算的当前进度百分比</div>
        <div class="progress"><div id="countBar" class="bar"></div></div>
        <div class="label" style="margin-top:8px;">按时间计算的当前进度百分比</div>
        <div class="progress"><div id="timeBar" class="bar"></div></div>
        <div class="stats" style="margin-top:8px;">
          <div class="stat">
            <div class="label">当前压力(kPa)</div>
            <div class="value"><strong data-bind="currentPressure">0</strong></div>
            <div class="label">放松期最低：<strong data-bind="relaxMinPressure">0</strong></div>
          </div>
          <div class="stat">
            <div class="label">提肛目标(kPa)</div>
            <div class="value"><strong data-bind="clenchTargetPressure">0</strong><span class="achieved" data-show="clenchSuccess">已达成</span><span class="failed" data-show="clenchFailed">挑战失败 · 开始电击</span></div>
          </div>
        </div>
        <div class="actions">
          <button class="primary" data-action="pause"><span data-bind="btnText">暂停</span></button>
          <button class="danger" data-action="shockOnce">手动电击</button>
        </div>
      </section>
      <section class="card">
        <h3 class="section-title">统计</h3>
        <div class="label">成功次数：<strong data-bind="successCount">0</strong></div>
        <div class="label">电击次数：<strong data-bind="shockCount">0</strong></div>
        <div class="label">状态文本：<span data-bind="statusText">-</span></div>
        <div class="label">上次 ping：<span data-bind="lastPing">-</span></div>
      </section>
      <section class="card">
        <h3 class="section-title">日志（最近 10 条）</h3>
        <ul id="logs"></ul>
      </section>
    </main>
    <script>
      (function(){
        const state = {}; const uiFields = {}; const $ = (s)=>Array.from(document.querySelectorAll(s));
        function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
        function render(){
          $('[data-bind]').forEach(el=>{ const k=el.getAttribute('data-bind'); let v=(k in state)?state[k]:(k in uiFields?uiFields[k]:el.textContent); if(k==='startTime'){ const n=Number(v); if(!Number.isNaN(n)&&n>0) v=new Date(n).toLocaleString(); } if(el.tagName==='STRONG'){ const n=Number(v); if(!Number.isNaN(n)) v=n.toFixed(2); } el.textContent=(v===undefined||v===null)?'':String(v); });
          const phaseMap = { relax: '放松阶段', clench: '提肛阶段' };
          const stageEl = document.getElementById('stageText');
          const remainEl = document.getElementById('remainText');
          if (stageEl) stageEl.textContent = '当前阶段：' + (phaseMap[state.phase] || '-');
          if (remainEl) remainEl.textContent = String(state.phaseRemaining || 0);
          const cPct = clamp(Number(state.countProgressPercent)||0, 0, 100);
          const tPct = clamp(Number(state.timeProgressPercent)||0, 0, 100);
          const cBar = document.getElementById('countBar'); const tBar = document.getElementById('timeBar');
          if (cBar) cBar.style.width = cPct.toFixed(1)+'%';
          if (tBar) tBar.style.width = tPct.toFixed(1)+'%';
          $('[data-show]').forEach(el=>{ const key=el.getAttribute('data-show'); const show=!!state[key]; el.style.display = show ? '' : 'none'; });
        }
        function merge(o, p){ Object.assign(o, p||{}); }
        function addLog(item){ const li=document.createElement('li'); li.textContent='['+new Date(item.ts).toLocaleTimeString()+'] '+item.level+' — '+item.message; const ul=document.getElementById('logs'); ul.insertBefore(li, ul.firstChild); while(ul.children.length>10) ul.removeChild(ul.lastChild); }
        function postAction(name, payload){ return fetch('/api/games/current/actions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:name, payload }) }).catch(()=>{}); }
        $('[data-action]').forEach(el=>{ const name=el.getAttribute('data-action'); const raw=el.getAttribute('data-payload'); let payload=undefined; try{ if(raw) payload=JSON.parse(raw);}catch(_){} el.addEventListener('click', ()=>postAction(name, payload)); });
        const es=new EventSource('/api/games/current/stream');
        es.addEventListener('hello',(e)=>{ try{ const d=JSON.parse(e.data); merge(state, d.snapshot||{}); render(); }catch(_){} });
        es.addEventListener('state',(e)=>{ try{ const d=JSON.parse(e.data); merge(state, d); render(); }catch(_){} });
        es.addEventListener('ui',(e)=>{ try{ const d=JSON.parse(e.data); merge(uiFields, d.fields||{}); render(); }catch(_){} });
        es.addEventListener('log',(e)=>{ try{ addLog(JSON.parse(e.data)); }catch(_){} });
      })();
    </script>
  </body>
</html>`;
  },
};

module.exports = pelvicTraining;
