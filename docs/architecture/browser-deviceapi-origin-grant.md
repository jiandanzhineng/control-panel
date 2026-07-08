# 内置浏览器 DeviceAPI Origin 授权

## 1. 背景

当前内置浏览器使用 Electron `<webview>` 加载第三方网页。普通网页默认没有 `DeviceAPI`，也拿不到 Node、IPC 或插件 detector 能力；只有用户进入已安装插件运行页时，主进程才会在匹配 `matchUrls` 的 webview 上注入插件 detector。

本功能支持一种更接近浏览器权限的体验：第三方网页可以主动申请访问本客户端的 `DeviceAPI`，用户确认同意后，该网页当天内可以调用设备能力。

目标不是开放 Electron/Node 权限，而是只开放一个受控的 `DeviceAPI` 代理，并在主进程/后端保持授权校验。

## 2. 目标

- 授权粒度为网页 `origin`，例如 `https://example.com`。
- 授权有效期为本地当天，到当天 `23:59:59.999` 自动失效。
- 授权后，该 origin 可调用 `DeviceAPI` 的全部设备与全部能力。
- 授权提示明确告知用户风险，由用户自行确认是否信任该网站。
- 普通网页不获得 Node、IPC、文件系统或任意后端接口能力。
- 导航到其他 origin 后不继承授权，需要重新申请。
- 用户可以撤销当前 origin 授权，并可一键停止当前设备输出。

## 3. 非目标

- 不做细粒度设备选择、能力选择或参数选择。
- 不做长期永久授权。
- 不把任意第三方网页变成插件 detector；插件系统仍保留现有 manifest / matchUrls / preload 校验机制。
- 不绕过 bridge 的安全兜底，例如电压封顶、自动停止、退出复位。

## 4. 授权模型

授权记录由客户端保存，网页本身不可写入。

```ts
type BrowserDeviceGrant = {
  origin: string;
  grantedAt: number;
  expiresAt: number;
};
```

`origin` 必须由主进程根据 webview 当前 URL 计算，不能信任网页传入的字符串。

过期时间按客户端本地日期计算：

```ts
function endOfToday(now = new Date()) {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  ).getTime();
}
```

授权存储建议放在 Electron `app.getPath('userData')` 下，例如：

```text
userData/data/browser-device-grants.json
```

文件内容示例：

```json
{
  "https://example.com": {
    "origin": "https://example.com",
    "grantedAt": 1783500000000,
    "expiresAt": 1783516799999
  }
}
```

## 5. 用户交互

网页首次调用 `DeviceAPI.requestAccess()` 时，如果当前 origin 没有当天有效授权，主进程弹确认框。

建议文案：

```text
https://example.com 请求访问设备控制能力

允许后，该网站今天内可以通过 DeviceAPI 控制当前客户端已接入的全部设备和能力。
请确认你信任该网站。恶意网页可能导致设备误触发或持续输出。

[允许今天访问] [拒绝]
```

拒绝后，本次调用返回拒绝错误，不写入授权。

允许后，写入当天授权，并允许该 origin 后续调用 `DeviceAPI`。

浏览器工具栏建议增加两个入口：

- 当前网站授权状态：未授权 / 已授权至今天结束。
- 撤销当前网站授权：删除当前 origin 授权，并立即停止当前浏览器网页发起的设备会话。

## 6. API 形态

普通浏览器 webview 注入一个专用 preload。它只暴露受控代理，不暴露 Node 对象。

网页侧示例：

```js
await DeviceAPI.requestAccess();

await DeviceAPI.device('shock').invoke('shock', 'start', { voltage: 30 });
await DeviceAPI.device('shock').invoke('shock', 'stop', {});
```

建议暴露的最小接口：

```ts
interface BrowserDeviceAPI {
  requestAccess(): Promise<{ ok: true; expiresAt: number }>;
  getGrantStatus(): Promise<{ granted: boolean; origin: string; expiresAt?: number }>;
  revokeAccess(): Promise<{ ok: true }>;
  device(logicalId: string): {
    invoke(capability: string, action: string, params?: Record<string, unknown>): Promise<unknown>;
    writeProps(props: Record<string, unknown>): Promise<unknown>;
    sendMessage(msg: unknown): Promise<unknown>;
    read(property: string): Promise<unknown>;
    isMapped(): Promise<boolean>;
  };
  getDevices(): Promise<unknown>;
  getDeviceMap(): Promise<Record<string, string[]>>;
  params: Record<string, unknown>;
}
```

`params` 可为空对象。由于本方案选择“设备和能力全开放”，不需要用户在授权时配置参数。

## 7. 运行链路

实现新增一条与插件 detector 分离的浏览器 DeviceAPI 链路：

```text
第三方网页
  -> BrowserDeviceAPI preload 代理
  -> Electron IPC
  -> 主进程按 webContents 当前 URL 计算 origin 并校验当天授权
  -> 后端 bridge / browser-device session
  -> deviceService / MQTT / virtualDeviceService
```

关键点：

