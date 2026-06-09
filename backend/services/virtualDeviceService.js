const deviceService = require('./deviceService');
const logService = require('./logService');

const virtualDevices = new Map();

class VirtualDevice {
  constructor({ id, type, properties = {} }) {
    this.id = id;
    this.type = type;
    this.properties = { ...properties };
    this.commandLog = [];
    this.timeline = null;
    this.timelineTimer = null;
    this.reportTimer = null;
    this.isVirtual = true;
    this.connected = true;
    this.lowStateFlag = false;
    this.highStateFlag = false;
  }

  recordCommand(cmd) {
    this.commandLog.push({ ts: Date.now(), ...cmd });
    if (this.commandLog.length > 1000) this.commandLog.shift();
  }

  setProperties(props) {
    const oldProps = { ...this.properties };
    Object.assign(this.properties, props);
    this._injectPropertyUpdate(props, oldProps);
  }

  emitMessage(msg) {
    this._injectMessage(msg);
  }

  _injectPropertyUpdate(newProps, oldProps) {
    const payload = { method: 'update', ...newProps };
    deviceService.handleDeviceMessage({ topic: `/dpub/${this.id}`, text: JSON.stringify(payload) });
  }

  _injectMessage(msg) {
    const payload = { ...msg };
    deviceService.handleDeviceMessage({ topic: `/dpub/${this.id}`, text: JSON.stringify(payload) });
  }

  startReport(delayMs) {
    this.stopReport();
    if (!delayMs || delayMs <= 0) return;
    this.reportTimer = setInterval(() => {
      this._injectPropertyUpdate(this.properties, {});
    }, delayMs);
  }

  stopReport() {
    if (this.reportTimer) { clearInterval(this.reportTimer); this.reportTimer = null; }
  }

  destroy() {
    this.stopReport();
    if (typeof this.stopTimeline === 'function') this.stopTimeline();
  }
}

function createDevice({ id, type, properties = {} }) {
  if (virtualDevices.has(id)) {
    const err = new Error(`虚拟设备已存在: ${id}`);
    err.code = 'VIRTUAL_DEVICE_EXISTS';
    throw err;
  }
  const vdev = new VirtualDevice({ id, type, properties });

  deviceService.handleDeviceMessage({
    topic: `/dpub/${id}`,
    text: JSON.stringify({ method: 'report', device_type: type, ...properties }),
  });

  const reportDelay = properties.report_delay_ms || getDefaultReportDelay(type);
  if (reportDelay > 0) {
    vdev.startReport(reportDelay);
  } else {
    // 执行器类设备（无自动上报，如 TD01/PJ01/DIANJI/ZIDONGSUO）也需保持在线以供映射，
    // 用一个低频心跳重发当前属性，避免被离线检查标记下线。
    vdev.startReport(30000);
  }

  virtualDevices.set(id, vdev);
  return vdev;
}

function getDefaultReportDelay(type) {
  const delays = { QIYA: 5000, QTZ: 10000, DZC01: 5000, CUNZHI01: 5000 };
  return delays[type] || 0;
}

function deleteDevice(id) {
  const vdev = virtualDevices.get(id);
  if (!vdev) return false;
  vdev.destroy();
  virtualDevices.delete(id);
  deviceService.deleteDeviceById(id);
  return true;
}

function getDevice(id) {
  return virtualDevices.get(id) || null;
}

function listDevices() {
  return Array.from(virtualDevices.values()).map((v) => ({
    id: v.id, type: v.type, properties: v.properties,
    connected: true, isVirtual: true,
  }));
}

function setProperties(id, props) {
  const vdev = virtualDevices.get(id);
  if (!vdev) return null;
  const oldDistance = vdev.properties.distance;
  vdev.setProperties(props);

  if (props.report_delay_ms !== undefined) {
    vdev.stopReport();
    vdev.startReport(props.report_delay_ms);
  }

  if (vdev.type === 'QTZ' && props.distance !== undefined) {
    handleQtzThreshold(vdev, oldDistance, props.distance);
  }
  return vdev.properties;
}

