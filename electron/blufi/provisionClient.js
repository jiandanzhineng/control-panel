const {
  BLUFI_UUIDS,
  FRAME_TYPE_CONTROL,
  FRAME_TYPE_DATA,
  CONTROL_SET_SEC_MODE,
  CONTROL_SET_OP_MODE,
  CONTROL_CONNECT_WIFI,
  CONTROL_GET_WIFI_STATUS,
  DATA_STA_SSID,
  DATA_STA_PASSWORD,
  WIFI_SUCCESS,
  WIFI_FAIL,
  textToBytes,
  buildFrames,
  createNotificationParser,
  decodeFrame,
} = require('./protocol');

const { formatElectronText } = require('../locale');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function bytesFromDataView(value) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

async function writeCharacteristic(characteristic, value) {
  if (typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(value);
  } else if (typeof characteristic.writeValue === 'function') {
    await characteristic.writeValue(value);
  } else {
    throw new Error('BLUFI write characteristic is not writable');
  }
}

function t(locale, key, vars) {
  return formatElectronText(locale === 'en' ? 'en' : 'zh', key, vars);
}

function validateCredentials(ssid, password, locale = 'zh') {
  const ssidBytes = textToBytes(ssid);
  const passwordBytes = textToBytes(password);
  if (ssidBytes.length === 0) throw new Error(t(locale, 'wifiNameRequired'));
  if (ssidBytes.length > 32) throw new Error(t(locale, 'wifiNameTooLong'));
  if (passwordBytes.length > 64) throw new Error(t(locale, 'wifiPasswordTooLong'));
  return { ssidBytes, passwordBytes };
}

class BlufiProvisionClient {
  constructor({
    bluetooth,
    onStatus = () => {},
    pollTimeoutMs = 45000,
    responseTimeoutMs = 6000,
    writeDelayMs = 60,
    retryDelayMs = 800,
    locale = 'zh',
  } = {}) {
    this.bluetooth = bluetooth;
    this.onStatus = onStatus;
    this.pollTimeoutMs = pollTimeoutMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.writeDelayMs = writeDelayMs;
    this.retryDelayMs = retryDelayMs;
    this.locale = locale === 'en' ? 'en' : 'zh';
  }

  status(stage, message, detail = '') {
    try { this.onStatus({ stage, message, detail }); } catch (_) {}
  }

  async provision({ ssid, password }) {
    if (!this.bluetooth?.requestDevice) {
      const error = new Error(t(this.locale, 'provisionUnsupported'));
      error.code = 'BLUFI_NOT_SUPPORTED';
      throw error;
    }
    const { ssidBytes, passwordBytes } = validateCredentials(ssid, password, this.locale);

    this.status('selecting', t(this.locale, 'selectProvisionDevice'));
    const device = await this.bluetooth.requestDevice({
      filters: [{ namePrefix: 'BLUFI' }],
      optionalServices: [BLUFI_UUIDS.service],
    });
    const deviceName = device.name || t(this.locale, 'blufiDevice');
    this.status('connecting', t(this.locale, 'connectingName', { name: deviceName }));

    const server = await device.gatt.connect();
    let notifyCharacteristic = null;
    let notificationListener = null;
    try {
      const service = await server.getPrimaryService(BLUFI_UUIDS.service);
      const writeCharacteristicRef = await service.getCharacteristic(BLUFI_UUIDS.write);
      notifyCharacteristic = await service.getCharacteristic(BLUFI_UUIDS.notify);

      const parser = createNotificationParser();
      const queue = [];
      let waiter = null;
      const pushDecoded = (decoded) => {
        if (waiter && waiter.predicate(decoded)) {
          const pending = waiter;
          waiter = null;
          clearTimeout(pending.timer);
          pending.resolve(decoded);
        } else {
          queue.push(decoded);
        }
      };
      notificationListener = (event) => {
        for (const frame of parser.feed(bytesFromDataView(event.target.value))) {
          pushDecoded(decodeFrame(frame));
        }
      };
      notifyCharacteristic.addEventListener('characteristicvaluechanged', notificationListener);
      await notifyCharacteristic.startNotifications();

      const waitFor = (predicate) => new Promise((resolve, reject) => {
        const queuedIndex = queue.findIndex(predicate);
        if (queuedIndex >= 0) {
          resolve(queue.splice(queuedIndex, 1)[0]);
          return;
        }
        waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiter = null;
            reject(new Error(t(this.locale, 'waitDeviceTimeout')));
          }, this.responseTimeoutMs),
        };
      });

      let sequence = 0;
      const sendFrame = async (frameType, subtype, payload = new Uint8Array(0)) => {
        const frames = buildFrames(sequence, frameType, subtype, payload);
        for (const frame of frames) {
          await writeCharacteristic(writeCharacteristicRef, frame);
          if (this.writeDelayMs > 0) await sleep(this.writeDelayMs);
        }
        sequence = (sequence + frames.length) & 0xff;
      };
      const sendControl = (subtype, payload) => sendFrame(FRAME_TYPE_CONTROL, subtype, payload);
      const sendData = (subtype, payload) => sendFrame(FRAME_TYPE_DATA, subtype, payload);

      this.status('writing', t(this.locale, 'writingWifi'));
      await sendControl(CONTROL_SET_SEC_MODE, Uint8Array.of(0x00));
      await sendControl(CONTROL_SET_OP_MODE, Uint8Array.of(0x01));
      await sendData(DATA_STA_SSID, ssidBytes);
      await sendData(DATA_STA_PASSWORD, passwordBytes);
      await sendControl(CONTROL_CONNECT_WIFI);

      this.status('joining', t(this.locale, 'waitingWifi'));
      const deadline = Date.now() + this.pollTimeoutMs;
      let lastState = null;
      while (Date.now() < deadline) {
        queue.length = 0;
        await sendControl(CONTROL_GET_WIFI_STATUS);
        let decoded = null;
        try {
          decoded = await waitFor((item) => item.kind === 'wifi_status' || item.kind === 'error');
        } catch (_) {}

        if (decoded?.kind === 'wifi_status') {
          lastState = decoded;
          if (decoded.staState === WIFI_SUCCESS) {
            const stationIp = decoded.extras?.stationIp || '';
            this.status('success', t(this.locale, 'wifiConnected'), stationIp);
            return { ok: true, deviceName, stationIp };
          }
          if (decoded.staState === WIFI_FAIL) {
            const reason = decoded.extras?.reason;
            const reasonText = reason == null ? '' : t(this.locale, 'wifiReasonCode', { code: reason });
            throw new Error(t(this.locale, 'wifiConnectFailed', { reason: reasonText }));
          }
        }
        if (this.retryDelayMs > 0) await sleep(this.retryDelayMs);
      }
      throw new Error(t(this.locale, 'wifiWaitTimeout', { state: lastState?.staStateName || t(this.locale, 'unknown') }));
    } finally {
      if (notifyCharacteristic && notificationListener) {
        notifyCharacteristic.removeEventListener('characteristicvaluechanged', notificationListener);
      }
      try { server.disconnect(); } catch (_) {}
    }
  }
}

module.exports = {
  BlufiProvisionClient,
  validateCredentials,
};
