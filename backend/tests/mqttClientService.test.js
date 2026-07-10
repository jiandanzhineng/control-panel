jest.mock('mqtt', () => ({
  connect: jest.fn(),
}));

jest.mock('../services/logService', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

function createClient() {
  const handlers = {};
  return {
    connected: true,
    on: jest.fn((event, cb) => {
      handlers[event] = cb;
    }),
    publish: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    end: jest.fn(),
    handlers,
  };
}

describe('mqttClientService', () => {
  let mqttClientService;
  let client;
  let mqtt;
  let logService;

  beforeEach(() => {
    jest.resetModules();
    client = createClient();
    mqtt = require('mqtt');
    logService = require('../services/logService');
    jest.clearAllMocks();
    mqtt.connect.mockReturnValue(client);
    mqttClientService = require('../services/mqttClientService');
  });

  afterEach(() => {
    try { mqttClientService.disconnect(); } catch (_) {}
  });

  function initConnectedClient() {
    mqttClientService.init();
    client.handlers.connect();
  }

  it('records full outbound audit log for object payloads', () => {
    initConnectedClient();

    mqttClientService.publish('/drecv/dev01', { method: 'update', power: 255 }, { qos: 1, retain: true });

    expect(client.publish).toHaveBeenCalledWith(
      '/drecv/dev01',
      '{"method":"update","power":255}',
      { qos: 1, retain: true },
      expect.any(Function)
    );
    expect(logService.info).toHaveBeenCalledWith(
      'mqttClient',
      'MQTT outbound queued - topic: /drecv/dev01, qos: 1, retain: true, payload: {"method":"update","power":255}'
    );
  });

  it('records full outbound audit log for string payloads', () => {
    initConnectedClient();

    mqttClientService.publish('/custom/topic', 'plain-text');

    expect(logService.info).toHaveBeenCalledWith(
      'mqttClient',
      'MQTT outbound queued - topic: /custom/topic, qos: 0, retain: false, payload: plain-text'
    );
  });

  it('records async publish failures with full outbound context', () => {
    initConnectedClient();
    client.publish.mockImplementation((topic, payload, options, cb) => cb(new Error('broker rejected')));

    mqttClientService.publish('/drecv/dev02', { method: 'stop' });

    expect(logService.warn).toHaveBeenCalledWith(
      'mqttClient',
      'MQTT outbound failed (async) - topic: /drecv/dev02, qos: 0, retain: false, payload: {"method":"stop"}, error: broker rejected, connected: true, clientState: true'
    );
  });

  it('records sync publish failures with full outbound context', () => {
    initConnectedClient();
    client.publish.mockImplementation(() => {
      throw new Error('socket closed');
    });

    expect(() => mqttClientService.publish('/drecv/dev03', { method: 'update', shock: 1 }))
      .toThrow('socket closed');

    expect(logService.error).toHaveBeenCalledWith(
      'mqttClient',
      'MQTT outbound failed (sync) - topic: /drecv/dev03, qos: 0, retain: false, payload: {"method":"update","shock":1}, error: socket closed, connected: true, clientConnected: true'
    );
  });

  it('rejects publishing before init', () => {
    expect(() => mqttClientService.publish('/drecv/dev04', { method: 'update' }))
      .toThrow('MQTT client not initialized');

    expect(client.publish).not.toHaveBeenCalled();
    expect(logService.info).not.toHaveBeenCalledWith(
      'mqttClient',
      expect.stringContaining('MQTT outbound queued')
    );
  });

  it('rejects publishing while disconnected', () => {
    mqttClientService.init();

    expect(() => mqttClientService.publish('/drecv/dev05', { method: 'update' }))
      .toThrow('MQTT client not connected');

    expect(client.publish).not.toHaveBeenCalled();
    expect(logService.info).not.toHaveBeenCalledWith(
      'mqttClient',
      expect.stringContaining('MQTT outbound queued')
    );
  });
});
