#!/usr/bin/env python3
"""Build the vocab-game Japanese JLPT word banks (N5-N1).

Source data: SeupLio/kotoba-jlpt processed JLPT N5-N1 JSON files (CC BY-SA 4.0),
derived from OpenJLPT (CC BY-SA 4.0), Japanese-Chinese-thesaurus (Unlicense),
and kotoba-jlpt overrides (CC0).

The downloaded JSON files are untrusted input: run this script with `python -I`,
keep source files in `tmp/vocab-bank/ja-src/kotoba/`, and never execute anything
from that directory.

Usage:
  python -I tools/vocab-bank/build_ja_banks.py \
      --src tmp/vocab-bank/ja-src/kotoba \
      --out backend/games/vocab-game/banks

  # build only some levels and print 20 random entries per bank for review
  python -I tools/vocab-bank/build_ja_banks.py \
      --src tmp/vocab-bank/ja-src/kotoba \
      --only jlpt_n5,jlpt_n4 --sample 20

Output: one JS file per bank, assigning window.VG_BANKS.<id>:
  { id, name, nameEn, lang: 'ja-JP', count, words: [[word, phonetic, short, full], ...] }

Fields:
  word      Japanese surface form (kanji/kana)
  phonetic  Kana reading ('' when identical to word, e.g. pure kana words)
  short     Option text with POS prefix, <= 24 chars
  full      Fuller gloss with POS prefix, <= 80 chars
"""
import argparse
import collections
import json
import os
import random
import re
import sys

BANKS = [
    ('jlpt_n5', 'n5.json', '日语 N5', 'JLPT N5'),
    ('jlpt_n4', 'n4.json', '日语 N4', 'JLPT N4'),
    ('jlpt_n3', 'n3.json', '日语 N3', 'JLPT N3'),
    ('jlpt_n2', 'n2.json', '日语 N2', 'JLPT N2'),
    ('jlpt_n1', 'n1.json', '日语 N1', 'JLPT N1'),
]

SHORT_MAX = 24
FULL_MAX = 80
TRIM = ' ,.，、;；:：'
PAREN_RE = re.compile(r'[（(][^）)]{1,48}[）)]')
LONG_PAREN_RE = re.compile(r'[（(][^）)]{7,}[）)]')

POS_MAP = {
    '名词': 'n.',
    '五段动词': 'v.',
    '一段动词': 'v.',
    'サ变动词': 'v.',
    'ザ变动词': 'v.',
    'カ变动词': 'v.',
    '形容词（い）': 'adj.',
    '形容动词（な）': 'adj.',
    '连体词': 'adj.',
    '连体修饰语': 'adj.',
    'タルト型形容词': 'adj.',
    'ナリ形容词': 'adj.',
    '副词': 'adv.',
    '副词（と）': 'adv.',
    '感叹词': 'int.',
    '接续词': 'conj.',
    '代词': 'pron.',
    '数词': 'num.',
    '量词/助数词': 'num.',
    '助词': 'part.',
    '助动词': 'aux.',
    '前缀': 'pref.',
    '名词性前缀': 'pref.',
    '后缀': 'suf.',
    '名词性后缀': 'suf.',
    '短语/惯用': 'phr.',
}

BUCKET_FALLBACK = {
    'N': 'n.',
    'V': 'v.',
    'ADJ': 'adj.',
    'ADV': 'adv.',
    'EXP': 'phr.',
    'AFFIX': 'aff.',
}


def map_pos(word, pos_list, bucket):
    if isinstance(pos_list, list):
        if word.endswith('する') and any('动词' in str(p or '') for p in pos_list):
            return 'v.'
        for p in pos_list:
            key = str(p or '').strip()
            if key in POS_MAP:
                return POS_MAP[key]
    return BUCKET_FALLBACK.get(str(bucket or '').strip().upper(), '')


def strip_unclosed_paren(text):
    for open_ch, close_ch in (('（', '）'), ('(', ')')):
        last_open = text.rfind(open_ch)
        if last_open >= 0 and text.find(close_ch, last_open) < 0:
            text = text[:last_open]
    return text.rstrip(TRIM + ' ')


def trim_to(text, limit):
    text = text.strip()
    if len(text) <= limit:
        return text
    cleaned = LONG_PAREN_RE.sub('', text).strip()
    cleaned = re.sub(r'\s{2,}', ' ', cleaned)
    if cleaned and len(cleaned) <= limit:
        return cleaned
    cleaned = PAREN_RE.sub('', text).strip()
    cleaned = re.sub(r'\s{2,}', ' ', cleaned)
    if cleaned and len(cleaned) <= limit:
        return cleaned
    cut = text[:limit]
    cut = strip_unclosed_paren(cut)
    return cut.rstrip(TRIM + ' ') or text[:limit]


def clean_senses(raw_zh):
    out = []
    seen = set()
    for item in raw_zh or []:
        s = re.sub(r'\s+', ' ', str(item or '').strip()).strip(TRIM)
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def format_gloss(prefix, senses, limit, max_senses):
    head = (prefix + ' ') if prefix else ''
    picked = []
    for sense in senses[:max_senses]:
        cand = head + '；'.join(picked + [sense])
        if len(cand) <= limit:
            picked.append(sense)
        elif not picked:
            compact = LONG_PAREN_RE.sub('', sense).strip(TRIM + ' ')
            if compact and len(head + compact) <= limit:
                picked.append(compact)
            else:
                picked.append(trim_to(sense, max(4, limit - len(head))))
            break
        else:
            break
    result = (head + '；'.join(picked)).strip()
    if len(result) > limit:
        result = trim_to(result, limit)
    return result


