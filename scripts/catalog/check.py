"""Deterministic checks on extracted chunk JSON against the annotated PDF text.

usage: python3 -I scripts/catalog/check.py <work_dir> <raw_dir> [--chunks file] [chunk_id ...]
work_dir holds annot/, badge_rows.json and chunks.json produced by prep.py. --chunks checks a follow-up pass instead
(parts there are referenced hardware, so any series badge is accepted).
Prints one line per problem and a per-chunk summary; exits 1 if any chunk has errors.
"""
import json, re, sys, os

work, raw = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
followup = '--chunks' in args
if followup:
    i = args.index('--chunks')
    chunks = json.load(open(args[i + 1]))
    del args[i:i + 2]
else:
    chunks = json.load(open(f'{work}/chunks.json'))
only = set(args)
badge_rows = json.load(open(f'{work}/badge_rows.json'))
CATS = set('profile structural_shape internal_fastener bracket_plate t_nut screw_bolt fastener_assembly hardware_other panel panel_mount hinge handle latch door_track gasket_edge caster foot_leveler base_plate linear_motion accessory end_cap stanchion tool machining_service kit pipe_joint other'.split())
PN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9.\-/]*\d[A-Za-z0-9.\-/]*$')

SUP = str.maketrans('⁰¹²³⁴⁵⁶⁷⁸⁹', '0123456789')

def norm(s): return re.sub(r'\s+', '', s.translate(SUP)).lower()


def value_found(v, flat):
    """A spec value is found if it, or each of its numeric pieces (for values that merge several cells), is in the text."""
    n = norm(v)
    if n in flat: return True
    nums = re.findall(r'\d[\d,./-]*\d|\d', v.translate(SUP))
    return bool(nums) and all(x in flat for x in nums)

bad_chunks = 0
for c in chunks:
    if only and c['id'] not in only: continue
    path = f"{raw}/{c['id']}.json"
    errs, warns = [], []
    if not os.path.exists(path):
        print(f"{c['id']}: MISSING FILE"); bad_chunks += 1; continue
    try:
        data = json.load(open(path))
    except Exception as e:
        print(f"{c['id']}: INVALID JSON {e}"); bad_chunks += 1; continue
    text = '\n'.join(open(f"{work}/annot/p{n:04d}.txt").read() for n in c['pages'])
    words = set(re.split(r'[\s|]+', text))
    words |= {w.rstrip('*†') for w in words}
    flat = norm(text)
    seen = {}
    hw = set()
    for p in data.get('parts', []):
        pn = p.get('part_number', '')
        if pn in seen: errs.append(f'duplicate {pn}')
        seen[pn] = p
        if pn not in words: errs.append(f'{pn}: part number not found verbatim in page text')
        if p.get('category') not in CATS: errs.append(f"{pn}: bad category {p.get('category')}")
        ser = p.get('series') or []
        if not followup and not set(ser) & {'15', 'F'}: errs.append(f'{pn}: series {ser} has neither 15 nor F')
        g = p.get('profile')
        if g:
            for k in ('ix_in4', 'iy_in4', 'weight_lb_per_in'):
                v = g.get(k)
                if v is None: warns.append(f'{pn}: profile.{k} missing'); continue
                # the printed value must exist in the text (formats like 0.2542 or .2542)
                s = f'{v}'.rstrip('0').rstrip('.')
                if s not in flat and s.lstrip('0') not in flat: errs.append(f'{pn}: profile.{k}={v} not in page text')
        for k, v in (p.get('specs') or {}).items():
            if isinstance(v, str) and len(norm(v)) >= 3 and not value_found(v, flat): warns.append(f'{pn}: spec {k}={v!r} not in text')
        for h in p.get('suggested_hardware') or []:
            hw.add(h.get('part_number'))
            if h.get('part_number') not in words: errs.append(f"{pn}: suggested hardware {h.get('part_number')} not in page text")
    # coverage: every row starting with a part-number-like word and carrying a 15/F badge
    for n in c['pages']:
        for r in badge_rows.get(str(n), []):
            w = r['first_word']
            if PN.match(w) and w not in seen and w not in hw:
                warns.append(f'p{n}: badge row {w!r} not extracted ({r["line"][:70]})')
    status = 'ERR' if errs else ('warn' if warns else 'ok')
    if errs: bad_chunks += 1
    print(f"{c['id']} {status}: {len(seen)} parts, {len(errs)} errors, {len(warns)} warnings")
    for e in errs: print('   E', e)
    for w in warns: print('   w', w)
sys.exit(1 if bad_chunks else 0)
