# rc-car 语音资源

IndexTTS-2.5 在 2080ti 本地生成，嫌弃少女风格（参考音色：IndexTTS-2 官方 Demo `examples/voice_03.wav`）。
台词与情绪向量见 `tools/indextts/rccar.py`，服务器部署见 上层工作区 `docs/note/indextts.md`。

```bash
# 2080ti，IndexTTS 源码目录
python rccar.py examples/voice_03.wav ~/smart/index-tts-out/rccar
# 本机仓库根目录：拉回 wav 后去静音、统一响度、转 32kHz mono 128k mp3
scp -r 2080ti:smart/index-tts-out/rccar tmp/rccar-voice/raw
tools/indextts/postprocess.sh tmp/rccar-voice/raw
python tools/cosyvoice/generate_voices.py check
```

- 中文：`voices/zh/<key>.mp3`；英文：`voices/en/<key>.mp3`（同一音色）

## 需要的 14 个 key

`calib_start` `calib_done` `cmd_forward` `cmd_backward` `cmd_left` `cmd_right`
`cmd_stop` `violation` `level_up` `level_down` `pelvic_remind` `edging_peak`
`sensor_lost` `game_end`
