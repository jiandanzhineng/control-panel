const {
  FRAME_TYPE_CONTROL,
  FRAME_TYPE_DATA,
  CONTROL_SET_OP_MODE,
  CONTROL_CONNECT_WIFI,
  DATA_STA_SSID,
  DATA_WIFI_STATUS,
  WIFI_SUCCESS,
  WIFI_FAIL,
  WIFI_REASON,
  WIFI_IP,
  MAX_CHUNK,
  textToBytes,
  parseWifiStatus,
  buildFrames,
  createNotificationParser,
  decodeFrame,
} = require('../../electron/blufi/protocol');

describe('BLUFI protocol', () => {
  it('builds control frames and preserves empty payloads', () => {
    expect([...buildFrames(5, FRAME_TYPE_CONTROL, CONTROL_SET_OP_MODE, Uint8Array.of(1))[0]])
      .toEqual([(CONTROL_SET_OP_MODE << 2) | FRAME_TYPE_CONTROL, 0, 5, 1, 1]);
    expect([...buildFrames(0, FRAME_TYPE_CONTROL, CONTROL_CONNECT_WIFI)[0]])
      .toEqual([(CONTROL_CONNECT_WIFI << 2) | FRAME_TYPE_CONTROL, 0, 0, 0]);
  });

  it('fragments and reassembles long UTF-8 payloads', () => {
    const payload = textToBytes('家里的 Wi-Fi-2.4G');
    const frames = buildFrames(7, FRAME_TYPE_DATA, DATA_STA_SSID, payload);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0][3]).toBe(MAX_CHUNK + 2);
    expect(frames.map((frame) => frame[2]))
      .toEqual(frames.map((_frame, index) => (7 + index) & 0xff));

    const parser = createNotificationParser();
    const decoded = frames.flatMap((frame) => parser.feed(frame));
    expect(decoded).toHaveLength(1);
    expect([...decoded[0].payload]).toEqual([...payload]);
  });

  it('parses success IP and failure reason from Wi-Fi status', () => {
    expect(parseWifiStatus(Uint8Array.from([
      1, WIFI_SUCCESS, 0, WIFI_IP, 4, 192, 168, 5, 31,
    ]))).toMatchObject({
      staStateName: 'connected',
      extras: { stationIp: '192.168.5.31' },
    });
    expect(parseWifiStatus(Uint8Array.from([
      1, WIFI_FAIL, 0, WIFI_REASON, 1, 7,
    ]))).toMatchObject({
      staStateName: 'failed',
      extras: { reason: 7 },
    });
  });

  it('decodes Wi-Fi status frames', () => {
    expect(decodeFrame({
      frameType: FRAME_TYPE_DATA,
      subtype: DATA_WIFI_STATUS,
      sequence: 2,
      payload: Uint8Array.from([1, WIFI_SUCCESS, 0]),
    })).toMatchObject({ kind: 'wifi_status', staState: WIFI_SUCCESS });
  });
});
