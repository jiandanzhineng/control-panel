#!/usr/bin/env python3
"""
游戏语音批量生成脚本（通用）
使用 MiniMax speech-2.8-hd API (via cursorai)
女教师音色，温柔而坚定

用法:
  python generate_voices.py              # 生成喝水/憋尿解锁语音
  python generate_voices.py edging       # 生成寸止玩法语音
  python generate_voices.py check        # 校验游戏目录中的语音资源
"""

import json
import os
import sys
import time

# ============================================================
# API 配置
# ============================================================
# API key 从环境变量或同目录 .env 读取，不要硬编码提交：
#   MINIMAX_API_KEY=replace-with-your-key
def _load_dotenv():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

_load_dotenv()

API_URL = "https://api.cursorai.art/minimax/v1/t2a_v2"
API_KEY = os.environ.get("MINIMAX_API_KEY", "")

# 女教师音色：用成熟女声 + 稍慢语速 + 稍低音调
VOICE_CONFIG = {
    "voice_id": "female-yujie",       # 御姐音 → 成熟女性
    "speed": 0.95,                     # 稍慢，稳重
    "vol": 1.0,
    "pitch": -2,                       # 略低，增加威严感
}

SHORT_PUNISHMENT_KEYS = {
    "punish_pressure",
    "punish_tiptoe_qtz",
    "punish_drink_stall",
    "punish_pee_stall",
}

AUDIO_CONFIG = {
    "sample_rate": 32000,
    "bitrate": 128000,
    "format": "mp3",
}

# 输出目录（游戏静态资源目录）
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output_voices")

# ============================================================
# 喝水/憋尿解锁
# ============================================================
DRINK_PEE_LINES = [
    # === 一、开场引导 ===
    ("start_drink",     "准备好了吗？今天的水要全部喝完哦。保持提肛，踮起脚尖，我们开始吧。"),
    ("start_pee",       "准备好了吗？让重量持续增加，我们开始吧。"),

    # === 二、进度播报 ===
    ("progress_25",     "已经完成四分之一了，做得不错，继续保持。"),
    ("progress_50",     "已经完成一半了，再加把劲，你可以的。"),
    ("progress_75",     "快了快了，还剩最后四分之一，坚持住。"),
    ("progress_90",     "马上就完成了，最后冲刺，不许放弃哦。"),

    # === 三、督促/鼓励 ===
    ("encourage_drink", "水要慢慢喝，不用急，但也不能停哦。"),
    ("encourage_pee",   "继续保持重量上升，不要停哦。"),
    ("remind_tiptoe",   "脚尖踮起来，脚跟不要落地。"),
    ("remind_sphincter","注意提肛，收紧一点，不要放松。"),

    # === 四、惩罚执行 ===
    ("punish_pressure", "气压不足受罚。"),
    ("punish_tiptoe_qtz","脚跟落地受罚。"),
    ("punish_tiptoe_cunzhi","脚跟落地了，压力超标。要罚一下，下次踮高一点。"),
    ("punish_drink_stall","喝水停顿受罚。"),
    ("punish_pee_stall","重量停滞受罚。"),

    # === 五、冷却期 ===
    ("cooldown_start",  "惩罚结束，给你一点时间缓缓。调整好状态，马上继续。"),
    ("cooldown_end",    "休息好了吗？来，振作起来，我们继续。"),

    # === 六、完成/结束 ===
    ("unlock_drink",    "太棒了！水全部喝完了，目标达成。你做得很好。"),
    ("unlock_pee",      "目标已达成，解锁成功。"),
    ("unlock_timeout",  "时间到了。虽然没有完全达标，但还是辛苦了，先休息吧。"),
    ("end_manual",      "好了，今天就到这里。好好休息，下次再来。"),
]

# ============================================================
# 寸止玩法 — 7 条（精简版，3 阶段状态机）
# ============================================================
EDGING_LINES = [
    ("edging_start",    "训练开始。放松身体，集中注意力，感受你的状态。过程中可以随时调整气压参数，让玩法更适应你的身体。"),
    ("edging_middle",   "已经到中期了，不会让你轻易得逞的～"),
    ("edging_peak",     "过头了哦。没有控制住呢——安静，停下来，不要乱动。"),
    ("edging_delay",    "先缓一缓，给你几秒钟冷静一下。深呼吸。"),
    ("edging_calm",     "压力回落了，回到平静状态。慢慢来。"),
    ("edging_takeoff",  "最后冲刺阶段到了，好好感受，不用再压抑了。"),
    ("edging_end",      "训练结束。今天辛苦了，好好休息。"),
]


