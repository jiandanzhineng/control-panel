// 主控端「远程模式」过滤中间件（远程会话模式方案 §4.0 第 4 点、§4.3）。
//
// 只在本机处于「主控端远程模式」（remoteSessionService.isOperatorRemoteMode()）时生效，
// 其余时刻一律直接放行，行为与以前完全一致：
//   1. 设备列表/详情只返回本会话投影房间来的设备，隐藏本机设备；
//   2. 昵称、控制连接切换这类只能在被控端执行的写操作，转发成主房间 RPC；
//   3. 只能在本机做的操作（蓝牙/串口/固件/插件/设置等）返回 423 REMOTE_LOCKED。
//
// 转译表与锁定表都写在这一个文件里，方便审查（新增页面接口忘了入表 = 远程下不可用）。
const remoteSession = require('../services/remoteSessionService');
const deviceService = require('../services/deviceService');
const nicknameService = require('../services/nicknameService');
const { sendError } = require('../utils/http');

const REMOTE_LOCKED = 'REMOTE_LOCKED';
const REMOTE_LOCKED_MESSAGE = '远程控制中不可用，断开后可用';

function locked(res) {
  return sendError(res, REMOTE_LOCKED, REMOTE_LOCKED_MESSAGE, 423);
}

// ---------- 1. 本机专属接口锁定表（method + 路径正则） ----------
// 读接口若页面靠它渲染，放进 LOCK_ALLOWLIST 放行。
const LOCK_RULES = [
  // 串口 / 插线烧录 / 固件
  { method: '*', pattern: /^\/serial(\/|$)/ },
  { method: '*', pattern: /^\/wired-flash(\/|$)/ },
  { method: '*', pattern: /^\/devices\/[^/]+\/firmware(\/|$)/ },
  { method: '*', pattern: /^\/devices\/firmware(\/|$)/ },
  // MQTT 客户端直发（可绕开设备白名单与安全钳制）
  { method: 'POST', pattern: /^\/mqtt-client(\/|$)/ },
  // 蓝牙 / 品牌设备发现与连接
  { method: '*', pattern: /^\/brands(\/|$)/ },
  { method: '*', pattern: /^\/test(\/|$)/ },
  // 插件 / 本地应用
  { method: 'POST', pattern: /^\/plugins(\/|$)/ },
  { method: 'POST', pattern: /^\/local-apps(\/|$)/ },
  { method: 'PUT', pattern: /^\/local-apps(\/|$)/ },
  { method: 'DELETE', pattern: /^\/local-apps(\/|$)/ },
  // 网络服务 / 语音设置 / 开发者访问
  { method: '*', pattern: /^\/mdns(\/|$)/ },
  { method: 'POST', pattern: /^\/mqtt\/(start|stop)$/ },
  { method: 'PUT', pattern: /^\/voice\/settings$/ },
  { method: 'POST', pattern: /^\/voice\/settings$/ },
  { method: 'PUT', pattern: /^\/dev-access$/ },
  // 虚拟设备写入（读放行：页面/测试平台渲染需要）
  { method: 'POST', pattern: /^\/virtual-devices(\/|$)/ },
  { method: 'PUT', pattern: /^\/virtual-devices(\/|$)/ },
  { method: 'DELETE', pattern: /^\/virtual-devices(\/|$)/ },
  // 设备看门狗：本机测试/调试用
  { method: 'POST', pattern: /^\/device-watchdog(\/|$)/ },
  // 清空本机设备清单（破坏性，只能在被控端做）
  { method: 'DELETE', pattern: /^\/devices\/all$/ },
  // 批量设备操作：deviceService.batchExecuteOperation 不做逐字段安全钳制，
  // 且 deviceIds 缺省时会命中「该类型全部已连接设备」＝本机设备，远程模式下必须禁掉。
  { method: 'POST', pattern: /^\/devices\/batch(\/|$)/ },
  // 账号/设置类写操作
  { method: 'POST', pattern: /^\/auth(\/|$)/ },
  { method: 'PUT', pattern: /^\/auth(\/|$)/ },
];