- 每次命令都必须由主进程重新取 webview 当前 URL 并计算 origin。
- preload 不接受网页传入的 origin 作为授权依据。
- 后端收到命令时仍要知道该命令来自哪个 origin，并检查授权是否有效。
- 普通网页只能通过代理调用设备相关命令，不能直接访问 `/api/*` 或 bridge 的原始 WebSocket 能力。

## 8. 与现有 bridge 的关系

当前 bridge 已经支持：

- `init` 传入 `deviceMap` / `params`。
- `invoke` / `writeProps` / `sendMessage` / `read`。
- 全局唯一活跃玩法。
- 显式退出信号复位设备。
- 断线宽限与兜底复位。
- `shock` 电压封顶与自动停止。

当前实现复用 bridge 的设备命令实现，并补了一个“浏览器 origin 授权”的入口层。

网页不能直接连接 `/bridge`。原因是浏览器 WebSocket 的请求内容不能可靠代表用户授权，且第三方网页可自行构造消息。当前做法是：

1. preload 通过 IPC 发命令给主进程。
2. 主进程校验当前 origin 的授权。
3. 主进程或后端服务调用现有 bridge 处理逻辑，或者抽出 bridge 的命令执行核心复用。

如果未来改成复用 WebSocket，也必须在后端给浏览器 DeviceAPI session 加独立认证 token，token 只由主进程发给 preload，且后端按 token 绑定 origin 与过期时间。

## 9. 设备映射策略

本方案选择“授权后设备和能力全开放”。实现上仍需要把网页的逻辑设备映射到真实设备。

推荐默认映射策略：

- `getDevices()` 返回当前可用设备列表与能力。
- `DeviceAPI.device(id)` 中的 `id` 可以直接使用真实设备 id。
- 为兼容现有游戏/插件写法，可额外提供按能力的默认逻辑 id：
  - `shock`：映射到第一个具备 `shock` 能力的设备。
  - `vibrator`：映射到第一个具备 `strength` 能力的设备。

后端执行命令时必须确认目标设备存在且具备对应 capability。即便 origin 已授权，也不能允许调用设备不支持的能力。

## 10. 安全边界

虽然产品决策是“授权后全能力开放”，仍建议保留以下硬边界：

- 只开放 `DeviceAPI`，不开放 Node、IPC、文件系统、shell、任意后端接口。
- 授权只对当前 origin 有效，不对完整浏览历史或所有网站有效。
- 授权每天过期。
- 每次命令都校验授权，不只在 `requestAccess()` 时校验一次。
- 电击电压继续封顶。
- 电击 start 继续由后端自动 stop。
- 导航离开授权 origin 时，当前 origin 发起的设备会话应退出并复位。
- 关闭 webview、离开浏览器页、撤销授权时，立即停止当前浏览器设备会话。

## 11. 实现步骤记录

1. 新增授权存储服务：读写 `browser-device-grants.json`，提供 `getGrant(origin)`、`grantToday(origin)`、`revoke(origin)`、`isGranted(origin)`。
2. 主进程增加 IPC：
   - `browser-device:request-access`
   - `browser-device:get-grant-status`
   - `browser-device:revoke-access`
   - `browser-device:invoke`
   - `browser-device:write-props`
   - `browser-device:send-message`
   - `browser-device:read`
   - `browser-device:get-devices`
3. 新增普通浏览器 webview preload，例如 `electron/browser-device-preload.js`，只暴露 `window.DeviceAPI` 代理。
4. 修改 `BrowserView.vue` 的 `<webview>`，为普通浏览器挂载该 preload。
5. 修改 `electron/main.js` 的 `will-attach-webview` 安全处理：
   - 继续拒绝任意未知 preload。
   - 允许普通浏览器专用 DeviceAPI preload。
   - 插件 detector preload 仍走现有插件校验。
6. 新增主进程授权弹窗，按 webview 当前 URL 计算 origin。
7. 新增后端或主进程设备命令执行入口，并在执行前校验 origin 当天授权。
8. 在浏览器工具栏加授权状态、撤销授权、一键停止入口。
9. 补测试：
   - 未授权调用被拒绝。
   - 授权后同 origin 可调用。
   - 不同 origin 不继承授权。
   - 授权跨天失效。
   - 撤销后命令被拒绝并复位。
   - 导航离开授权 origin 后复位。

## 12. 验收标准

- 普通网页默认不能调用设备。
- 普通网页调用 `DeviceAPI.requestAccess()` 时出现风险确认弹窗。
- 用户允许后，该 origin 当天内可调用所有 `DeviceAPI` 设备能力。
- 同一天刷新页面或重新打开该 origin，不重复弹窗。
- 换到另一个 origin 后需要重新授权。
- 到第二天授权自动失效。
- 用户撤销授权后，该 origin 立即无法继续调用设备。
- 关闭内置浏览器 webview 或离开授权 origin 时，设备输出被复位。
- 普通网页仍不能获得 Node、IPC、文件系统或任意后端接口能力。
