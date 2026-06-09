const registry = require('../devices/registry');

const deviceTypeMap = registry.getDeviceTypeMap();
const deviceTypeConfig = registry.getAllDeviceTypeConfigs();

const typeCapabilityMap = registry.getTypeCapabilityMap();

function getDeviceTypeName(type) {
  return registry.getDeviceTypeName(type);
}

function getAllDeviceTypes() {
  return registry.getAllDeviceTypes();
}

function isValidDeviceType(type) {
  return registry.isValidDeviceType(type);
}

function getDeviceOperations(type) {
  return registry.getDeviceOperations(type);
}

function hasOperations(type) {
  return getDeviceOperations(type).length > 0;
}

function getDeviceTypeConfig(type) {
  return registry.getDeviceTypeConfig(type);
}

function getAllDeviceTypeConfigs() {
  return registry.getAllDeviceTypeConfigs();
}

function getCapabilityName(capability) {
  return registry.getCapabilityName(capability);
}

function getAllCapabilities() {
  return registry.getAllCapabilities();
}

function getCapabilityConfig(capability) {
  return registry.getCapabilityDefinition(capability);
}

function getTypeCapabilities(type) {
  return registry.getDeviceCapabilities(type);
}

function hasCapability(type, capability) {
  return registry.hasCapability(type, capability);
}

function hasCapabilities(type, capabilities) {
  return registry.hasCapabilities(type, capabilities);
}

function getTypesByCapability(capability) {
  return registry.getTypesByCapability(capability);
}

module.exports = {
  deviceTypeMap,
  deviceTypeConfig,
  getDeviceTypeName,
  getAllDeviceTypes,
  isValidDeviceType,
  getDeviceOperations,
  hasOperations,
  getDeviceTypeConfig,
  getAllDeviceTypeConfigs,
  typeCapabilityMap,
  getCapabilityName,
  getAllCapabilities,
  getCapabilityConfig,
  getTypeCapabilities,
  hasCapability,
  hasCapabilities,
  getTypesByCapability,
};
