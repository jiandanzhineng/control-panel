const express = require('express');
const request = require('supertest');

jest.mock('../services/remoteSessionService', () => ({
  isOperatorRemoteMode: jest.fn(() => false),
  projectionRoomId: jest.fn(() => null),
  command: jest.fn(async () => ({ ok: true, result: {} })),
}));

jest.mock('../services/deviceService', () => ({
  listDevicesForApi: jest.fn(() => []),
  getDeviceForApi: jest.fn(() => null),
}));

jest.mock('../services/nicknameService', () => ({
  getNickname: jest.fn(() => null),
  setNickname: jest.fn(),
}));

const remoteSession = require('../services/remoteSessionService');
const deviceService = require('../services/deviceService');
const nicknameService = require('../services/nicknameService');
const { remoteSessionFilter } = require('../middleware/remoteSessionFilter');

const ROOM_ID = 'room-proj-1';

// 一台本机 BLE 设备 + 一台本会话投影来的设备
const localDevice = {
  id: 'local-1',
  name: '本机设备',
  nickname: null,
  type: 'TD01',
  connected: true,
  controlConnection: 'ble',
  connections: [{ type: 'ble', connected: true }],
  data: {},
};
const projectedDevice = {
  id: 'remote-1',
  name: '被控端设备',
  nickname: '左',
  type: 'TD01',
  connected: true,
  controlConnection: 'remote',
  connections: [{ type: 'remote', connected: true, roomId: ROOM_ID, ownerUserId: 'owner' }],
  data: {},
};
// 别的会话投影来的设备（roomId 不同）同样不能出现
const otherProjected = {
  ...projectedDevice,
  id: 'remote-2',
  connections: [{ type: 'remote', connected: true, roomId: 'room-other', ownerUserId: 'owner' }],
};

function enableOperatorMode(enabled = true, roomId = ROOM_ID) {
  remoteSession.isOperatorRemoteMode.mockReturnValue(enabled);
  remoteSession.projectionRoomId.mockReturnValue(enabled ? roomId : null);
}

function createApp() {
  const app = express();
  app.use(express.json());
  // 未命中的路由落到这里：能看到请求说明中间件放行了
  app.use((req, res, next) => {
    res.setHeader('x-reached-route', '1');
    next();
  });
  app.use('/api', remoteSessionFilter);
  // 模拟真实路由的回包形状（只要中间件放行就会命中）
  app.get('/api/devices', (req, res) => res.json(deviceService.listDevicesForApi()));
  app.get('/api/devices/:id', (req, res) => {
    const device = deviceService.getDeviceForApi(req.params.id);
    if (!device) return res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND', message: '设备不存在' } });
    res.json(device);
  });
  app.patch('/api/devices/:id', (req, res) => {
    const device = deviceService.getDeviceForApi(req.params.id);
    if (!device) return res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND' } });
    nicknameService.setNickname(req.params.id, req.body?.name);
    res.json({ ...device, name: req.body?.name, nickname: nicknameService.getNickname(req.params.id) });
  });
  app.post('/api/devices/:id/nickname', (req, res) => {
    const device = deviceService.getDeviceForApi(req.params.id);
    if (!device) return res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND' } });
    nicknameService.setNickname(req.params.id, req.body?.nickname);
    res.json({ ...device, nickname: nicknameService.getNickname(req.params.id) });
  });
  app.put('/api/devices/:id/control-connection', (req, res) => {
    const device = deviceService.getDeviceForApi(req.params.id);
    if (!device) return res.status(404).json({ error: { code: 'DEVICE_NOT_FOUND' } });
    res.json({ ...device, controlConnection: req.body?.type });
  });
  app.post('/api/devices/:id/capabilities/:capability/actions/:action', (req, res) => res.json({ success: true }));
  app.all(/^\/api\/.*/, (req, res) => res.json({ reached: req.originalUrl }));
  return app;
}

