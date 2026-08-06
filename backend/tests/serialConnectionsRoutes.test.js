const express = require('express');
const request = require('supertest');

jest.mock('../services/serialConnectionService', () => ({
  listPorts: jest.fn(),
  connect: jest.fn(),
  disconnectDevice: jest.fn(),
  getSettings: jest.fn(),
  setSettings: jest.fn(),
}));

const serial = require('../services/serialConnectionService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/serial', require('../routes/serialConnections'));
  return app;
}

describe('serial connection routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the port array and settings without wrappers', async () => {
    serial.listPorts.mockResolvedValue([{ path: 'COM5', status: 'idle' }]);
    serial.getSettings.mockReturnValue({ autoConnect: false });
    expect((await request(createApp()).get('/api/serial/ports')).body)
      .toEqual([{ path: 'COM5', status: 'idle' }]);
    expect((await request(createApp()).get('/api/serial/settings')).body)
      .toEqual({ autoConnect: false });
  });

  it('connects and disconnects a physical device', async () => {
    serial.connect.mockResolvedValue({
      id: 'aabbccddeeff', controlConnection: 'serial', connections: [{ type: 'serial' }],
    });
    serial.disconnectDevice.mockResolvedValue(true);
    const connected = await request(createApp()).post('/api/serial/connections').send({ path: 'COM5' });
    expect(connected.status).toBe(200);
    expect(connected.body.id).toBe('aabbccddeeff');
    expect(serial.connect).toHaveBeenCalledWith('COM5', { automatic: false });

    const disconnected = await request(createApp()).delete('/api/serial/connections/aabbccddeeff');
    expect(disconnected.status).toBe(200);
    expect(disconnected.body).toEqual({ ok: true });
  });

  it('persists settings and maps service errors', async () => {
    serial.setSettings.mockResolvedValue({ autoConnect: true });
    expect((await request(createApp()).put('/api/serial/settings').send({ autoConnect: true })).body)
      .toEqual({ autoConnect: true });

    const error = Object.assign(new Error('old firmware'), {
      code: 'SERIAL_IDENTITY_INVALID', status: 409,
    });
    serial.connect.mockRejectedValue(error);
    const failed = await request(createApp()).post('/api/serial/connections').send({ path: 'COM7' });
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('SERIAL_IDENTITY_INVALID');
  });
});
