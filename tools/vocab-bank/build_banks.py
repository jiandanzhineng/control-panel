#!/usr/bin/env python3
"""Build the vocab-game word banks from ECDICT.

Source data: ECDICT (MIT) https://github.com/skywind3000/ECDICT
The downloaded CSV is untrusted input: run this script with `python -I`,
keep the CSV in its own empty directory (e.g. tmp/vocab-bank/src/), and
never execute anything from that directory.

Usage:
  python -I tools/vocab-bank/build_banks.py --csv tmp/vocab-bank/src/ecdict.csv \
      --out backend/games/vocab-game/banks

  # build only some banks and print 30 random entries per bank for review
  python -I tools/vocab-bank/build_banks.py --csv tmp/vocab-bank/src/ecdict.csv \
      --only cet4,ielts --sample 30

Options:
  --csv PATH      ECDICT csv file (required)
  --out DIR       output directory (default: backend/games/vocab-game/banks)
  --only IDS      comma separated bank ids: gaokao,cet4,cet6,ielts
  --sample N      print N random words per bank for manual review (default 0)
  --seed N        random seed for sampling (default 20261101)
  --stats-json P  also write build statistics as JSON to P

Output: one JS file per bank, assigning window.VG_BANKS.<id>:
  { id, name, nameEn, count, words: [[word, phonetic, short, full], ...] }

Fields:
  word      original spelling, phrases/punctuation/ALL-CAPS entries skipped
  phonetic  ECDICT phonetic without surrounding slashes, '' when missing
  short     option text, <= 24 chars, first 2 part-of-speech lines
  full      fuller gloss, <= 80 chars, part-of-speech lines joined by '；'
"""
import argparse
import collections
import csv
import json
import os
import random
import re
import sys

BANKS = [
    ('gaokao', 'gk', '高考', 'Gaokao'),
    ('cet4', 'cet4', '四级', 'CET-4'),
    ('cet6', 'cet6', '六级', 'CET-6'),
    ('ielts', 'ielts', '雅思', 'IELTS'),
]
SHORT_MAX = 24
FULL_MAX = 80
LINE_SPLIT = re.compile(r'\\r\\n|\\n|\r\n|\n')
POS_RE = re.compile(r'^([A-Za-z]{1,6})\.\s*(.*)$')
SENSE_SPLIT = re.compile(r'[,，;；]')
BRACKET_RE = re.compile(r'^\[[^\]]{1,10}\]')
WORD_RE = re.compile(r'^[A-Za-z][A-Za-z\-]*$')
CJK_RE = re.compile(r'[一-鿿]')
PAREN_RE = re.compile(r'[（(][^）)]{1,48}[）)]')
TRIM = ' ,.，、;；:：'


def split_lines(text):
    return [s.strip() for s in LINE_SPLIT.split(text or '') if s.strip()]


def parse_meaning(translation):
    """Return [(pos, body)] for usable Chinese gloss lines.

    Lines starting with a field tag such as [网络]/[医]/[计]/[经] are
    dropped, as is a tag right after the part of speech ("n. [医] ...").
    Lines without any Chinese characters are dropped too.
    """
    pairs = []
    for line in split_lines(translation):
        if BRACKET_RE.match(line):
            continue
        m = POS_RE.match(line)
        pos, body = (m.group(1), m.group(2)) if m else ('', line)
        body = body.strip()
        if not body or body.startswith('[') or not CJK_RE.search(body):
            continue
        pairs.append((pos, body))
    return pairs


def clean_body(body):
    """Normalize whitespace and ellipses for display."""
    body = re.sub(r'\s+', ' ', body)
    body = re.sub(r'……|\.{3,}', '…', body)
    return body.strip()


def clean_sense(seg):
    return clean_body(seg).strip(TRIM + ' ')


def strip_parens(text):
    prev = None
    while prev != text:
        prev = text
        text = PAREN_RE.sub('', text)
    return text.strip(TRIM + ' ')


