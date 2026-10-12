"""Prepare the 80/20 catalog PDF for extraction.

usage: python3 -I scripts/catalog/prep.py <catalog.pdf> <work_dir> [--pages N,N,...]   (needs: pip install pymupdf)

With --pages, only annot/ and img/ are written for the listed PDF pages (for a follow-up pass over pages
that have no 15/F badge but define hardware that 15 series parts reference, such as the Bolt Assemblies tables).

Writes to work_dir:
  annot/pNNNN.txt   page text laid out by row, " | " between columns, series badges as tokens ([15], [10], [F], [metric], [RT], [QF], [P])
  img/pNNNN.png     page image at 130 dpi
  badge_rows.json   rows that carry a 15 or F badge, used by check.py for coverage
  chunks.json       pages grouped into extraction chunks (same catalog section, <= 8 pages, <= 70 badged rows)

Only pages with a 15 series or F (fractional hardware) badge are prepared.

Series badges are vector drawings, not text: a small filled box with white glyph outlines. Red boxes are fractional
(two glyphs = "10" or "15", one glyph = "F"); the second glyph of "15" is drawn with 21 path segments and the "0" of
"10" with 20, which is how the two are told apart. Blue = metric, green = RT, orange = QF, black = P.
"""
import json, os, re, sys
import pymupdf

PDF, WORK = sys.argv[1], sys.argv[2]
EXTRA = [int(x) for x in sys.argv[sys.argv.index('--pages') + 1].split(',')] if '--pages' in sys.argv else None
os.makedirs(f'{WORK}/annot', exist_ok=True)
os.makedirs(f'{WORK}/img', exist_ok=True)
doc = pymupdf.open(PDF)

RED, BLUE, BLUE2, GREEN, ORANGE, BLACK = (0.855, 0.102, 0.196), (0.0, 0.4, 0.7), (0.0, 0.5, 0.8), (0.0, 0.5, 0.2), (1.0, 0.5, 0.1), (0.0, 0.0, 0.0)


def near(a, b, t=0.06):
    return all(abs(x - y) < t for x, y in zip(a, b))


def badges(page):
    dr = page.get_drawings()
    whites = [x for x in dr if x.get('fill') and min(x['fill']) > 0.97 and x['rect'].width < 7 and x['rect'].height < 9]
    out = []
    for b in dr:
        f, r = b.get('fill'), b['rect']
        if not f or not (6 < r.width < 20 and 5 < r.height < 10):
            continue
        inside = sorted([w for w in whites if r.contains(w['rect'])], key=lambda w: w['rect'].x0)
        if not inside:
            continue
        n = len(inside)
        if near(f, RED):
            tok = ('15' if len(inside[1]['items']) >= 21 else '10') if n == 2 else ('F' if n == 1 else 'red?')
        elif near(f, BLUE) or near(f, BLUE2):
            tok = 'metric' if n == 2 else 'M'
        elif near(f, GREEN):
            tok = 'RT'
        elif near(f, ORANGE):
            tok = 'QF'
        elif near(f, BLACK, 0.12):
            tok = 'P'
        else:
            continue
        out.append((r, tok))
    return out


def layout(page, bdg):
    items = [(w[0], w[1], w[2], w[3], w[4]) for w in page.get_text('words')]
    items += [(r.x0, r.y0, r.x1, r.y1, f'[{t}]') for r, t in bdg]
    items.sort(key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    lines, cur, cy = [], [], None
    for w in items:
        c = (w[1] + w[3]) / 2
        if cy is not None and abs(c - cy) > 3:
            lines.append(cur)
            cur = []
        if not cur:
            cy = c
        cur.append(w)
    if cur:
        lines.append(cur)
    text, rows = [], []
    for ln in lines:
        ln.sort(key=lambda w: w[0])
        s, prev = '', None
        for w in ln:
            if prev is not None:
                s += ' | ' if w[0] - prev > 6 else ' '
            s += w[4]
            prev = w[2]
        text.append(s)
        toks = [w[4] for w in ln if w[4].startswith('[')]
        if any(t in ('[15]', '[F]') for t in toks):
            rows.append({'first_word': ln[0][4], 'badges': toks, 'line': s})
    return '\n'.join(text), rows


label_re = re.compile(r'^\d{1,2}-\d{1,3}$')


def label(page):
    first = next((l for l in page.get_text().splitlines() if label_re.match(l.strip())), None)
    return first.strip() if first else '?'


def write_page(n, page, bdg):
    txt, rows = layout(page, bdg)
    open(f'{WORK}/annot/p{n:04d}.txt', 'w').write(f'PDF page {n} | catalog page {label(page)}\n' + txt)
    page.get_pixmap(dpi=130).save(f'{WORK}/img/p{n:04d}.png')
    return rows


if EXTRA:
    for n in EXTRA:
        write_page(n, doc[n - 1], badges(doc[n - 1]))
        print(f'p{n} {label(doc[n - 1])}')
    sys.exit(0)

badge_rows, labels = {}, {}
for i, page in enumerate(doc):
    n = i + 1
    labels[n] = label(page)
    bdg = badges(page)
    if not any(t in ('15', 'F') for _, t in bdg):
        continue
    badge_rows[n] = write_page(n, page, bdg)

json.dump(badge_rows, open(f'{WORK}/badge_rows.json', 'w'), indent=0)

chunks, cur, load, sec = [], [], 0, None
for n in sorted(badge_rows):
    s = labels[n].split('-')[0]
    r = len(badge_rows[n])
    if cur and (s != sec or len(cur) >= 8 or load + r > 70):
        chunks.append(cur)
        cur, load = [], 0
    cur.append(n)
    load += r
    sec = s
if cur:
    chunks.append(cur)
json.dump([{'id': f'c{i:03d}', 'section': labels[c[0]].split('-')[0], 'pages': c, 'catalog_pages': [labels[n] for n in c],
            'badge_rows': sum(len(badge_rows[n]) for n in c)} for i, c in enumerate(chunks)], open(f'{WORK}/chunks.json', 'w'))
print(f'{len(badge_rows)} pages prepared in {len(chunks)} chunks; {sum(len(v) for v in badge_rows.values())} badged rows')
