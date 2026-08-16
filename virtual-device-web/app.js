/* 浏览器端虚拟设备：连 MQTT、周期上报、显示下行电击/马达。
 * 协议逻辑在 device.js（可单测），这里只管连接和 DOM。
 */
'use strict';

const D = window.CunzhiDevice;
const $ = (id) => document.getElementById(id);

const ARC_THRESHOLD = 30;  // 数字人侧 tiptoe-punish 弧的阈值，画一条参考线

// power(0~255) 折算成百分比后的档位名，只影响显示
const VIBE_LEVELS = [
  { max: 0, name: '停止' },
  { max: 25, name: '弱' },
  { max: 50, name: '中' },
  { max: 75, name: '强' },
  { max: 100, name: '最强' },
];

const ui = {
  dot: $('dot'), connText: $('connText'), cfgHint: $('cfgHint'),
  broker: $('broker'), devId: $('devId'), reportMs: $('reportMs'),
  btnConnect: $('btnConnect'), btnDisconnect: $('btnDisconnect'),
  pressure: $('pressure'), pVal: $('pVal'), pFill: $('pFill'), pMark: $('pMark'),
  autoFall: $('autoFall'),
  shockBox: $('shockBox'), shockState: $('shockState'), shockVolt: $('shockVolt'),
  shockCount: $('shockCount'), shockLast: $('shockLast'),
  vibeBox: $('vibeBox'), vibeState: $('vibeState'), vibeVal: $('vibeVal'),
  vFill: $('vFill'), vibePct: $('vibePct'),
  vibeCount: $('vibeCount'), vibeLast: $('vibeLast'),
  log: $('log'), btnClear: $('btnClear'),
};

let client = null;
let state = D.initialState();
let reportTimer = null;
let heartbeatTimer = null;
let autoStopTimer = null;
let shockCount = 0;
let vibeCount = 0;

