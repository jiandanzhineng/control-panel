/**
 * 设备发现：郊狼（DGLab）与役次元（YCY）的设备探测。
 * 发现仅做“可达性 / 存在性”探测，不强制要求设备已配对；连接阶段再建立控制通道。
 */
const dglab = require('./protocols/dglab');
const ycy = require('./protocols/ycy');

/**
 * 探测单个郊狼娱乐模式端点是否可达。
 * 返回 { ok, host, port, error? }
 */
function probeDGLab({ host, port = dglab.DEFAULT_PORT, WebSocketClass = null, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (r) => { if (!finished) { finished = true; resolve(r); } };
    const client = new dglab.DGLabSocketClient({ host, port, WebSocketClass, keepAlive: false });
    const timer = setTimeout(() => finish({ ok: false, host, port, error: 'timeout' }), timeoutMs);
    client.connect()
      .then(() => { clearTimeout(timer); finish({ ok: true, host, port }); client.disconnect(); })
      .catch((err) => { clearTimeout(timer); finish({ ok: false, host, port, error: err?.message || String(err) }); });
  });
}

/** 批量探测（手动输入多个候选 IP） */
async function discoverDGLab({ hosts = [], port = dglab.DEFAULT_PORT, WebSocketClass = null } = {}) {
  const results = await Promise.all(
    hosts.map((h) => probeDGLab({ host: h, port, WebSocketClass }))
  );
  return results;
}

/**
 * 探测役次元 API-bridge 是否可达且已就绪。
 * 需要 connectCode 才能登录；此处仅探测服务连通性，返回 { ok, host, port }。
 */
function probeYcyBridge({ host = '127.0.0.1', port = ycy.BRIDGE_DEFAULT_PORT, WebSocketClass = null, timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (r) => { if (!finished) { finished = true; resolve(r); } };
    let client;
    try {
      client = new ycy.YcyBridgeClient({ host, port, WebSocketClass });
    } catch (err) {
      return finish({ ok: false, host, port, error: err?.message || String(err) });
    }
    const timer = setTimeout(() => finish({ ok: false, host, port, error: 'timeout' }), timeoutMs);
    client.connect()
      .then(() => { clearTimeout(timer); finish({ ok: true, host, port }); client.disconnect(); })
      .catch((err) => { clearTimeout(timer); finish({ ok: false, host, port, error: err?.message || String(err) }); });
  });
}

/** BLE 扫描役次元设备（需要 noble） */
async function scanYcyBle({ timeoutMs = 5000 } = {}) {
  const transport = new ycy.YcyBleTransport();
  return transport.scan(timeoutMs);
}

module.exports = {
  probeDGLab,
  discoverDGLab,
  probeYcyBridge,
  scanYcyBle,
};