// 即使命中 LOCK_RULES 也放行的读接口（页面渲染需要，且无本机副作用）。
// [method, 路径正则]，method 为 '*' 表示所有方法。
const LOCK_ALLOWLIST = [
  ['*', /^\/brands\/status$/],
  ['GET', /^\/brands\/settings$/],
  ['GET', /^\/serial\/settings$/],
  ['GET', /^\/mqtt\/status$/],
  ['GET', /^\/mdns\/status$/],
  ['GET', /^\/voice\/status$/],
  ['GET', /^\/voice\/phrases$/],
  ['GET', /^\/dev-access$/],
  ['GET', /^\/local-apps$/],
  ['GET', /^\/plugins$/],
  ['GET', /^\/plugins\/[^/]+$/],
  ['GET', /^\/test\/provision$/],
  ['GET', /^\/wired-flash\/(ports|driver-status|firmware)$/],
];

// 远程模式绝不能被锁的路由（自检用，避免误伤远控本身）
const NEVER_LOCKED = [
  /^\/remote-session(\/|$)/,
  /^\/remote-game(\/|$)/,
  /^\/remote-projection(\/|$)/,
  /^\/logs\/current$/,
  /^\/games(\/|$)/,
  /^\/game-runtime(\/|$)/,
];

function isLockedRoute(method, path) {
  if (NEVER_LOCKED.some((pattern) => pattern.test(path))) return false;
  const verb = String(method || 'GET').toUpperCase();
  if (LOCK_ALLOWLIST.some(([allowMethod, pattern]) => (
    (allowMethod === '*' || allowMethod === verb) && pattern.test(path)
  ))) return false;
  return LOCK_RULES.some((rule) => (
    (rule.method === '*' || rule.method === verb) && rule.pattern.test(path)
  ));
}

// ---------- 2. 投影设备判定 ----------

/** 设备是否属于本会话的投影房间（transportMetadata.roomId 在 remote 连接上）。 */
function isSessionProjectedDevice(device, roomId) {
  if (!device || !roomId) return false;
  return (device.connections || []).some(
    (connection) => connection?.type === 'remote' && connection.roomId === roomId,
  );
}

function filterDeviceList(roomId) {
  return deviceService.listDevicesForApi().filter((device) => isSessionProjectedDevice(device, roomId));
}

function getProjectedDevice(id, roomId) {
  const device = deviceService.getDeviceForApi(id);
  return isSessionProjectedDevice(device, roomId) ? device : null;
}

// ---------- 2.1 设备子路由的设备归属 ----------
// `/api/devices/:id/<子路由>`（能力调用、预置操作、原始消息、监视流、固件等）
// 之前完全没做归属校验：主控端页面拿设备 ID 就能驱动本机设备。这里统一收紧。

// 这些子路由下没有设备 ID（`:id` 是集合名），不能按设备归属拦。
const DEVICE_SUBROUTE_SKIP = new Set(['all', 'batch', 'firmware']);
// 这些子路由只能在被控端做（固件升级依赖本机串口/插线烧录），远程模式下整条禁掉。
const DEVICE_SUBROUTE_LOCAL_ONLY = new Set(['firmware']);

const DEVICE_SUBROUTE = /^\/devices\/([^/]+)(\/.*)?$/;

function deviceSubrouteTarget(path) {
  const match = DEVICE_SUBROUTE.exec(path);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  if (DEVICE_SUBROUTE_SKIP.has(id)) return null;
  const sub = match[2] || '';
  return {
    id,
    sub,
    // 固件升级只能在被控端做（依赖本机串口/插线烧录），远程模式下整条禁掉
    localOnly: DEVICE_SUBROUTE_LOCAL_ONLY.has(id) || sub.startsWith('/firmware'),
  };
}

