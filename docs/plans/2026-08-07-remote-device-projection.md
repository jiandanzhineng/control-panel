# 远程设备投影（Remote Device Projection）实施计划

> 状态：设计稿
> 一句话：把持有方的真实设备经 MQTT 投影成操作方的一台「远程设备」，操作方用现成 DeviceAPI / 任意游戏直接驱动，底层自动走 MQTT 落到真实设备。
> 端侧：**先做 PC 端**。

## 1. 为什么现有架构天然支持

设备驱动层每层都是接口化、传输无关的：

```
游戏 JS → DeviceAPI → CapabilityRegistry → BridgeCtx.writeProps → PropSink → DeviceTransport → 设备
```

**远程设备 = 给 `DeviceTransport` 加第三种实现 `remote`（现有 `ble`/`mqtt`），其余各层零改动。**

**能力推导零成本**：远程设备只需把真实设备的 `deviceType` 字符串（如 `CUNZHI01`）传过来，操作方 `DeviceTypeRegistry.get(type)` 自动给出全部能力、操作、监控项。游戏看到的是一台和本地一模一样的设备。

## 2. 角色与授权

| 角色 | 含义 |
|---|---|
| **持有方 (Owner)** | 真实设备所在端，开房间，v1 假定单持有方 |
| **操作方 (Operator)** | 加房间，远程操作设备，可多个 |

**授权（已确认）：**
1. **全量授权**——投影即授权全部能力，不做部分授权。
2. **鉴权靠 broker**——MQTT broker 的 JWT ACL 已按 topic 限制：能到达 Sink 的消息必然来自有权限的房间成员。**Sink 不再做二次鉴权**（能收到 = 已授权）。
3. **一对多**——一台设备可同时给多个操作方控。
4. **时间限制**——持有方设一个控制时长（如 1 小时），超时后 Sink 停止接受远程写入并对设备安全停机。

## 3. 两个新组件

**操作方：`RemoteDeviceTransport`**（实现 `DeviceTransport`，`kind=remote`）
- `writeInt/writeFloat/sendMessage` → 经 MQTT 发到持有方
- `onXxxChanged` → 订阅持有方上行的属性/消息
- `properties` → 握手时同步来的属性表

**持有方：`RemoteDeviceSink`**（接收器）
- 收操作方写入 → **钳制**（≤上限）→ 调本地 transport 落真实设备（鉴权已由 broker 保证，不重复做）
- 真实设备属性变化 → 经 MQTT 上行给操作方
- **时间限制**：超过持有方设定时长 → 拒绝写入 + 安全停机
- 多操作方：全收，见 §5

## 4. 握手与数据流

**设备清单**：操作方进房后主动发一条 `requestDeviceList`，持有方回一份（全量能力，无裁剪）：

```json
{ "deviceId": "aabbccddeeff", "deviceType": "CUNZHI01", "name": "寸止",
  "properties": { "voltage": {"writable":true}, "pressure": {"canNotify":true} },
  "limits": { "voltage": 20, "power": 128 },
  "controlTtlSec": 3600 }
```

- `deviceId` 直接用真实设备 id（路由回正确本地设备），不造虚拟 id
- `deviceType` → 操作方推导能力；`properties` → 构造 transport
- `limits` → 强度上限；`controlTtlSec` → 持有方设的控制时长

**下行（操作方→设备）**：
```
游戏 DeviceAPI.invoke('shock','start',{voltage:15})
 → BridgeCtx.writeProps({voltage:15,shock:1})
 → RemoteDeviceTransport.writeInt → MQTT → Sink 钳制+查时限 → 本地 transport → 真实设备
```
**游戏代码完全不知道设备是远程的。**

**上行（设备→操作方）**：真实设备属性变化 → Sink → MQTT → RemoteDeviceTransport 触发 `onXxxChanged` → 游戏 `onValue` 回调。

## 5. 并发与安全（不可裁剪）

**并发策略（已定）：谁想控就控，冲突不管，不仲裁。** 后到覆盖先到，不加锁、不分优先级。属性变化广播给所有操作方仅作信息同步。

**安全：**
| 机制 | 位置 | 说明 |
|---|---|---|
| 鉴权 | broker ACL | 能到达 Sink 的消息必来自有权限的房间成员，Sink 不重复校验 |
| 写入钳制 | 持有方 Sink（强制） | 所有远程写入钳到 limits 内再落设备，不信操作方自觉 |
| 时间限制 | 持有方 Sink | 超过 controlTtlSec → 拒绝写入 + 安全停机 |
| 断连兜底 | 持有方 Sink | 房间关闭/操作方全断 → 对真实设备安全停机（`DeviceTypeDef.close`） |

## 6. 延迟的诚实评估

| 操作 | 经 MQTT 延迟 | 远程可行 |
|---|---|---|
| 电击/振动一次 | 百毫秒级 | ✓ |
| 传感器观看（500ms） | 百毫秒级 | ✓ |
| 实时闭环（edging 200ms 环） | 跟不上 | 视实测，不预先约束 |

延迟对闭环控制的影响待实测，本机制**不对闭环做硬性约束**。

## 7. 落地形态：设备控制游戏

**新增一个游戏「设备控制台」**：功能类似现有 `control.html`（设备全局控制中心）——列出所有在线设备，控制每台设备的全部参数。

- 该游戏走标准 DeviceAPI（`control.html` 的 `device-control.js` 已是此模式：「所有控制动作统一走 DeviceAPI」）。
- **远程设备实现 DeviceTransport 后，此游戏零改动即可看到并操作远程设备**——远程设备自动出现在设备列表里。
- 操作方在此游戏里把刺激/惩罚落到远程设备上；持有方在自己端看真实设备状态。

**设备列表加「连接类型」字段**：BLE / 串口 / MQTT / 远程 统一作为连接类型展示，操作方能区分本地设备与远程设备。

## 8. 改动清单（先做 PC 端）

| 层 | 改动 | 工作量 |
|---|---|---|
| `packages/api` 后端 | 零改动 | 0 |
| `room-sdk` | 零改动 | 0 |
| 能力/游戏层 | 零改动（自动继承） | 0 |
| **PC 面板 RoomBridge** | **从零新增（PC 当前无任何房间代码，先行项）** | 中 |
| 操作方 `RemoteDeviceTransport` | 新增（PC 经 RoomBridge） | 中 |
| 持有方 `RemoteDeviceSink` | 新增（钳制+时限+转发+上行） | 中 |
| 投影握手协议 | 新增（设备清单 + limits + 时限） | 小 |
| 「设备控制台」游戏 | 新增（可基于 control.html 改造） | 中 |
| 设备列表「连接类型」字段 | 新增 BLE/串口/MQTT/远程 标识 | 小 |

## 9. 待讨论

1. **延迟实测**：MQTT 往返对电击/振动手感的影响，先做最小验证。
2. **共存 UI**：「连接类型」字段的具体展示形式（标签/图标/分组）。
3. **命名**：术语定为「远程设备投影」，写入 CONTEXT.md 术语表。