def generate_voice(name, text):
    """调用 speech-2.8-hd API 生成单条语音"""
    import requests

    if not API_KEY:
        raise RuntimeError("未找到 MINIMAX_API_KEY，请在 tools/cosyvoice/.env 或环境变量中配置")
    voice_setting = dict(VOICE_CONFIG)
    if name in SHORT_PUNISHMENT_KEYS:
        voice_setting["speed"] = 1.3

    payload = {
        "model": "speech-2.8-hd",
        "text": text,
        "stream": False,
        "voice_setting": voice_setting,
        "audio_setting": AUDIO_CONFIG,
    }

    resp = requests.post(
        API_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=60,
        proxies={"http": "", "https": ""},   # 绕过系统代理
    )

    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    base = data.get("base_resp", {})
    if base.get("status_code") != 0:
        raise RuntimeError(f"API error {base.get('status_code')}: {base.get('status_msg', 'unknown')}")

    hex_audio = data["data"]["audio"]
    return bytes.fromhex(hex_audio)


GAME_ASSET_SPECS = [
    ("drink-pee-unlock", os.path.join(os.path.dirname(__file__), "..", "..", "backend", "games", "drink-pee-unlock", "voices"),
     {name for name, _ in DRINK_PEE_LINES}),
    ("pressure-edging", os.path.join(os.path.dirname(__file__), "..", "..", "backend", "games", "pressure-edging", "voices"),
     {name for name, _ in EDGING_LINES if name != "edging_takeoff"}),
    ("pressure-edging-v2", os.path.join(os.path.dirname(__file__), "..", "..", "backend", "games", "pressure-edging-v2", "voices"),
     {name for name, _ in EDGING_LINES}),
]


def validate_game_assets():
    """Report missing and unused MP3 files for each game voice manifest."""
    valid = True
    print("\n===== 游戏语音资源校验 =====")
    for label, directory, expected in GAME_ASSET_SPECS:
        actual = set()
        if os.path.isdir(directory):
            actual = {
                os.path.splitext(filename)[0]
                for filename in os.listdir(directory)
                if filename.lower().endswith(".mp3")
            }
        missing = sorted(expected - actual)
        unused = sorted(actual - expected)
        print(f"{label}: 引用 {len(expected)}，缺失 {len(missing)}，未使用 {len(unused)}")
        for name in missing:
            print(f"  缺失: {name}.mp3")
        for name in unused:
            print(f"  未使用: {name}.mp3")
        valid = valid and not missing and not unused
    return valid


def run(lines, label):
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    total = len(lines)
    success = 0
    failed = []

    for idx, (name, text) in enumerate(lines, 1):
        out_path = os.path.join(OUTPUT_DIR, f"{name}.mp3")
        print(f"[{idx}/{total}] {name} ... ", end="", flush=True)

        # 跳过已生成的文件
        if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
            print("已存在，跳过")
            success += 1
            continue

        try:
            audio_bytes = generate_voice(name, text)
            with open(out_path, "wb") as f:
                f.write(audio_bytes)
            size_kb = len(audio_bytes) / 1024
            print(f"OK ({size_kb:.1f} KB)")
            success += 1
            # API 限速，间隔一下
            time.sleep(0.5)
        except Exception as e:
            print(f"FAIL: {e}")
            failed.append((name, str(e)))
            time.sleep(1)

    print(f"\n===== {label} 完成 =====")
    print(f"成功: {success}/{total}")
    if failed:
        print(f"失败 {len(failed)} 条:")
        for name, err in failed:
            print(f"  {name}: {err}")

    # 列出本组生成的文件
    print(f"\n{label} — 输出目录: {OUTPUT_DIR}")
    keys = set(name for name, _ in lines)
    for f in sorted(os.listdir(OUTPUT_DIR)):
        stem = os.path.splitext(f)[0]
        if stem in keys:
            fpath = os.path.join(OUTPUT_DIR, f)
            print(f"  {f}  ({os.path.getsize(fpath) / 1024:.1f} KB)")
    return not failed


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "drink"

    generated = True
    if mode == "check":
        pass
    elif mode == "edging":
        generated = run(EDGING_LINES, "寸止玩法")
    elif mode == "drink":
        generated = run(DRINK_PEE_LINES, "喝水/憋尿解锁")
    else:
        sys.exit("用法: python generate_voices.py [drink|edging|check]")

    if not generated or not validate_game_assets():
        sys.exit(1)


if __name__ == "__main__":
    main()
