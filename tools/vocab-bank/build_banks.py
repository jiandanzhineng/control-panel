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
  word      original spelling; phrases/punctuation/ALL-CAPS entries skipped
  phonetic  ECDICT phonetic without surrounding slashes, '' when missing
  short     option text, <= 24 chars, first 2 part-of-speech lines
  full      fuller gloss, <= 80 chars, part-of-speech lines joined by '；'

Plural/3rd-person forms are resolved via exchange (0:lemma + 1:s/s3/3/3s):
dropped when the lemma is in the same bank (unless the plural has its own
gloss), otherwise replaced by the lemma when that lemma is at least as
common. Person/place-only senses are dropped.
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
LONG_PAREN_RE = re.compile(r'[（(][^）)]{7,}[）)]')
BAD_NAME_RE = re.compile(r'[（(][^）)]*(?:人名|姓氏|地名|州名|城市名)[^）)]*[）)]')
INFLECTION_MARK_RE = re.compile(
    r'的(?:名词)?复数(?:形式)?|复数形式|的第三人称单数|第三人称单数|'
    r'三单形式|的过去式|的过去分词|的现在分词|ing形式')
PLURAL_TYPES = {'s', 's3', '3', '3s'}
TRIM = ' ,.，、;；:：'


def split_lines(text):
    return [s.strip() for s in LINE_SPLIT.split(text or '') if s.strip()]


def drop_bad_senses(body):
    """Drop senses that only describe a person/place name, keep separators."""
    chunks = re.split(r'([,，;；])', body)
    if not any(BAD_NAME_RE.search(chunks[i])
               for i in range(0, len(chunks), 2)):
        return body
    out = []
    for i in range(0, len(chunks), 2):
        seg = chunks[i]
        sep = chunks[i + 1] if i + 1 < len(chunks) else ''
        if seg.strip() and not BAD_NAME_RE.search(seg):
            out.append(seg + sep)
    return ''.join(out).strip().strip(TRIM + ' ')


def parse_meaning(translation):
    """Return [(pos, body)] for usable Chinese gloss lines.

    Lines starting with a field tag such as [网络]/[医]/[计]/[经] are
    dropped, as is a tag right after the part of speech ("n. [医] ...").
    Senses that are only person/place names are dropped as well.
    """
    pairs = []
    for line in split_lines(translation):
        if BRACKET_RE.match(line):
            continue
        m = POS_RE.match(line)
        pos, body = (m.group(1), m.group(2)) if m else ('', line)
        body = drop_bad_senses(body.strip())
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


def balance_brackets(text):
    """Drop a trailing unclosed bracket group (and stray closing brackets)."""
    stack = []
    for i, ch in enumerate(text):
        if ch in '（(':
            stack.append(i)
        elif ch in '）)':
            if stack:
                stack.pop()
            else:
                return text[:i]
    return text[:stack[0]] if stack else text


def cut_text(text, limit):
    """Cut to limit chars without slicing through a word or bracket group."""
    text = text[:limit]
    if len(text) == limit and text and text[-1].isascii() and text[-1].isalpha():
        i = len(text) - 1
        while i > 0 and text[i - 1].isascii() and text[i - 1].isalpha():
            i -= 1
        text = text[:i]
    text = balance_brackets(text)
    return text.rstrip(TRIM + ' （(【[〔')


def build_short(pairs, stats=None):
    """First 2 part-of-speech lines, <= 3 senses each, total <= 24 chars.

    Long parenthetical explanations (> 6 chars) are removed from short
    options; they are kept in the full gloss.
    """
    parts = []
    for pos, body in pairs[:2]:
        prefix = pos + '. ' if pos else ''
        senses = []
        for seg in SENSE_SPLIT.split(body):
            shortened = LONG_PAREN_RE.sub('', seg)
            if stats is not None and shortened != seg:
                stats['short_strip_paren'] += 1
            seg = clean_sense(shortened)
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


def effective_rank(row):
    frq = int(row.get('frq') or 0)
    bnc = int(row.get('bnc') or 0)
    return frq if frq > 0 else bnc


def parse_lemma(row):
    """Return the base word for a plural / 3rd-person form, else None."""
    exchange = row.get('exchange') or ''
    m0 = re.search(r'(?:^|/)0:([^/]+)', exchange)
    m1 = re.search(r'(?:^|/)1:([^/]+)', exchange)
    if not m0 or not m1 or m1.group(1) not in PLURAL_TYPES:
        return None
    word = (row.get('word') or '').strip().lower()
    lemma = m0.group(1).strip().lower()
    if not lemma or lemma == word:
        return None
    # A few rows are mislabelled ("does" -> "doe"); trust an explicit
    # "do的第三人称单数" reference in the gloss over the exchange field.
    ref = re.search(r'([A-Za-z]{2,})的(?:名词复数|复数|第三人称单数|三单)',
                    row.get('translation') or '')
    if ref and ref.group(1).lower() != lemma:
        return None
    return lemma


