/* CUNZHI01 虚拟设备协议逻辑 —— 纯函数，无 MQTT / DOM 依赖，可单测。
 *
 * 对齐 hardware CUNZHI01.c + base_device.c：
 *   订阅 /drecv/<id> 与 /all
 *   上行 /dpub/<id>  {method:'report', ver, ...全部属性}     心跳
 *                    {method:'update', pressure, pressure1, battery, game_cz_count}
 *   下行 set/update 改状态不回显；get 回 {method:'update', msg_id, key, value}
 *
 * shock=1 开始电击、shock=0 停止；voltage 是强度；power 是马达强度。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CunzhiDevice = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEVICE_TYPE = 'CUNZHI01';
  const FIRMWARE_VER = 'vweb-0.2.0';
  // 与 CUNZHI01.c device_properties[] 顺序一致
  const PROPERTY_KEYS = [
    'device_type', 'sleep_time', 'battery', 'power', 'voltage', 'shock',
    'delay', 'safe', 'pressure', 'pressure1', 'report_delay_ms',
    'game_mode', 'game_duration', 'game_fly_dur', 'game_e_vol', 'game_e_dur',
    'game_p1_thresh', 'game_p2_thresh', 'game_m_dur', 'game_m_power',
    'game_m_step', 'game_cooldown', 'game_kegel_t', 'game_cz_count',
  ];

  function pubTopic(id) { return `/dpub/${id}`; }
  function recvTopic(id) { return `/drecv/${id}`; }
  function allTopic() { return '/all'; }

  function initialState() {
    return {
      ver: FIRMWARE_VER,
      device_type: DEVICE_TYPE,
      sleep_time: 7200,
      battery: 0,
      power: 0,
      voltage: 0,
      shock: 0,
      delay: 30,
      safe: 1,
      pressure: 0,
      pressure1: 0,
      report_delay_ms: 5000,
      game_mode: 0,
      game_duration: 0,
      game_fly_dur: 60,
      game_e_vol: 0,
      game_e_dur: 0,
      game_p1_thresh: 0,
      game_p2_thresh: 0,
      game_m_dur: 0,
      game_m_power: 0,
      game_m_step: 0,
      game_cooldown: 0,
      game_kegel_t: 0,
      game_cz_count: 0,
    };
  }

  function reportMessage(state) {
    const m = { method: 'report', ver: state.ver || FIRMWARE_VER };
    for (const k of PROPERTY_KEYS) m[k] = state[k];
    return m;
  }

  function updateMessage(props) {
    return { method: 'update', ...props };
  }

  // CUNZHI01.c report_task：周期只发这 4 个字段
  function periodicUpdateMessage(state) {
    return {
      method: 'update',
      pressure: state.pressure,
      pressure1: state.pressure1,
      battery: state.battery,
      game_cz_count: state.game_cz_count,
    };
  }

  function decodeMsg(raw) {
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (_) { return null; }
    }
    return raw && typeof raw === 'object' ? raw : null;
  }

  /** 解析下行报文，返回要应用的属性变更；不认识的返回 null。 */
  function parseCommand(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch (_) { return null; }
    }
    if (!msg || typeof msg !== 'object') return null;

    // 固件 set：单属性 key/value，不回显
    if (msg.method === 'set' && typeof msg.key === 'string') {
      return { [msg.key]: msg.value };
    }
    // 能力指令统一走 method:'update' + 属性（shock/voltage/power/...）
    if (msg.method === 'update') {
      const props = { ...msg };
      delete props.method;
      delete props.msg_id;
      return Object.keys(props).length ? props : null;
    }
    // DIANJI 风格的 dian 报文：定时电击。CUNZHI01 用不到，但收到也认。
    if (msg.method === 'dian') {
      return { shock: 1, voltage: Number(msg.voltage) || 0,
               _autoStopMs: Number(msg.time) || 3000 };
    }
    return null;
  }

  // 固件 device_handle_receive：set/update 改状态不回显；get 回 {method,msg_id,key,value}
  function handleInbound(state, raw) {
    const msg = decodeMsg(raw);
    if (!msg || typeof msg.method !== 'string') {
      return { state, events: [], replies: [] };
    }
    if (msg.method === 'get' && typeof msg.key === 'string') {
      const reply = { method: 'update', key: msg.key, value: state[msg.key] };
      if (msg.msg_id !== undefined) reply.msg_id = msg.msg_id;
      return { state, events: [], replies: [reply] };
    }
    const props = parseCommand(msg);
    if (!props) return { state, events: [], replies: [] };
    const applied = applyCommand(state, props);
    return { state: applied.state, events: applied.events, replies: [] };
  }

  /** 把变更并进 state，返回 {state, events}。events 供 UI 显示。 */
  function applyCommand(state, props) {
    const next = { ...state };
    const events = [];
    if (!props) return { state: next, events };

    const autoStopMs = props._autoStopMs;
    for (const [k, v] of Object.entries(props)) {
      if (k === '_autoStopMs') continue;
      const num = typeof v === 'number' ? v : Number(v);
      next[k] = Number.isNaN(num) ? v : num;
    }
    if (props.shock !== undefined) {
      const on = Number(props.shock) === 1;
      events.push(on
        ? { type: 'shock_start', voltage: next.voltage, autoStopMs }
        : { type: 'shock_stop' });
    }
    if (props.power !== undefined) {
      events.push({ type: 'power', value: next.power });
    }
    return { state: next, events };
  }

  return {
    DEVICE_TYPE, PROPERTY_KEYS, FIRMWARE_VER,
    pubTopic, recvTopic, allTopic, initialState,
    reportMessage, updateMessage, periodicUpdateMessage,
    parseCommand, applyCommand, handleInbound,
  };
}));