def load_bank(src_path):
    with open(src_path, 'r', encoding='utf-8') as f:
        items = json.load(f)
    rows = []
    stats = collections.Counter()
    seen_words = set()
    for idx, item in enumerate(items):
        stats['raw'] += 1
        word = str(item.get('word') or '').strip()
        if not word:
            stats['drop_empty_word'] += 1
            continue
        key = word.lower()
        if key in seen_words:
            stats['drop_dup'] += 1
            continue
        senses = clean_senses(item.get('zh'))
        if not senses:
            stats['drop_no_zh'] += 1
            continue
        reading = str(item.get('reading') or '').strip()
        phonetic = '' if (not reading or reading == word) else reading
        pos = map_pos(word, item.get('pos'), item.get('bucket'))
        short = format_gloss(pos, senses, SHORT_MAX, 3)
        full = format_gloss(pos, senses, FULL_MAX, 8)
        if not short:
            stats['drop_no_short'] += 1
            continue
        seen_words.add(key)
        order = item.get('order')
        sort_key = (int(order) if isinstance(order, int) else idx, idx)
        rows.append((word, phonetic, short, full, sort_key))
    rows.sort(key=lambda r: r[4])
    return rows, stats


def write_bank(out_dir, bank, rows):
    bid, _src_file, name, name_en = bank
    path = os.path.join(out_dir, bid + '.js')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write('// Generated from kotoba-jlpt (CC BY-SA 4.0) by tools/vocab-bank/build_ja_banks.py. Do not edit by hand.\n')
        f.write('window.VG_BANKS = window.VG_BANKS || {};\n')
        f.write("window.VG_BANKS.%s = { id: '%s', name: %s, nameEn: %s, lang: 'ja-JP', count: %d, words: [\n"
                % (bid, bid, json.dumps(name, ensure_ascii=False),
                   json.dumps(name_en, ensure_ascii=False), len(rows)))
        for i, (word, phonetic, short, full, _) in enumerate(rows):
            item = json.dumps([word, phonetic, short, full], ensure_ascii=False,
                              separators=(',', ':'))
            f.write('  ' + item + (',\n' if i < len(rows) - 1 else '\n'))
        f.write('] };\n')
    return path


def summarize(rows, stats):
    sh = [r[2] for r in rows]
    dup = collections.Counter(sh)
    dup_groups = sum(1 for n in dup.values() if n > 1)
    dup_words = sum(n for n in dup.values() if n > 1)
    dropped = {k[5:]: v for k, v in stats.items() if k.startswith('drop_')}
    return {
        'count': len(rows),
        'avgShort': round(sum(len(s) for s in sh) / len(sh), 2) if sh else 0,
        'maxShort': max((len(s) for s in sh), default=0),
        'maxFull': max((len(r[3]) for r in rows), default=0),
        'duplicateShortGroups': dup_groups,
        'duplicateShortWords': dup_words,
        'withPhonetic': sum(1 for r in rows if r[1]),
        'raw': stats['raw'],
        'dropped': dropped,
    }


def print_samples(rows, bid, n, seed):
    rng = random.Random(seed)
    sample = rng.sample(rows, min(n, len(rows)))
    print('\n===== %s sample (%d) =====' % (bid, len(sample)))
    for word, phonetic, short, full, _ in sample:
        print('%s | %s | %s | %s' % (word, phonetic or '-', short, full))


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(description='Build vocab-game Japanese JLPT banks')
    ap.add_argument('--src', required=True, help='Directory containing n1.json..n5.json')
    ap.add_argument('--out', default='backend/games/vocab-game/banks')
    ap.add_argument('--only', default='', help='comma separated bank ids')
    ap.add_argument('--sample', type=int, default=0)
    ap.add_argument('--seed', type=int, default=20261123)
    ap.add_argument('--stats-json', default='')
    args = ap.parse_args()

    all_ids = [b[0] for b in BANKS]
    ids = [s.strip() for s in args.only.split(',') if s.strip()] or all_ids
    bad = set(ids) - set(all_ids)
    if bad:
        sys.exit('unknown bank ids: ' + ', '.join(sorted(bad)))
    os.makedirs(args.out, exist_ok=True)

    report = {}
    total_size = 0
    for bank in BANKS:
        bid, src_file, name, _name_en = bank
        if bid not in ids:
            continue
        src_path = os.path.join(args.src, src_file)
        if not os.path.isfile(src_path):
            sys.exit('missing source file: ' + src_path)
        rows, stats = load_bank(src_path)
        path = write_bank(args.out, bank, rows)
        size = os.path.getsize(path)
        total_size += size
        info = summarize(rows, stats)
        info['bytes'] = size
        info['file'] = path
        report[bid] = info
        print('%-8s %-7s count=%-5d raw=%-5d avgShort=%.2f maxShort=%d '
              'maxFull=%d dupShort=%d/%d phonetic=%d %d bytes'
              % (bid, name, info['count'], info['raw'], info['avgShort'],
                 info['maxShort'], info['maxFull'],
                 info['duplicateShortGroups'], info['duplicateShortWords'],
                 info['withPhonetic'], size))
        if info['dropped']:
            print('         dropped:', ', '.join(
                '%s=%d' % (k, v) for k, v in sorted(info['dropped'].items())))
        if args.sample:
            print_samples(rows, bid, args.sample, args.seed)
    print('\ntotal size: %d bytes (%.2f MB)' % (total_size, total_size / 1048576))
    if args.stats_json:
        with open(args.stats_json, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == '__main__':
    sys.exit(main())
