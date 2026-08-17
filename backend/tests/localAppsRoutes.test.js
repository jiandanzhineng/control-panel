const express = require('express');
const request = require('supertest');

jest.mock('../services/localAppService', () => ({
  listApps: jest.fn(),
  getStatus: jest.fn(),
  syncApp: jest.fn(),
}));
jest.mock('../services/localAppProcessService', () => ({
  getRunning: jest.fn(),
  startApp: jest.fn(),
  stopApp: jest.fn(),
}));

const localAppService = require('../services/localAppService');
const localAppProcessService = require('../services/localAppProcessService');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/local-apps', require('../routes/localApps'));
  return app;
}

describe('localApps routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists apps', async () => {
    localAppService.listApps.mockResolvedValue([{ id: 'digital-human', installed: false }]);
    const res = await request(createApp()).get('/api/local-apps');
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe('digital-human');
  });

  it('returns status with process info', async () => {
    localAppService.getStatus.mockResolvedValue({ id: 'digital-human', installed: true });
    localAppProcessService.getRunning.mockReturnValue({ running: false, id: 'digital-human' });
    const res = await request(createApp()).get('/api/local-apps/digital-human/status');
    expect(res.status).toBe(200);
    expect(res.body.process.running).toBe(false);
  });

  it('starts an installed app', async () => {
    localAppProcessService.startApp.mockResolvedValue({
      id: 'digital-human', running: true, url: 'http://127.0.0.1:8020/',
    });
    const res = await request(createApp()).post('/api/local-apps/digital-human/start');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(true);
  });
});
