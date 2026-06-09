const { getCapabilityDefinition } = require('./capabilities');

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

  toConfig() {
    return {
      type: this.type,
      name: this.name,
      capabilities: this.getCapabilityKeys(),
      operations: this.getPublicOperations(),
    };
  }
}

module.exports = BaseDeviceType;
