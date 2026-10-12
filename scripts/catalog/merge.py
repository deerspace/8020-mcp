"""Merge verified chunk files (data/raw/*.json) into data/catalog.json.

usage: python3 -I scripts/catalog/merge.py <raw_dir> <out_file>
Parts that appear in several chunks are merged: the most complete record wins, suggested hardware is unioned,
and every catalog page the part appears on is kept in catalog_pages.
"""
import json, re, sys, glob, datetime

raw, out = sys.argv[1], sys.argv[2]
KEEP = ['part_number', 'name', 'category', 'series', 'section', 'catalog_page', 'catalog_pages', 'description', 'features',
        'material', 'alloy', 'finish', 'color', 'weight', 'weight_lb', 'specs', 'dimension_notes', 'profile', 'shape',
        'suggested_hardware', 'notes']

ORDER = ['15', 'F', '10', 'M', 'RT', 'QF', 'P']


def completeness(p):
    return sum(1 for v in p.values() if v not in (None, '', [], {})) + len(p.get('specs') or {})

def psi(s):
    m = re.match(r'\s*([\d,]+)\s*(psi|lb)', s or '')
    return float(m.group(1).replace(',', '')) if m else None


def inches(s):
    m = re.match(r'\s*([\d.]+)\s*[”"]', s or '')
    return float(m.group(1)) if m else None

parts = {}
for f in sorted(glob.glob(f'{raw}/*.json')):
    for p in json.load(open(f)).get('parts', []):
        pn = p['part_number'].strip()
        p['part_number'] = pn
        pages = {p.get('catalog_page')} - {None}
        if pn in parts:
            old = parts[pn]
            winner, loser = (p, old) if completeness(p) > completeness(old) else (old, p)
            # Keep the winning record's hardware list; add only part numbers it does not already have.
            # (The same printed row is often described with different context wording on different pages.)
            hw = list(winner.get('suggested_hardware') or [])
            have = {h.get('part_number') for h in hw}
            hw += [h for h in loser.get('suggested_hardware') or [] if h.get('part_number') not in have]
            if hw: winner['suggested_hardware'] = hw
            winner['series'] = sorted(set(winner.get('series') or []) | set(loser.get('series') or []), key=lambda s: ORDER.index(s) if s in ORDER else 9)
            winner['catalog_pages'] = sorted(set(old.get('catalog_pages', [])) | pages)
            # Fill fields the winning record lacks (e.g. a weight printed on only one of the pages).
            for k, v in loser.items():
                if k not in winner or winner[k] in (None, '', [], {}):
                    winner[k] = v
            if isinstance(loser.get('specs'), dict):
                winner['specs'] = {**loser['specs'], **(winner.get('specs') or {})}
            parts[pn] = winner
        else:
            p['catalog_pages'] = sorted(pages)
            parts[pn] = p

# Extraction agents worked page group by page group; reword their process notes for a database reader.
REWORDS = [
    (r'on a preceding page not in this chunk', 'on a preceding page'),
    (r'\(not in this chunk\)', '(on another page)'),
    (r'not in this chunk', 'on another page'),
    (r'(are|is) not described in this chunk', r'\1 not described on this page'),
    (r'in this chunk:', 'on these pages:'),
    (r'missing from the extracted PDF text', 'missing from the PDF text layer'),
    (r'\bwhich are not extracted\b', 'which are not in this database'),
    (r'\(not extracted\)', '(not in this database)'),
    (r'\bnot extracted\b', 'not in this database'),
]


def reword(text):
    for pat, rep in REWORDS:
        text = re.sub(pat, rep, text)
    return text


for p in parts.values():
    for k in ('notes', 'description', 'dimension_notes'):
        if isinstance(p.get(k), str): p[k] = reword(p[k])
    w = p.get('weight')
    m = re.match(r'\s*([\d.]+)\s*lb', w or '')
    if m and not (p.get('profile') and 'per' in w): p['weight_lb'] = float(m.group(1))
    g = p.get('profile')
    if g:
        lens = [x for x in (inches(s) for s in g.get('stock_lengths') or []) if x]
        if lens: g['max_length_in'] = max(lens)
        if any('per inch' in (s or '').lower() for s in g.get('stock_lengths') or []): g['sold_per_inch'] = True
        specs = p.get('specs') or {}
        e, y = psi(specs.get('Modulus of Elasticity')), psi(specs.get('Yield Strength'))
        if e: g['modulus_psi'] = e
        if y: g['yield_psi'] = y
        # Shapes the catalog prints no moments of inertia for can't be beam-checked: keep their geometry as "shape".
        if g.get('ix_in4') is None or g.get('iy_in4') is None:
            p['shape'] = {k: v for k, v in g.items() if k not in ('ix_in4', 'iy_in4')}
            del p['profile']
    hws = p.get('suggested_hardware') or []
    for h in hws:
        if not h.get('part_number'): h.pop('part_number', None)
        if h.get('qty') is None:
            m = re.search(r'Qty\. printed as "([^"]+)"', h.get('description') or '')
            if m:
                h['qty'] = m.group(1)
            elif re.search(r'\b(nut|washer)\b', h.get('description') or '', re.I):
                # Hardware tables print one Qty. per row for a bolt + nut + washer set; nut/washer entries inherit it.
                same = {x.get('qty') for x in hws if x is not h and x.get('context') == h.get('context') and x.get('qty') is not None}
                if len(same) == 1: h['qty'] = same.pop()
    for k in list(p):
        if k not in KEEP: del p[k]

ordered = sorted(parts.values(), key=lambda p: (p['category'] != 'profile', p['category'], p['part_number']))
catalog = {
    'series': '80/20 fractional 15 series, plus fractional (F) hardware',
    'source': '80/20 product catalog PDF (889 pages), extracted page by page and cross-checked against the page text and images',
    'generated': datetime.date.today().isoformat(),
    'notes': [
        'Specs, part numbers and suggested hardware come from the 80/20 catalog. The catalog has no prices; prices come from prices.json, read from 8020.net.',
        'Confirm part numbers and prices on 8020.net before ordering. Catalog data can lag the website.',
        'Series badges: 15 = 15 series, F = fractional hardware for 10 and 15 series, RT = Ready Tube, QF = Quick Frame, P = pipe.',
        'Parts badged only 10 or M (metric) are included because 15 series parts list them as suggested or included hardware.',
        'Bolt Assemblies tables print no series badge; their series is inferred from thread size (5/16-18 = 15).',
        'series lists the 15/F/RT/QF/P badges. Metric badges printed alongside them (e.g. 15 + 40) are recorded in notes, not in series.',
        'suggested_hardware holds the T-slot mounting hardware for the 15 series; Ready Tube mounting hardware for 15+RT parts is described in notes.',
        'dimension_notes are read from the catalog drawings and are interpretive; the lettered values in specs are exactly as printed.',
    ],
    'parts': [{k: p[k] for k in KEEP if k in p} for p in ordered],
}
json.dump(catalog, open(out, 'w'), indent=1, ensure_ascii=False)
print(f'{len(ordered)} parts written to {out}')