def cut_text(text, limit):
    """Cut to limit chars without slicing through an ASCII word."""
    text = text[:limit]
    if len(text) == limit and text and text[-1].isascii() and text[-1].isalpha():
        i = len(text) - 1
        while i > 0 and text[i - 1].isascii() and text[i - 1].isalpha():
            i -= 1
        text = text[:i]
    return text.rstrip(TRIM + ' （(【[〔')


def build_short(pairs):
    """First 2 part-of-speech lines, <= 3 senses each, total <= 24 chars."""
    parts = []
    for pos, body in pairs[:2]:
        prefix = pos + '. ' if pos else ''
        senses = []
        for seg in SENSE_SPLIT.split(body):
            seg = clean_sense(seg)
            if not seg or seg in senses or len(senses) >= 3:
                continue
            if not CJK_RE.search(seg):
                continue
            if len('；'.join(parts + [prefix + '；'.join(senses + [seg])])) <= SHORT_MAX:
                senses.append(seg)
                continue
            if not senses and not parts:
                budget = SHORT_MAX - len(prefix)
                seg = cut_text(strip_parens(seg), budget)
                if seg and CJK_RE.search(seg):
                    senses.append(seg)
            break
        if senses:
            parts.append(prefix + '；'.join(senses))
        if len('；'.join(parts)) >= SHORT_MAX:
            break
    return '；'.join(parts)


def build_full(pairs):
    """All usable gloss lines joined by '；', capped at 80 chars."""
    lines = []
    for pos, body in pairs:
        text = clean_body((pos + '. ' + body) if pos else body)
        if text:
            lines.append(text)
    kept = []
    for line in lines:
        if len('；'.join(kept + [line])) <= FULL_MAX:
            kept.append(line)
        elif kept:
            break
        else:
            kept.append(cut_text(line, FULL_MAX))
    return '；'.join(kept)


def word_reject(word):
    """Return a drop reason for words we do not want in the game."""
    if not word:
        return 'empty'
    if ' ' in word:
        return 'phrase'
    if not WORD_RE.match(word):
        return 'punct'
    if len(word) > 1 and word.isupper():
        return 'abbr'
    return None


def rank_key(row):
    """Sort by COCA rank, fall back to BNC, unknown ranks last."""
    frq = int(row.get('frq') or 0)
    bnc = int(row.get('bnc') or 0)
    rank = frq if frq > 0 else bnc
    word = (row.get('word') or '').lower()
    return (0, rank, word) if rank > 0 else (1, 0, word)


REQUIRED_COLUMNS = {'word', 'phonetic', 'translation', 'tag', 'bnc', 'frq'}


def load_banks(csv_path, ids):
    """Stream the CSV once, bucket tagged rows and build glosses."""
    wanted = {tag: bid for bid, tag, _, _ in BANKS if bid in ids}
    rows = {bid: [] for bid in ids}
    seen = {bid: set() for bid in ids}
    stats = {bid: collections.Counter() for bid in ids}
    with open(csv_path, encoding='utf-8', newline='') as f:
        reader = csv.DictReader(f)
        missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
        if missing:
            sys.exit('missing CSV columns: ' + ', '.join(sorted(missing)))
        for row in reader:
            tags = set((row.get('tag') or '').split())
            for tag, bid in wanted.items():
                if tag not in tags:
                    continue
                stats[bid]['raw'] += 1
                word = (row.get('word') or '').strip()
                reason = word_reject(word)
                if reason:
                    stats[bid]['drop_' + reason] += 1
                    continue
                key = word.lower()
                if key in seen[bid]:
                    stats[bid]['drop_duplicate'] += 1
                    continue
                seen[bid].add(key)
                pairs = parse_meaning(row.get('translation'))
                exchange = row.get('exchange') or ''
                if pairs and all(p == 'abbr' for p, _ in pairs) and \
                        re.search(r'(?:^|/)[01]:', exchange):
                    # Inflected form of an acronym ("topics" -> TOPICS),
                    # its gloss is not the meaning of the word itself.
                    stats[bid]['drop_abbr_form'] += 1
                    continue
                short = build_short(pairs)
                if not short:
                    stats[bid]['drop_no_meaning'] += 1
                    continue
                rows[bid].append(
                    (word, (row.get('phonetic') or '').strip(), short,
                     build_full(pairs), rank_key(row)))
    return rows, stats


