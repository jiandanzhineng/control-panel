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

下载慢时可用 `https://ghfast.top/` 前缀镜像（如 `https://ghfast.top/https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv`）。脚本按 `tag` 字段取 `gk`/`cet4`/`cet6`/`ielts`，扫描 csv 两遍：第一遍收 tagged 词和变形词，第二遍按需取 lemma 词条。

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
- 释义义项里带 `（人名）`/`（姓氏）`/`（地名）`/`（…州名）`/`（…城市名）` 的整段丢掉；丢完为空按无释义处理。
- 变形词：`exchange` 有 `0:<lemma>` 且 `1:` 是 `s`/`s3`/`3`/`3s`（复数、第三人称单数）且 lemma 不是自己时：
  - lemma 已在同一词库：丢弃该变形；但释义没有「X的复数/三单」这类标注、且与 lemma 释义的义项重合不到一半时按独立词保留（customs、means、works、mechanics、remains、pictures、sports、effects 等）。
  - lemma 不在词库：lemma 词频不比它差时整条替换成 lemma（词、音标、释义都取 lemma）；lemma 更冷门（chopsticks、sunglasses、keywords）或缺失（bedclothes）时保留原词。`stairs`/`sales`/`credentials` 的 `0:` 指向自己或没有 `0:`，天然保留。
  - `does` 这类 exchange 标错（`0:doe`）的，以释义里的「do的第三人称单数」为准，不替换。
- `short`：最多前 2 个词性行，每行按 `,`/`，`/`;`/`；` 拆义项，最多 3 个，总长 ≤ 24 字符；超过 6 字的括号补充说明（如 `网站（全球资讯网的主机站）`）在 short 里删掉，full 保留；放不下时先去括号再截断，不在英文单词中间切，不为第二个词性截半句，截断落在括号内时删掉整个括号组（不留 `英里（1英里约合1609米` 这种半边括号）。
- `full`：过滤后所有词性行用 `；` 连接，超过 80 字符按行丢弃/截断。
- 没有可用中文释义的词丢弃。
- 排序：COCA `frq` 升序；`frq` 为 0 用 `bnc` 兜底；两者都 0 的排最后按字母序。
- `short` 完全相同的词保留，但游戏出干扰项时必须避开相同/互相包含的释义。

## 当前统计（2026-11-01，ECDICT master）

| 词库 | id | 词数 | 文件大小 | 平均 short | 重复 short（组/词） | 丢弃 |
|---|---|---|---|---|---|---|
| 高考 | gaokao | 3656 | 446 KB | 15.66 | 8 / 16 | 21（abbr 6、变形 3、无中文 9、标点 3） |
| 四级 | cet4 | 3841 | 473 KB | 15.91 | 12 / 24 | 8（abbr 2、无中文 3、标点 3） |
| 六级 | cet6 | 5397 | 648 KB | 15.50 | 12 / 24 | 10（abbr 1、变形 3、无中文 5、标点 1） |
| 雅思 | ielts | 4843 | 589 KB | 15.68 | 7 / 14 | 197（abbr 5、abbr 变形 3、变形 175、无中文 12、短语 2） |

合计 2,155,803 字节（2.06 MB），单文件都小于 1MB。

变形词处理影响（丢弃 / 替换成 lemma / 保留）：gaokao 3 / 4 / 7，cet4 0 / 1 / 3，cet6 3 / 3 / 4，ielts 175 / 90 / 31（ielts 的 31 次保留判定里有 3 个随后按缩写变形规则丢弃）。相比未处理变形的第一版：gaokao 3659→3656、cet4 3841→3841、cet6 5399→5397、ielts 5013→4843。

“无中文”多为只有 `[计]`/`[经]` 等专业标注的词（如 internet、download、online），按规则整行被过滤后没有可用释义；“abbr 变形”指 `topics`/`ideas` 这类缩写词复数，释义只是缩写全称，词本身不是那个意思。

## 已知问题

- ECDICT 本身缺音标：gaokao 25、cet4 10、cet6 24、ielts 50 个词，`phonetic` 为空串（ielts 从 231 降到 50，主要是复数换成了带音标的 lemma）。
- 源数据有拼写问题（`reservior`、`uptodate`）和个别首词性不常用（`tough` 先给 `n. 恶棍`），脚本按原顺序取，不做人工修正。
