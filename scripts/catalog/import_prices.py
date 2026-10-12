"""Write data/prices.json from prices collected on 8020.net.

usage: python3 -I scripts/catalog/import_prices.py <collected.txt> <checked_date> [--units units.txt] [data_dir]

collected.txt has one whitespace-separated line per part: part_number, price, unit ("in" for per inch,
"ea" for each), then optionally the cut charge and a non-InStock availability (e.g. OutOfStock).
BEGIN/END marker lines are ignored. It is produced by reading 8020.net in a browser: the search
results page gives the price and whether it is per inch (per-inch items have no price type), and the
product page's schema.org Product data gives the unit and the cut charge.

units.txt (optional) overrides the unit for parts whose visible "Price Per ..." label differs from the
schema.org data: "part_number per_sqft <stock width> <stock height>" lines. The schema.org data marks
panels as per inch, but their pages price them per square foot and waive the cut charge at the stock
sheet size. ("Price Per Millimeter" pages are only a display unit; their schema.org price is per inch.)
"""
import json, re, sys
from pathlib import Path

args = sys.argv[1:]
units = {}
if '--units' in args:
    i = args.index('--units')
    for line in open(args[i + 1]):
        f = line.split()
        if f and not f[0].startswith('#'):
            units[f[0]] = (f[1], [float(f[2]), float(f[3])] if len(f) >= 4 else None)
    del args[i:i + 2]
src, checked = args[0], args[1]
data = Path(args[2] if len(args) > 2 else 'data')
catalog = {p['part_number'] for p in json.load(open(data / 'catalog.json'))['parts']}

prices, unknown = {}, []
for line in open(src):
    fields = line.split()
    if not fields or fields[0] == 'BEGIN' or fields[0] == 'END':
        continue
    pn, price, unit, *rest = fields
    cut = next((x for x in rest if re.fullmatch(r'[\d.]+', x)), None)
    avail = next((x for x in rest if not re.fullmatch(r'[\d.]+', x)), None)
    if pn not in catalog:
        unknown.append(pn)
        continue
    price_unit = 'per_inch' if unit == 'in' else 'each'
    if pn in units:
        price_unit = units[pn][0]
    entry = {
        'price': float(price),
        'price_unit': price_unit,
        'url': f'https://8020.net/{pn.lower()}.html',
        'verified': checked,
    }
    if cut is not None and unit == 'in':
        entry['cut_charge'] = float(cut)
    if pn in units and units[pn][1]:
        entry['stock_sheet_in'] = units[pn][1]
    if avail:
        entry['availability'] = avail
    prices[pn] = entry

out = {
    'source': '8020.net list prices (search results and product pages), read in a browser. Before tax, shipping and machining.',
    'prices': dict(sorted(prices.items())),
}
json.dump(out, open(data / 'prices.json', 'w'), indent=1)
units = {u: sum(1 for e in prices.values() if e['price_unit'] == u) for u in ('each', 'per_inch', 'per_sqft')}
print(f'{len(prices)} prices written {units}; {len(unknown)} rows skipped (not in catalog): {unknown[:10]}')
