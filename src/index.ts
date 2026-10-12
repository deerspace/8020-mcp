#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Catalog } from "./catalog.js";
import { buildBom, deflection, optimizeCuts, recommendProfiles } from "./engineering.js";

const catalog = Catalog.load();
const server = new McpServer({ name: "8020-mcp", version: "0.1.0" });

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  "catalog_info",
  {
    title: "Catalog info",
    description: "Describe the local 80/20 catalog: series covered, part counts per category, data source and caveats. Call this first to see what is available.",
    annotations: readOnly,
  },
  async () => {
    const dates = catalog.parts.map((p) => p.price?.verified).filter((d): d is string => !!d).sort();
    return json({
      series: catalog.file.series,
      source: catalog.file.source,
      generated: catalog.file.generated,
      total_parts: catalog.parts.length,
      profiles: catalog.profiles().length,
      priced_parts: dates.length,
      prices_checked: dates.length ? { oldest: dates[0], newest: dates[dates.length - 1] } : null,
      categories: catalog.categories(),
      notes: catalog.file.notes,
    });
  },
);

server.registerTool(
  "search_parts",
  {
    title: "Search parts",
    description:
      "Search 80/20 fractional 15 series parts and fractional hardware by part number, name or keyword (e.g. '1530', 'inside corner bracket', 'swivel caster', 'anchor fastener', '5/16-18'). Filter by category (see catalog_info) or series badge.",
    inputSchema: {
      query: z.string().describe("Part number or keywords. Empty string lists the category."),
      category: z.string().optional(),
      series: z
        .enum(["15", "F", "10", "M", "RT", "QF", "P"])
        .optional()
        .describe("15 = 15 series, F = fractional hardware for 10 and 15 series, 10/M = 10 series or metric hardware that 15 series parts reference."),
      limit: z.number().int().min(1).max(100).default(20),
    },
    annotations: readOnly,
  },
  async ({ query, category, series, limit }) => {
    const results = catalog.search(query, { category, series, limit });
    return json(
      results.map((p) => ({
        part_number: p.part_number,
        name: p.name,
        category: p.category,
        series: p.series,
        finish: p.finish,
        catalog_page: p.catalog_page,
        price: p.price ? { usd: p.price.price, unit: p.price.price_unit, checked: p.price.verified } : null,
      })),
    );
  },
);

server.registerTool(
  "get_part",
  {
    title: "Get part",
    description:
      "Full details for one or more part numbers: specs and dimensions, section properties for profiles, suggested mounting hardware, catalog page, and price when one has been checked.",
    inputSchema: { part_numbers: z.array(z.string()).min(1).max(50) },
    annotations: readOnly,
  },
  async ({ part_numbers }) => json(part_numbers.map((pn) => catalog.get(pn) ?? { part_number: pn, error: "Not in the local catalog." })),
);

server.registerTool(
  "beam_deflection",
  {
    title: "Beam deflection",
    description:
      "Check how much a 15 series profile bends under load, with bending stress and safety factor. Use it to choose a profile for shelves, desk rails, spans and cantilevers.",
    inputSchema: {
      part_number: z.string().describe("A profile, e.g. 1515, 1530, 1545."),
      length_in: z.number().positive().describe("Unsupported span in inches."),
      load_lb: z.number().min(0).describe("Point load, or the total load for a uniform load."),
      support: z.enum(["simply_supported", "cantilever", "fixed_both_ends"]).default("simply_supported"),
      load_type: z.enum(["center", "uniform"]).default("uniform").describe("For a cantilever, 'center' means a point load at the free end."),
      orientation: z.enum(["strong", "weak"]).default("strong").describe("strong = tall face vertical (e.g. 1530 standing 3\" tall)."),
      include_self_weight: z.boolean().default(true),
    },
    annotations: readOnly,
  },
  async ({ part_number, ...input }) => {
    const part = catalog.get(part_number);
    if (!part) return fail(`${part_number} is not in the local catalog.`);
    try {
      return json(deflection(part, input));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "recommend_profile",
  {
    title: "Recommend profile",
    description:
      "Find every 15 series profile (and orientation) stiff and strong enough for a span and load, lightest first. Use it before beam_deflection when the profile is not chosen yet.",
    inputSchema: {
      length_in: z.number().positive().describe("Unsupported span in inches."),
      load_lb: z.number().min(0).describe("Point load, or the total load for a uniform load."),
      support: z.enum(["simply_supported", "cantilever", "fixed_both_ends"]).default("simply_supported"),
      load_type: z.enum(["center", "uniform"]).default("uniform"),
      min_span_ratio: z.number().positive().default(360).describe("Stiffness target as span / deflection: 360 for shelves and desks, 240 for general frames."),
      min_safety_factor: z.number().positive().default(3).describe("Against 6063-T6 yield."),
      limit: z.number().int().min(1).max(50).default(10),
    },
    annotations: readOnly,
  },
  async ({ limit, ...req }) => {
    const fits = recommendProfiles(catalog, req);
    return json({ matches: fits.length, results: fits.slice(0, limit) });
  },
);

server.registerTool(
  "build_bom",
  {
    title: "Build bill of materials",
    description:
      "Price a parts list. Profiles and other cut-to-length parts need length_in (price per inch + cut charge per piece); panels sold by the square foot need width_in and height_in. Returns line totals, weight, and warnings such as fasteners a bracket needs that are sold separately.",
    inputSchema: {
      items: z
        .array(
          z.object({
            part_number: z.string(),
            qty: z.number().int().positive(),
            length_in: z.number().positive().optional(),
            width_in: z.number().positive().optional(),
            height_in: z.number().positive().optional(),
          }),
        )
        .min(1),
    },
    annotations: readOnly,
  },
  async ({ items }) => json(buildBom(catalog, items)),
);

server.registerTool(
  "optimize_cuts",
  {
    title: "Optimize cuts",
    description:
      "Pack cut pieces into stock bars to minimize waste, for when you buy full-length bars and cut them yourself. If 80/20 cuts to length for you, use build_bom instead.",
    inputSchema: {
      cuts: z.array(z.object({ length_in: z.number().positive(), qty: z.number().int().positive(), label: z.string().optional() })).min(1),
      stock_length_in: z.number().positive().default(72),
      kerf_in: z.number().min(0).default(0.125).describe("Saw blade width lost per cut."),
    },
    annotations: readOnly,
  },
  async ({ cuts, stock_length_in, kerf_in }) => {
    try {
      return json(optimizeCuts(cuts, stock_length_in, kerf_in));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());
