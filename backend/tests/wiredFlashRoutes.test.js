const express = require('express');
const request = require('supertest');

jest.mock('../services/wiredFlashService', () => ({
  listPorts: jest.fn(),
  identify: jest.fn(),
  getFirmwareForDevice: jest.fn(),
  startFlash: jest.fn(),
  getFlashStatus: jest.fn(),
}));

const wiredFlashService = require('../services/wiredFlashService');
const wiredFlashRouter = require('../routes/wiredFlash');

const app = express();
app.use(express.json());
app.use('/api/wired-flash', wiredFlashRouter);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('wiredFlash 路由', () => {
  test('GET /ports 返回端口列表', async () => {
    wiredFlashService.listPorts.mockResolvedValue([{ path: 'COM17', busy: false, deviceId: null }]);
    const res = await request(app).get('/api/wired-flash/ports');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ path: 'COM17', busy: false, deviceId: null }]);
  });

  test('POST /identify 透传 path 并返回识别结果', async () => {
    wiredFlashService.identify.mockResolvedValue({ path: 'COM17', identified: true, deviceType: 'QTZ', version: 'v1.1.38', mac: '6055f97c342c' });
    const res = await request(app).post('/api/wired-flash/identify').send({ path: 'COM17' });
    expect(res.status).toBe(200);
    expect(wiredFlashService.identify).toHaveBeenCalledWith('COM17');
    expect(res.body.deviceType).toBe('QTZ');
  });

  test('POST /identify 业务错误按 error.code + error.status 响应', async () => {
    const error = new Error('串口已被占用');
    error.code = 'SERIAL_PORT_BUSY';
    error.status = 409;
    wiredFlashService.identify.mockRejectedValue(error);
    const res = await request(app).post('/api/wired-flash/identify').send({ path: 'COM17' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'SERIAL_PORT_BUSY', message: '串口已被占用' } });
  });

  test('GET /firmware 透传查询参数', async () => {
    wiredFlashService.getFirmwareForDevice.mockResolvedValue({ supported: true });
    const res = await request(app).get('/api/wired-flash/firmware?deviceType=QTZ&currentVersion=v1.1.30');
    expect(res.status).toBe(200);
    expect(wiredFlashService.getFirmwareForDevice).toHaveBeenCalledWith('QTZ', 'v1.1.30');
  });

  test('POST /flash 返回 flashId', async () => {
    wiredFlashService.startFlash.mockResolvedValue({ flashId: 'flash-1' });
    const res = await request(app).post('/api/wired-flash/flash').send({ path: 'COM17', deviceType: 'QTZ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flashId: 'flash-1' });
    expect(wiredFlashService.startFlash).toHaveBeenCalledWith({ path: 'COM17', deviceType: 'QTZ' });
  });

  test('GET /flash/:flashId/status 未知任务返回 404', async () => {
    wiredFlashService.getFlashStatus.mockReturnValue(null);
    const res = await request(app).get('/api/wired-flash/flash/nope/status');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('FLASH_NOT_FOUND');
  });

  test('GET /flash/:flashId/status 返回任务状态', async () => {
    wiredFlashService.getFlashStatus.mockReturnValue({ flashId: 'flash-1', status: 'flashing', progress: 42 });
    const res = await request(app).get('/api/wired-flash/flash/flash-1/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('flashing');
  });
});
