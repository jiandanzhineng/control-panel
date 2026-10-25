# 语音开始：测试方法

## 测试音频生成

```powershell
pwsh -File tools/gen-voice-wav.ps1 -TextFile <UTF-8文本，一行一句> -OutDir <目录> -Prefix <前缀> [-Rate n] [-PadSeconds n]
```

Windows SAPI（默认 Microsoft Huihui Desktop）出 16k 单声道 wav，`-PadSeconds` 前后补静音，默认峰值归一化 0.84（KWS 对响度敏感）。中文文本必须放外部 UTF-8 文件，直接写命令行会被 PowerShell 的 GBK 读坏。本机 SAPI 只有 `Microsoft Zira Desktop` 一个英文音色；更多英文音色用 piper VITS（`tmp/voice-probe-en/scripts/gen_piper.py`，`OfflineTts` 加载 `vits-piper-en_US-*/`，22.05kHz 需重采样到 16k）。

KWS 音频必须留尾巴：喂完最后一块补 ~0.66s 静音（`numTrailingBlanks`），否则最后一个音素还没出结果就结束会漏检。测试脚本与 fixture 生成都按此来。

## E2E 假麦克风

```bash
node tools/electron-dev.js --local-registry --remote-debugging-port=9224 \
  --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
  --use-file-for-fake-audio-capture=<wav绝对路径>
```

`tools/electron-dev.js` 会把额外参数透传给 electron。假音频循环播放，所以 wav 里口令前后必须留几秒静音（`-PadSeconds 2`），否则口令连播会在第一次识别后继续触发。假设备在麦克风列表里显示为 `Fake Audio Input`。

## E2E 截图

CDP 默认 `Page.captureScreenshot` 抓合成帧，后台页里 Element Plus 入场过渡（opacity 0→1）会卡住不推进，截图里「已识别口令」标签看不见。改成 `fromSurface:false` 即可拍到瞬时状态。不要在页面里 await requestAnimationFrame，后台页 rAF 被节流会让 CDP 调用挂死。

## 单测

`backend/tests/voicePhraseCatalog.test.js`、`voiceTriggerService.test.js`（fixture wav 在 `backend/tests/fixtures/voice/`，用 `tmp/voice-probe-en/scripts/make_fixtures.py` 从探测音频裁出，每条 60~140KB）、`voiceTriggerWs.test.js`（真实 http server + ws 客户端，覆盖 `/bridge` 与 `/voice-trigger` 共存）、`wsUpgradeRouter.test.js`（未知路径 400）。
