import type { Catalog, Part } from "./catalog.js";

/** 6063-T6 values published on 80/20's aluminum profile pages; used when a profile does not list its own. */
export const ELASTIC_MODULUS_PSI = 10_000_000;
export const YIELD_STRENGTH_PSI = 25_000;

export type Support = "simply_supported" | "cantilever" | "fixed_both_ends";
export type LoadType = "center" | "uniform";
export type Orientation = "strong" | "weak";

export interface DeflectionInput {
  length_in: number;
  load_lb: number;
  support: Support;
  load_type: LoadType;
  orientation: Orientation;
  include_self_weight: boolean;
}

// [deflection coefficient k where δ = k·P·L³/(E·I), moment coefficient m where M = m·P·L]
// P is the point load, or the total load W for uniform loads.
const BEAM_CASES: Record<Support, Record<LoadType, [number, number]>> = {
  simply_supported: { center: [1 / 48, 1 / 4], uniform: [5 / 384, 1 / 8] },
  cantilever: { center: [1 / 3, 1], uniform: [1 / 8, 1 / 2] }, // "center" = load at the free end
  fixed_both_ends: { center: [1 / 192, 1 / 8], uniform: [1 / 384, 1 / 12] },
};

export function deflection(part: Part, input: DeflectionInput) {
  const g = part.profile;
  if (!g) throw new Error(`${part.part_number} is not a profile, so it has no section properties.`);

  const strongIsX = g.ix_in4 >= g.iy_in4;
  const useStrong = input.orientation === "strong";
  const I = useStrong ? Math.max(g.ix_in4, g.iy_in4) : Math.min(g.ix_in4, g.iy_in4);
  // Depth along the load direction: the taller face for the strong axis.
  const depth = useStrong ? Math.max(g.width_in, g.height_in) : Math.min(g.width_in, g.height_in);
  const c = depth / 2;
  const L = input.length_in;
  const E = g.modulus_psi ?? ELASTIC_MODULUS_PSI;
  const yieldPsi = g.yield_psi ?? YIELD_STRENGTH_PSI;

  const [k, m] = BEAM_CASES[input.support][input.load_type];
  const [kSelf, mSelf] = BEAM_CASES[input.support].uniform;
  const selfWeight = input.include_self_weight ? g.weight_lb_per_in * L : 0;

  const deflectionIn = (k * input.load_lb * L ** 3) / (E * I) + (kSelf * selfWeight * L ** 3) / (E * I);
  const momentInLb = m * input.load_lb * L + mSelf * selfWeight * L;
  const stressPsi = (momentInLb * c) / I;

  return {
    part_number: part.part_number,
    axis_used: `${useStrong ? "strong" : "weak"} (I = ${I} in^4, published as ${useStrong === strongIsX ? "Ix" : "Iy"})`,
    depth_in_load_direction: depth,
    self_weight_lb: round(selfWeight, 3),
    max_deflection_in: round(deflectionIn, 4),
    span_over_deflection: deflectionIn > 0 ? Math.round(L / deflectionIn) : null,
    max_bending_moment_in_lb: round(momentInLb, 1),
    max_bending_stress_psi: Math.round(stressPsi),
    safety_factor_vs_yield: stressPsi > 0 ? round(yieldPsi / stressPsi, 2) : null,
    guidance: deflectionGuidance(L, deflectionIn),
    assumptions: [
      `E = ${E.toLocaleString()} psi and yield = ${yieldPsi.toLocaleString()} psi, as published by 80/20 for ${part.material ?? "this profile"}${part.alloy ? ` ${part.alloy}` : ""}.`,
      "Ideal supports. Real T-slot joints are not perfectly fixed, so a 'fixed_both_ends' result is optimistic; simply_supported is the conservative choice for bracketed frames.",
      "Static load only, no impact, fatigue, or connector capacity check. Bracket and fastener ratings often govern before the profile does.",
    ],
  };
}

