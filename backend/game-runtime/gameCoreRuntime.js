class GameCoreRuntime {
  constructor(core) {
    this.core = core;
    this.queue = [];
    this.last = null;
  }

  enqueue(events) {
    const rows = Array.isArray(events) ? events : [events];
    for (const event of rows) {
      if (event && typeof event === 'object') this.queue.push(event);
    }
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
  }

  tick(nowMs) {
    const events = this.queue.splice(0, this.queue.length);
    this.last = this.core.step({ nowMs, events });
    return this.last;
  }

  snapshot() {
    return this.core.snapshot();
  }
}

module.exports = { GameCoreRuntime };
