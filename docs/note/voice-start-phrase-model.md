# 语音开始：口令建模与参数

## 改口令时用 text2token 生成建模单元

```bash
pip install sherpa-onnx click sentencepiece pypinyin
```

- 中文：`text2token(['开始游戏'], tokens='backend/voice-kws/tokens.txt', tokens_type='ppinyin')` → `k āi sh ǐ y óu x ì`
- 英文：`text2token(['START THE GAME'], tokens='.../tokens.txt', tokens_type='phone+ppinyin', lexicon='<model>/en.phone')` → `S T AA1 R T DH AH0 G EY1 M`（必须大写，小写不在词典里会被跳过）

两者写进 `voicePhraseCatalog.js` 的 `tokens`；`buildKeywordsText()` 拼成 `<tokens> @<keyword>`。

英文 keyword 必须用下划线：关键词里不能有空格，`@` 后写 `start the game` 会让模型报 `Encode keywords failed`。目录里 `keyword` 存 `START_THE_GAME`（模型返回的就是它），`label` 是给人看的 `start the game`。

## 选型结论

zh-en 模型，-4..+4 九档语速 + 4 个 piper 音色 × 3 语速 = 21 条正例、324 条中英负例：`start the game` 21/21、0 误触发；`let's start the game` 同样 21/21 但更长；`game start` 全部误触发，弃用；`start game` 15/21；`start the game now` 16~18/21。中文「开始游戏」9/9、0 误触发。

参数：`keywordsScore=2.0`、`keywordsThreshold=0.15`、`maxActivePaths=4`、`numTrailingBlanks=1`、featConfig 16kHz/80 维、`modelingUnit=cjkchar`（对本模型只是标签）。score 1.5~2.5 × threshold 0.10~0.20 全网格结果一致。扫描脚本 `tmp/voice-probe-en/scripts/`（`measure.py` 单配置、`measure_all.py` 并行跑全部候选）。

一次装全部口令：KeywordSpotter 不支持按流换关键词，模型里始终装着两条；命中即回 `{type:'detected',phrase,phraseId}`，`ready` 带 `phrases`。一条 vs 两条的召回/误触发实测一致，单帧 decode 无差异（216ms vs 214ms / 6.4s 音频，约实时率 3.4%）。
