#!/bin/bash
# 用法: tools/indextts/postprocess.sh <rccar.py 输出目录>
# 去首尾静音 → 响度统一 -16 LUFS → 32kHz 单声道 128k mp3，写入游戏 voices/{zh,en}
set -e
src="$1"
dst="$(cd "$(dirname "$0")/../.." && pwd)/backend/games/rc-car/voices"
trim="silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse"
for locale in zh en; do
  mkdir -p "$dst/$locale"
  for wav in "$src/$locale"/*.wav; do
    key="$(basename "$wav" .wav)"
    ffmpeg -loglevel error -y -i "$wav" \
      -af "$trim,apad=pad_dur=0.08,loudnorm=I=-16:TP=-1.5:LRA=11" \
      -ar 32000 -ac 1 -b:a 128k "$dst/$locale/$key.mp3"
  done
done
echo "done -> $dst"
