const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const nicknameService = require('../services/nicknameService');
const firmwareOtaService = require('../services/firmwareOtaService');
const { sendError } = require('../utils/http');
const logger = require('../utils/logger');

// 查询设备列表
router.get('/', (req, res) => {
  try {
    const rows = deviceService.listDevicesForApi();
    res.json(rows);
  } catch (e) {
    sendError(res, 'DEVICE_LIST_FAILED', e.message || String(e), 500);
  }
});

// 清空所有设备（注意顺序，避免与 :id 冲突）
router.delete('/all', (req, res) => {
  try {
    deviceService.clearDevices();
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'DEVICE_CLEAR_FAILED', e.message || String(e), 500);
  }
});

function getBatchFirmwareDevices(scope = 'online') {
  const rows = deviceService.listDevicesForApi();
  if (scope === 'all') return rows;
  return rows.filter((device) => device.connected);
}

// 批量查询设备固件信息
router.get('/firmware/batch', async (req, res) => {
  try {
    const scope = req.query.scope === 'all' ? 'all' : 'online';
    const devices = getBatchFirmwareDevices(scope);
    const firmwareList = await firmwareOtaService.getLatestFirmwareForDevices(devices);

    res.json({
      scope,
      checkedAt: new Date().toISOString(),
      total: devices.length,
      devices: devices.map((device, index) => ({
        device,
        firmware: firmwareList[index],
        status: firmwareOtaService.getOtaStatus(device.id),
      })),
    });
  } catch (e) {
    sendError(res, e.code || 'FIRMWARE_BATCH_FAILED', e.message || String(e), e.status || 500);
  }
});

// 批量下发更新到最新版本的 OTA 指令
router.post('/firmware/batch/update-latest', async (req, res) => {
  try {
    const deviceIds = Array.isArray(req.body?.deviceIds) ? req.body.deviceIds : [];
    const uniqueIds = [...new Set(deviceIds.map((id) => String(id || '').trim()).filter(Boolean))];

    if (uniqueIds.length === 0) {
      return sendError(res, 'DEVICE_IDS_REQUIRED', '请提供需要升级的设备列表', 400);
    }

    const devices = [];
    const missing = [];
    for (const id of uniqueIds) {
      const device = deviceService.getDeviceById(id);
      if (device) devices.push(device);
      else missing.push(id);
    }

    const result = await firmwareOtaService.updateDevicesToLatest(devices, {
      force: !!req.body?.force,
    });

    const missingResults = missing.map((id) => ({
      deviceId: id,
      ok: false,
      skipped: false,
      failed: true,
      error: {
        code: 'DEVICE_NOT_FOUND',
        message: '设备不存在',
        status: 404,
      },
    }));

    res.json({
      ...result,
      results: [...result.results, ...missingResults],
      missing: missingResults,
      failedCount: result.failedCount + missing.length,
    });
  } catch (e) {
    sendError(res, e.code || 'FIRMWARE_BATCH_UPDATE_FAILED', e.message || String(e), e.status || 500);
  }
});

// 对已是最新固件版本的在线设备下发指示灯闪烁动作
router.post('/firmware/batch/blink-latest', async (req, res) => {
  try {
    const devices = getBatchFirmwareDevices('online');
    const result = await firmwareOtaService.blinkLatestDevices(
      devices,
      (deviceId, action) => deviceService.publishDeviceAction(deviceId, action)
    );

    res.json(result);
  } catch (e) {
    sendError(res, e.code || 'FIRMWARE_BATCH_BLINK_FAILED', e.message || String(e), e.status || 500);
  }
});

// 批量设备 OTA 状态流
router.get('/firmware/batch/status-stream', (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length === 0) {
      return sendError(res, 'DEVICE_IDS_REQUIRED', '请提供需要订阅的设备列表', 400);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const writeStatus = (status) => {
      res.write(`event: status\n`);
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    };

    const unsubscribes = [];
    for (const id of uniqueIds) {
      const device = deviceService.getDeviceById(id);
      if (!device) continue;
      writeStatus(firmwareOtaService.getOtaStatus(id));
      unsubscribes.push(firmwareOtaService.onOtaStatus(id, writeStatus));
    }

    const cleanup = () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  } catch (e) {
    sendError(res, 'FIRMWARE_BATCH_STATUS_STREAM_FAILED', e.message || String(e), 500);
  }
});

