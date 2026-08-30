// 串口复位时序。烧录对齐 Flash Tool：同一打开的串口句柄上做自动复位，立刻同步，不关口重开。
//
// 本机 CH343 板卡实测 DTR/RTS 映射:
//   DTR=false → EN 拉低(芯片复位);DTR=true  → EN 释放
//   RTS=false → BOOT(GPIO9) 拉低;      RTS=true  → BOOT 拉高
//
// 进下载模式后必须保持 BOOT 拉低。不能再把 DTR/RTS 拉回运行态，
// 也不能关串口重开(关口会抖控制线，芯片会退出下载模式)。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let SerialPortClass = null;

function getSerialPortClass() {
  if (!SerialPortClass) SerialPortClass = require('serialport').SerialPort;
  return SerialPortClass;
}

// 测试注入用;传 null 恢复为懒加载 serialport
function setSerialPortClass(cls) {
  SerialPortClass = cls || null;
}

async function withPort(path, baudRate, fn) {
  const SerialPort = getSerialPortClass();
  const port = new SerialPort({ path, baudRate, dataBits: 8, stopBits: 1, parity: 'none', autoOpen: false });
  await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
  try {
    return await fn(port);
  } finally {
    if (port.isOpen) await new Promise((resolve) => port.close(() => resolve()));
  }
}

function setLines(port, flags) {
  return new Promise((resolve, reject) => port.set(flags, (e) => (e ? reject(e) : resolve())));
}

async function setDeviceLines(device, flags) {
  if (typeof device.setSignals === 'function') {
    const signals = {};
    if (typeof flags.dtr === 'boolean') signals.dataTerminalReady = flags.dtr;
    if (typeof flags.rts === 'boolean') signals.requestToSend = flags.rts;
    if (Object.keys(signals).length === 0) return;
    await device.setSignals(signals);
    return;
  }
  if (!device.port) {
    throw new Error('串口设备未打开，无法设置 DTR/RTS');
  }
  await setLines(device.port, flags);
}

async function pulseDownloadMode(setFn) {
  await setFn({ dtr: false, rts: true });
  await sleep(300);
  await setFn({ dtr: true, rts: false });
  await sleep(300);
}

// 已打开的同一句柄上做自动复位，复位后保持 BOOT 拉低。
async function enterDownloadModeOnDevice(device) {
  await pulseDownloadMode((flags) => setDeviceLines(device, flags));
}

async function enterDownloadMode(path) {
  await withPort(path, 115200, async (port) => {
    await pulseDownloadMode((flags) => setLines(port, flags));
  });
}

async function hardResetToApp(path) {
  await withPort(path, 115200, async (port) => {
    await setLines(port, { dtr: false, rts: false });
    await sleep(150);
    await setLines(port, { dtr: true, rts: true });
    await sleep(100);
  });
}

module.exports = {
  withPort,
  setLines,
  enterDownloadMode,
  enterDownloadModeOnDevice,
  hardResetToApp,
  setSerialPortClass,
};