function handleQtzThreshold(vdev, oldDist, newDist) {
  const low = vdev.properties.low_band || 60;
  const high = vdev.properties.high_band || 150;
  const hysteresis = 10;

  if (oldDist >= low && newDist < low - hysteresis && !vdev.lowStateFlag) {
    vdev.lowStateFlag = true;
    vdev.emitMessage({ method: 'low' });
  } else if (newDist >= low) {
    vdev.lowStateFlag = false;
  }

  if (oldDist <= high && newDist > high + hysteresis && !vdev.highStateFlag) {
    vdev.highStateFlag = true;
    vdev.emitMessage({ method: 'high' });
  } else if (newDist <= high) {
    vdev.highStateFlag = false;
  }
}

function emitMessage(id, msg) {
  const vdev = virtualDevices.get(id);
  if (!vdev) return null;
  vdev.emitMessage(msg);
  return true;
}

function getCommands(id) {
  const vdev = virtualDevices.get(id);
  if (!vdev) return null;
  return vdev.commandLog;
}

function clearCommands(id) {
  const vdev = virtualDevices.get(id);
  if (!vdev) return false;
  vdev.commandLog = [];
  return true;
}

function startTimeline(id, timeline, loop = false) {
  const vdev = virtualDevices.get(id);
  if (!vdev) return null;
  vdev.stopTimeline = () => {
    if (vdev.timelineTimer) { clearTimeout(vdev.timelineTimer); vdev.timelineTimer = null; }
    vdev.timeline = null;
  };
  vdev.timeline = { steps: timeline, loop, currentStep: 0, running: true, startedAt: Date.now() };
  runTimelineStep(vdev, 0);
  return vdev.timeline;
}

function runTimelineStep(vdev, index) {
  if (!vdev.timeline || !vdev.timeline.running) return;
  const steps = vdev.timeline.steps;
  if (index >= steps.length) {
    if (vdev.timeline.loop) { vdev.timeline.currentStep = 0; runTimelineStep(vdev, 0); }
    else { vdev.timeline.running = false; }
    return;
  }
  const step = steps[index];
  const delay = Array.isArray(step.delay) ? (step.delay[0] + Math.random() * (step.delay[1] - step.delay[0])) : (step.delay || 0);

  vdev.timelineTimer = setTimeout(() => {
    if (!vdev.timeline || !vdev.timeline.running) return;
    if (step.set) setProperties(vdev.id, step.set);
    if (step.emit) emitMessage(vdev.id, step.emit);
    vdev.timeline.currentStep = index + 1;
    runTimelineStep(vdev, index + 1);
  }, delay);
}

function stopTimeline(id) {
  const vdev = virtualDevices.get(id);
  if (!vdev || !vdev.timeline) return false;
  if (typeof vdev.stopTimeline === 'function') vdev.stopTimeline();
  return true;
}

function getTimelineStatus(id) {
  const vdev = virtualDevices.get(id);
  if (!vdev || !vdev.timeline) return null;
  const tl = vdev.timeline;
  return { running: tl.running, currentStep: tl.currentStep, totalSteps: tl.steps.length, elapsed: Date.now() - tl.startedAt };
}

function interceptCommand(deviceId, cmd) {
  const vdev = virtualDevices.get(deviceId);
  if (!vdev) return false;
  vdev.recordCommand(cmd);

  if (vdev.type === 'DIANJI' && cmd.action === 'sendMessage' && cmd.msg?.method === 'dian') {
    const time = cmd.msg.time || 3000;
    vdev.setProperties({ shock: 1, voltage: cmd.msg.voltage || 0 });
    setTimeout(() => { vdev.setProperties({ shock: 0 }); }, time);
  }
  return true;
}

function isVirtualDevice(deviceId) {
  return virtualDevices.has(deviceId);
}

function batchCreate(devices) {
  return devices.map((d) => {
    try {
      const vdev = createDevice(d);
      return { id: vdev.id, type: vdev.type, ok: true };
    } catch (e) {
      return { id: d.id, error: e.message };
    }
  });
}

module.exports = {
  createDevice, deleteDevice, getDevice, listDevices,
  setProperties, emitMessage, getCommands, clearCommands,
  startTimeline, stopTimeline, getTimelineStatus,
  interceptCommand, isVirtualDevice, batchCreate,
};
