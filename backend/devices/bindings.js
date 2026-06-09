// Legacy compatibility - bindings are now handled directly by capabilities.js
// This file re-exports capability definitions for backward compatibility

const capabilities = require('./capabilities');

module.exports = {
  ...capabilities,
};