function log(kind, text) {
  const t = new Date().toTimeString().slice(0, 8);
  const el = document.createElement('div');
  el.innerHTML = `<span class="t">${t}</span><span class="${kind}">${text}</span>`;
  ui.log.appendChild(el);
  while (ui.log.children.length > 300) ui.log.removeChild(ui.log.firstChild);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setConn(status, text) {
  ui.dot.className = 'dot' + (status ? ' ' + status : '');
  ui.connText.textContent = text;
}

function renderPressure() {
  const v = state.pressure1;
  ui.pVal.textContent = v;
  const pct = Math.min(100, Math.max(0, v));
  ui.pFill.style.width = pct + '%';
  ui.pFill.classList.toggle('over', v >= ARC_THRESHOLD);
}

function renderShock() {
  const on = Number(state.shock) === 1;
  ui.shockBox.className = 'shock ' + (on ? 'on' : 'off');
  ui.shockState.textContent = on ? '电击中' : '未通电';
  ui.shockVolt.textContent = on ? state.voltage : 0;
}

// power 是 strength 能力的字段，0~255。真设备用它调马达/跳蛋强度。
function renderVibe() {
  const v = Math.max(0, Math.min(255, Number(state.power) || 0));
  const pct = Math.round((v / 255) * 100);
  const on = v > 0;
  ui.vibeBox.className = 'vibe ' + (on ? 'on' : 'off');
  ui.vibeState.textContent = on ? VIBE_LEVELS.find((l) => pct <= l.max).name : '停止';
  ui.vibeVal.textContent = v;
  ui.vibePct.textContent = pct + '%';
  ui.vFill.style.width = pct + '%';
  // 抖动幅度 0.6~2.4px，让弱档和满档看起来不一样
  ui.vibeBox.style.setProperty('--amp', (0.6 + (pct / 100) * 1.8).toFixed(2) + 'px');
}

function renderAll() { renderPressure(); renderShock(); renderVibe(); }

// ---- MQTT ----

function publish(topic, msg, kind) {
  if (!client || !client.connected) return;
  const text = JSON.stringify(msg);
  client.publish(topic, text);
  log(kind || 'out', `→ ${topic} ${text}`);
}

function onCommand(topic, payloadBuf) {
  const raw = payloadBuf.toString();
  log('in', `← ${topic} ${raw}`);
  const r = D.handleInbound(state, raw);
  state = r.state;
  for (const reply of r.replies) {
    publish(D.pubTopic(currentId()), reply);
  }
  for (const ev of r.events) {
    if (ev.type === 'shock_start') {
      shockCount += 1;
      ui.shockCount.textContent = shockCount;
      ui.shockLast.textContent =
        `${new Date().toTimeString().slice(0, 8)} · ${ev.voltage}V`;
      if (autoStopTimer) clearTimeout(autoStopTimer);
      if (ev.autoStopMs) {
        autoStopTimer = setTimeout(() => {
          state = D.applyCommand(state, { shock: 0 }).state;
          renderShock();
        }, ev.autoStopMs);
      }
    }
    if (ev.type === 'power') {
      vibeCount += 1;
      ui.vibeCount.textContent = vibeCount;
      ui.vibeLast.textContent =
        `${new Date().toTimeString().slice(0, 8)} · ${ev.value}`;
    }
  }
  renderShock();
  renderVibe();
}

function currentId() { return ui.devId.value.trim(); }

function connect() {
  const url = ui.broker.value.trim();
  const id = currentId();
  if (!url || !id) {
    ui.cfgHint.className = 'hint err';
    ui.cfgHint.textContent = 'Broker 和设备 ID 都不能为空';
    return;
  }
  if (!window.mqtt) {
    ui.cfgHint.className = 'hint err';
    ui.cfgHint.textContent = 'mqtt.min.js 没加载到，检查 server.js 的日志';
    return;
  }

  ui.cfgHint.className = 'hint';
  ui.cfgHint.textContent = '';
  setConn('', '连接中…');
  ui.btnConnect.disabled = true;

  client = window.mqtt.connect(url, {
    clientId: `vweb_${id}_${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
  });

  client.on('connect', () => {
    setConn('on', `已连接 · ${id}`);
    ui.btnDisconnect.disabled = false;
    log('sys', `已连接 ${url}`);
    const topics = [D.recvTopic(id), D.allTopic()];
    client.subscribe(topics, (err) => {
      if (err) log('sys', `订阅失败: ${err.message}`);
      else log('sys', `订阅 ${topics.join(' ')}`);
    });
    // report 让 control-panel 自动注册这台设备（deviceService.js:321）
    publish(D.pubTopic(id), D.reportMessage(state));
    startReport();
    startHeartbeat();
  });

  client.on('message', onCommand);

  client.on('error', (err) => {
    setConn('err', '错误');
    log('sys', `错误: ${err.message}`);
    ui.cfgHint.className = 'hint err';
    ui.cfgHint.textContent = err.message;
  });

  client.on('close', () => {
    setConn('', '未连接');
    ui.btnConnect.disabled = false;
    ui.btnDisconnect.disabled = true;
    stopReport();
    stopHeartbeat();
  });

  client.on('reconnect', () => setConn('', '重连中…'));
}

function disconnect() {
  stopReport();
  stopHeartbeat();
  if (autoStopTimer) { clearTimeout(autoStopTimer); autoStopTimer = null; }
  if (client) { client.end(true); client = null; }
  setConn('', '未连接');
  ui.btnConnect.disabled = false;
  ui.btnDisconnect.disabled = true;
  log('sys', '已断开');
}

// ---- 周期上报 ----
// 对齐 CUNZHI01.c report_task：每 report_delay_ms 发 pressure/pressure1/battery/game_cz_count。
// UI 间隔默认 500ms，方便反射弧调试（固件默认 5s）。
function startReport() {
  stopReport();
  const ms = Math.max(100, Number(ui.reportMs.value) || 500);
  reportTimer = setInterval(() => {
    publish(D.pubTopic(currentId()), D.periodicUpdateMessage(state));
  }, ms);
}

function stopReport() {
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
}

// 对齐 base_device.c heartbeat_task：每 10s 全量 report
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    publish(D.pubTopic(currentId()), D.reportMessage(state));
  }, 10000);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ---- 交互 ----

function setPressure(v) {
  state.pressure1 = Math.round(Math.max(0, Math.min(100, Number(v) || 0)));
  ui.pressure.value = state.pressure1;
  renderPressure();
}

ui.pressure.addEventListener('input', (e) => setPressure(e.target.value));
ui.pressure.addEventListener('change', () => {
  if (ui.autoFall.checked) setPressure(0);
});

for (const btn of document.querySelectorAll('[data-preset]')) {
  btn.addEventListener('click', () => setPressure(btn.dataset.preset));
}

ui.btnConnect.addEventListener('click', connect);
ui.btnDisconnect.addEventListener('click', disconnect);
ui.btnClear.addEventListener('click', () => { ui.log.innerHTML = ''; });
ui.reportMs.addEventListener('change', () => { if (reportTimer) startReport(); });

// 阈值参考线
ui.pMark.style.left = ARC_THRESHOLD + '%';

renderAll();
log('sys', '就绪。填好 Broker 和设备 ID 后点连接。');
