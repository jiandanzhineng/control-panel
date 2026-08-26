/**
 * 遥控蓝牙设备连接适配器。
 * 支持两种模式：
 *   - bridge：连接 YCY API-bridge（WebSocket → IM game_cmd），以指令触发控制。
 *   - ble   ：BLE 直连（0x35 族真实帧：电刺激 35 11 / 电机 35 12 / pump 35 12），原始强度/通道下发。
 * 作为 deviceConnectionService 的 transport adapter：实现 send(message) / disconnect()。
 */
const ycy = require('./protocols/ycy');
const { mergeFjbState, toLevel255, clampInt } = require('./capabilityMap');

class YCYConnection {
  constructor({ deviceId, mode = 'bridge', WebSocketClass = null } = {}) {
    this.brand = 'ycy';
    this.deviceId = deviceId;
    this.mode = mode; // 'bridge' | 'ble'
    this.WebSocketClass = WebSocketClass || null;
    this.bridge = null;
    this.ble = null;
    this.auth = null; // { uid, token } 桥接模式鉴权
    this._statusCb = null;
    this._keepAliveTimer = null;
    this._fjb = { stroke: 0, vibe: 0, axis: 0 };
  }

  /** 注册状态回调：brandService 用它接收 close / error，驱动状态机与重连。 */
  onStatus(cb) {
    this._statusCb = cb;
    return this;
  }

  async connect(opts = {}) {
    if (this.mode === 'ble') {
      this.ble = new ycy.YcyBleTransport();
      await this.ble.connect(this.deviceId, {
        serviceUuid: opts.serviceUuid,
        writeUuid: opts.writeUuid,
      });
      return this;
    }
    // bridge 模式
    const { host = '127.0.0.1', port = ycy.BRIDGE_DEFAULT_PORT, connectCode, uid, token } = opts;
    const auth = connectCode ? ycy.parseConnectCode(connectCode) : { uid: uid || '', token: token || '' };
    // 保存重建所需连接参数（便于轻量重连）。
    this.auth = { ...auth, host, port, connectCode };
    this.bridge = new ycy.YcyBridgeClient({ host, port, WebSocketClass: this.WebSocketClass });
    this.bridge.on('close', () => { this._stopKeepAlive(); this._statusCb?.('close', { error: '遥控蓝牙设备桥接已关闭' }); });
    this.bridge.on('error', (err) => { this._statusCb?.('error', { error: err?.message || String(err) }); });
    await this.bridge.connect();
    this.bridge.login(auth);
    this._startKeepAlive();
    return this;
  }

  /** 轻量重连：复用既有 host/port/auth 重建桥接客户端。 */
  async reconnect() {
    this.disconnect();
    await this.connect({ host: this.auth?.host, port: this.auth?.port, connectCode: this.auth?.connectCode, uid: this.auth?.uid, token: this.auth?.token });
  }

  _startKeepAlive() {
    this._stopKeepAlive();
    // 30s 心跳 ping，避免空闲连接被中间网络回收（与蓝牙体感设备保持一致）。
    this._keepAliveTimer = setInterval(() => {
      if (this.bridge && this.bridge.ws && this.bridge.ws.readyState === 1) {
        try { this.bridge.ws.ping?.(); } catch (_) {}
      }
    }, 30000);
    if (typeof this._keepAliveTimer.unref === 'function') this._keepAliveTimer.unref();
  }

  _stopKeepAlive() {
    if (this._keepAliveTimer) { clearInterval(this._keepAliveTimer); this._keepAliveTimer = null; }
  }

  _normalize(brandCommand) {
    const c = brandCommand || {};
    if (c.cmd === 'setMotors') {
      const ch = c.channels || {};
      if (ch.a != null && ch.stroke == null) {
        return { ...c, cmd: 'setSpeed', speed: toLevel255(ch.a, 20) || 0 };
      }
      this._fjb = mergeFjbState(this._fjb, ch);
      return { brand: 'ycy', cmd: 'setFjb', ...this._fjb };
    }
    if (c.cmd === 'setFjb') {
      this._fjb = {
        stroke: c.stroke != null ? c.stroke : this._fjb.stroke,
        vibe: c.vibe != null ? c.vibe : this._fjb.vibe,
        axis: c.axis != null ? c.axis : this._fjb.axis,
      };
      return { ...c, cmd: 'setFjb', ...this._fjb };
    }
    if (c.cmd === 'stopFjb' || c.cmd === 'stopToy' || c.cmd === 'stopAll') {
      this._fjb = { stroke: 0, vibe: 0, axis: 0 };
    }
    if (c.cmd === 'setEstim') {
      return {
        brand: 'ycy', cmd: 'setStrength',
        channel: c.channel || 'A',
        value: Math.round((clampInt(c.intensity, 0, 255) / 255) * 100),
        wave: c.wave,
      };
    }
    return c;
  }

  /** 接收品牌命令（由 YCY_* 设备类型 emit），翻译并下发 */
  send(brandCommand) {
    const cmd = this._normalize(brandCommand);
    if (this.mode === 'ble') {
      if (!this.ble) throw new Error('遥控蓝牙设备 BLE 未连接');
      return this.ble.write(ycy.toBleFrame(cmd));
    }
    if (!this.bridge) throw new Error('遥控蓝牙设备桥接未连接');
    return this.bridge.send(ycy.toBridgeMessage(cmd, { token: this.auth?.token }));
  }

  disconnect() {
    this._stopKeepAlive();
    if (this.bridge) { try { this.bridge.disconnect(); } catch (_) {} this.bridge = null; }
    if (this.ble) { try { this.ble.disconnect(); } catch (_) {} this.ble = null; }
  }

  toMetadata() {
    return {
      brand: 'ycy',
      mode: this.mode,
      kind: this.mode === 'ble' ? 'ycy-ble' : 'ycy-bridge',
      ...(this.auth?.uid ? { uid: this.auth.uid } : {}),
    };
  }
}

module.exports = { YCYConnection };