function lockedRoutes() {
  return [
    ['get', '/api/serial/ports'],
    ['post', '/api/wired-flash/flash'],
    ['post', '/api/devices/dev-1/firmware/update-latest'],
    ['get', '/api/brands/discover'],
    ['post', '/api/brands/connect'],
    ['post', '/api/plugins/foo/activate'],
    ['post', '/api/local-apps/app/start'],
    ['post', '/api/mqtt/start'],
    ['post', '/api/mdns/publish'],
    ['post', '/api/voice/settings'],
    ['put', '/api/dev-access'],
    ['post', '/api/virtual-devices'],
    ['put', '/api/virtual-devices/dev-1/properties'],
    ['delete', '/api/virtual-devices/dev-1'],
    ['post', '/api/test/start'],
    ['post', '/api/device-watchdog/stop-all'],
    ['post', '/api/auth/login'],
    // 批量操作不走安全钳制，且 deviceIds 缺省会命中本机全部同类设备
    ['post', '/api/devices/batch/operations'],
    ['post', '/api/devices/firmware/batch/update-latest'],
    ['post', '/api/devices/firmware/batch/blink-latest'],
    // MQTT 直发可绕开设备白名单与安全钳制
    ['post', '/api/mqtt-client/publish'],
  ];
}

// 设备子路由：本机设备 / 别的会话设备 / 固件 一律 423；本会话投影设备放行
function deviceSubrouteCases() {
  return [
    ['get', '/api/devices/local-1/monitor-stream'],
    ['get', '/api/devices/local-1/monitor-data'],
    ['get', '/api/devices/local-1/message-stream'],
    ['post', '/api/devices/local-1/message'],
    ['post', '/api/devices/local-1/operations/lock'],
    ['post', '/api/devices/local-1/capabilities/shock/actions/start'],
    ['delete', '/api/devices/local-1'],
    ['get', '/api/devices/remote-2/monitor-stream'],
    ['post', '/api/devices/remote-2/capabilities/shock/actions/start'],
    ['get', '/api/devices/remote-1/firmware/latest'],
    ['post', '/api/devices/remote-1/firmware/update-latest'],
    ['get', '/api/devices/remote-1/firmware/status'],
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  enableOperatorMode(false);
  deviceService.listDevicesForApi.mockReturnValue([localDevice, projectedDevice, otherProjected]);
  deviceService.getDeviceForApi.mockImplementation((id) => (
    [localDevice, projectedDevice, otherProjected].find((device) => device.id === id) || null
  ));
  nicknameService.getNickname.mockReturnValue('左');
});