function deflectionGuidance(L: number, d: number): string {
  if (d <= 0) return "No deflection.";
  const ratio = L / d;
  if (ratio >= 360) return "Stiff: within L/360, fine for shelves, desks and anything people lean on.";
  if (ratio >= 240) return "Acceptable for most frames (L/240 to L/360). Noticeable under a hand if you lean on it.";
  if (ratio >= 120) return "Flexible (L/120 to L/240). Consider a deeper profile, a mid support, or turning it to the strong axis.";
  return "Too flexible (worse than L/120). Use a bigger profile or shorten the span.";
}

// ---------------------------------------------------------------------------

export interface BomItem {
  part_number: string;
  qty: number;
  /** Cut length for parts sold by the inch. */
  length_in?: number;
  /** Panel size for parts sold by the square foot. */
  width_in?: number;
  height_in?: number;
}

export function buildBom(catalog: Catalog, items: BomItem[]) {
  const lines = [];
  const warnings: string[] = [];
  const unpriced: string[] = [];
  let total = 0;
  let weight = 0;

  for (const item of items) {
    const part = catalog.get(item.part_number);
    if (!part) {
      warnings.push(`${item.part_number}: not in the local catalog. Check the part number on 8020.net.`);
      lines.push({ part_number: item.part_number, qty: item.qty, length_in: item.length_in, name: "UNKNOWN", line_total: null });
      unpriced.push(item.part_number);
      continue;
    }

    const geometry = part.profile ?? part.shape;
    const priceUnit = part.price?.price_unit ?? (geometry ? "per_inch" : "each");
    let unit: number | null = null;
    let lineWeight: number | null = null;
    if (priceUnit === "per_inch") {
      if (item.length_in == null) {
        warnings.push(`${part.part_number}: is cut to length, so it needs length_in.`);
      } else {
        const max = geometry?.max_length_in;
        if (max && item.length_in > max) warnings.push(`${part.part_number}: ${item.length_in}" is longer than the ${max}" longest stock length.`);
        if (part.price) unit = part.price.price * item.length_in + (part.price.cut_charge ?? 0);
        if (geometry?.weight_lb_per_in) lineWeight = geometry.weight_lb_per_in * item.length_in * item.qty;
      }
    } else if (priceUnit === "per_sqft") {
      if (item.width_in == null || item.height_in == null) {
        warnings.push(`${part.part_number}: is sold by the square foot, so it needs width_in and height_in.`);
      } else if (part.price) {
        const stock = part.price.stock_sheet_in;
        const isStock =
          !!stock &&
          ((item.width_in === stock[0] && item.height_in === stock[1]) || (item.width_in === stock[1] && item.height_in === stock[0]));
        if (stock && Math.max(item.width_in, item.height_in) > Math.max(...stock) + 1e-9)
          warnings.push(`${part.part_number}: ${item.width_in}" x ${item.height_in}" is larger than the ${stock[0]}" x ${stock[1]}" stock sheet.`);
        unit = part.price.price * ((item.width_in * item.height_in) / 144) + (isStock ? 0 : part.price.cut_charge ?? 0);
      }
    } else {
      if (part.price) unit = part.price.price;
      if (part.weight_lb != null) lineWeight = part.weight_lb * item.qty;
    }

    const tslot = (part.suggested_hardware ?? []).filter((h) => !/ready tube|quick frame/i.test(h.context ?? ""));
    if (tslot.length) {
      const count = (q: number | string | undefined) =>
        typeof q === "number" ? `${q * item.qty}x` : q ? `${q} per part x${item.qty}:` : "";
      const list = tslot
        .map((h) => `${count(h.qty)} ${h.part_number ?? ""}${h.description ? ` (${h.description})` : ""}`.replace(/\s+/g, " ").trim())
        .join(", ");
      warnings.push(`${part.part_number} x${item.qty}: suggested mounting hardware, sold separately: ${list}`);
    }

    const lineTotal = unit == null ? null : round(unit * item.qty, 2);
    if (lineTotal == null) unpriced.push(part.part_number);
    else total += lineTotal;
    if (lineWeight != null) weight += lineWeight;

    lines.push({
      part_number: part.part_number,
      name: part.name,
      qty: item.qty,
      length_in: item.length_in,
      size_in: item.width_in != null && item.height_in != null ? `${item.width_in} x ${item.height_in}` : undefined,
      unit_price: unit == null ? null : round(unit, 2),
      line_total: lineTotal,
      weight_lb: lineWeight == null ? null : round(lineWeight, 2),
      price_checked: part.price?.verified ?? null,
    });
  }

  return {
    lines,
    subtotal_usd: round(total, 2),
    unpriced_parts: [...new Set(unpriced)],
    approx_weight_lb: round(weight, 1),
    warnings,
    note:
      "Prices are 8020.net list prices on the date shown, before tax, shipping and machining (taps, counterbores, access holes). " +
      "Cut-to-length lines include one cut charge per piece; panels include the cut charge unless ordered at the stock sheet size. " +
      "The subtotal covers priced lines only; get current prices for unpriced_parts on 8020.net.",
  };
}

