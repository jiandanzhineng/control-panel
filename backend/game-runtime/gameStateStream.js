// 游戏状态流（GameStateStream）
// 作用：把宿主端 / 远端不断产生的「全量状态文档」转换成带 rev 的事件流，供
// gameHostService 与 remoteGameService 共用。
//   { type: 'snapshot', rev, state }      新订阅者的首个事件、reset() 之后
//   { type: 'patch', rev, baseRev, ops }  合并窗口结束时 diff 非空才发出
// 字段名 state 与前端（frontend/src/play/gameStateStream.ts）和契约文档一致，
// SSE 路由与 MQTT 都直接转发这里的事件，不要改成 snapshot。
// 规则：
//   1. rev 从 0 开始单调递增，每发出一个事件 +1；flush 无差异时不递增、不通知。
//   2. update() 只记录最新状态；窗口内已有待执行的 flush 时不再重复排期，
//      所以 windowMs 内的 N 次 update 合并为一条 patch，diff 基准是「上一次
//      已发布」的状态（而非上一次 update）。windowMs=50 时上限约 20 条消息/秒。
//   3. reset() 用于开新一局：丢弃待发布内容、直接发布全量 snapshot 并递增 rev；
//      允许传 null（订阅者据此渲染「无游戏」）。
//   4. 定时器由 setTimer/clearTimer 注入，测试可确定性驱动。
//   5. 订阅者回调逐个 try/catch，单个订阅者抛错不影响其他订阅者。

const { diff } = require('../public/game-state-patch');

class GameStateStream {
  constructor({
    windowMs = 50,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    this.windowMs = windowMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.rev = 0;
    this.published = null; // 上一次已发布的状态文档，作为 diff 基准
    this.pending = null; // 窗口内最新的待发布状态
    this.hasPending = false;
    this.timer = null;
    this.listeners = new Set();
  }

  // 记录最新状态；窗口内只排一次 flush
  update(snapshot) {
    this.pending = snapshot;
    this.hasPending = true;
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.flush();
      }, this.windowMs);
    }
  }

  // 立即发布待处理内容；返回发出的事件，无可发内容时返回 null
  flush() {
    this.cancelTimer();
    if (!this.hasPending) return null;
    const next = this.pending;
    this.hasPending = false;
    if (this.published === null) {
      // 还没有基准状态：只能发全量
      return this.publish({ type: 'snapshot', state: next }, next);
    }
    const ops = diff(this.published, next);
    if (!Array.isArray(ops) || ops.length === 0) {
      // 无变化：不递增 rev，不通知
      return null;
    }
    return this.publish(
      { type: 'patch', baseRev: this.rev, ops },
      next,
    );
  }

  // 开新一局：丢弃待发布内容，直接全量发布并递增 rev
  reset(snapshot) {
    this.cancelTimer();
    this.hasPending = false;
    this.pending = null;
    return this.publish({ type: 'snapshot', state: snapshot === undefined ? null : snapshot }, snapshot === undefined ? null : snapshot);
  }

  // 会话结束：取消定时器并丢弃状态
  clear() {
    this.cancelTimer();
    this.published = null;
    this.pending = null;
    this.hasPending = false;
    this.listeners.clear();
  }

  getRev() {
    return this.rev;
  }

  getSnapshot() {
    return this.published;
  }

  // 订阅；返回退订函数。新订阅者先同步收到当前全量状态
  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    this.notify(listener, {
      type: 'snapshot',
      rev: this.rev,
      state: this.published,
    });
    return () => {
      this.listeners.delete(listener);
    };
  }

  cancelTimer() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  // 递增 rev、更新已发布状态并广播；调用方传入不含 rev 的事件体
  publish(event, snapshot) {
    this.rev += 1;
    this.published = snapshot === undefined ? null : snapshot;
    const payload = Object.assign({ rev: this.rev }, event);
    this.notifyAll(payload);
    return payload;
  }

  notifyAll(event) {
    for (const listener of Array.from(this.listeners)) {
      this.notify(listener, event);
    }
  }

  // 单个订阅者抛错不影响其他订阅者
  notify(listener, event) {
    try {
      listener(event);
    } catch (_) {}
  }
}

module.exports = { GameStateStream };
