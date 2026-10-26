/**
 * Report Lens estate — the FILE-backed report catalogue and, for mock mode, a synthetic semantic
 * model behind each report.
 *
 * Two roles in one file, kept apart below:
 *
 *  1. THE CATALOGUE — report rows and page rows with a "covers" text: the shape a report catalogue
 *     keeps as two tables (reports, pages). This is the fallback adapter: a Databricks table pair
 *     behind two Unity Catalog functions can answer instead (lib/lens/catalog.ts), and this file
 *     answers whenever that is not configured or not reachable.
 *  2. THE MOCK MODELS — tables, measures and generated rows, so the page, the agent's tools and
 *     its actions run end-to-end with no Power BI and no model key. Every figure here is
 *     SYNTHETIC, by rule.
 *
 * Two estates: the MOCK one here (synthetic reports, no Power BI) and the LIVE one in
 * content/lens-estate.ts — the Power BI reports this deployment embeds, with their bindings.
 */

import { LIVE_CATALOG } from "@/content/lens-estate";

export interface LensVisualSpec {
  title: string;
  /** Column of the model's fact table the visual groups by. */
  dim: string;
  /** Measure name. */
  measure: string;
}

export interface LensCatalogPage {
  /** Power BI section id. */
  page: string;
  title: string;
  /** What the page covers — the text `find_report_page` matches. */
  covers: string;
  /** Mock only: the visuals the synthetic report renders on this page. */
  visuals?: LensVisualSpec[];
}

export interface LensCatalogReport {
  /** Our key; also what `open_report` takes. */
  report_id: string;
  name: string;
  /** The domain the report belongs to (a business area). */
  module: string;
  description: string;
  env: "demo";
  pages: LensCatalogPage[];
  /** Chips the assistant offers on THIS report, beside the generic ones — each verified on the mock. */
  suggestions?: string[];
  /** Power BI binding, when the report exists for real. */
  binding?: { workspaceId: string; reportId: string; datasetId?: string };
}

export interface MockMeasure {
  name: string;
  /** Row field summed; absent = a row count. */
  field?: string;
  format?: "currency" | "number";
}

export interface MockModel {
  table: string;
  dims: Record<string, string[]>;
  measures: MockMeasure[];
  rows: Array<Record<string, string | number>>;
}

// ------------------------------------------------------------------------------------------
// 1. the catalogue
// ------------------------------------------------------------------------------------------

/** The MOCK estate: synthetic reports with a model in MOCK_MODELS below, no Power BI behind them. */
const MOCK_CATALOG: LensCatalogReport[] = [
  {
    report_id: "retail-sales",
    name: "Retail Sales",
    module: "Sales",
    description:
      "Revenue, transactions and units sold, by product, country and sales channel — the weekly commercial review.",
    env: "demo",
    suggestions: ["Filter the report to Japan", "What is the Total Revenue by product?"],
    pages: [
      {
        page: "ReportSectionOverview",
        title: "Overview",
        covers: "Headline revenue and transactions, trend of the main figures, top products",
        visuals: [
          { title: "Revenue by product", dim: "product", measure: "Total Revenue" },
          { title: "Transactions by channel", dim: "channel", measure: "Transactions" },
        ],
      },
      {
        page: "ReportSectionCountry",
        title: "By Country",
        covers: "Revenue and units by country and market, geographic comparison",
        visuals: [
          { title: "Revenue by country", dim: "country", measure: "Total Revenue" },
          { title: "Units by country", dim: "country", measure: "Total Quantity" },
        ],
      },
      {
        page: "ReportSectionProduct",
        title: "By Product",
        covers: "Product mix, units sold per product, best and worst sellers",
        visuals: [
          { title: "Units by product", dim: "product", measure: "Total Quantity" },
          { title: "Transactions by product", dim: "product", measure: "Transactions" },
        ],
      },
      {
        page: "ReportSectionChannel",
        title: "Channels",
        covers: "Online versus store sales, channel share of revenue",
        visuals: [{ title: "Revenue by channel", dim: "channel", measure: "Total Revenue" }],
      },
    ],
  },
  {
    report_id: "procurement-scorecard",
    name: "Procurement Scorecard",
    module: "Procurement",
    description:
      "Spend, realized savings and contract coverage by category, supplier and region — the quarterly category review.",
    env: "demo",
    suggestions: ["Filter the report to Metals", "What are the Realized Savings by supplier?"],
    pages: [
      {
        page: "ReportSectionSpend",
        title: "Spend",
        covers: "Total spend by category and region, where the money goes",
        visuals: [
          { title: "Spend by category", dim: "category", measure: "Spend" },
          { title: "Spend by region", dim: "region", measure: "Spend" },
        ],
      },
      {
        page: "ReportSectionSavings",
        title: "Savings",
        covers: "Realized savings against spend, savings by category and supplier",
        visuals: [
          { title: "Realized savings by category", dim: "category", measure: "Realized Savings" },
          { title: "Realized savings by supplier", dim: "supplier", measure: "Realized Savings" },
        ],
      },
      {
        page: "ReportSectionSuppliers",
        title: "Suppliers",
        covers: "Supplier concentration, contracts per supplier, supplier risk",
        visuals: [
          { title: "Spend by supplier", dim: "supplier", measure: "Spend" },
          { title: "Contracts by supplier", dim: "supplier", measure: "Contracts" },
        ],
      },
    ],
  },
  {
    report_id: "store-operations",
    name: "Store Operations",
    module: "Operations",
    description:
      "Stock on hand, orders shipped and late orders, by store and product family — the daily operations board.",
    env: "demo",
    suggestions: ["Filter the report to Milan Centrale", "What are the Late Orders by family?"],
    pages: [
      {
        page: "ReportSectionInventory",
        title: "Inventory",
        covers: "Stock on hand by store and product family, stock levels",
        visuals: [
          { title: "Units on hand by store", dim: "store", measure: "Units On Hand" },
          { title: "Units on hand by family", dim: "family", measure: "Units On Hand" },
        ],
      },
      {
        page: "ReportSectionFulfilment",
        title: "Fulfilment",
        covers: "Orders shipped and late orders, delivery performance, service level",
        visuals: [
          { title: "Orders shipped by store", dim: "store", measure: "Orders Shipped" },
          { title: "Late orders by store", dim: "store", measure: "Late Orders" },
        ],
      },
      {
        page: "ReportSectionFamilies",
        title: "Product Families",
        covers: "Shipments and late orders per product family",
        visuals: [
          { title: "Orders shipped by family", dim: "family", measure: "Orders Shipped" },
          { title: "Late orders by family", dim: "family", measure: "Late Orders" },
        ],
      },
    ],
  },
];