HEADER = (
    '// 来源 ECDICT (MIT) https://github.com/skywind3000/ECDICT ，'
    '由 tools/vocab-bank/build_banks.py 生成，勿手改\n'
    'window.VG_BANKS = window.VG_BANKS || {};\n'
)


def write_bank(out_dir, bank, words):
    bid, _, name, name_en = bank
    path = os.path.join(out_dir, bid + '.js')
    head = ("window.VG_BANKS.%s = { id: '%s', name: '%s', nameEn: '%s', "
            "count: %d, words: [\n" % (bid, bid, name, name_en, len(words)))
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(HEADER)
        f.write(head)
        for i, (word, phonetic, short, full, _) in enumerate(words):
            item = json.dumps([word, phonetic, short, full], ensure_ascii=False,
                              separators=(',', ':'))
            f.write('  ' + item + (',\n' if i < len(words) - 1 else '\n'))
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
        'raw': stats['raw'],
        'dropped': dropped,
    }


def print_samples(rows, bid, n, seed):
    rng = random.Random(seed)
    sample = rng.sample(rows, min(n, len(rows)))
    print('\n===== %s sample (%d) =====' % (bid, len(sample)))
    for word, phonetic, short, full, key in sample:
        print('%s | /%s/ | %s | %s | rank=%s' % (word, phonetic, short, full, key[1]))


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(description='Build vocab-game banks from ECDICT')
    ap.add_argument('--csv', required=True, help='ECDICT csv path')
    ap.add_argument('--out', default='backend/games/vocab-game/banks')
    ap.add_argument('--only', default='', help='comma separated bank ids')
    ap.add_argument('--sample', type=int, default=0)
    ap.add_argument('--seed', type=int, default=20261101)
    ap.add_argument('--stats-json', default='')
    args = ap.parse_args()

    all_ids = [b[0] for b in BANKS]
    ids = [s.strip() for s in args.only.split(',') if s.strip()] or all_ids
    bad = set(ids) - set(all_ids)
    if bad:
        sys.exit('unknown bank ids: ' + ', '.join(sorted(bad)))
    os.makedirs(args.out, exist_ok=True)

    rows, stats = load_banks(args.csv, ids)
    report = {}
    total_size = 0
    for bank in BANKS:
        bid = bank[0]
        if bid not in ids:
            continue
        data = sorted(rows[bid], key=lambda r: r[4])
        path = write_bank(args.out, bank, data)
        size = os.path.getsize(path)
        total_size += size
        info = summarize(data, stats[bid])
        info['bytes'] = size
        info['file'] = path
        report[bid] = info
        print('%-7s %-4s count=%-5d raw=%-5d avgShort=%.2f maxShort=%d '
              'maxFull=%d dupShort=%d/%d %d bytes'
              % (bid, bank[2], info['count'], info['raw'], info['avgShort'],
                 info['maxShort'], info['maxFull'],
                 info['duplicateShortGroups'], info['duplicateShortWords'], size))
        if info['dropped']:
            print('        dropped:', ', '.join(
                '%s=%d' % (k, v) for k, v in sorted(info['dropped'].items())))
        if args.sample:
            print_samples(data, bid, args.sample, args.seed)
    print('\ntotal size: %d bytes (%.2f MB)' % (total_size, total_size / 1048576))
    if args.stats_json:
        with open(args.stats_json, 'w', encoding='utf-8') as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == '__main__':
    sys.exit(main())
