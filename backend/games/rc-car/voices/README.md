# rc-car 语音资源

语音由 `tools/cosyvoice/generate_voices.py` 的 `rccar` 模式生成，MiniMax `speech-2.8-hd`。

```bash
# 在仓库根目录，先把 MINIMAX_API_KEY 写入 tools/cosyvoice/.env
python tools/cosyvoice/generate_voices.py rccar
```

- 中文：`voices/zh/<key>.mp3`（voice_id `female-yujie`）
- 英文：`voices/en/<key>.mp3`（voice_id `English_CalmWoman`）
- 口令与「没有照做」speed 1.3，其余 0.95。

## 需要的 14 个 key

`calib_start` `calib_done` `cmd_forward` `cmd_backward` `cmd_left` `cmd_right`
`cmd_stop` `violation` `level_up` `level_down` `pelvic_remind` `edging_peak`
`sensor_lost` `game_end`

生成后运行 `python tools/cosyvoice/generate_voices.py check` 校验缺失/多余文件。
