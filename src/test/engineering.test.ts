import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Catalog } from "../catalog.js";
import { buildBom, deflection, optimizeCuts, recommendProfiles } from "../engineering.js";

const fixture = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "test", "fixture");
const catalog = Catalog.load(fixture);

test("1515 simply supported, 100 lb center, 48 in span, no self weight", () => {
  const r = deflection(catalog.get("1515")!, {
    length_in: 48, load_lb: 100, support: "simply_supported", load_type: "center", orientation: "strong", include_self_weight: false,
  });
  // PL^3 / 48EI = 100 * 110592 / (48 * 1e7 * 0.2542)
  assert.equal(r.max_deflection_in, 0.0906);
  // M = PL/4 = 1200 in-lb, stress = M c / I = 1200 * 0.75 / 0.2542
  assert.equal(r.max_bending_stress_psi, 3541);
});

test("strong vs weak axis uses the matching I and depth", () => {
  const base = { length_in: 48, load_lb: 100, support: "simply_supported" as const, load_type: "center" as const, include_self_weight: false };
  const strong = deflection(catalog.get("TEST-1530")!, { ...base, orientation: "strong" });
  const weak = deflection(catalog.get("TEST-1530")!, { ...base, orientation: "weak" });
  assert.equal(strong.depth_in_load_direction, 3);
  assert.equal(weak.depth_in_load_direction, 1.5);
  assert.ok(Math.abs(weak.max_deflection_in / strong.max_deflection_in - 1.8 / 0.5) < 0.01);
});

test("profiles with their own published material values use them instead of aluminum", () => {
  const base = { length_in: 48, load_lb: 100, support: "simply_supported" as const, load_type: "center" as const, orientation: "strong" as const, include_self_weight: false };
  const al = deflection(catalog.get("1515")!, base);
  const frp = deflection(catalog.get("TEST-FRP")!, base);
  assert.ok(Math.abs(frp.max_deflection_in / al.max_deflection_in - 2) < 0.01);
  assert.ok(Math.abs(frp.safety_factor_vs_yield! / al.safety_factor_vs_yield! - 2) < 0.01);
});

test("shapes without section properties are sold by length but never beam-checked", () => {
  assert.ok(!catalog.profiles().some((p) => p.part_number === "TEST-FLAT"));
  const r = buildBom(catalog, [{ part_number: "TEST-FLAT", qty: 2, length_in: 10 }]);
  assert.equal(r.lines[0].weight_lb, 0.32);
});

test("BOM prices cut-to-length profiles, flags unpriced and unknown parts, lists T-slot hardware only", () => {
  const r = buildBom(catalog, [
    { part_number: "1515", qty: 4, length_in: 24 },
    { part_number: "TEST-PLATE", qty: 2 },
    { part_number: "1515-Black", qty: 1, length_in: 300 },
    { part_number: "nope", qty: 1 },
  ]);
  assert.equal(r.lines[0].line_total, 4 * (0.98 * 24 + 3));
  assert.equal(r.lines[1].line_total, 12);
  assert.deepEqual(r.unpriced_parts, ["1515-Black", "nope"]);
  assert.ok(r.warnings.some((w) => w.includes("6x 3320")));
  assert.ok(!r.warnings.some((w) => w.includes("3960")));
  assert.ok(r.warnings.some((w) => w.includes("longer than the 242")));
});

test("panels are priced per square foot, with the cut charge waived at the stock sheet size", () => {
  const r = buildBom(catalog, [
    { part_number: "TEST-PANEL", qty: 2, width_in: 24, height_in: 36 },
    { part_number: "TEST-PANEL", qty: 1, width_in: 96, height_in: 48 },
    { part_number: "TEST-PANEL", qty: 1 },
  ]);
  assert.equal(r.lines[0].line_total, Math.round(2 * (10.2 * 6 + 16.13) * 100) / 100);
  assert.equal(r.lines[1].line_total, Math.round(10.2 * 32 * 100) / 100);
  assert.equal(r.lines[2].line_total, null);
  assert.ok(r.warnings.some((w) => w.includes("width_in and height_in")));
});

test("recommend_profile returns only profiles that pass, lightest first, one per color family", () => {
  const fits = recommendProfiles(catalog, { length_in: 48, load_lb: 100, support: "simply_supported", load_type: "uniform", min_span_ratio: 360, min_safety_factor: 3 });
  assert.ok(fits.every((f) => (f.span_over_deflection ?? 0) >= 360));
  assert.equal(fits.filter((f) => f.part_number.startsWith("1515")).length, 1);
  for (let i = 1; i < fits.length; i++) assert.ok(fits[i - 1].weight_lb_per_in <= fits[i].weight_lb_per_in);
});

test("cut optimizer packs with kerf", () => {
  const r = optimizeCuts([{ length_in: 30, qty: 4 }], 72, 0.125);
  assert.equal(r.bars_needed, 2);
  assert.deepEqual(r.bars[0].cuts, ['30"', '30"']);
});

test("search ranks exact part numbers and base parts first", () => {
  assert.equal(catalog.search("1515")[0].part_number, "1515");
  assert.equal(catalog.search("flat plate")[0].part_number, "TEST-PLATE");
  assert.equal(catalog.search("", { category: "bracket_plate" }).length, 1);
});
