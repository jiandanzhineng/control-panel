const request = require('supertest');
const app = require('../index');

jest.setTimeout(20000);

function pickCandidateIp(rows) {
  const ips = Array.isArray(rows) ? rows.filter((x) => x && x.ip && x.ip !== '127.0.0.1') : [];
  return ips.length ? ips[0].ip : null;
}

describe('Backend API (Express)', () => {
  it('GET /api should be OK', async () => {
    const res = await request(app).get('/api');
    expect(res.status).toBe(200);
    expect(typeof res.text).toBe('string');
  });

  it('MQTT status/start/stop should respond (skip running assertions when env missing)', async () => {
    let res = await request(app).get('/api/mqtt/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.running).toBe('boolean');

    // Try start (may fail if mosquitto not installed)
    res = await request(app)
      .post('/api/mqtt/start')
      .send({ port: 1883, bind: '0.0.0.0' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    // wait a little and check status again
    await new Promise((r) => setTimeout(r, 250));
    res = await request(app).get('/api/mqtt/status');
    expect(res.status).toBe(200);
    expect(typeof res.body.running).toBe('boolean');

    // Stop should set running=false (even if not actually started)
    res = await request(app).post('/api/mqtt/stop');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('running', false);
  });

  it('GET /network/ips should return an array with IPv4 items', async () => {
    const res = await request(app).get('/api/network/ips');
    expect([200, 500]).toContain(res.status); // env without IPv4 may return 500 per route logic
    if (res.status === 200) {
      expect(Array.isArray(res.body)).toBe(true);
      for (const r of res.body) {
        expect(typeof r.ip).toBe('string');
        expect(r.ip).not.toBe('127.0.0.1');
        expect(typeof r.cidr).toBe('number');
        expect(r.cidr).toBeGreaterThanOrEqual(1);
        expect(r.cidr).toBeLessThanOrEqual(32);
        expect(typeof r.interface).toBe('string');
        expect(r.interface.length).toBeGreaterThan(0);
      }
    }
  });

  it('mDNS publish/status/unpublish should respond (skip when env missing)', async () => {
    // First, get candidate IP
    const net = await request(app).get('/api/network/ips');
    if (net.status !== 200 || !Array.isArray(net.body) || net.body.length === 0) {
      // No IPv4 available, skip
      return;
    }
    const candidateIp = pickCandidateIp(net.body);
    if (!candidateIp) return;

    // Try publish
    let res = await request(app)
      .post('/api/mdns/publish')
      .send({ ip: candidateIp })
      .set('Content-Type', 'application/json');

    // If failed (missing python/zeroconf), just skip assertions
    if (res.status !== 200 || (res.body && res.body.error)) {
      return;
    }

    const id = res.body.id;
    expect(res.body.running).toBe(true);
    expect(typeof res.body.pid).toBe('number');

    // status
    res = await request(app).get('/api/mdns/status');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // unpublish
    res = await request(app)
      .post('/api/mdns/unpublish')
      .send({ id })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.running).toBe(false);
  });
});