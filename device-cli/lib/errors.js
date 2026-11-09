'use strict';

class UsageError extends Error {
  constructor(message, command = null) {
    super(message);
    this.name = 'UsageError';
    this.code = 'USAGE_ERROR';
    this.command = command;
    this.exitCode = 2;
  }
}

class ApiError extends Error {
  constructor(message, { code = 'API_ERROR', status = 0, data = null, path = '', url = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.data = data;
    this.path = path;
    this.url = url;
    this.exitCode = 1;
  }
}

function errorBody(error) {
  return {
    ok: false,
    error: {
      code: error?.code || 'ERROR',
      message: error?.message || String(error),
      status: Number(error?.status) || 0
    }
  };
}

module.exports = { UsageError, ApiError, errorBody };