// ---------- 3. REST → 主房间语义命令转译表 ----------
// 键 = `${method} ${路径正则}`；值 = 由匹配结果生成语义命令。
// 未命中的写操作在远程模式下返回 423（只能在被控端执行）。
const FORWARD_RULES = [
  {
    method: 'PATCH',
    pattern: /^\/devices\/([^/]+)$/,
    command: (req) => ({
      type: 'devices.rename',
      payload: { deviceId: decodeURIComponent(req.match[1]), name: req.body?.name },
    }),
    // 与 backend/routes/devices.js 的 PATCH /:id 回包同形
    respond: (req) => {
      const id = decodeURIComponent(req.match[1]);
      const device = deviceService.getDeviceForApi(id);
      const patch = req.body || {};
      if (typeof patch.name === 'string') nicknameService.setNickname(id, patch.name);
      if (!device) return null;
      return {
        ...device,
        name: typeof patch.name === 'string' ? patch.name : device.name,
        nickname: nicknameService.getNickname(id),
      };
    },
  },
  {
    method: 'POST',
    pattern: /^\/devices\/([^/]+)\/nickname$/,
    command: (req) => ({
      type: 'devices.rename',
      payload: { deviceId: decodeURIComponent(req.match[1]), name: req.body?.nickname },
    }),
    respond: (req) => {
      const id = decodeURIComponent(req.match[1]);
      const device = deviceService.getDeviceForApi(id);
      if (!device) return null;
      return { ...device, nickname: nicknameService.getNickname(id) };
    },
  },
  {
    method: 'PUT',
    pattern: /^\/devices\/([^/]+)\/control-connection$/,
    command: (req) => ({
      type: 'devices.controlConnection.set',
      payload: { deviceId: decodeURIComponent(req.match[1]), connectionType: req.body?.type },
    }),
    respond: (req) => getProjectedDevice(decodeURIComponent(req.match[1]), req.roomId),
  },
];

function matchForward(method, path) {
  const verb = String(method || '').toUpperCase();
  for (const rule of FORWARD_RULES) {
    if (rule.method !== verb) continue;
    const match = rule.pattern.exec(path);
    if (match) return { rule, match };
  }
  return null;
}

async function forwardToHost(req, res, entry) {
  const { rule, match } = entry;
  const command = rule.command({ ...req, match });
  if (!command.payload || Object.values(command.payload).some((value) => value === undefined)) {
    return sendError(res, 'INVALID_REQUEST', '缺少必要参数', 400);
  }
  try {
    const result = await remoteSession.command(command);
    if (result?.ok === false) {
      return sendError(res, result.code || 'REMOTE_COMMAND_FAILED', result.message || '远程命令执行失败', 400);
    }
    const body = rule.respond({ ...req, match });
    if (body === null) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    return res.json(body);
  } catch (error) {
    return sendError(res, error?.code || 'REMOTE_COMMAND_FAILED', error?.message || '远程命令执行失败', 400);
  }
}

// ---------- 中间件 ----------

function remoteSessionFilter(req, res, next) {
  if (!remoteSession.isOperatorRemoteMode()) return next();
  const roomId = remoteSession.projectionRoomId();
  const rawPath = String(req.path || '');
  // 去掉尾部斜杠：否则 `/api/devices/` 会绕过下面的精确匹配，直接拿到本机设备全表
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
  const method = String(req.method || 'GET').toUpperCase();

  if (isLockedRoute(method, path)) return locked(res);

  // 设备列表 / 详情：只给本会话投影来的设备
  if (method === 'GET' && path === '/devices') {
    return res.json(filterDeviceList(roomId));
  }
  const deviceDetail = /^\/devices\/([^/]+)$/.exec(path);
  if (method === 'GET' && deviceDetail) {
    const id = decodeURIComponent(deviceDetail[1]);
    const device = getProjectedDevice(id, roomId);
    if (!device) return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    return res.json(device);
  }

  const forward = matchForward(method, path);
  if (forward) {
    const targetId = forward.match[1] ? decodeURIComponent(forward.match[1]) : null;
    // 只能操作本会话投影来的设备
    if (targetId && !getProjectedDevice(targetId, roomId)) {
      return sendError(res, 'DEVICE_NOT_FOUND', '设备不存在', 404);
    }
    return forwardToHost({ ...req, roomId }, res, forward);
  }

  // 设备子路由（能力调用/预置操作/原始消息/监视流/固件…）：
  // 本机设备（或别的会话投影来的设备）一律 423，防止主控端拿设备 ID 驱动本机硬件；
  // 本会话投影来的设备放行——它们的写入经 remote 连接适配器走投影链路，由被控端钳制。
  const subroute = deviceSubrouteTarget(path);
  if (subroute) {
    if (subroute.localOnly || !getProjectedDevice(subroute.id, roomId)) return locked(res);
    return next();
  }

  return next();
}

module.exports = {
  remoteSessionFilter,
  isLockedRoute,
  isSessionProjectedDevice,
  filterDeviceList,
  matchForward,
  deviceSubrouteTarget,
  LOCK_RULES,
  LOCK_ALLOWLIST,
  NEVER_LOCKED,
};
