// 气压寸止玩法：基于气压传感器的寸止训练（嵌入式 HTML + SSE）
// 参考：demoEmbeddedSse.js 的接口与事件模型；结合 pressure-edging-game.js 的业务逻辑

const pressureEdging = {
  title: '气压寸止玩法123版',
  description: '基于气压传感器(QIYA)的寸止训练，根据压力与时间窗智能调节 TD01 强度，并在超阈值时触发电击。',

  // 启动前可配置参数（供前端生成配置界面）
  parameter: [
    { key: 'duration', type: 'number', name: '游戏时长(分钟)', required: true, default: 20, min: 1, max: 120 },
    { key: 'criticalPressure', type: 'number', name: '临界气压(kPa)', required: true, default: 20, min: 0, max: 60, step: 0.5 },
    { key: 'maxMotorIntensity', type: 'number', name: 'TD01最大强度(男用td超过50可能会断联，请谨慎设置)', required: true, default: 50, min: 1, max: 255 },
    { key: 'lowPressureDelay', type: 'number', name: '低压延迟(秒)', required: true, default: 5, min: 0, max: 120 },
    { key: 'stimulationRampRateLimit', type: 'number', name: '强度递增速率上限(每秒)', required: true, default: 2, min: 1, max: 10 },
    { key: 'pressureSensitivity', type: 'number', name: '压力敏感度系数', required: true, default: 15, min: 0, max: 20, step: 0.1 },
    { key: 'stimulationRampRandomPercent', type: 'number', name: '强度随机扰动(%)', required: false, default: 0, min: 0, max: 100 },
    { key: 'intensityGradualIncrease', type: 'number', name: '延迟后逐步提升(每秒)', required: false, default: 2, min: 0, max: 20, step: 0.5 },
    { key: 'shockIntensity', type: 'number', name: '电击强度(V)', required: false, default: 20, min: 10, max: 100 },
    { key: 'shockDuration', type: 'number', name: '电击持续(秒)', required: false, default: 3, min: 0.5, max: 50, step: 0.1 },
    { key: 'midPressure', type: 'number', name: '中间(兴奋)压力', required: false, default: 19.2, min: 0, max: 24, step: 0.1 },
  ],

  requiredDevices: [
    { logicalId: 'QIYA_DEVICE', name: '气压传感器', type: 'QIYA', required: true },
    { logicalId: 'TD_DEVICE', name: '偏轴电机控制器', interface: 'strength', required: true },
    { logicalId: 'DIANJI_DEVICE', name: '电击设备', type: 'DIANJI', required: false },
    { logicalId: 'ZIDONGSUO_DEVICE', name: '自动锁', type: 'ZIDONGSUO', required: false },
  ],

  // 玩法运行态（非持久）
  _runtime: {
    // 配置值会在 start 时覆盖
    config: {
      duration: 20,                           //min
      criticalPressure: 20,                   //kPa
      maxMotorIntensity: 200,
      lowPressureDelay: 5,                    //s
      stimulationRampRateLimit: 10,
      pressureSensitivity: 15,                //kPa
      stimulationRampRandomPercent: 0,        //1-100
      intensityGradualIncrease: 2,
      shockIntensity: 20,
      shockDuration: 1,                       //s
      midPressure: 19.2                       //kPa
    },

    // 过程状态
    running: false,
    paused: false,
    startTime: 0,                             //ms
    endTime: 0,                               //ms

    // 传感与强度
    currentPressure: 0,                       //kPa
    maxPressure: 0,                           //kPa
    minPressure: 999,                         //kPa
    averagePressure: 0,                       //kPa
    pressureHistory: [],

    unRandomIntensity: 0,
    targetIntensity: 0,
    currentIntensity: 0,
    midIntensity: 0,
    lastUpdateTs: 0,                          //ms
    prevPressure: 0,


    // 延迟与提升
    isAtStartIntensity: false,
    isInDelayPeriod: false,
    delayStartTime: 0,                        //ms
    isPressureLow: false,

    // 电击
    isShocking: false,
    lastShockTime: 0,                         //ms
    shockCount: 0,
    shockTimer: null,

    // 统计
    totaldeniedTimes:0,
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
    this._runtime.unRandomIntensity = 0;
    this._runtime.targetIntensity = 0;
    this._runtime.currentIntensity = 0;
    this._runtime.midIntensity = 0.5 * this._runtime.config.maxMotorIntensity;
    this._runtime.lastUpdateTs = now;
    this._runtime.prevPressure = 0;
    this._runtime.isPressureLow = true;
    this._runtime.isInDelayPeriod = false;  
    this._runtime.delayStartTime = (-1) * this._runtime.config.lowPressureDelay - 1e-6;
    this._runtime.totaldeniedTimes = 0;
    this._runtime.totalStimulationTime = 0;

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
      criticalPressure: this._runtime.config.criticalPressure,
      midPressure: this._runtime.config.midPressure,
      midIntensity: this._runtime.midIntensity,
      maxMotorIntensity: this._runtime.config.maxMotorIntensity,
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
    
    /*
    添加从UI上读取midPressure、criticalPressure的语句
    this._runtime.config.midPressure = get();
    this._runtime.config.criticalPressure = get();
    */

    const pressure = this._runtime.currentPressure;
    const cfg = this._runtime.config;

    // 到时结束
    if (now >= this._runtime.endTime) {
      this.end(deviceManager);
      return false;
    }

    // 逻辑
    // 低压:当前压力低于临界压力; 超压:当前压力高于临界压力

    // 过载触发：立即归零并进入冷却等待回落
    if (pressure >= cfg.criticalPressure) {
      if (this._runtime.isInDelayPeriod === false) {
        this._triggerShock(deviceManager);
        this._runtime.totaldeniedTimes++;
        deviceManager.emitUi({ fields: { statusText: `过载，等待压力回落…` } });
      }
      this._runtime.isInDelayPeriod = true;
      this._runtime.isPressureLow = false;
      this._runtime.delayStartTime = 0;
      this._runtime.targetIntensity = 0;
    }
    // 在冷却期：等待压力回落至 P_mid 后再开始延迟计时
    else if (this._runtime.isInDelayPeriod) {
      if (this._runtime.delayStartTime <= 0 && pressure < cfg.midPressure) {
        this._runtime.delayStartTime = now;
        this._runtime.isPressureLow = true;
        this._runtime.targetIntensity = 0;
        deviceManager.emitUi({ fields: { statusText: `冷却延迟(${cfg.lowPressureDelay}s)…` } });
      } else if (this._runtime.delayStartTime > 0 && (now - this._runtime.delayStartTime) / 1000 < cfg.lowPressureDelay) {
        this._runtime.targetIntensity = 0;
      } else if (this._runtime.delayStartTime > 0) {
        // 延迟结束，恢复
        const baseTarget = cfg.maxMotorIntensity * (cfg.criticalPressure - pressure) / Math.max(1e-6, (cfg.criticalPressure - cfg.pressureSensitivity));
        this._runtime.targetIntensity = baseTarget;
        this._runtime.unRandomIntensity = baseTarget;
        this._runtime.isAtStartIntensity = true;
        this._runtime.isInDelayPeriod = false;
        deviceManager.emitUi({ fields: { statusText: '强度逐步提升中…' } });
      } else {
        this._runtime.targetIntensity = 0;
      }
    }
    // 正常/恢复阶段
    else{

      // 若之前处于延迟期，结束延迟期，计算初始强度，发送文本
      if(this._runtime.isInDelayPeriod === true){       
        const baseTarget = cfg.maxMotorIntensity * (cfg.criticalPressure - pressure) / Math.max(1e-6, (cfg.criticalPressure-cfg.pressureSensitivity));
        this._runtime.targetIntensity = baseTarget;
        this._runtime.unRandomIntensity = baseTarget;
        this._runtime.isAtStartIntensity = true;
        deviceManager.log('info', `延迟结束，基础强度: ${baseTarget.toFixed(1)}，开始逐步提升`);
        deviceManager.emitUi({ fields: { statusText: '强度逐步提升中…' } });
      }
              
      // 低于中间压力，逐步提升目标强度，应用随机扰动，中间强度实时更新为当前强度 
      else if(pressure <= cfg.midPressure){
        const increaseIntensity = dtSec * (cfg.intensityGradualIncrease || 0);
        this._runtime.unRandomIntensity += increaseIntensity;
        const rnd = 1 + (Math.random() - 0.5) * 2 * (cfg.stimulationRampRandomPercent / 100);
        this._runtime.targetIntensity = Math.min(Math.max(this._runtime.unRandomIntensity * rnd, 0),cfg.maxMotorIntensity);
        }
      
      // 介于中间压力和临界压力之间，
      // 以上方if最后抓取的midIntensity作为midPressure的压力，
      // 将目标强度以当前压力进行以点(midPressure,midIntensity)和点(criticalPressure,0)之间连线的线性映射
      else if(pressure < cfg.criticalPressure){
        if (this._runtime.prevPressure < cfg.midPressure && pressure >= cfg.midPressure) {
          this._runtime.midIntensity = this._runtime.currentIntensity;
        }
        const intensity = this._runtime.midIntensity * ((cfg.criticalPressure - pressure)||0) / Math.max(0.01,(cfg.criticalPressure-cfg.midPressure));
        this._runtime.targetIntensity = Math.min(Math.max(intensity, 0), cfg.maxMotorIntensity);
        }

      //维持非延迟期状态
      this._runtime.isInDelayPeriod = false;
    }

    // 应用速率限制并下发到 TD01
    const maxChange = Math.max(0, cfg.stimulationRampRateLimit) * dtSec;
    const cur = this._runtime.currentIntensity;
    const tgt = this._runtime.targetIntensity;
    let next = cur;
    if (tgt <= cur || this._runtime.isAtStartIntensity) next = tgt; // 延迟期后的初始强度与下降不应受速率限制限制
    else next = Math.min(cur + maxChange, tgt);
    this._runtime.isAtStartIntensity = false;

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
      midPressure: this._runtime.config.midPressure,
      criticalPressure: this._runtime.config.criticalPressure,
      midIntensity: this._runtime.midIntensity,
    });

    this._runtime.prevPressure = pressure;
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
        this._runtime.targetIntensity = Math.min(this._runtime.config.maxMotorIntensity, Math.max(0, this._runtime.targetIntensity + delta));
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
      case 'setThresholds': {
        const mp = Number(payload?.midPressure);
        const cp = Number(payload?.criticalPressure);
        if (!Number.isNaN(mp)) this._runtime.config.midPressure = mp;
        if (!Number.isNaN(cp)) this._runtime.config.criticalPressure = cp;
        deviceManager.emitState({ midPressure: this._runtime.config.midPressure, criticalPressure: this._runtime.config.criticalPressure });
        deviceManager.log('info', '更新阈值', { midPressure: this._runtime.config.midPressure, criticalPressure: this._runtime.config.criticalPressure });
        return { midPressure: this._runtime.config.midPressure, criticalPressure: this._runtime.config.criticalPressure };
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
      :root { --bg:#f5f7fa; --bg2:#ffffff; --card:#ffffff; --text:#1f2937; --muted:#64748b; --border:#e5e7eb; --primary:#3b82f6; --accent:#22d3ee; --ok:#16a34a; --warn:#d97706; --danger:#dc2626; }
      * { box-sizing: border-box; }
      body { margin:0; padding:16px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif; color:var(--text); background: var(--bg); }
      header { display:flex; align-items:center; gap:12px; }
      .title { font-size:20px; margin:0; color:#0f172a; }
      .pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px; background:#f8fafc; color:var(--muted); border:1px solid var(--border); font-size:12px; }
      .pill.ok { color:var(--ok); }
      main { margin-top:12px; display:grid; grid-template-columns:1fr; gap:12px; }
      .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:14px; box-shadow:0 6px 18px rgba(0,0,0,0.06); }
      .section-title { margin:0 0 8px; font-size:16px; color:#0f172a; }
      .stats { display:grid; grid-template-columns:1fr; gap:12px; }
      @media (min-width: 760px) { .stats { grid-template-columns:1fr 1fr; } }
      .stat { background:var(--bg2); border:1px solid var(--border); border-radius:12px; padding:12px; }
      .stat .label { color:var(--muted); font-size:12px; }
      .stat .value { font-weight:700; font-size:26px; color:#0f172a; }
      .progress { height:10px; background:#f1f5f9; border:1px solid var(--border); border-radius:10px; overflow:hidden; margin-top:6px; }
      .bar { height:100%; width:0%; background: linear-gradient(90deg, var(--primary), var(--accent)); transition: width .25s ease; }
      .bar.secondary { background: linear-gradient(90deg, #93c5fd, #a5b4fc); opacity:.55; }
      .actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
      button { padding:10px 14px; border-radius:12px; border:1px solid var(--border); background:#f8fafc; color:#0f172a; cursor:pointer; }
      button.primary { background: linear-gradient(180deg, #60a5fa, #3b82f6); border-color:#3b82f6; color:#fff; }
      button.danger { background: linear-gradient(180deg, #f87171, #dc2626); border-color:#dc2626; color:#fff; }
      .muted { color:var(--muted); }
      .row { display:flex; align-items:center; gap:8px; }
      #logs { list-style:none; margin:0; padding:0; max-height:180px; overflow:auto; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      #logs li { padding:6px 8px; border-bottom:1px solid var(--border); color:#334155; }
      #logs li.l-warn { color:var(--warn); }
      #logs li.l-error { color:#ef4444; }
      .hidden { display:none !important; }
    </style>
  </head>
  <body>
    <header>
      <h2 class="title" data-bind="title">气压寸止玩法</h2>
      <span class="pill"><span class="muted">开始</span> <span data-bind="startTime">-</span></span>
      <span class="pill ok"><span class="muted">状态</span> <span data-bind="running">false</span></span>
    </header>
    <main>
      <section class="card">
        <h3 class="section-title">压力与强度</h3>
        <div class="stats">
          <div class="stat">
            <div class="label">当前压力(kPa)</div>
            <div class="value"><strong data-bind="currentPressure">0</strong></div>
            <div class="progress"><div id="pBar" class="bar"></div></div>
            <div class="label">平均压力(近60点)：<strong data-bind="averagePressure">0</strong></div>
          </div>
          <div class="stat">
            <div class="label">当前强度</div>
            <div class="value"><strong data-bind="currentIntensity">0</strong></div>
            <div class="progress"><div id="iBar" class="bar"></div></div>
            <div class="label">目标强度：<strong data-bind="targetIntensity">0</strong></div>
            <div class="progress"><div id="tBar" class="bar secondary"></div></div>
          </div>
        </div>
        
        <p class="warn" data-show="paused">已暂停</p>
        <div class="actions">
          <button class="primary" data-action="pause"><span data-bind="btnText">暂停</span></button>
          <button data-action="addIntensity" data-payload='{"delta":10}'>目标强度 +10</button>
          <button class="danger" data-action="shockOnce">手动电击</button>
        </div>
      </section>
      <section class="card">
        <h3 class="section-title">动态控制图</h3>
        <canvas id="chart" width="600" height="220" style="width:100%; height:220px; border:1px solid var(--border); border-radius:12px; background:#f8fafc"></canvas>
        <div class="row muted">X=压力，Y=强度；拖拽底部两个点调节 P_mid/P_crit</div>
      </section>
      <section class="card">
        <h3 class="section-title">状态</h3>
        <div class="row"><span class="muted">状态文本</span> <span data-bind="statusText">-</span></div>
        <div class="row"><span class="muted">电击次数</span> <strong data-bind="shockCount">0</strong></div>
        <div class="row"><span class="muted">累计刺激时长</span> <strong data-bind="totalStimulationTime">0</strong> 秒</div>
        <div class="row"><span class="muted">上次 ping</span> <span data-bind="lastPing">-</span></div>
      </section>
      <section class="card">
        <h3 class="section-title">日志（最近 10 条）</h3>
        <ul id="logs"></ul>
      </section>
    </main>
    <script>
      (function(){
        const state = {};
        const uiFields = {};
        const $ = (sel) => Array.from(document.querySelectorAll(sel));
        function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
        let chartXMin = 15;
        let chartXMax = 25;
        function render(){
          $('[data-bind]').forEach(el => {
            const key = el.getAttribute('data-bind');
            let val = (key in state) ? state[key] : (key in uiFields ? uiFields[key] : el.textContent);
            if (key === 'startTime') {
              const num = Number(val);
              if (!Number.isNaN(num) && num > 0) val = new Date(num).toLocaleString();
            }
            if (el.tagName === 'STRONG') {
              const num = Number(val);
              if (!Number.isNaN(num)) val = num.toFixed(2);
            }
            el.textContent = (val === undefined || val === null) ? '' : String(val);
          });
          $('[data-show]').forEach(el => {
            const key = el.getAttribute('data-show');
            const val = !!state[key];
            el.classList.toggle('hidden', !val);
          });
          const c = Number(state.criticalPressure) || 20;
          const m = Number(state.maxMotorIntensity) || 200;
          const cp = clamp((Number(state.currentPressure)||0)/c, 0, 1);
          const ci = clamp((Number(state.currentIntensity)||0)/m, 0, 1);
          const ti = clamp((Number(state.targetIntensity)||0)/m, 0, 1);
          const pBar = document.getElementById('pBar');
          const iBar = document.getElementById('iBar');
          const tBar = document.getElementById('tBar');
          if (pBar) pBar.style.width = (cp*100).toFixed(1)+'%';
          if (iBar) iBar.style.width = (ci*100).toFixed(1)+'%';
          if (tBar) tBar.style.width = (ti*100).toFixed(1)+'%';
          drawChart();
        }
        function merge(obj, patch){ Object.assign(obj, patch || {}); }
        function addLog(item){
          const li = document.createElement('li');
          li.className = 'l-' + (item.level||'info');
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
          let payload = undefined;
          try { if (raw) payload = JSON.parse(raw); } catch(_) {}
          el.addEventListener('click', () => postAction(name, payload));
        });
        const es = new EventSource('/api/games/current/stream');
        es.addEventListener('hello', (e) => { try { const data = JSON.parse(e.data); merge(state, data.snapshot || {}); render(); } catch(_){} });
        es.addEventListener('state', (e) => { try { const d = JSON.parse(e.data); merge(state, d); render(); } catch(_){} });
        es.addEventListener('ui', (e) => { try { const d = JSON.parse(e.data); merge(uiFields, d.fields || {}); render(); } catch(_){} });
        es.addEventListener('log', (e) => { try { addLog(JSON.parse(e.data)); } catch(_){} });
        function drawChart(){
          const el = document.getElementById('chart');
          if (!el) return;
          const dpr = window.devicePixelRatio || 1;
          const w = el.clientWidth, h = el.clientHeight;
          if (el.width !== Math.round(w*dpr)) el.width = Math.round(w*dpr);
          if (el.height !== Math.round(h*dpr)) el.height = Math.round(h*dpr);
          const ctx = el.getContext('2d');
          ctx.setTransform(dpr,0,0,dpr,0,0);
          ctx.clearRect(0,0,w,h);
          const c = Number(state.criticalPressure)||20;
          const mBase = Number(state.maxMotorIntensity)||200;
          const pm = Number(state.midPressure|| (c*0.9));
          const im = Number(state.midIntensity|| (mBase*0.5));
          const pc = Number(state.currentPressure)||0;
          const ic = Number(state.currentIntensity)||0;
          const pad = 28;
          const gx0 = pad, gx1 = w - pad, gy0 = h - pad, gy1 = pad;
          chartXMax = Math.min(35, Math.max(chartXMax, 25, c + 5));
          const desiredMin = Math.max(0, pm - 5);
          if (chartXMin > desiredMin) chartXMin = desiredMin;
          function xOfP(p){
            const pp = Math.max(chartXMin, Math.min(chartXMax, p));
            return gx0 + (gx1-gx0) * ((pp - chartXMin) / Math.max(1e-6, (chartXMax - chartXMin)));
          }
          let m = Math.max(mBase, ic + 20, (Number(state.targetIntensity)||0) + 20, (Number(state.midIntensity)||0) + 10);
          function yOfI(i){ return gy0 - (gy0-gy1) * (Math.max(0, Math.min(m, i)) / Math.max(1e-6, m)); }
          ctx.strokeStyle = '#cbd5e1'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(gx0, gy0); ctx.lineTo(gx1, gy0); ctx.lineTo(gx1, gy1); ctx.stroke();
          const tickN = 5;
          const fmt = (v) => (v % 1 === 0 ? String(v) : v.toFixed(1));
          ctx.fillStyle = '#64748b';
          ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          for (let i = 0; i <= tickN; i++){
            const p = chartXMin + (chartXMax - chartXMin) * i / tickN; const x = xOfP(p);
            ctx.beginPath(); ctx.moveTo(x, gy0); ctx.lineTo(x, gy0+4); ctx.stroke();
            ctx.fillText(fmt(p), x, gy0+6);
          }
          ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
          for (let i = 0; i <= tickN; i++){
            const v = m * i / tickN; const y = yOfI(v);
            ctx.beginPath(); ctx.moveTo(gx0, y); ctx.lineTo(gx0-4, y); ctx.stroke();
            ctx.fillText(fmt(v), gx0-6, y);
          }
          const xMid = xOfP(pm), xCrit = xOfP(c), yMid = yOfI(im);
          const inset = 8;
          const dxMid = Math.max(gx0+inset, Math.min(gx1-inset, xMid));
          const dxCrit = Math.max(gx0+inset, Math.min(gx1-inset, xCrit));
          ctx.fillStyle = 'rgba(59,130,246,0.15)';
          ctx.beginPath(); ctx.moveTo(dxMid, gy0); ctx.lineTo(dxCrit, gy0); ctx.lineTo(dxMid, yMid); ctx.closePath(); ctx.fill();
          ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(dxMid, gy0); ctx.lineTo(dxMid, yMid); ctx.lineTo(dxCrit, gy0); ctx.stroke();
          ctx.fillStyle = '#0ea5e9';
          ctx.beginPath(); ctx.arc(dxMid, gy0, 6, 0, Math.PI*2); ctx.fill();
          ctx.fillStyle = '#f97316';
          ctx.beginPath(); ctx.arc(dxCrit, gy0, 6, 0, Math.PI*2); ctx.fill();
          const xCur = xOfP(pc), yCur = yOfI(ic);
          ctx.fillStyle = '#10b981';
          ctx.beginPath(); ctx.arc(xCur, yCur, 8, 0, Math.PI*2); ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(16,185,129,0.5)'; ctx.stroke();
          const st = String(uiFields.statusText||'');
          let mode = 'NORMAL';
          if (pc >= c) mode = 'OVERLOAD';
          else if (st.indexOf('冷却') !== -1 || st.indexOf('延迟') !== -1) mode = 'DELAY';
          const color = mode === 'OVERLOAD' ? '#ef4444' : (mode === 'DELAY' ? '#f59e0b' : '#10b981');
          ctx.save();
          ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
          const text = mode;
          const tw = ctx.measureText(text).width + 12;
          const th = 20;
          const bx = gx0 + 6, by = gy1 + 6;
          ctx.fillStyle = 'rgba(248,250,252,0.9)';
          ctx.fillRect(bx, by, tw, th);
          ctx.strokeStyle = color; ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, tw, th);
          ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(text, bx + 6, by + th/2);
          ctx.restore();
          let info = document.getElementById('chart-info');
          if (!info) {
            info = document.createElement('div');
            info.id = 'chart-info';
            info.style.marginTop = '6px';
            info.style.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial';
            info.style.color = '#334155';
            el.parentNode.insertBefore(info, el.nextSibling);
          }
          info.textContent = 'midPressure: ' + fmt(pm) + ' | criticalPressure: ' + fmt(c) + ' | midIntensity: ' + fmt(im);
        }
        (function initDrag(){
          const el = document.getElementById('chart'); if(!el) return;
          let dragging = null;
          function nearestHandle(x){
            const c = Number(state.criticalPressure)||20;
            const pm = Number(state.midPressure|| (c*0.9));
            const pad = 28; const w = el.clientWidth; const gx0 = pad, gx1 = w-pad;
            const inset = 8;
            const xMid = gx0 + (gx1-gx0) * ((Math.max(chartXMin, Math.min(chartXMax, pm)) - chartXMin) / Math.max(1e-6, (chartXMax - chartXMin)));
            const xCrit = gx0 + (gx1-gx0) * ((Math.max(chartXMin, Math.min(chartXMax, c)) - chartXMin) / Math.max(1e-6, (chartXMax - chartXMin)));
            const dxMid = Math.max(gx0+inset, Math.min(gx1-inset, xMid));
            const dxCrit = Math.max(gx0+inset, Math.min(gx1-inset, xCrit));
            return (Math.abs(x-dxMid) < Math.abs(x-dxCrit)) ? 'mid' : 'crit';
          }
          function setFromX(which, x){
            const c = Number(state.criticalPressure)||20;
            const pad = 28; const w = el.clientWidth; const gx0 = pad, gx1 = w-pad;
            const p = chartXMin + (x - gx0) / Math.max(1e-6, (gx1-gx0)) * (chartXMax - chartXMin);
            const inset = 8;
            const pInset = inset / Math.max(1e-6, (gx1-gx0)) * (chartXMax - chartXMin);
            const pClamped = Math.max(chartXMin + pInset, Math.min(chartXMax - pInset, p));
            if (which === 'mid') {
              const cp = Number(state.criticalPressure)||c;
              state.midPressure = Math.max(chartXMin + pInset, Math.min(cp-0.1, pClamped));
            } else {
              const mp = Number(state.midPressure)|| (c*0.9);
              const np = Math.max(Math.max(mp+0.1, chartXMin + pInset), Math.min(60, pClamped));
              state.criticalPressure = np;
            }
            render();
          }
          el.addEventListener('mousedown', (e)=>{ const rect = el.getBoundingClientRect(); dragging = nearestHandle(e.clientX - rect.left); });
          window.addEventListener('mousemove', (e)=>{ if(!dragging) return; const rect = el.getBoundingClientRect(); setFromX(dragging, e.clientX - rect.left); });
          window.addEventListener('mouseup', ()=>{
            if(!dragging) return; dragging = null;
            postAction('setThresholds', { midPressure: Number(state.midPressure), criticalPressure: Number(state.criticalPressure) });
          });
        })();
      })();
    </script>
  </body>
</html>`;
  },
};

module.exports = pressureEdging;
