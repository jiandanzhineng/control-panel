const deviceService = require('./deviceService');
const deviceRegistry = require('../devices/registry');
const { getDeviceTypeConfig } = require('../config/deviceTypes');
const logger = require('./logService');

// 存储活动测试状态: deviceId -> { intervalId, loopIndex, loopData }
const activeTests = new Map();
// SSE 客户端连接
const sseClients = new Set();
// 全局测试平台开启状态
let isTestPlatformOpen = false;
// 轮询检测定时器
let checkInterval = null;

// 监听设备数据变更，用于 SSE 推送
deviceService.onDeviceDataChange(({ device, changes }) => {
  // SSE 推送
  if (sseClients.size > 0) {
    // 检查是否有 monitorData 相关的变更
    const config = getDeviceTypeConfig(device.type);
    if (config && config.monitorData) {
      const monitorKeys = config.monitorData.map(m => m.key);
      const relevantChanges = {};
      let hasRelevantChanges = false;

      // 检查变更的属性是否在 monitorData 中
      Object.keys(changes).forEach(key => {
        if (monitorKeys.includes(key)) {
          relevantChanges[key] = changes[key].new;
          hasRelevantChanges = true;
        }
      });

      // 如果有相关变更，推送给所有客户端
      if (hasRelevantChanges) {
        broadcastSSE({
          type: 'update',
          deviceId: device.id,
          data: relevantChanges
        });
      }
    }
  }
});

/**
 * 启动轮询检查
 * 检测在线设备是否已开始测试，未开始则自动开始
 */
function startCheckLoop() {
  if (checkInterval) return;
  
  checkInterval = setInterval(() => {
    if (!isTestPlatformOpen) return;

    const devices = deviceService.connectedDevices();
    devices.forEach(device => {
      const active = activeTests.get(device.id);
      if (active?.noCapabilities && active.deviceType !== device.type) {
        activeTests.delete(device.id);
      }
      // 如果设备在线，且不在测试列表中，则开始测试
      if (!activeTests.has(device.id)) {
        logger.info('TestService', `轮询检测到设备 ${device.id} 在线且未测试，自动开始测试`);
        startTest(device.id);
      }
    });
  }, 1000); // 每秒检查一次
}

/**
 * 停止轮询检查
 */
function stopCheckLoop() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

/**
 * 开始测试指定设备
 */
function startTest(deviceId) {
  const device = deviceService.getDeviceById(deviceId);
  if (!device) {
    logger.warn('TestService', `无法开始测试：设备 ${deviceId} 不存在`);
    return;
  }

  const deviceType = deviceRegistry.getDeviceType(device.type);
  const plan = deviceType.getTestPlan();

  const hasStart = plan.start.length > 0;
  const hasLoop = plan.loop.length > 0;
  const hasStop = plan.stop.length > 0;

  if (!hasStart && !hasLoop && !hasStop) {
    logger.info('TestService', `设备 ${deviceId} (${device.type}) 无可测试能力`);
    // 即使没有可测试能力，也标记为已测试，避免重复检查
    activeTests.set(deviceId, { intervalId: null, noCapabilities: true, deviceType: device.type });
    return;
  }

  // 停止之前的测试（如果有）
  stopTest(deviceId, false); // false 表示不发送 stop 消息，仅清理定时器

  logger.info('TestService', `开始测试设备 ${deviceId}`);

  // 1. 发送 Start 步骤（各能力的 start，发一次）
  plan.start.forEach((fn) => safeRunStep(deviceType, deviceId, fn));

  // 2. 启动 Loop（各能力的 loop 步骤展平后轮流循环下发）
  if (hasLoop) {
    const loopDelay = plan.loopDelay || 2000;
    let loopIndex = 0;

    const intervalId = setInterval(() => {
      // 检查设备是否还在线/存在
      const currentDevice = deviceService.getDeviceById(deviceId);
      if (!currentDevice || !currentDevice.connected) {
        // 设备离线，暂停发送但保留测试状态（等待重连）
        return;
      }

      const fn = plan.loop[loopIndex];
      safeRunStep(deviceType, deviceId, fn);

      loopIndex = (loopIndex + 1) % plan.loop.length;
    }, loopDelay);

    activeTests.set(deviceId, { intervalId });
  } else {
    // 如果没有 loop，也记录在 activeTests 中，避免重复触发
    activeTests.set(deviceId, { intervalId: null });
  }
}

/**
 * 停止测试指定设备
 * @param {string} deviceId 
 * @param {boolean} sendStopMsg 是否发送停止消息
 */
function stopTest(deviceId, sendStopMsg = true) {
  const testState = activeTests.get(deviceId);
  
  if (testState) {
    if (testState.intervalId) {
      clearInterval(testState.intervalId);
    }
    activeTests.delete(deviceId);
  }

  if (sendStopMsg) {
    const device = deviceService.getDeviceById(deviceId);
    if (device) {
      const deviceType = deviceRegistry.getDeviceType(device.type);
      const plan = deviceType.getTestPlan();
      if (plan.stop.length > 0) {
        plan.stop.forEach((fn) => safeRunStep(deviceType, deviceId, fn));
        logger.info('TestService', `停止测试设备 ${deviceId}，发送 Stop 消息`);
      }
    }
  }
}

/**
 * 通过设备当前连接的传输下发测试消息。
 */
function devicePublishFn(deviceId, message) {
  return deviceService.devicePublishFn(deviceId, message);
}

/**
 * 安全执行单个测试步骤（通过设备能力 context 下发）
 */
function safeRunStep(deviceType, deviceId, fn) {
  try {
    deviceType.runTestStep(deviceId, fn, devicePublishFn);
  } catch (err) {
    logger.error('TestService', `测试步骤执行失败: ${err.message}`);
  }
}

/**
 * 开启测试平台（前端页面打开）
 */
function startPlatform() {
  isTestPlatformOpen = true;
  logger.info('TestService', '测试平台开启');
  
  // 对所有在线设备开始测试
  const devices = deviceService.connectedDevices();
  devices.forEach(device => {
    startTest(device.id);
  });
  
  // 启动轮询检查
  startCheckLoop();
}

/**
 * 关闭测试平台（前端页面关闭）
 */
function stopPlatform() {
  isTestPlatformOpen = false;
  logger.info('TestService', '测试平台关闭');
  
  // 停止轮询检查
  stopCheckLoop();

  // 停止所有设备的测试
  const devices = deviceService.state.devices; // 获取所有设备，包括离线的，确保状态清除
  devices.forEach(device => {
    stopTest(device.id, true);
  });
  
  // 清理残留的 activeTests (针对已删除设备)
  for (const [deviceId, state] of activeTests) {
    if (state && state.intervalId) {
      clearInterval(state.intervalId);
    }
    activeTests.delete(deviceId);
  }
}

/**
 * SSE 广播
 */
function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

/**
 * 处理 SSE 连接
 */
function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  sseClients.add(res);

  // 发送初始数据（可选）
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
}

module.exports = {
  startTest,
  stopTest,
  startPlatform,
  stopPlatform,
  handleSSE
};
