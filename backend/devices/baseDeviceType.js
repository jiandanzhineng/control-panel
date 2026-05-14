const { getCapabilityDefinition, validateActionInput } = require('./capabilities');

class BaseDeviceType {
  constructor({ type, name, capabilities = {}, operations = [], test_operations = null }) {
    if (!type) throw new Error('Device type requires type');
    this.type = type;
    this.name = name || type;
    this.capabilities = new Map();
    for (const [key, binding] of Object.entries(capabilities || {})) {
      if (!binding || typeof binding !== 'object') continue;
      this.capabilities.set(key, { key, ...binding });
    }
    this.operations = Array.isArray(operations) ? operations : [];
    this.test_operations = test_operations || null;
  }

  update(payload = {}) {
    return { method: 'update', ...(payload || {}) };
  }

  hasCapability(key) {
    return this.capabilities.has(key);
  }

  getCapability(key) {
    return this.capabilities.get(key) || null;
  }

  getCapabilityKeys() {
    return Array.from(this.capabilities.keys());
  }

  createContext(device) {
    return {
      device,
      deviceType: this,
      update: (payload) => this.update(payload),
    };
  }

  invokeCapability(device, capabilityKey, actionName, input = {}) {
    const binding = this.getCapability(capabilityKey);
    if (!binding) {
      const err = new Error(`设备类型 ${this.type} 不支持能力: ${capabilityKey}`);
      err.code = 'DEVICE_CAPABILITY_NOT_SUPPORTED';
      throw err;
    }
    const action = binding.actions?.[actionName];
    if (typeof action !== 'function') {
      const err = new Error(`设备类型 ${this.type} 不支持能力动作: ${capabilityKey}.${actionName}`);
      err.code = 'DEVICE_CAPABILITY_ACTION_NOT_SUPPORTED';
      throw err;
    }
    validateActionInput(capabilityKey, actionName, input || {});
    return action(this.createContext(device), input || {});
  }

  invokeOperation(device, operationKey, params = {}) {
    const operation = this.operations.find((op) => op && op.key === operationKey);
    if (!operation) {
      const err = new Error(`设备类型 ${this.type} 不支持操作: ${operationKey}`);
      err.code = 'DEVICE_OPERATION_NOT_SUPPORTED';
      throw err;
    }
    if (typeof operation.invoke === 'function') {
      return operation.invoke(this.createContext(device), params || {});
    }
    if (operation.capability && operation.action) {
      const input = { ...(operation.input || {}), ...(params || {}) };
      return this.invokeCapability(device, operation.capability, operation.action, input);
    }
    if (operation.message) {
      return operation.message;
    }
    const err = new Error(`设备操作未定义实现: ${operationKey}`);
    err.code = 'DEVICE_OPERATION_INVALID';
    throw err;
  }

  getMonitorData() {
    const rows = [];
    const seen = new Set();
    for (const binding of this.capabilities.values()) {
      for (const item of binding.monitorData || []) {
        if (!item?.key || seen.has(item.key)) continue;
        rows.push(item);
        seen.add(item.key);
      }
    }
    return rows;
  }

  getPublicOperations() {
    return this.operations.map((operation) => ({
      key: operation.key,
      name: operation.name || operation.key,
      capability: operation.capability,
      action: operation.action,
      input: operation.input,
    }));
  }

  getCapabilityConfig() {
    const result = {};
    for (const [key, binding] of this.capabilities.entries()) {
      const definition = getCapabilityDefinition(key) || { key, name: key };
      result[key] = {
        key,
        name: definition.name || key,
        actions: definition.actions || {},
        properties: definition.properties || [],
        monitorData: binding.monitorData || [],
      };
    }
    return result;
  }

  toConfig() {
    const config = {
      name: this.name,
      capabilities: this.getCapabilityKeys(),
      capabilityConfig: this.getCapabilityConfig(),
      monitorData: this.getMonitorData(),
      operations: this.getPublicOperations(),
    };
    if (this.test_operations) config.test_operations = this.test_operations;
    return config;
  }
}

module.exports = BaseDeviceType;
