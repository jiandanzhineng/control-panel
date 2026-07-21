const fs = require('fs');
const path = require('path');
const vm = require('vm');

const bridgePath = path.join(__dirname, '..', 'public', 'device-api-bridge.js');

class FakeWebSocket {
  constructor() {
    this.readyState = 1;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
}
FakeWebSocket.instances = [];

function reply(ws, request, result) {
  ws.onmessage({ data: JSON.stringify({ id: request.id, result }) });
}

describe('browser DeviceAPI capability values', () => {
  it('reads values and dispatches value subscriptions', async () => {
    const context = {
      window: {},
      document: { getElementById: () => null },
      location: { protocol: 'http:', host: 'localhost:5278', search: '' },
      WebSocket: FakeWebSocket,
      URLSearchParams,
      Promise,
      Map,
      setTimeout: jest.fn(),
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(bridgePath, 'utf8'), context);
    const ws = FakeWebSocket.instances[0];
    ws.onopen();
    reply(ws, ws.sent[0], { ready: true });

    const sensor = context.window.DeviceAPI.device('sensor');
    const callback = jest.fn();
    sensor.onValue('tiptoePressure', callback);
    expect(ws.sent.at(-1)).toMatchObject({
      action: 'subscribeValue',
      deviceId: 'sensor',
      capability: 'tiptoePressure',
    });

    ws.onmessage({ data: JSON.stringify({
      event: 'capabilityValueChange',
      deviceId: 'sensor',
      capability: 'tiptoePressure',
      value: 200,
      oldValue: 0,
      physicalId: 'qtz-1',
    }) });
    expect(callback).toHaveBeenCalledWith(200, 0, 'qtz-1');

    const readPromise = sensor.readValue('tiptoePressure');
    const readRequest = ws.sent.at(-1);
    expect(readRequest).toMatchObject({
      action: 'readValue',
      deviceId: 'sensor',
      capability: 'tiptoePressure',
    });
    reply(ws, readRequest, [200]);
    await expect(readPromise).resolves.toEqual([200]);
  });
});