def make_entry(row, stats=None):
    """Build [word, phonetic, short, full] for one CSV row, or None."""
    pairs = parse_meaning(row.get('translation'))
    exchange = row.get('exchange') or ''
    if pairs and all(p == 'abbr' for p, _ in pairs) and \
            re.search(r'(?:^|/)[01]:', exchange):
        if stats is not None:
            stats['drop_abbr_form'] += 1
        return None
    short = build_short(pairs, stats)
    if not short:
        if stats is not None:
            stats['drop_no_meaning'] += 1
        return None
    return ((row.get('word') or '').strip(), (row.get('phonetic') or '').strip(),
            short, build_full(pairs), rank_key(row))


def gloss_senses(translation):
    """Normalized sense strings used to compare a plural with its lemma."""
    senses = set()
    for _, body in parse_meaning(translation):
        for seg in SENSE_SPLIT.split(body):
            seg = PAREN_RE.sub('', clean_sense(seg)).strip(TRIM + ' ')
            if seg:
                senses.add(seg)
    return senses


def independent_plural(row, lemma_row):
    """True when a plural has a gloss of its own (customs, means, works)."""
    if lemma_row is None or INFLECTION_MARK_RE.search(row.get('translation') or ''):
        return False
    own = gloss_senses(row.get('translation'))
    base = gloss_senses(lemma_row.get('translation'))
    if not own or not base:
        return False
    shared = len(own & base) / len(own)
    return shared < 0.5


def read_tagged(csv_path, ids):
    """First pass: collect tagged rows that pass the basic word filter."""
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
                rows[bid].append(row)
    return rows, stats


def read_lemmas(csv_path, needed):
    """Second pass: fetch base-word rows for inflected forms."""
    found = {}
    if not needed:
        return found
    with open(csv_path, encoding='utf-8', newline='') as f:
        for row in csv.DictReader(f):
            key = (row.get('word') or '').strip().lower()
            if key in needed:
                old = found.get(key)
                if old is None or (not (old.get('translation') or '').strip()
                                   and (row.get('translation') or '').strip()):
                    found[key] = row
    return found


def load_banks(csv_path, ids):
    """Resolve plural forms to base words, then build all glosses."""
    rows, stats = read_tagged(csv_path, ids)
    bank_words = {bid: {(r.get('word') or '').strip().lower() for r in rs}
                  for bid, rs in rows.items()}
    needed = set()
    for bid, rs in rows.items():
        for row in rs:
            lemma = parse_lemma(row)
            if lemma:
                needed.add(lemma)
    lemmas = read_lemmas(csv_path, needed)
    out = {bid: [] for bid in ids}
    seen = {bid: set() for bid in ids}
    for bid, rs in rows.items():
        for row in rs:
            src = row
            lemma = parse_lemma(row)
            if lemma:
                cand = lemmas.get(lemma)
                if lemma in bank_words[bid]:
                    if independent_plural(row, cand):
                        stats[bid]['keep_inflected'] += 1
                    else:
                        stats[bid]['drop_inflected'] += 1
                        continue
                elif cand is not None and word_reject(cand.get('word') or '') is None:
                    wr, lr = effective_rank(row), effective_rank(cand)
                    if lr > 0 and (wr == 0 or lr <= wr) and \
                            make_entry(cand) is not None:
                        src = cand
                        stats[bid]['replace_inflected'] += 1
                    else:
                        stats[bid]['keep_inflected'] += 1
                else:
                    stats[bid]['keep_inflected'] += 1
            entry = make_entry(src)
            if entry is None and src is not row:
                src = row
                stats[bid]['keep_inflected'] += 1
                entry = make_entry(src)
            if entry is None:
                make_entry(src, stats[bid])  # count the drop reason
                continue
            entry = make_entry(src, stats[bid])
            key = entry[0].lower()
            if key in seen[bid]:
                stats[bid]['drop_duplicate'] += 1
                continue
            seen[bid].add(key)
            out[bid].append(entry)
    return out, stats


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
        'inflectedReplaced': stats.get('replace_inflected', 0),
        'inflectedKept': stats.get('keep_inflected', 0),
        'shortStripParen': stats.get('short_strip_paren', 0),
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
