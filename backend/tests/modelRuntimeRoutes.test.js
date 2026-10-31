const express = require('express');
const request = require('supertest');

jest.mock('../services/localSessionService', () => ({ isLoopback: () => true }));
jest.mock('../model-runtime', () => {
  const models = [{ id: 'sense', task: 'asr' }];
  return {
    catalog: { list: () => models, get: (id) => models.find((m) => m.id === id) || null },
    allSettings: jest.fn(() => Object.create(null)),
    updateSettings: jest.fn((task, patch) => ({ task, ...patch })),
  };
});

const modelRuntime = require('../model-runtime');
const router = require('../routes/models');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/models', router);
  return instance;
}

describe('POST /api/models/settings', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects task names that are not in the catalog, including __proto__', async () => {
    const response = await request(app())
      .post('/api/models/settings')
      .set('Content-Type', 'application/json')
      .send('{"tasks":{"__proto__":{"localEnabled":true}}}')
      .expect(400);
    expect(response.body.error.code).toBe('INVALID_TASK');
    expect(modelRuntime.updateSettings).not.toHaveBeenCalled();
    expect({}.localEnabled).toBeUndefined();
  });

  test('accepts a known task and only passes the three supported fields', async () => {
    await request(app())
      .post('/api/models/settings')
      .send({ tasks: { asr: { localEnabled: true, provider: 'cpu', model: null, __proto__: { x: 1 } } } })
      .expect(200);
    expect(modelRuntime.updateSettings).toHaveBeenCalledWith('asr', {
      localEnabled: true, model: null, provider: 'cpu',
    });
  });

  test('rejects a model that does not belong to the task', async () => {
    const response = await request(app())
      .post('/api/models/settings')
      .send({ tasks: { asr: { model: 'other' } } })
      .expect(400);
    expect(response.body.error.code).toBe('BAD_MODEL');
  });
});
