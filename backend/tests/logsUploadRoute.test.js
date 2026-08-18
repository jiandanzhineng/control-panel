const express = require('express');
const request = require('supertest');

jest.mock('../services/diagnosticUploadService', () => ({
  uploadDiagnostics: jest.fn(),
}));

const diagnosticUploadService = require('../services/diagnosticUploadService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/logs', require('../routes/logs'));
  return app;
}

describe('logs upload route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the uploaded bundle id', async () => {
    diagnosticUploadService.uploadDiagnostics.mockResolvedValue({ id: 'bundle-12345678' });
    const res = await request(createApp()).post('/api/logs/upload-diagnostics');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 'bundle-12345678' });
  });

  it('forwards rate-limit errors', async () => {
    const error = new Error('too many');
    error.status = 429;
    error.code = 'TOO_MANY_REQUESTS';
    diagnosticUploadService.uploadDiagnostics.mockRejectedValue(error);
    const res = await request(createApp()).post('/api/logs/upload-diagnostics');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});