/** Both estates; which one a page sees is decided by the road (lib/lens/catalog `lensReports`). */
export const LENS_CATALOG: LensCatalogReport[] = [...MOCK_CATALOG, ...LIVE_CATALOG];

// ------------------------------------------------------------------------------------------
// 2. the mock models — synthetic, generated deterministically so a demo replays identically
// ------------------------------------------------------------------------------------------

/** A tiny deterministic generator (mulberry32): the same seed, the same estate, every run. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cartesian(dims: Record<string, string[]>): Array<Record<string, string>> {
  return Object.entries(dims).reduce<Array<Record<string, string>>>(
    (acc, [k, vs]) => acc.flatMap((row) => vs.map((v) => ({ ...row, [k]: v }))),
    [{}],
  );
}

function model(
  table: string,
  dims: Record<string, string[]>,
  measures: MockMeasure[],
  seed: number,
  fields: Record<string, [number, number]>,
): MockModel {
  const r = rng(seed);
  const rows = cartesian(dims).map((row) => {
    const out: Record<string, string | number> = { ...row };
    for (const [f, [lo, hi]] of Object.entries(fields)) out[f] = Math.round(lo + r() * (hi - lo));
    return out;
  });
  return { table, dims, measures, rows };
}

export const MOCK_MODELS: Record<string, MockModel> = {
  "retail-sales": model(
    "sales",
    {
      product: ["Golden Gate Ginger", "Outback Oatmeal", "Austin Almond Biscotti", "Tokyo Tidbits", "Orchard Oasis", "Pearly Pies"],
      country: ["Japan", "US", "Australia", "Italy", "Germany"],
      channel: ["Store", "Online"],
    },
    [
      { name: "Total Revenue", field: "revenue", format: "currency" },
      { name: "Total Quantity", field: "quantity" },
      { name: "Transactions" },
    ],
    17,
    { revenue: [300, 2400], quantity: [40, 260] },
  ),
  "procurement-scorecard": model(
    "spend",
    {
      category: ["Metals", "Logistics", "Electronics", "Packaging", "IT Services"],
      supplier: ["Northwind Metals", "Contoso Freight", "Fabrikam Parts", "Tailspin Packaging", "Litware Systems", "Adatum Components"],
      region: ["EMEA", "Americas", "APAC"],
    },
    [
      { name: "Spend", field: "spend", format: "currency" },
      { name: "Realized Savings", field: "savings", format: "currency" },
      { name: "Contracts", field: "contracts" },
    ],
    29,
    { spend: [20000, 240000], savings: [500, 18000], contracts: [0, 6] },
  ),
  "store-operations": model(
    "operations",
    {
      store: ["Milan Centrale", "Turin Lingotto", "Rome Termini", "Bologna Fiera", "Naples Porto"],
      family: ["Bakery", "Snacks", "Beverages", "Frozen"],
    },
    [
      { name: "Units On Hand", field: "on_hand" },
      { name: "Orders Shipped", field: "shipped" },
      { name: "Late Orders", field: "late" },
    ],
    41,
    { on_hand: [120, 1800], shipped: [40, 600], late: [0, 45] },
  ),
};
