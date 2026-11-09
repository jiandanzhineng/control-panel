const express = require('express');
const request = require('supertest');

const agentControl = require('../services/agentControlService');
const { agentRequestFilter, AGENT_CLIENT_HEADER } = require('../middleware/agentRequestFilter');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', agentRequestFilter);
  app.use('/api/agent-control', require('../routes/agentControl'));
  app.post('/api/devices/:id/capabilities/:cap/actions/:action', (req, res) => {
    res.json({ agentClientId: req.agentClientId || null });
  });
  app.post('/api/devices/:id/message', (req, res) => res.json({ agentClientId: req.agentClientId || null }));
  app.post('/api/client/games/:id/launch', (req, res) => res.json({ agentClientId: req.agentClientId || null }));
  app.post('/api/client/screenshot', (req, res) => res.json({ agentClientId: req.agentClientId || null }));
  return app;
}

describe('agent-control HTTP interface', () => {
  beforeEach(() => {
    agentControl._resetForTests();
  });

  afterEach(() => {
    agentControl._resetForTests();
  });

  it('creates, reports and releases a lease', async () => {
    const app = createApp();
    const created = await request(app)
      .post('/api/agent-control/lease')
      .send({ clientId: 'dsh-1', ttlSec: 30, limits: { default: 60, capabilities: { shock: 20 } } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      ok: true,
      clientId: 'dsh-1',
      ttlSec: 30,
      limits: { default: 60, capabilities: { strength: 60, shock: 20 } },
    });

    const status = await request(app).get('/api/agent-control/status');
    expect(status.body).toMatchObject({ active: true, leases: [expect.objectContaining({ clientId: 'dsh-1' })] });

    const released = await request(app).delete('/api/agent-control/lease/dsh-1');
    expect(released.body).toMatchObject({ ok: true, released: true });
    expect((await request(app).get('/api/agent-control/status')).body.leases).toEqual([]);
  });

  it('returns 400 for invalid lease bodies', async () => {
    const app = createApp();
    const badId = await request(app).post('/api/agent-control/lease').send({ clientId: 'bad id' });
    expect(badId.status).toBe(400);
    expect(badId.body.error.code).toBe('INVALID_CLIENT_ID');
    const badTtl = await request(app).post('/api/agent-control/lease').send({ clientId: 'dsh-1', ttlSec: 4 });
    expect(badTtl.status).toBe(400);
    expect(badTtl.body.error.code).toBe('INVALID_TTL_SECONDS');
  });

  it('returns 428 for agent device writes without a lease', async () => {
    const response = await request(createApp())
      .post('/api/devices/dev-1/capabilities/strength/actions/set')
      .set(AGENT_CLIENT_HEADER, 'dsh-1')
      .send({ input: { value: 100 } });
    expect(response.status).toBe(428);
    expect(response.body.error.code).toBe('AGENT_LEASE_REQUIRED');
  });

  it('lets agent device writes through when the lease is active', async () => {
    const app = createApp();
    await request(app).post('/api/agent-control/lease').send({ clientId: 'dsh-1', limits: { default: 60 } });
    const response = await request(app)
      .post('/api/devices/dev-1/capabilities/strength/actions/set')
      .set(AGENT_CLIENT_HEADER, 'dsh-1')
      .send({ input: { value: 100 } });
    expect(response.status).toBe(200);
    expect(response.body.agentClientId).toBe('dsh-1');
  });

  it('does not require a lease for reads, screenshots, or stop requests', async () => {
    const app = createApp();
    const read = await request(app).get('/api/agent-control/status').set(AGENT_CLIENT_HEADER, 'dsh-1');
    expect(read.status).toBe(200);

    const screenshot = await request(app).post('/api/client/screenshot').set(AGENT_CLIENT_HEADER, 'dsh-1').send({});
    expect(screenshot.status).toBe(200);

    const stop = await request(app)
      .post('/api/devices/dev-1/capabilities/strength/actions/stop')
      .set(AGENT_CLIENT_HEADER, 'dsh-1')
      .send({});
    expect(stop.status).toBe(200);
  });

  it('allows lease renewal even if the previous lease already expired', async () => {
    const app = createApp();
    const response = await request(app)
      .post('/api/agent-control/lease')
      .set(AGENT_CLIENT_HEADER, 'dsh-1')
      .send({ clientId: 'dsh-1', limits: { default: 60 } });
    expect(response.status).toBe(200);
  });

  it('rejects a malformed X-Agent-Client header', async () => {
    const response = await request(createApp())
      .post('/api/devices/dev-1/message')
      .set(AGENT_CLIENT_HEADER, 'bad id')
      .send({ message: { method: 'update' } });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_CLIENT_ID');
  });
});
