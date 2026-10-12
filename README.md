# 8020-mcp

An MCP server with a local catalog of **80/20 fractional 15 series** T-slot parts and the fractional hardware they use. It lets Claude (or any MCP client) look up parts, choose a profile for a span and load, price a bill of materials, and plan cuts.

80/20 has no public API, so the catalog is built from 80/20's own product catalog PDF and stored as JSON in this repo.

## Tools

| Tool | What it does |
| --- | --- |
| `catalog_info` | What the catalog covers: part counts per category, data source, caveats. |
| `search_parts` | Search by part number or keywords (`1530`, `inside corner bracket`, `swivel caster`, `5/16-18`), filtered by category or series badge. |
| `get_part` | Full record for one or more parts: specs, dimensions, section properties, suggested mounting hardware, catalog page, price if checked. |
| `recommend_profile` | Every 15 series profile and orientation stiff and strong enough for a span and load, lightest first. |
| `beam_deflection` | Deflection, bending stress and safety factor for a chosen profile, span, load and support. |
| `build_bom` | Price a parts list (cut-to-length profiles include the per-piece cut charge) and list the mounting hardware each bracket needs. |
| `optimize_cuts` | Pack cut pieces into stock bars to minimize waste when you cut your own. |

## Setup

Requires Node 20+.

```bash
npm install
```

```bash
npm run build
```

**Claude Code:** this folder has a `.mcp.json`, so starting `claude` here offers to load the server. To use it from any folder:

```bash
claude mcp add 8020 -- node "$(pwd)/dist/index.js"
```

**Claude Desktop:** add this to `claude_desktop_config.json`, using the absolute path to this folder:

```json
{
  "mcpServers": {
    "8020": { "command": "node", "args": ["/absolute/path/to/8020-mcp/dist/index.js"] }
  }
}
```

## Data

- `data/catalog.json`: parts, specs and suggested hardware, extracted from the 80/20 catalog PDF.
- `data/prices.json`: list prices read from 8020.net, each with the date it was checked. The PDF has no prices, so most parts are unpriced until added here; `build_bom` reports which lines are unpriced.
- `data/raw/`: the per-chunk extraction output that `catalog.json` is merged from.

Series badges as printed in the catalog: `15` = 15 series, `F` = fractional hardware (fits 10 and 15 series), `RT` = Ready Tube, `QF` = Quick Frame, `P` = pipe. A few parts badged only `10` or `M` (metric) are included because 15 series parts list them as suggested or included hardware. Bolt assembly tables print no badge, so their series comes from the thread size (5/16-18 = 15).

Always confirm part numbers and prices on [8020.net](https://8020.net) before ordering.

### Rebuilding the catalog from a new PDF

```bash
pip install pymupdf
```

```bash
python3 -I scripts/catalog/prep.py path/to/catalog.pdf work/
```

`prep.py` finds every page with a 15 series or F badge (the badges are vector drawings, decoded from their glyph shapes), and writes per-page annotated text, page images and extraction chunks. Each chunk is then extracted to `data/raw/<chunk>.json` and checked by a second reader.

Some hardware has no badge to find: the Bolt Assemblies tables (catalog pages 4-182 to 4-192) print none, and some screws, nuts and washers that 15 series parts list as suggested hardware are badged only 10 or metric. Prepare those pages with `--pages` and extract them as a follow-up pass (the `s*.json` and `t*.json` files in `data/raw/`):

```bash
python3 -I scripts/catalog/prep.py path/to/catalog.pdf work/ --pages 346,347,348
```

Then check and merge:

```bash
python3 -I scripts/catalog/check.py work/ data/raw
```

```bash
python3 -I scripts/catalog/merge.py data/raw data/catalog.json
```

`check.py` confirms every part number and spec value appears in the page text and that every badged row was extracted. `merge.py` deduplicates parts that appear on several pages.

### Data quality

The current catalog was extracted from 80/20's 889-page catalog: 2,388 parts, including 90 T-slot profiles with section properties and 145 bolt-and-nut fastener assemblies.

- Every chunk was extracted by one reader and independently re-checked against the page text and image by a second.
- `check.py` confirms every part number and profile number appears in the PDF text, and every 15/F badged table row was extracted. The few part numbers on pages with an unreadable text layer were confirmed by eye.
- All 1,362 suggested-hardware references resolve to parts in the catalog, except three included-hardware components the catalog never defines (275401, 206701, 209002).
- A stratified audit of 167 random parts found 127 with no issue at all and 8 real errors. The 8 were 2 duplicated hardware entries from the merge, 2 "1 or 2" quantities that had been dropped, and 4 cases of the conventions below. The merge bugs are fixed; the rest were wording, not values.

Conventions to know:

- `series` lists the 15/F/RT/QF/P badges. Metric badges printed next to them (e.g. a part badged 15 and 40) are mentioned in `notes`.
- `suggested_hardware` holds 15 series T-slot mounting hardware. Ready Tube mounting hardware for 15+RT parts is in `notes`.
- `dimension_notes` interpret the catalog drawings; the lettered values in `specs` are exactly as printed.

## Engineering assumptions

Beam checks use the modulus and yield strength each profile's catalog table prints (10,000,000 psi and 25,000 psi for the 6063-T6 aluminum profiles; the fiber reinforced 1515FRP-BLACK lists its own) and textbook formulas for ideal supports under static load. T-slot joints are not perfectly rigid, so `simply_supported` is the conservative choice for bracketed frames. Connector and fastener capacity often limits a design before the profile does, and is not checked.

## Development

```bash
npm test
```
