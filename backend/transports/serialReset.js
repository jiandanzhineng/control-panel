// 串口复位时序(提取自 .tmp/spike-flash-connect5.cjs,真机 6/6 验证可靠)。
//
// 本机 CH343 板卡实测 DTR/RTS 映射(反直觉,勿按 ESP 常规理解):
//   DTR=false → EN 拉低(芯片复位);DTR=true  → EN 释放
//   RTS=false → BOOT(GPIO9) 拉低;      RTS=true  → BOOT 拉高
//
// 不要用 esptool-js 自带的 ClassicReset/HardReset,也不要用 esploader.main()
// 的默认复位——统一由这里先手动进下载模式,再 esploader.main('no_reset') 同步。
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

// 进下载模式:{dtr:false,rts:true} 保持 300ms → {dtr:true,rts:false} 保持 300ms
// 用专用临时句柄操作,完成后关闭并等 300ms 再让调用方重开端口。
async function enterDownloadMode(path) {
  await withPort(path, 115200, async (port) => {
    await setLines(port, { dtr: false, rts: true });   // EN 低 + BOOT 高(实测可靠时序)
    await sleep(300);
    await setLines(port, { dtr: true, rts: false });   // EN 释放 + BOOT 低 → 下载模式
    await sleep(300);
  });
  await sleep(300);
}

// 复位回 app:{dtr:false,rts:false} 150ms → {dtr:true,rts:true}
async function hardResetToApp(path) {
  await withPort(path, 115200, async (port) => {
    await setLines(port, { dtr: false, rts: false });  // EN 低
    await sleep(150);
    await setLines(port, { dtr: true, rts: true });    // EN 释放 + BOOT 高 → app
    await sleep(100);
  });
}

module.exports = {
  withPort,
  setLines,
  enterDownloadMode,
  hardResetToApp,
  setSerialPortClass,
};
