# 背单词离线口令

- 游戏通过 `DeviceAPI.speech.commands` 调用 PC 宿主；适用于带有效启动令牌的本机 `vocab-game`，远程会话/投影拒绝使用。旧宿主未提供此接口时，游戏保留原转写兼容路径。
- 采集在 `backend/public/vocab-command-audio.js`：16 kHz 单声道 AudioWorklet，每帧 512 样本转 PCM16，走现有本机 `/bridge` WebSocket。没有 WAV 编码、整句收集或云端 ASR 请求。
- `backend/voice/vocabCommandCatalog.js` 定义中英六组口令；与「开始游戏」使用独立目录/识别实例，共用 `backend/voice-kws/` 的中英 3M Zipformer 模型。参数 score=2、threshold=0.15，maxActivePaths=4，numTrailingBlanks=1。
- `VocabCommandSession` 聚合为 100 ms 解码；换题、朗读解禁时重建识别流，长静音满 1.5 秒清理编码器历史。命中后保护 350 ms。generation/seq 丢弃旧会话、旧题的音频和结果。
- 页面隐藏即释放麦克风并暂停后端口令；恢复前台重新申请并保护 300 ms。退出、切点选、WS 断线、授权迟到均释放音轨和 AudioContext。
- 回归入口：`npm --prefix backend test -- --runInBand vocabCommandSession.test.js vocabCommandAudio.test.js deviceApiCommands.test.js bridgeSpeech.test.js voiceTriggerService.test.js voiceTriggerWs.test.js`。真实音频在 `backend/tests/fixtures/voice/vocab/`；连续十二口令与普通讲话负例均直接运行模型。
- Electron 验收用隔离 userData、独立前后端/CDP 端口和虚拟电击设备；账号使用内存替身，禁止将测试进度写入真实账号。截图报告在项目 `tmp/`。
