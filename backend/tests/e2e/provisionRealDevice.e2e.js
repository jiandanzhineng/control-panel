// 真机 E2E 主流程。运行前先起后端（见 docs/test/autotest-provision-e2e.md）。
const {
  PORT_PATH, DEVICE_TYPE, results, check, api, sleep, provisionState, portEntry, waitForStage,
} = require('./provisionE2eLib');

async function testProvisionSettings() {
  console.log('\n[1] 供给设置读写与持久化');
  const updated = await api('/api/test/provision/settings', {
    method: 'PUT',
    body: JSON.stringify({ autoFlash: true, deviceType: DEVICE_TYPE }),
  });
  check('PUT 设置返回 200', updated.status === 200, `status=${updated.status}`);
  check('设置已生效', updated.body?.settings?.autoFlash === true
    && updated.body?.settings?.deviceType === DEVICE_TYPE,
  JSON.stringify(updated.body?.settings));

  const bad = await api('/api/test/provision/settings', {
    method: 'PUT', body: JSON.stringify({ autoFlash: 'yes' }),
  });
  check('非法 autoFlash 返回 400', bad.status === 400, `status=${bad.status} code=${bad.body?.error?.code}`);
}

async function testPipelineToConnected() {
  console.log('\n[2] 启动测试平台，等待端口跑完流水线');
  const started = await api('/api/test/start', { method: 'POST' });
  check('POST /api/test/start 返回 200', started.status === 200, `status=${started.status}`);
  check('供给已开启', started.body?.provision?.enabled === true);

  const tracked = portEntry(started.body?.provision, PORT_PATH);
  check(`${PORT_PATH} 已被纳入流水线`, !!tracked, tracked ? `stage=${tracked.stage}` : '未找到该端口');
  check(`${PORT_PATH} 识别为 CH34x`, tracked?.ch34x === true, `vendorId=${tracked?.vendorId}`);

  // 烧录含下载+写 flash，给足时间
  const { entry, seen } = await waitForStage(PORT_PATH, ['connected', 'failed'], 180000, '流水线终态');
  check('端口最终连接成功', entry.stage === 'connected', `stage=${entry.stage} msg=${entry.message}`);
  check('拿到设备 ID', /^[0-9a-f]{12}$/.test(entry.deviceId || ''), `deviceId=${entry.deviceId}`);
  console.log(`      阶段流转: ${[...new Set(seen)].join(' → ')}`);
  return entry;
}

async function testAutoTestStarted(deviceId) {
  console.log('\n[3] 设备上线后自动开始内置自动化测试');
  // testService 每秒轮询在线设备自动开测；设备刚连上时 type 还是 base，
  // 要等 report 带上 device_type 后才拿到真正的测试计划，故留足时间。
  const deadline = Date.now() + 30000;
  let device = null;
  while (Date.now() < deadline) {
    device = (await api('/api/devices')).body?.find((item) => item.id === deviceId);
    // start 步骤会把上报间隔压到 100ms，是"测试计划已下发"的可观测证据
    if (device?.type === 'CUNZHI01' && device?.data?.report_delay_ms === 100) break;
    await sleep(1000);
  }
  check('设备出现在设备列表且在线', device?.connected === true,
    device ? `type=${device.type} connected=${device.connected}` : '设备列表中没有该设备');
  check('设备型号已由上报确定', device?.type === 'CUNZHI01', `type=${device?.type}`);
  check('测试计划 start 步骤已下发（report_delay_ms=100）',
    device?.data?.report_delay_ms === 100, `report_delay_ms=${device?.data?.report_delay_ms}`);
  return device;
}

async function testMonitorData(deviceId) {
  console.log('\n[4] 测试循环持续驱动设备并回流上报数据');
  const seenShock = new Set();
  const seenPower = new Set();
  let last = null;
  // CUNZHI01 的 loop 有 4 步、每步 2 秒（一轮 8 秒），shock=1 只在其中一步保持。
  // 采样窗口取 ~30 秒覆盖多轮，避免刚好错过某一步导致误报。
  for (let i = 0; i < 60; i += 1) {
    last = (await api('/api/devices')).body?.find((item) => item.id === deviceId);
    if (last?.data) {
      seenShock.add(last.data.shock);
      seenPower.add(last.data.power);
    }
    await sleep(500);
  }
  check('设备持续上报监控数据', typeof last?.data?.pressure === 'number',
    `pressure=${last?.data?.pressure}`);
  check('电击测试循环在下发（shock 出现多个取值）', seenShock.size > 1,
    `shock 取值=${[...seenShock].join(',')}`);
  check('强度测试循环在下发（power 出现多个取值）', seenPower.size > 1,
    `power 取值=${[...seenPower].join(',')}`);
}

async function testRetryOnUntracked() {
  console.log('\n[5] 未跟踪端口的重试返回 404');
  const res = await api('/api/test/provision/ports/COM_NOT_EXIST/retry', { method: 'POST' });
  check('未跟踪端口重试 404', res.status === 404, `status=${res.status} code=${res.body?.error?.code}`);
}

async function testManualRestart(deviceId) {
  console.log('\n[6] 手动重新开始测试后循环仍在跑');
  const restarted = await api(`/api/test/device/${deviceId}/start`, { method: 'POST' });
  check('可手动重新下发测试开始命令', restarted.status === 200, `status=${restarted.status}`);
  await sleep(5000);
  const device = (await api('/api/devices')).body?.find((item) => item.id === deviceId);
  check('重启后 start 步骤再次下发', device?.data?.report_delay_ms === 100,
    `report_delay_ms=${device?.data?.report_delay_ms}`);
}

async function testStopRestoresAutoConnect() {
  console.log('\n[7] 停止平台并恢复串口自动连接原值');
  const before = (await api('/api/serial/settings')).body;
  const stopped = await api('/api/test/stop', { method: 'POST' });
  check('POST /api/test/stop 返回 200', stopped.status === 200, `status=${stopped.status}`);
  check('供给已关闭', stopped.body?.provision?.enabled === false);
  const after = (await api('/api/serial/settings')).body;
  check('串口自动连接恢复为原值 false', after?.autoConnect === false,
    `开启期间=${before?.autoConnect} 停止后=${after?.autoConnect}`);
  const state = await provisionState();
  check('端口条目已清空', (state?.ports?.length || 0) === 0, `ports=${state?.ports?.length}`);
}

async function main() {
  if (!PORT_PATH) {
    console.error('必须设置 E2E_PORT，例如 E2E_PORT=COM17');
    process.exit(2);
  }
  console.log(`真机 E2E：port=${PORT_PATH} deviceType=${DEVICE_TYPE}`);

  const serial = (await api('/api/serial/settings')).body;
  check('前置条件：串口自动连接默认关闭', serial?.autoConnect === false, `autoConnect=${serial?.autoConnect}`);

  await testProvisionSettings();
  const entry = await testPipelineToConnected();
  await testAutoTestStarted(entry.deviceId);
  await testMonitorData(entry.deviceId);
  await testRetryOnUntracked();
  await testManualRestart(entry.deviceId);
  await testStopRestoresAutoConnect();

  const failed = results.filter((item) => !item.ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    failed.forEach((item) => console.log(`  FAIL ${item.name} — ${item.detail}`));
    process.exit(1);
  }
}

main().catch(async (error) => {
  console.error(`\nE2E 异常终止: ${error?.message || error}`);
  try { await api('/api/test/stop', { method: 'POST' }); } catch (_) {}
  process.exit(1);
});
