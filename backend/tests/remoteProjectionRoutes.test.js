jest.mock('../services/remoteProjectionService', () => ({
  getStatus: jest.fn(() => ({ active: false })),
  create: jest.fn(async () => ({ active: true, role: 'owner' })),
  join: jest.fn(async () => ({ active: true, role: 'operator' })),
  stop: jest.fn(async () => ({ active: false })),
}));

const express = require('express');
const request = require('supertest');
const service = require('../services/remoteProjectionService');
const router = require('../routes/remoteProjection');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/remote-projection', router);
  return app;
}

test('remote projection routes forward auth and room inputs', async () => {
  const app = createApp();
  await request(app).get('/api/remote-projection/status').expect(200, { active: false });
  await request(app)
    .post('/api/remote-projection/create')
    .set('authorization', 'Bearer owner-token')
    .send({ controlTtlSec: 600, limits: { voltage: 18, power: 100 } })
    .expect(201, { active: true, role: 'owner' });
  expect(service.create).toHaveBeenCalledWith(expect.objectContaining({
    token: 'owner-token', controlTtlSec: 600, limits: { voltage: 18, power: 100 },
  }));

  await request(app)
    .post('/api/remote-projection/join')
    .set('authorization', 'Bearer operator-token')
    .send({ joinCode: 'ROOM-CODE' })
    .expect(200, { active: true, role: 'operator' });
  expect(service.join).toHaveBeenCalledWith({ token: 'operator-token', joinCode: 'ROOM-CODE' });

  await request(app).post('/api/remote-projection/stop').expect(200, { active: false });
  expect(service.stop).toHaveBeenCalledTimes(1);
});
