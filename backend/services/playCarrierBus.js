// 玩法载体事件总线：bridge（页面式/插件，本机）与 HostRuntime 的「启动 / 退出」各发一次。
// 远程占用仲裁（remoteGameService）据此发现「被控端本地开始/结束了一次玩法」。
// 单独成模块是为了让 bridgeService / gameHostService / remoteGameService 互不 require，避免环。
const handlers = new Set();

/** 订阅载体变化（启动 / 退出）。返回取消订阅函数。 */
function onPlayCarrierChange(handler) {
  if (typeof handler !== 'function') return () => {};
  handlers.add(handler);
  return () => handlers.delete(handler);
}

function emit(event) {
  for (const handler of handlers) {
    try { handler(event); } catch (_) { /* 订阅方自己兜异常 */ }
  }
}

/** 本机开始了一次玩法：kind = bridge | host；source = host 玩法自己的来源（remote = 主控端起的）。 */
function emitPlayCarrierStart({ kind, gameId = null, gameName = null, source = null } = {}) {
  emit({ action: 'start', kind, gameId, gameName, source });
}

/** 本机的一次玩法结束（正常退出 / 顶替 / 宽限超时复位）。 */
function emitPlayCarrierExit({ kind, reason = null, source = null } = {}) {
  emit({ action: 'exit', kind, reason, source });
}

/** 清空订阅（测试用）。 */
function reset() {
  handlers.clear();
}

module.exports = { onPlayCarrierChange, emitPlayCarrierStart, emitPlayCarrierExit, reset };
