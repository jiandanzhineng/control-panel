"""遥控车语音：IndexTTS-2.5 本地生成（嫌弃少女风格）。

在 2080ti 的 IndexTTS 源码目录运行（需 checkpoints_25 与参考音频）：
    python rccar.py <参考音频.wav> <输出目录>
输出 <输出目录>/{zh,en}/<key>.wav，再用 tools/indextts/postprocess.sh 转 mp3。
"""
import os
import sys
import time

sys.path.insert(0, os.getcwd())

# (key, 中文, English)
LINES = [
    ("calib_start",   "趴好，不许乱动哦。", "Get down. Don't you dare move."),
    ("calib_done",    "好了。乖乖听我的口令。", "Done. Now listen to me."),
    ("cmd_forward",   "前进！", "Forward!"),
    ("cmd_backward",  "后退！", "Back!"),
    ("cmd_left",      "左转啦！", "Left!"),
    ("cmd_right",     "右转啦！", "Right!"),
    ("cmd_stop",      "停下！", "Stop!"),
    ("violation",     "哈？连这都做不到？杂鱼。", "Huh? Can't even do that? Pathetic."),
    ("level_up",      "不听话？那就再加一档。", "Disobeying? Turning it up."),
    ("level_down",    "哼，还算乖，降一档吧。", "Hmph, good enough. Turning it down."),
    ("pelvic_remind", "给我夹紧，提肛！", "Squeeze. Tighter!"),
    ("edging_peak",   "到边缘了哦，不许去。", "You're at the edge. Don't you dare."),
    ("sensor_lost",   "传感器断开了，原地别动。", "Sensor lost. Stay right there."),
    ("game_end",      "结束了。哼，也就那样吧。", "It's over. Hmph, you were barely okay."),
]

# [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
# 嫌弃为主，带得意与恼火；不加 calm，否则听起来有气无力
EMO = [0.3, 0.25, 0, 0, 0.5, 0, 0.1, 0]


def main():
    ref, out = sys.argv[1], sys.argv[2]
    from indextts.infer_v2_5 import IndexTTS2
    tts = IndexTTS2(cfg_path="checkpoints_25/config.yaml", model_dir="checkpoints_25",
                    use_bf16=False, use_cuda_kernel=False)
    for locale, idx, lang in (("zh", 1, "ZH"), ("en", 2, "EN")):
        os.makedirs(os.path.join(out, locale), exist_ok=True)
        for line in LINES:
            t = time.time()
            path = os.path.join(out, locale, line[0] + ".wav")
            tts.infer(spk_audio_prompt=ref, text=line[idx], output_path=path, lang=lang,
                      emo_vector=EMO, use_random=False, verbose=False)
            print(locale, line[0], round(time.time() - t, 1), "s", flush=True)


if __name__ == "__main__":
    main()