describe('remote session filter', () => {
  test('stays inactive outside operator remote mode', async () => {
    const app = createApp();
    await request(app).get('/api/devices').expect(200, [localDevice, projectedDevice, otherProjected]);
    await request(app).get('/api/devices/local-1').expect(200);
    await request(app).post('/api/mqtt/start').expect(200);
    await request(app).get('/api/serial/ports').expect(200);
    expect(remoteSession.command).not.toHaveBeenCalled();
  });

  test('hides local devices and devices from other projection rooms', async () => {
    enableOperatorMode();
    const app = createApp();
    const list = await request(app).get('/api/devices').expect(200);
    expect(list.body.map((device) => device.id)).toEqual(['remote-1']);

    await request(app).get('/api/devices/remote-1').expect(200, projectedDevice);
    await request(app).get('/api/devices/local-1').expect(404);
    await request(app).get('/api/devices/remote-2').expect(404);
  });

  test('forwards nickname and control-connection writes as room commands', async () => {
    enableOperatorMode();
    const app = createApp();

    await request(app)
      .patch('/api/devices/remote-1')
      .send({ name: '新名字' })
      .expect(200, { ...projectedDevice, name: '新名字', nickname: '左' });
    expect(remoteSession.command).toHaveBeenCalledWith({
      type: 'devices.rename',
      payload: { deviceId: 'remote-1', name: '新名字' },
    });

    await request(app)
      .post('/api/devices/remote-1/nickname')
      .send({ nickname: '右' })
      .expect(200, { ...projectedDevice, nickname: '左' });
    expect(remoteSession.command).toHaveBeenLastCalledWith({
      type: 'devices.rename',
      payload: { deviceId: 'remote-1', name: '右' },
    });

    await request(app)
      .put('/api/devices/remote-1/control-connection')
      .send({ type: 'mqtt' })
      .expect(200);
    expect(remoteSession.command).toHaveBeenLastCalledWith({
      type: 'devices.controlConnection.set',
      payload: { deviceId: 'remote-1', connectionType: 'mqtt' },
    });
  });

  test('rejects forwarded writes for devices outside the session', async () => {
    enableOperatorMode();
    const app = createApp();
    await request(app).patch('/api/devices/local-1').send({ name: 'x' }).expect(404);
    expect(remoteSession.command).not.toHaveBeenCalled();
  });

  test('surfaces command failures from the host', async () => {
    enableOperatorMode();
    remoteSession.command.mockResolvedValueOnce({ ok: false, code: 'CONTROL_NOT_AUTHORIZED', message: '未授权远控' });
    const app = createApp();
    const response = await request(app).patch('/api/devices/remote-1').send({ name: 'x' }).expect(400);
    expect(response.body.error.code).toBe('CONTROL_NOT_AUTHORIZED');
  });

  test('locks local-only APIs with 423 REMOTE_LOCKED', async () => {
    enableOperatorMode();
    const app = createApp();
    for (const [method, path] of lockedRoutes()) {
      const response = await request(app)[method](path);
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 423 });
      expect(response.body.error).toMatchObject({
        code: 'REMOTE_LOCKED',
        message: '远程控制中不可用，断开后可用',
      });
    }
  });

  test('locks device subroutes for local and foreign devices with 423', async () => {
    enableOperatorMode();
    const app = createApp();
    for (const [method, path] of deviceSubrouteCases()) {
      const response = await request(app)[method](path);
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 423 });
      expect(response.body.error.code).toBe('REMOTE_LOCKED');
    }
    // 本机设备在远程模式下连列表都进不来，更不该能被 ID 直接驱动
    expect(remoteSession.command).not.toHaveBeenCalled();
  });

  test('lets the session-projected device keep its subroutes', async () => {
    enableOperatorMode();
    const app = createApp();
    await request(app).get('/api/devices/remote-1/monitor-stream').expect(200);
    await request(app).post('/api/devices/remote-1/operations/lock').expect(200);
    await request(app)
      .post('/api/devices/remote-1/capabilities/shock/actions/start')
      .send({ input: { value: 5 } })
      .expect(200);
  });

  test('never locks the remote session, game, log and capability routes', async () => {
    enableOperatorMode();
    const app = createApp();
    await request(app).get('/api/remote-session/status').expect(200);
    await request(app).post('/api/remote-session/stop').expect(200);
    await request(app).get('/api/remote-game/status').expect(200);
    await request(app).get('/api/remote-projection/status').expect(200);
    await request(app).get('/api/logs/current').expect(200);
    await request(app).get('/api/games').expect(200);
    await request(app).post('/api/game-runtime/start').expect(200);
    await request(app)
      .post('/api/devices/remote-1/capabilities/strength/actions/set')
      .send({ input: { value: 10 } })
      .expect(200);
  });

  test('trailing slashes cannot bypass the device list filter', async () => {
    enableOperatorMode();
    const app = createApp();
    const list = await request(app).get('/api/devices/').expect(200);
    expect(list.body.map((device) => device.id)).toEqual(['remote-1']);
    await request(app).get('/api/devices/local-1/').expect(404);
  });

  test('lets read-only APIs pages need pass through', async () => {
    enableOperatorMode();
    const app = createApp();
    await request(app).get('/api/brands/status').expect(200);
    await request(app).get('/api/brands/settings').expect(200);
    await request(app).get('/api/serial/settings').expect(200);
    await request(app).get('/api/mqtt/status').expect(200);
    await request(app).get('/api/mdns/status').expect(200);
    await request(app).get('/api/voice/status').expect(200);
    await request(app).get('/api/dev-access').expect(200);
    await request(app).get('/api/plugins').expect(200);
    await request(app).get('/api/local-apps').expect(200);
    await request(app).get('/api/virtual-devices/dev-1/properties').expect(200);
    await request(app).get('/api/wired-flash/ports').expect(200);
  });
});