// ---------------------------------------------------------------------------

export interface ProfileRequirement {
  length_in: number;
  load_lb: number;
  support: Support;
  load_type: LoadType;
  /** Required stiffness as span / deflection, e.g. 360. */
  min_span_ratio: number;
  min_safety_factor: number;
}

/** Every catalog profile and orientation that meets the requirement, lightest first. */
export function recommendProfiles(catalog: Catalog, req: ProfileRequirement) {
  const fits = [];
  const seen = new Set<string>();
  for (const part of catalog.profiles()) {
    const g = part.profile!;
    // Color variants share section properties; only rank one of each.
    const key = `${g.width_in}x${g.height_in}:${g.ix_in4}:${g.iy_in4}:${g.weight_lb_per_in}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const orientations: Orientation[] = g.ix_in4 === g.iy_in4 ? ["strong"] : ["strong", "weak"];
    for (const orientation of orientations) {
      const r = deflection(part, { ...req, orientation, include_self_weight: true });
      if ((r.span_over_deflection ?? Infinity) >= req.min_span_ratio && (r.safety_factor_vs_yield ?? Infinity) >= req.min_safety_factor) {
        fits.push({
          part_number: part.part_number,
          name: part.name,
          orientation,
          weight_lb_per_in: g.weight_lb_per_in,
          max_deflection_in: r.max_deflection_in,
          span_over_deflection: r.span_over_deflection,
          safety_factor_vs_yield: r.safety_factor_vs_yield,
        });
      }
    }
  }
  return fits.sort((a, b) => a.weight_lb_per_in - b.weight_lb_per_in);
}

// ---------------------------------------------------------------------------

export interface CutRequest {
  length_in: number;
  qty: number;
  label?: string;
}

/** First-fit-decreasing packing of cut pieces into stock bars. */
export function optimizeCuts(cuts: CutRequest[], stockLengthIn: number, kerfIn: number) {
  const pieces: { length: number; label: string }[] = [];
  for (const c of cuts) {
    if (c.length_in > stockLengthIn) throw new Error(`A ${c.length_in}" piece does not fit in a ${stockLengthIn}" stock bar.`);
    for (let i = 0; i < c.qty; i++) pieces.push({ length: c.length_in, label: c.label ?? `${c.length_in}"` });
  }
  pieces.sort((a, b) => b.length - a.length);

  const bars: { cuts: { length: number; label: string }[]; used: number }[] = [];
  for (const piece of pieces) {
    // A cut costs one kerf unless it ends exactly at the end of the bar.
    const bar = bars.find((b) => b.used + piece.length <= stockLengthIn + 1e-9);
    const target = bar ?? (bars.push({ cuts: [], used: 0 }), bars[bars.length - 1]);
    target.cuts.push(piece);
    target.used = Math.min(stockLengthIn, target.used + piece.length + kerfIn);
  }

  const totalCut = pieces.reduce((s, p) => s + p.length, 0);
  return {
    stock_length_in: stockLengthIn,
    kerf_in: kerfIn,
    bars_needed: bars.length,
    bars: bars.map((b, i) => ({
      bar: i + 1,
      cuts: b.cuts.map((c) => c.label),
      offcut_in: round(Math.max(0, stockLengthIn - b.cuts.reduce((s, c) => s + c.length + kerfIn, 0)), 3),
    })),
    total_cut_length_in: round(totalCut, 3),
    utilization_pct: round((totalCut / (bars.length * stockLengthIn)) * 100, 1),
  };
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