// 查询设备详情
router.get('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const dev = deviceService.getDeviceForApi(id);
    if (!dev) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    res.json(dev);
  } catch (e) {
    sendError(res, 'DEVICE_DETAIL_FAILED', e.message || String(e), 500);
  }
});

// 更新设备元数据（例如名称），并通知设备
router.patch('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const patch = req.body || {};
    const dev = deviceService.updateDeviceMeta(id, patch);
    if (!dev) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    try {
      deviceService.notifyDeviceUpdate(id, patch);
    } catch (e) {
      return sendError(res, 'MQTT_CLIENT_PUBLISH_FAILED', e.message || String(e), 500);
    }
    res.json(deviceService.toApiDevice(dev));
  } catch (e) {
    sendError(res, 'DEVICE_UPDATE_FAILED', e.message || String(e), 500);
  }
});

// 设置设备昵称
router.post('/:id/nickname', (req, res) => {
  try {
    const id = req.params.id;
    const { nickname } = req.body;
    
    // 我们允许给还未连接的设备设置昵称，但为了保持一致性，最好确认设备存在
    const dev = deviceService.getDeviceById(id);
    if (!dev) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    
    nicknameService.setNickname(id, nickname);
    res.json(deviceService.toApiDevice(dev));
  } catch (e) {
    sendError(res, 'SET_NICKNAME_FAILED', e.message || String(e), 500);
  }
});

// 获取设备可用的最新 OTA 固件信息
router.get('/:id/firmware/latest', async (req, res) => {
  try {
    const id = req.params.id;
    const device = deviceService.getDeviceById(id);
    if (!device) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);

    const result = await firmwareOtaService.getLatestFirmwareForDevice(device);
    res.json(result);
  } catch (e) {
    sendError(res, e.code || 'FIRMWARE_LATEST_FAILED', e.message || String(e), e.status || 500);
  }
});

// 查询设备 OTA 状态
router.get('/:id/firmware/status', (req, res) => {
  try {
    const id = req.params.id;
    const device = deviceService.getDeviceById(id);
    if (!device) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);

    res.json(firmwareOtaService.getOtaStatus(id));
  } catch (e) {
    sendError(res, 'FIRMWARE_STATUS_FAILED', e.message || String(e), 500);
  }
});

// 下发更新到最新版本的 OTA 指令
router.post('/:id/firmware/update-latest', async (req, res) => {
  try {
    const id = req.params.id;
    const device = deviceService.getDeviceById(id);
    if (!device) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);

    const result = await firmwareOtaService.updateDeviceToLatest(device, {
      force: !!req.body?.force,
    });
    res.json(result);
  } catch (e) {
    sendError(res, e.code || 'FIRMWARE_UPDATE_FAILED', e.message || String(e), e.status || 500);
  }
});

