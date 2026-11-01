# 背单词词库（ECDICT 生成）

`backend/games/vocab-game/banks/` 下的 `gaokao.js` / `cet4.js` / `cet6.js` / `ielts.js` 由 `tools/vocab-bank/build_banks.py` 从 ECDICT 生成，勿手改。

## 来源与许可证

- 数据：ECDICT https://github.com/skywind3000/ECDICT ，MIT，Copyright (c) 2025 Linwei。许可证原文在同目录 `LICENSE-ECDICT.txt`。
- 下载 `ecdict.csv`（约 66MB，master 分支）放到 `tmp/vocab-bank/src/`。`tmp/` 已 gitignore，原始 csv 与中间文件都不入库。
- csv 当作不可信数据：只用自己的脚本读，Python 一律加 `-I`，不要在该目录运行别的解释器。

## 重新生成

```sh
python -I tools/vocab-bank/build_banks.py --csv tmp/vocab-bank/src/ecdict.csv \
  --out backend/games/vocab-game/banks

# 只生成部分词库，并随机抽 30 条/库打印出来人工检查
python -I tools/vocab-bank/build_banks.py --csv tmp/vocab-bank/src/ecdict.csv \
  --only cet4,ielts --sample 30

# 另存统计 JSON
python -I tools/vocab-bank/build_banks.py --csv ... --stats-json tmp/vocab-bank/stats.json
```

下载慢时可用 `https://ghfast.top/` 前缀镜像（如 `https://ghfast.top/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv`）。脚本会按 `tag` 字段一次流式扫描 csv，取 `gk`/`cet4`/`cet6`/`ielts`。

## 输出格式

每个文件给 `window.VG_BANKS` 挂一个词库，手机 `file://` 下直接 `<script>` 引入，不需要 fetch：

```js
window.VG_BANKS = window.VG_BANKS || {};
window.VG_BANKS.cet4 = { id: 'cet4', name: '四级', nameEn: 'CET-4', count: 3841,
  words: [["abandon", "ә'bændәn", "vt. 放弃；抛弃；遗弃", "vt. 放弃, 抛弃, 遗弃；n. 放任, 无拘束"], ...] };
```

`words` 每项为 `[word, phonetic, short, full]`：

- `word`：原词，保留原大小写；跨词库用小写做进度 id。
- `phonetic`：ECDICT 音标原样，空为 `''`，不带斜杠（游戏显示时自己加）。
- `short`：选项显示用，≤ 24 字符，取前 2 个词性行。
- `full`：答错时显示，≤ 80 字符，各词性行用 `；` 连接。

## 生成规则

- 跳过含空格的短语、除连字符外带标点的词（`Mr.`、`B.C.`）、长度大于 1 的全大写缩写（`TV`、`AIDS`）。
- 释义按 `translation` 里的 `\n` 分行；丢掉 `[网络]`/`[医]`/`[计]`/`[经]` 等方括号开头的行，以及词性后紧跟方括号标注的行，只保留含中文的行。
- `short`：最多前 2 个词性行，每行按 `,`/`，`/`;`/`；` 拆义项，最多 3 个，总长 ≤ 24 字符；放不下时先去括号补充说明再截断，不在英文单词中间切，也不为第二个词性截半句。
- `full`：过滤后所有词性行用 `；` 连接，超过 80 字符按行丢弃/截断。
- 没有可用中文释义的词丢弃。
- 排序：COCA `frq` 升序；`frq` 为 0 用 `bnc` 兜底；两者都 0 的排最后按字母序。
- `short` 完全相同的词保留，但游戏出干扰项时必须避开相同/互相包含的释义。

## 当前统计（2026-11-01，ECDICT master）

| 词库 | id | 词数 | 文件大小 | 平均 short | 重复 short（组/词） | 丢弃 |
|---|---|---|---|---|---|---|
| 高考 | gaokao | 3659 | 447 KB | 15.68 | 8 / 16 | 18（abbr 6、无中文 9、标点 3） |
| 四级 | cet4 | 3841 | 473 KB | 15.91 | 12 / 24 | 8（abbr 2、无中文 3、标点 3） |
| 六级 | cet6 | 5399 | 648 KB | 15.49 | 12 / 24 | 8（abbr 1、无中文 6、标点 1） |
| 雅思 | ielts | 5013 | 608 KB | 15.73 | 10 / 20 | 27（abbr 5、abbr 变形 3、无中文 17、短语 2） |

合计 2,174,827 字节（2.07 MB），单文件都小于 1MB。

“无中文”多为只有 `[计]`/`[经]` 等专业标注的词（如 internet、download、online），按规则整行被过滤后没有可用释义；“abbr 变形”指 `topics`/`ideas` 这类缩写词复数，释义只是缩写全称，词本身不是那个意思。

## 已知问题

- ECDICT 本身缺音标：gaokao 29、cet4 10、cet6 24、ielts 231 个词（多为复数/变形，如 States、sales），`phonetic` 为空串。
- 源数据有拼写问题（`reservior`、`uptodate`）和个别首词性不常用（`tough` 先给 `n. 恶棍`），脚本按原顺序取，不做人工修正。
