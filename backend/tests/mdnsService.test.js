const os = require('os');

jest.mock('dgram', () => ({
  createSocket: jest.fn(() => {
    const EventEmitter = require('events');
    const socket = new EventEmitter();
    socket.addMembership = jest.fn();
    socket.setMulticastInterface = jest.fn();
    socket.setMulticastTTL = jest.fn();
    socket.send = jest.fn((...args) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') setImmediate(() => callback(null));
    });
    socket.bind = jest.fn(() => setImmediate(() => socket.emit('listening')));
    socket.close = jest.fn((callback) => {
      if (callback) setImmediate(callback);
    });
    return socket;
  }),
}));

const dgram = require('dgram');
const mdnsService = require('../services/mdnsService');

const interfaces = {
  'vEthernet (WSL)': [
    { address: '172.20.0.1', family: 'IPv4', internal: false },
  ],
  'Bluetooth Network': [
    { address: '169.254.10.2', family: 'IPv4', internal: false },
  ],
  Ethernet: [
    { address: '192.168.5.39', family: 'IPv4', internal: false },
  ],
  WiFi: [
    { address: '192.168.6.10', family: 'IPv4', internal: false },
  ],
};

describe('mdnsService', () => {
  beforeEach(() => {
    jest.spyOn(os, 'networkInterfaces').mockReturnValue(interfaces);
  });

  afterEach(async () => {
    await mdnsService.unpublish();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('filters virtual adapters and prefers Wi-Fi over Ethernet', () => {
    expect(mdnsService.selectBinding(interfaces, {})).toEqual({
      interface: 'WiFi',
      ip: '192.168.6.10',
    });
  });

  it('supports an explicit physical interface or IPv4', () => {
    expect(mdnsService.selectBinding(interfaces, { MDNS_INTERFACE: 'Ethernet' })).toEqual({
      interface: 'Ethernet',
      ip: '192.168.5.39',
    });
    expect(mdnsService.selectBinding(interfaces, { MDNS_IPV4: '172.20.0.1' })).toBeNull();
  });

  it('publishes with a native UDP socket and reports its selected address', async () => {
    const result = await mdnsService.publish();
    const socket = dgram.createSocket.mock.results[0].value;

    expect(result).toMatchObject({
      pid: process.pid,
      running: true,
      ip: '192.168.6.10',
      interface: 'WiFi',
    });
    expect(dgram.createSocket).toHaveBeenCalledWith({ type: 'udp4', reuseAddr: true });
    expect(socket.bind).toHaveBeenCalledWith({
      port: 5353,
      address: '0.0.0.0',
      exclusive: false,
    });
    expect(socket.addMembership).toHaveBeenCalledWith('224.0.0.251', '192.168.6.10');
    expect(socket.setMulticastInterface).toHaveBeenCalledWith('192.168.6.10');

    expect(mdnsService.status()).toMatchObject({ running: true, ip: '192.168.6.10' });
    await mdnsService.unpublish();
    expect(mdnsService.status().running).toBe(false);
    expect(socket.close).toHaveBeenCalled();
  });

  it('answers a legacy query by unicast to its random source port', async () => {
    await mdnsService.publish();
    const socket = dgram.createSocket.mock.results[0].value;
    const query = Buffer.from([
      0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
      9, ...Buffer.from('easysmart'), 5, ...Buffer.from('local'), 0,
      0, 1, 0, 1,
    ]);

    socket.emit('message', query, { address: '192.168.5.80', port: 49152 });

    const responseCall = socket.send.mock.calls.at(-1);
    const response = responseCall[0];
    expect(responseCall.slice(1, 3)).toEqual([49152, '192.168.5.80']);
    expect(response.readUInt16BE(0)).toBe(0x1234);
    expect(response.readUInt16BE(4)).toBe(1);
    expect(response.readUInt16BE(6)).toBe(1);
  });
});
