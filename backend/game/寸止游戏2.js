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
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<title>气压寸止</title>
<style>
  :root{--bg:#f8fafc;--card:#fff;--text:#1e293b;--sub:#64748b;--border:#e2e8f0;--primary:#3b82f6;--danger:#ef4444;--warn:#f59e0b;--ok:#22c55e;}
  body{margin:0;padding:16px;font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);line-height:1.5;}
  .container{max-width:600px;margin:0 auto;display:grid;gap:16px;}
  header{display:flex;justify-content:space-between;align-items:center;}
  h1{margin:0;font-size:1.25rem;font-weight:700;}
  .badge{padding:4px 10px;border-radius:99px;font-size:0.85rem;background:#eff6ff;color:var(--primary);font-weight:500;}
  .card{background:var(--card);border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.05);border:1px solid var(--border);}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
  .metric{display:flex;flex-direction:column;}
  .label{font-size:0.85rem;color:var(--sub);margin-bottom:4px;}
  .value{font-size:2rem;font-weight:700;line-height:1.1;}
  .progress{height:8px;background:#f1f5f9;border-radius:4px;overflow:hidden;margin-top:8px;}
  .bar{height:100%;background:var(--primary);transition:width .3s;}
  .bar.p{background:linear-gradient(90deg,#3b82f6,#06b6d4);}
  .bar.i{background:linear-gradient(90deg,#8b5cf6,#ec4899);}
  .actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-top:10px;}
  button{border:1px solid var(--border);background:#fff;padding:12px;border-radius:10px;font-weight:600;color:var(--text);cursor:pointer;font-size:0.9rem;transition:all 0.2s;}
  button:active{background:#f1f5f9;transform:scale(0.98);}
  button.primary{background:var(--primary);color:#fff;border:none;}
  button.danger{color:var(--danger);border-color:#fee2e2;}
  canvas{width:100%;height:200px;background:#f8fafc;border-radius:8px;border:1px solid var(--border);margin:10px 0;}
  .adjust{display:flex;justify-content:space-between;background:#f1f5f9;padding:8px;border-radius:8px;font-size:0.85rem;}
  .adjust div{display:flex;align-items:center;gap:8px;}
  .btn-sm{width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:6px;background:#fff;}
  ul#logs{list-style:none;margin:0;padding:0;height:120px;overflow-y:auto;font-size:0.8rem;color:var(--sub);border-top:1px solid var(--border);padding-top:8px;}
  li{padding:2px 0;border-bottom:1px dashed #f1f5f9;}
  .stat-row{display:flex;gap:15px;font-size:0.85rem;color:var(--sub);margin-bottom:8px;}
  .stat-row b{color:var(--text);}
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1 data-bind="title">气压寸止</h1>
      <div style="font-size:0.8rem;color:var(--sub)">Started: <span data-bind="startTime">-</span></div>
    </div>
    <div class="badge" data-bind="statusText">Ready</div>
  </header>

  <div class="card">
    <div class="grid-2">
      <div class="metric">
        <span class="label">当前压力 (Avg: <span data-bind="averagePressure">0</span>)</span>
        <span class="value" data-bind="currentPressure">0</span>
        <div class="progress"><div id="pBar" class="bar p" style="width:0%"></div></div>
      </div>
      <div class="metric">
        <span class="label">当前强度 (Tgt: <span data-bind="targetIntensity">0</span>)</span>
        <span class="value" data-bind="currentIntensity">0</span>
        <div class="progress"><div id="iBar" class="bar i" style="width:0%"></div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="actions">
      <button class="primary" data-action="pause"><span data-bind="btnText">暂停</span></button>
      <button data-action="addIntensity" data-payload='{"delta":10}'>+10 强度</button>
      <button class="danger" data-action="shockOnce">⚡ 电击</button>
    </div>
  </div>

  <div class="card">
    <div class="stat-row">
      <span>中间压力: <b data-bind="midPressure">0</b></span>
      <span>临界压力: <b data-bind="criticalPressure">0</b></span>
    </div>
    <canvas id="chart"></canvas>
    <div class="adjust">
      <div>
        <span>中间</span>
        <button class="btn-sm" data-adjust="mid" data-val="-0.1">-</button>
        <button class="btn-sm" data-adjust="mid" data-val="0.1">+</button>
      </div>
      <div>
        <span>临界</span>
        <button class="btn-sm" data-adjust="crit" data-val="-0.1">-</button>
        <button class="btn-sm" data-adjust="crit" data-val="0.1">+</button>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="stat-row">
      <span>电击: <b data-bind="shockCount">0</b></span>
      <span>时长: <b data-bind="totalStimulationTime">0</b>s</span>
      <span>Ping: <span data-bind="lastPing">-</span></span>
    </div>
    <ul id="logs"></ul>
  </div>
</div>

<script>
(function(){
  const state={}; const ui={};
  const $=(s)=>document.querySelectorAll(s);
  const el=(id)=>document.getElementById(id);
  
  function render(){
    $('[data-bind]').forEach(e=>{
      const k=e.getAttribute('data-bind');
      let v = state[k] ?? ui[k] ?? '';
      if(k==='btnText' && v==='') v='暂停';
      if(k==='startTime' && v>0) v=new Date(v).toLocaleTimeString();
      if(e.tagName==='B' || e.classList.contains('value') || k==='averagePressure' || k==='targetIntensity') {
        const n=Number(v); if(!isNaN(n)) v=n.toFixed(k.includes('Pressure')?1:0);
      }
      e.textContent = v;
    });
    const cp = Number(state.currentPressure)||0;
    const crit = Number(state.criticalPressure)||20;
    const ci = Number(state.currentIntensity)||0;
    const maxI = Number(state.maxMotorIntensity)||200;
    if(el('pBar')) el('pBar').style.width = Math.min(100, (cp/crit)*100).toFixed(1)+'%';
    if(el('iBar')) el('iBar').style.width = Math.min(100, (ci/maxI)*100).toFixed(1)+'%';
    drawChart();
  }

  const post = (act, pay) => fetch('/api/games/current/actions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:act,payload:pay})}).catch(()=>{});
  $('[data-action]').forEach(b=>b.onclick=()=>post(b.getAttribute('data-action'), JSON.parse(b.getAttribute('data-payload')||'{}')));
  
  $('[data-adjust]').forEach(b=>{
    b.onclick=()=>{
      const type=b.getAttribute('data-adjust'), val=Number(b.getAttribute('data-val'));
      const c=Number(state.criticalPressure)||20, m=Number(state.midPressure)||(c*0.9);
      if(type==='mid') state.midPressure = Math.max(0, Math.min(c-0.1, m+val));
      else state.criticalPressure = Math.max(m+0.1, Math.min(60, c+val));
      render();
      post('setThresholds', {midPressure:state.midPressure, criticalPressure:state.criticalPressure});
    }
  });

  let chartXMin=15, chartXMax=25;
  function drawChart(){
    const cvs=el('chart'); if(!cvs)return;
    const ctx=cvs.getContext('2d');
    const w=cvs.width=cvs.clientWidth*2, h=cvs.height=cvs.clientHeight*2;
    ctx.scale(2,2); const W=w/2, H=h/2;
    
    const pad=20, gw=W-pad*2, gh=H-pad*2;
    const cp=Number(state.currentPressure)||0, ci=Number(state.currentIntensity)||0;
    const crit=Number(state.criticalPressure)||20, mid=Number(state.midPressure)||(crit*0.9);
    const midI=Number(state.midIntensity)||0, maxI=Number(state.maxMotorIntensity)||200;
    
    chartXMax = Math.max(chartXMax, crit+5);
    chartXMin = Math.min(chartXMin, mid-5);
    const xOf=(p)=>pad + gw * ((p-chartXMin)/Math.max(1e-6, chartXMax-chartXMin));
    const yOf=(i)=>pad + gh * (1 - i/Math.max(1e-6, Math.max(maxI, ci+10)));

    ctx.clearRect(0,0,W,H);
    ctx.strokeStyle='#e2e8f0'; ctx.beginPath();
    ctx.moveTo(pad, pad+gh); ctx.lineTo(pad+gw, pad+gh); 
    ctx.moveTo(pad, pad); ctx.lineTo(pad, pad+gh);
    ctx.stroke();
    
    const xM=xOf(mid), xC=xOf(crit), yM=yOf(midI), y0=pad+gh;
    ctx.fillStyle='rgba(59,130,246,0.1)';
    ctx.beginPath(); ctx.moveTo(xM,y0); ctx.lineTo(xC,y0); ctx.lineTo(xM,yM); ctx.fill();
    ctx.strokeStyle='#3b82f6'; ctx.beginPath(); ctx.moveTo(xM,y0); ctx.lineTo(xM,yM); ctx.lineTo(xC,y0); ctx.stroke();

    const dot=(x,y,c)=>{ctx.fillStyle=c;ctx.beginPath();ctx.arc(x,y,5,0,7);ctx.fill();}
    dot(xM, y0, '#3b82f6'); 
    dot(xC, y0, '#f97316'); 
    dot(xOf(cp), yOf(ci), '#22c55e'); 
    
    ctx.fillStyle='#64748b'; ctx.font='10px sans-serif';
    ctx.fillText(chartXMin.toFixed(0), pad, H-5);
    ctx.fillText(chartXMax.toFixed(0), W-20, H-5);
    
    ctx.textAlign='right';
    ctx.fillText(maxI.toFixed(0), pad-4, pad+8);
    ctx.fillText('0', pad-4, pad+gh);
    ctx.textAlign='left';
  }

  const es = new EventSource('/api/games/current/stream');
  const merge=(t,s)=>Object.assign(t,s||{});
  es.addEventListener('state',e=>{merge(state,JSON.parse(e.data));render();});
  es.addEventListener('ui',e=>{merge(ui,JSON.parse(e.data).fields);render();});
  es.addEventListener('log',e=>{
    const d=JSON.parse(e.data), li=document.createElement('li');
    li.textContent = \`[\${new Date(d.ts).toLocaleTimeString()}] \${d.message}\`;
    li.style.color = d.level==='warn'?'#f59e0b':(d.level==='error'?'#ef4444':'inherit');
    const ul=el('logs'); ul.prepend(li); if(ul.children.length>20) ul.lastChild.remove();
  });
  
  let drag=null;
  el('chart').onmousedown=e=>{
    const r=e.target.getBoundingClientRect(), x=e.clientX-r.left;
    const xM = (Number(state.midPressure)-chartXMin)/(chartXMax-chartXMin)*r.width;
    const xC = (Number(state.criticalPressure)-chartXMin)/(chartXMax-chartXMin)*r.width;
    drag = Math.abs(x-xM)<Math.abs(x-xC)?'mid':'crit';
  };
  window.onmousemove=e=>{
    if(!drag)return;
    const r=el('chart').getBoundingClientRect(), w=r.width;
    const p = chartXMin + ((e.clientX-r.left)/w)*(chartXMax-chartXMin);
    const c=Number(state.criticalPressure)||20, m=Number(state.midPressure);
    if(drag==='mid') state.midPressure=Math.max(chartXMin, Math.min(c-0.1, p));
    else state.criticalPressure=Math.max(m+0.1, Math.min(60, p));
    render();
  };
  window.onmouseup=()=>{if(drag){post('setThresholds',{midPressure:state.midPressure,criticalPressure:state.criticalPressure});drag=null;}};

})();
</script>
</body>
</html>`;
  },
};

module.exports = pressureEdging;
