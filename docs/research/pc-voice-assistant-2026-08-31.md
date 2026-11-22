# PC 客户端语音助手调研

日期：2026-08-31

范围：UnderSilicon Electron 客户端功能模块，不是游戏。

## 结论

做成常驻后台模块：主进程采麦 + 本地唤醒词，唤醒后再识别短指令，后端按意图调已有设备接口。不要做成游戏，也不要在渲染进程里常驻听麦。

唤醒词「瑰夏大人」用 sherpa-onnx 关键词检测即可，不必重训模型。第一句「打开跳蛋」用规则匹配：打开设备页的跳蛋控制；若本机只有一台震动设备，可直接下发强度。

## 为什么不是游戏

游戏依赖玩法载体、设备映射和启动配置，离开运行页就停。语音要在没开玩法、窗口最小化到托盘时仍能听。ADR 0004 同时只能有一个活跃玩法，语音必须独立，并且可以去启动玩法。现有「设置 → 语音服务」只是数字人/游戏的 LLM 渠道，不是听麦助手。

## 状态机

`Idle(KWS 常开)` → 听到「瑰夏大人」→ `Listening(3–8 秒)` → 指令文本 → `Dispatch` → 回到 Idle。超时或静音也回 Idle。只有 Listening 才跑语音识别；常开转写费 CPU、误触发多、隐私差。

## 唤醒词

| 方案 | 自定义中文 | 体积 | 许可 | 接入 |
| --- | --- | --- | --- | --- |
| sherpa-onnx KWS zipformer zh-en 3M | 改 keywords.txt，不重训 | 约 5–12 MB | Apache-2.0 | npm `sherpa-onnx-node`，Windows x64 |
| onnx-wakeword | 在线训专用模型 | <130 KB | 开源运行时 | 多一步训练 |
| Picovoice Porcupine | 控制台生成 | 很小 | 商业 AccessKey | 商用贵 |
| openWakeWord | 仅英文 | — | — | 排除 |

主推 sherpa-onnx。关键词用拼音单元，四字长度合适。需实测误唤醒和「瑰夏」读音。模型：

https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html

Node 绑定：

https://www.npmjs.com/package/sherpa-onnx-node

示例关键词（需用官方 `text2token --tokens-type phone+ppinyin` 生成最终文件）：

```
g uī x ià d à r én @瑰夏大人
```

## 指令识别与动作

唤醒后：Silero VAD + 流式中文 STT。STT 优先 sherpa-onnx streaming Paraformer INT8，与仓库已有评估一致：

E:\smart\docs\research\stt-tts-model-evaluation-2026-08-01.md

v1 用规则，不走 LLM：

- 打开/启动 + 跳蛋/震动 → 打开 `/devices` 品牌控制
- 关闭/停止 + 跳蛋 → `strength.stop`
- 强度 + 数字 → `strength.set`

设备控制已有 REST，见 `docs/guides/REST_设备控制指南.md`。开放对话可后续接现有 `/v1/chat/completions`。

## 模块切分

1. `electron/voice`：WASAPI 采麦（sherpa 示例用 `node-cpal`）、KWS、VAD/STT。托盘存活用现有 closeToTray。
2. `backend/services/voiceAssistant`：状态机、意图、动作。设备走 `deviceService`，不进游戏 VM。
3. 前端：设置页开关/灵敏度；主窗口 HUD。UI 导航走 IPC。

默认关闭，用户打开后才占麦。

## 风险与 POC

- 原生 addon 打包：asarUnpack，模型放 extraResources
- Windows 麦权限、独占模式
- 多台跳蛋要默认设备或先问
- 误唤醒：阈值、冷却、能量门
- 空闲 CPU：单线程 + int8 encoder

POC：主进程听到「瑰夏大人」打日志 → 5 秒 STT，「打开跳蛋」打开设备页 → 唯一震动设备时真正 set strength → HUD、回执、设置项、打包。
