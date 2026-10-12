import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export type PriceUnit = "each" | "per_inch";

export interface ProfileGeometry {
  /** Outer dimensions in inches, in title order (1530 = 1.50 wide x 3.00 tall). */
  width_in: number;
  height_in: number;
  /** Moments of inertia as published by 80/20, in^4. */
  ix_in4: number;
  iy_in4: number;
  weight_lb_per_in: number;
  area_in2?: number;
  stock_lengths?: string[];
  sold_per_inch?: boolean;
  /** Longest stock length, used to flag cuts that cannot be bought in one piece. */
  max_length_in?: number;
  open_slots?: number;
  drop_lock?: string;
  /** Published modulus of elasticity and yield strength, when the catalog prints them (6063-T6 aluminum unless noted). */
  modulus_psi?: number;
  yield_psi?: number;
}

/** Geometry of a structural shape the catalog gives no section properties for (flat stock, angles, tubes). */
export type ShapeGeometry = Omit<ProfileGeometry, "ix_in4" | "iy_in4">;

export interface SuggestedHardware {
  /** Absent when the catalog describes included hardware without a part number. */
  part_number?: string;
  /** A number, or the catalog's text when it prints a range such as "1 or 2"; absent when not printed. */
  qty?: number | string;
  description?: string;
  context?: string;
}

export interface Price {
  price: number;
  price_unit: PriceUnit;
  /** Per-piece cut charge for profiles sold by the inch. */
  cut_charge?: number;
  url?: string;
  /** ISO date the price was read from 8020.net. */
  verified: string;
}

export interface Part {
  part_number: string;
  name: string;
  category: string;
  /** Series badges printed in the catalog: "15", "F" (fractional hardware), "RT", "QF", "P". */
  series: string[];
  section?: string;
  catalog_page?: string;
  description?: string;
  features?: string[];
  material?: string;
  alloy?: string;
  finish?: string;
  color?: string;
  /** As printed, e.g. ".155 lb". */
  weight?: string;
  /** Parsed from weight when it is in lb. */
  weight_lb?: number;
  specs?: Record<string, string | number>;
  dimension_notes?: string;
  profile?: ProfileGeometry;
  shape?: ShapeGeometry;
  suggested_hardware?: SuggestedHardware[];
  notes?: string;
  /** Joined in from prices.json; absent when the part has no checked price. */
  price?: Price;
}

export interface CatalogFile {
  series: string;
  source: string;
  generated?: string;
  notes: string[];
  parts: Part[];
}

export interface PricesFile {
  source: string;
  prices: Record<string, Price>;
}

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = () => process.env.EIGHTY20_DATA_DIR ?? resolve(here, "..", "data");

export class Catalog {
  readonly file: CatalogFile;
  private byNumber = new Map<string, Part>();

  constructor(file: CatalogFile, prices?: PricesFile) {
    this.file = file;
    for (const p of file.parts) this.byNumber.set(normalize(p.part_number), p);
    for (const [pn, price] of Object.entries(prices?.prices ?? {})) {
      const part = this.byNumber.get(normalize(pn));
      if (part) part.price = price;
    }
  }

  static load(dir = dataDir()): Catalog {
    const catalog = JSON.parse(readFileSync(resolve(dir, "catalog.json"), "utf8")) as CatalogFile;
    const pricesPath = resolve(dir, "prices.json");
    const prices = existsSync(pricesPath) ? (JSON.parse(readFileSync(pricesPath, "utf8")) as PricesFile) : undefined;
    return new Catalog(catalog, prices);
  }

  get parts(): Part[] {
    return this.file.parts;
  }

  get(partNumber: string): Part | undefined {
    return this.byNumber.get(normalize(partNumber));
  }

  categories(): { category: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const p of this.parts) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    return [...counts].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category));
  }

  /** Parts with published section properties, so they can be beam-checked. */
  profiles(): Part[] {
    return this.parts.filter((p) => p.profile);
  }

  search(query: string, opts: { category?: string; series?: string; limit?: number } = {}): Part[] {
    const terms = tokenize(query);
    const limit = opts.limit ?? 20;
    const pool = this.parts.filter(
      (p) => (!opts.category || p.category === opts.category) && (!opts.series || p.series.includes(opts.series)),
    );
    if (terms.length === 0) return pool.slice(0, limit);

    const scored: { part: Part; score: number }[] = [];
    for (const part of pool) {
      const pn = normalize(part.part_number);
      const name = part.name.toLowerCase();
      const rest = [
        part.category,
        part.section ?? "",
        part.description ?? "",
        part.finish ?? "",
        part.notes ?? "",
        ...(part.features ?? []),
        ...Object.values(part.specs ?? {}).map(String),
      ]
        .join(" ")
        .toLowerCase();
      let score = 0;
      let matchedAll = true;
      for (const t of terms) {
        let s = 0;
        if (pn === t) s = 100;
        else if (pn.startsWith(t)) s = 40;
        else if (name.includes(t)) s = 10;
        else if (rest.includes(t)) s = 3;
        if (s === 0) matchedAll = false;
        score += s;
      }
      // Prefer the base part over its color variants when scores tie.
      if (score > 0) scored.push({ part, score: (matchedAll ? score * 2 : score) - pn.length * 0.01 });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.part);
  }
}

export function normalize(partNumber: string): string {
  return partNumber.trim().toLowerCase();
}

function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.replace(/["”]/g, ""))
    .filter(Boolean);
}
