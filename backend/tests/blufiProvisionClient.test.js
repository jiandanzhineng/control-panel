const { BlufiProvisionClient, validateCredentials } = require('../../electron/blufi/provisionClient');
const {
  BLUFI_UUIDS,
  FRAME_TYPE_DATA,
  DATA_WIFI_STATUS,
  WIFI_SUCCESS,
  buildFrames,
} = require('../../electron/blufi/protocol');

function makeGatt() {
  let notificationListener;
  const notify = {
    addEventListener: jest.fn((_event, listener) => { notificationListener = listener; }),
    removeEventListener: jest.fn(),
    startNotifications: jest.fn().mockResolvedValue(undefined),
  };
  const write = {
    writeValueWithResponse: jest.fn(async (frame) => {
      const subtype = frame[0] >> 2;
      const frameType = frame[0] & 0x03;
      if (frameType === 0 && subtype === 5) {
        const status = buildFrames(
          20,
          FRAME_TYPE_DATA,
          DATA_WIFI_STATUS,
          Uint8Array.from([1, WIFI_SUCCESS, 0, 0x18, 4, 192, 168, 5, 31]),
        )[0];
        const view = new DataView(status.buffer, status.byteOffset, status.byteLength);
        queueMicrotask(() => notificationListener({ target: { value: view } }));
      }
    }),
  };
  const service = {
    getCharacteristic: jest.fn(async (uuid) => (uuid === BLUFI_UUIDS.write ? write : notify)),
  };
  const server = {
    getPrimaryService: jest.fn().mockResolvedValue(service),
    disconnect: jest.fn(),
  };
  const device = {
    name: 'BLUFI_DEVICE',
    gatt: { connect: jest.fn().mockResolvedValue(server) },
  };
  return { device, server, write };
}

describe('BLUFI provision client', () => {
  it('rejects invalid credential byte lengths', () => {
    expect(() => validateCredentials('', '')).toThrow('Wi-Fi 名称');
    expect(() => validateCredentials('x'.repeat(33), '')).toThrow('32 字节');
    expect(() => validateCredentials('wifi', 'x'.repeat(65))).toThrow('64 字节');
  });

  it('writes credentials and resolves after the device reports an IP', async () => {
    const { device, server, write } = makeGatt();
    const requestDevice = jest.fn().mockResolvedValue(device);
    const statuses = [];
    const client = new BlufiProvisionClient({
      bluetooth: { requestDevice },
      onStatus: (status) => statuses.push(status),
      pollTimeoutMs: 100,
      responseTimeoutMs: 50,
      writeDelayMs: 0,
      retryDelayMs: 0,
    });

    await expect(client.provision({ ssid: 'Firesuiry', password: '11111111' }))
      .resolves.toEqual({ ok: true, deviceName: 'BLUFI_DEVICE', stationIp: '192.168.5.31' });
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ namePrefix: 'BLUFI' }],
      optionalServices: [BLUFI_UUIDS.service],
    });
    expect(write.writeValueWithResponse).toHaveBeenCalled();
    expect(statuses.map((status) => status.stage)).toEqual([
      'selecting', 'connecting', 'writing', 'joining', 'success',
    ]);
    expect(server.disconnect).toHaveBeenCalled();
  });
});