// 设备 OTA 状态流
router.get('/:id/firmware/status-stream', (req, res) => {
  const id = req.params.id;

  try {
    const device = deviceService.getDeviceById(id);
    if (!device) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    const writeStatus = (status) => {
      res.write(`event: status\n`);
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    };

    writeStatus(firmwareOtaService.getOtaStatus(id));
    const unsubscribe = firmwareOtaService.onOtaStatus(id, writeStatus);

    const cleanup = () => {
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  } catch (e) {
    sendError(res, 'FIRMWARE_STATUS_STREAM_FAILED', e.message || String(e), 500);
  }
});

// 删除单个设备
router.delete('/:id', (req, res) => {
  try {
    const id = req.params.id;
    const ok = deviceService.deleteDeviceById(id);
    if (!ok) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    res.json({ ok: true });
  } catch (e) {
    sendError(res, 'DEVICE_DELETE_FAILED', e.message || String(e), 500);
  }
});

// 执行设备操作
router.post('/:id/operations/:operationKey', (req, res) => {
  const { id, operationKey } = req.params;
  
  // 详细检查请求体
  logger.info('设备操作请求 - 原始数据', { 
    deviceId: id, 
    operationKey,
    hasBody: !!req.body,
    bodyType: typeof req.body,
    bodyContent: req.body,
    contentType: req.get('Content-Type'),
    contentLength: req.get('Content-Length')
  });
  
  const params = (req.body && req.body.params) || {};
  
  logger.info('设备操作请求 - 处理后', { 
    deviceId: id, 
    operationKey, 
    params
  });
  
  try {
    const result = deviceService.executeDeviceOperation(id, operationKey, params);
    logger.info('设备操作成功', { 
      deviceId: id, 
      operationKey, 
      result 
    });
    res.json(result);
  } catch (e) {
    logger.error('设备操作失败', { 
      deviceId: id, 
      operationKey, 
      params,
      error: e.message,
      stack: e.stack,
      errorCode: e.code || 'DEVICE_OPERATION_FAILED'
    });
    sendError(res, 'DEVICE_OPERATION_FAILED', e.message || String(e), 500);
  }
});

// 获取设备监控数据
router.get('/:id/monitor-data', (req, res) => {
  try {
    const id = req.params.id;
    const data = deviceService.getDeviceMonitorDataForApi(id);
    
    if (!data) {
      return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    }
    
    res.json(data);
  } catch (e) {
    sendError(res, 'DEVICE_MONITOR_DATA_FAILED', e.message || String(e), 500);
  }
});

// 获取设备监控数据（SSE模式）
router.get('/:id/monitor-stream', (req, res) => {
  const deviceId = req.params.id;
  
  try {
    // 检查设备是否存在
    const device = deviceService.getDeviceById(deviceId);
    if (!device) {
      return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    }

    // 检查设备是否支持监控数据
    if (!deviceService.deviceHasMonitorData(deviceId)) {
      return sendError(res, 'DEVICE_NO_MONITOR_DATA', '设备不支持监控数据', 400);
    }

    // 设置SSE响应头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // 发送初始数据
    const initialData = deviceService.getDeviceMonitorDataForApi(deviceId);
    if (initialData) {
      res.write(`event: history\n`);
      res.write(`data: ${JSON.stringify(initialData)}\n\n`);
    }

    // 设置设备高频率上报 (250ms)
    deviceService.notifyDeviceUpdate(deviceId, { report_delay_ms: 250 });
    console.log(`设置设备 ${deviceId} 高频率上报: 250ms`);

    // 注册设备数据变更监听
    const dataChangeHandler = (eventData) => {
      const { deviceId: changedDeviceId, device, changes } = eventData;
      if (changedDeviceId === deviceId) {
        console.log(`SSE推送数据变更: ${deviceId}`, changes);
        const monitorData = deviceService.getDeviceMonitorDataForApi(deviceId);
        if (monitorData) {
          res.write(`event: update\n`);
          res.write(`data: ${JSON.stringify(monitorData)}\n\n`);
          console.log(`SSE数据已推送: ${deviceId}`, monitorData);
        }
      } else{
        console.log(`设备与监控设备不符 changedDeviceId:${changedDeviceId} deviceId:${deviceId}`);
      }
    };

    console.log(`建立SSE连接: ${deviceId}`);
    deviceService.onDeviceDataChange(dataChangeHandler);

    // 连接关闭时清理
    req.on('close', () => {
      // 移除监听器
      const handlers = deviceService.state.dataChangeHandlers;
      const index = handlers.indexOf(dataChangeHandler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
      // 恢复设备正常上报频率 (5000ms)
      deviceService.notifyDeviceUpdate(deviceId, { report_delay_ms: 5000 });
      console.log(`恢复设备 ${deviceId} 正常上报频率: 5000ms`);
    });

    req.on('error', () => {
      // 移除监听器
      const handlers = deviceService.state.dataChangeHandlers;
      const index = handlers.indexOf(dataChangeHandler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
      // 恢复设备正常上报频率 (5000ms)
      deviceService.notifyDeviceUpdate(deviceId, { report_delay_ms: 5000 });
      console.log(`恢复设备 ${deviceId} 正常上报频率: 5000ms`);
    });

  } catch (e) {
    sendError(res, 'DEVICE_MONITOR_STREAM_FAILED', e.message || String(e), 500);
  }
});

module.exports = router;
