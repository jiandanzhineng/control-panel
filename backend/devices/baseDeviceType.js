const { getCapabilityDefinition } = require('./capabilities');
const { resolveValue } = require('./capabilityValue');
const { getMonitorSpec } = require('./monitorSpec');

class BaseDeviceType {
  constructor({ type, name, capabilities = {}, operations = [], close = null }) {
    if (!type) throw new Error('Device type requires type');
    this.type = type;
    this.name = name || type;
    this.capabilityOverrides = {};
    this.capabilityKeys = [];
    this.operations = Array.isArray(operations) ? operations : [];
    this.closeOp = close || null;

    if (Array.isArray(capabilities)) {
      this.capabilityKeys = capabilities;
    } else if (capabilities && typeof capabilities === 'object') {
      for (const [key, val] of Object.entries(capabilities)) {
        if (typeof val === 'string') {
          this.capabilityKeys.push(val);
        } else if (val && typeof val === 'object') {
          this.capabilityKeys.push(key);
          this.capabilityOverrides[key] = val;
        }
      }
    }
  }

  hasCapability(key) {
    return this.capabilityKeys.includes(key);
  }

  getCapabilityKeys() {
    return [...this.capabilityKeys];
  }

  getCapabilityAction(capabilityKey, actionName) {
    const override = this.capabilityOverrides[capabilityKey];
    if (override?.actions?.[actionName]) {
      return override.actions[actionName];
    }
    const cap = getCapabilityDefinition(capabilityKey);
    if (cap?.actions?.[actionName]) {
      return cap.actions[actionName];
    }
    return null;
  }

  getCapabilityEvents(capabilityKey) {
    const override = this.capabilityOverrides[capabilityKey];
    if (override?.events) return override.events;
    const cap = getCapabilityDefinition(capabilityKey);
    return cap?.events || {};
  }

  // 解析单个能力的有效定义（合并 override 与中心化控制协议定义）
  resolveCapability(capabilityKey) {
    const override = this.capabilityOverrides[capabilityKey] || {};
    const base = getCapabilityDefinition(capabilityKey) || { key: capabilityKey, name: capabilityKey };
    return {
      key: capabilityKey,
      name: override.name || base.name || capabilityKey,
      actions: override.actions || base.actions || {},
      value: override.value || base.value || null,
      monitorData: Array.isArray(override.monitorData)
        ? override.monitorData
        : getMonitorSpec(capabilityKey),
    };
  }

  resolveCapabilityValue(capabilityKey, props) {
    const value = this.resolveCapability(capabilityKey).value;
    return value ? resolveValue(value.source, props) : null;
  }

  getCapabilityValueWatch(capabilityKey) {
    const value = this.resolveCapability(capabilityKey).value;
    return Array.isArray(value?.watch) ? [...value.watch] : [];
  }

  // 聚合本设备所有能力对应的监控字段（数据源：monitorSpec 展示元数据，按 key 去重）
  getMonitorData() {
    const rows = [];
    const seen = new Set();
    for (const key of this.capabilityKeys) {
      for (const item of this.resolveCapability(key).monitorData) {
        if (!item?.key || seen.has(item.key)) continue;
        rows.push(item);
        seen.add(item.key);
      }
    }
    return rows;
  }

  // 对外暴露的能力配置（不含内部实现细节，如 events.watch/trigger）
  getCapabilityConfig() {
    const result = {};
    for (const key of this.capabilityKeys) {
      const cap = this.resolveCapability(key);
      result[key] = {
        key: cap.key,
        name: cap.name,
        actions: cap.actions,
        monitorData: cap.monitorData,
      };
    }
    return result;
  }

  createContext(deviceId, publishFn) {
    const self = this;
    return {
      deviceId,
      deviceType: self,
      writeProps(props) {
        const msg = { method: 'update', ...props };
        publishFn(deviceId, msg);
        return msg;
      },
      sendMessage(msg) {
        publishFn(deviceId, msg);
        return msg;
      },
      cap(capability, action, params) {
        return self.invokeCapability(deviceId, capability, action, params || {}, publishFn);
      },
    };
  }

  invokeCapability(deviceId, capabilityKey, actionName, input = {}, publishFn) {
    if (!this.hasCapability(capabilityKey)) {
      const err = new Error(`设备类型 ${this.type} 不支持能力: ${capabilityKey}`);
      err.code = 'DEVICE_CAPABILITY_NOT_SUPPORTED';
      throw err;
    }
    const action = this.getCapabilityAction(capabilityKey, actionName);
    if (typeof action !== 'function') {
      const err = new Error(`设备类型 ${this.type} 不支持能力动作: ${capabilityKey}.${actionName}`);
      err.code = 'DEVICE_CAPABILITY_ACTION_NOT_SUPPORTED';
      throw err;
    }
    const ctx = this.createContext(deviceId, publishFn);
    return action(ctx, input || {});
  }

  invokeOperation(deviceId, operationKey, params = {}, publishFn) {
    const operation = this.operations.find((op) => op && op.key === operationKey);
    if (!operation) {
      const err = new Error(`设备类型 ${this.type} 不支持操作: ${operationKey}`);
      err.code = 'DEVICE_OPERATION_NOT_SUPPORTED';
      throw err;
    }
    const ctx = this.createContext(deviceId, publishFn);
    if (typeof operation.invoke === 'function') {
      return operation.invoke(ctx, params || {});
    }
    if (operation.capability && operation.action) {
      const input = { ...(operation.input || {}), ...(params || {}) };
      return this.invokeCapability(deviceId, operation.capability, operation.action, input, publishFn);
    }
    const err = new Error(`设备操作未定义实现: ${operationKey}`);
    err.code = 'DEVICE_OPERATION_INVALID';
    throw err;
  }

  invokeClose(deviceId, publishFn) {
    if (!this.closeOp) return null;
    const ctx = this.createContext(deviceId, publishFn);
    if (typeof this.closeOp === 'function') {
      return this.closeOp(ctx);
    }
    return null;
  }

  getPublicOperations() {
    return this.operations.map((op) => ({
      key: op.key,
      name: op.name || op.key,
      capability: op.capability,
      action: op.action,
      input: op.input,
    }));
  }

  // 聚合本设备所有能力的测试段（start/loop/stop），用于自动化测试平台
  getTestPlan() {
    const start = [];
    const loop = [];
    const stop = [];
    let loopDelay = null;

    for (const key of this.capabilityKeys) {
      const cap = getCapabilityDefinition(key);
      const test = cap && cap.test;
      if (!test) continue;

      if (typeof test.start === 'function') start.push(test.start);
      if (Array.isArray(test.loop)) {
        for (const step of test.loop) {
          if (typeof step === 'function') loop.push(step);
        }
      }
      if (typeof test.stop === 'function') stop.push(test.stop);
      if (typeof test.loopDelay === 'number') {
        loopDelay = loopDelay === null ? test.loopDelay : Math.min(loopDelay, test.loopDelay);
      }
    }

    return { start, loop, stop, loopDelay: loopDelay === null ? 2000 : loopDelay };
  }

  // 执行单个测试步骤：用 context 调用测试函数（与 invokeCapability 复用同一机制）
  runTestStep(deviceId, fn, publishFn) {
    if (typeof fn !== 'function') return null;
    const ctx = this.createContext(deviceId, publishFn);
    return fn(ctx);
  }

  toConfig() {
    return {
      name: this.name,
      capabilities: this.getCapabilityKeys(),
      capabilityConfig: this.getCapabilityConfig(),
      monitorData: this.getMonitorData(),
      operations: this.getPublicOperations(),
    };
  }
}

module.exports = BaseDeviceType;
